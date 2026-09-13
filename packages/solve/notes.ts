import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type { Campaign, Entry, EntryId } from "xean";
import { z } from "zod";

import { jsonSnapshot, nonblank, roleLabels, submittedNotes } from "./roles";

const notesLabel = "xean-solve/notes";
const boundaryLabel = "xean-solve/coordinator-notes";
const requestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonblank,
  notes: submittedNotes.shape.notes,
});
const boundarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  after: z.number().int().positive(),
  through: z.number().int().positive(),
});

function receipts(records: readonly Entry[]) {
  return records.flatMap((entry) =>
    entry.kind === "call" && entry.label === notesLabel
      ? [
          {
            call: entry.seq,
            atMs: entry.atMs,
            ...requestSchema.parse(entry.request),
          },
        ]
      : [],
  );
}

function boundaries(records: readonly Entry[]) {
  const submitted = receipts(records),
    seen = new Set<number>();
  let consumedThrough = 0;
  return records.flatMap((entry) => {
    if (entry.kind !== "call" || entry.label !== boundaryLabel) return [];
    const request = boundarySchema.parse(entry.request);
    if (
      seen.has(request.after) ||
      request.after >= entry.seq ||
      request.through >= entry.seq ||
      request.through < request.after ||
      request.through < consumedThrough
    )
      throw new Error("invalid or duplicate submitted-notes boundary");
    seen.add(request.after);
    const submissions = submitted.filter(
      (receipt) =>
        receipt.call > consumedThrough && receipt.call <= request.through,
    );
    consumedThrough = request.through;
    return [{ call: entry.seq, ...request, submissions }];
  });
}

/** A local call request is the durable receipt even without its call-result. */
export async function appendSubmittedNotes(
  path: string,
  campaign: Campaign,
  input: z.input<typeof submittedNotes>,
  id: string,
  validate: (records: readonly Entry[]) => Promise<void>,
) {
  const request = requestSchema.parse({
    schemaVersion: 1,
    id,
    notes: submittedNotes.parse(input).notes,
  });
  const existing = (records: readonly Entry[]) => {
    const receipt = receipts(records).find((entry) => entry.id === request.id);
    if (receipt && !isDeepStrictEqual(receipt.notes, request.notes))
      throw new Error(
        `notes id already has a different submission: ${request.id}`,
      );
    return receipt;
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const through = campaign.lastSequence();
    const records = campaign.records({
        excludeLabels: ["xean/pi-request"],
        through,
      }),
      prior = existing(records);
    if (prior) return prior;
    await validate(records);
    let pending: ReturnType<Campaign["call"]>;
    {
      using lock = new Database(`${realpathSync(path)}.notes.lock`, {
        create: true,
      });
      lock.run("PRAGMA busy_timeout = 5000");
      lock.run("BEGIN EXCLUSIVE");
      const current = campaign.records({
          kinds: ["call"],
          labels: [notesLabel],
        }),
        duplicate = existing(current);
      if (duplicate) return duplicate;
      if (campaign.lastSequence() !== through) continue;
      // Append synchronously while locked, then settle the local call outside it.
      pending = campaign.call(
        { label: notesLabel, request: jsonSnapshot(request) },
        async () => null,
      );
    }
    const result = await pending;
    return receipts([campaign.record(result.call)!])[0]!;
  }
  throw new Error(
    "campaign changed while validating submitted notes; retry the same id",
  );
}

export function submittedNotesBoundary(
  records: readonly Entry[],
  after: EntryId,
) {
  return boundaries(records).find((boundary) => boundary.after === after);
}

/** Freeze pending notes before a role input is constructed, once per boundary. */
export async function freezeSubmittedNotes(
  campaign: Campaign,
  after: EntryId,
): Promise<boolean> {
  const through = campaign.lastSequence();
  const records = campaign.records({
      kinds: ["call"],
      labels: [
        notesLabel,
        boundaryLabel,
        roleLabels.explorer,
        roleLabels.coordinator,
        "xean-solve/explorer-guidance",
      ],
      through,
    }),
    bound = boundaries(records);
  const consumedThrough = bound.at(-1)?.through ?? 0;
  if (
    bound.some((entry) => entry.after === after) ||
    !receipts(records).some((entry) => entry.call > consumedThrough) ||
    records.some(
      (entry) =>
        entry.kind === "call" &&
        entry.seq > after &&
        (entry.label === roleLabels.explorer ||
          entry.label === roleLabels.coordinator ||
          entry.label === "xean-solve/explorer-guidance"),
    )
  )
    return false;
  await campaign.call(
    {
      label: boundaryLabel,
      request: { schemaVersion: 1, after, through },
    },
    async () => null,
  );
  return true;
}

/** Delivery records a coordinator request, not a model verification verdict. */
export function inspectSubmittedNotes(
  records: readonly Entry[],
  assigned: readonly { call: number; noteIds: readonly string[] }[] = [],
) {
  const bound = boundaries(records);
  return receipts(records).map((receipt) => {
    const binding = bound.find((entry) =>
      entry.submissions.some((submission) => submission.call === receipt.call),
    );
    const coordinator =
      binding &&
      records.find(
        (entry) =>
          entry.kind === "call" &&
          entry.label === roleLabels.coordinator &&
          entry.seq > binding.call,
      );
    const assignment = assigned.find((entry) => entry.call === receipt.call);
    return {
      ...receipt,
      pending: coordinator === undefined,
      boundary: binding?.call ?? null,
      coordinatorCall: coordinator?.seq ?? null,
      ...(assignment ? { noteIds: assignment.noteIds } : {}),
    };
  });
}
