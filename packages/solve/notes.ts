import type { Campaign, Entry } from "xean";
import { z } from "zod";

import { boundaryLabels, inbox } from "./inbox";
import { nonblank, roleLabels, submittedNotes } from "./roles";

const requestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonblank,
  notes: submittedNotes.shape.notes,
});
const notes = inbox({
  receiptLabel: "xean-solve/notes",
  receiptSchema: requestSchema,
  boundaryLabel: boundaryLabels.notes,
  startedLabels: [
    boundaryLabels.overlap,
    roleLabels.explorer,
    roleLabels.coordinator,
    boundaryLabels.guidance,
  ],
});

export function hasSubmittedNotes(
  records: readonly Entry[],
  id: string,
): boolean {
  return notes.receipts(records).some((receipt) => receipt.id === id);
}

function submissionRequest(input: z.input<typeof submittedNotes>, id: string) {
  return requestSchema.parse({
    schemaVersion: 1,
    id,
    notes: submittedNotes.parse(input).notes,
  });
}

/** Validate against a captured journal prefix, then append only while it is unchanged. */
export async function appendSubmittedNotes(
  path: string,
  campaign: Campaign,
  input: z.input<typeof submittedNotes>,
  id: string,
  validate: (records: readonly Entry[]) => Promise<void>,
) {
  const request = submissionRequest(input, id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const through = campaign.lastSequence();
    const records = campaign.records({
      excludeLabels: ["xean/pi-request"],
      through,
    });
    const prior = notes.existing(records, request);
    if (prior !== undefined) return prior;
    await validate(records);
    const receipt = await notes.appendLocked(path, campaign, request, {
      unchangedSince: through,
    });
    if (receipt !== undefined) return receipt;
  }
  throw new Error(
    "campaign changed while validating submitted notes; retry the same id",
  );
}

/**
 * Append role-produced notes while the workflow runner already owns its
 * campaign lock. The deterministic id makes a retry after a process
 * interruption idempotent; delivery still happens only at the normal boundary.
 */
export async function appendSubmittedNotesLocked(
  campaign: Campaign,
  input: z.input<typeof submittedNotes>,
  id: string,
) {
  return notes.append(campaign, submissionRequest(input, id));
}

export const submittedNotesBoundary = notes.at;

/** Freeze pending notes before a role input is constructed, once per boundary. */
export const freezeSubmittedNotes = notes.freeze;

/** Delivery records a coordinator request, not a model verification verdict. */
export function inspectSubmittedNotes(
  records: readonly Entry[],
  assigned: readonly { call: number; noteIds: readonly string[] }[] = [],
) {
  const bound = notes.boundaries(records);
  return notes.receipts(records).map((receipt) => {
    const binding = bound.find((entry) =>
      entry.receipts.some((submission) => submission.call === receipt.call),
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
