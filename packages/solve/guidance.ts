import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";

import type { Campaign, Entry, EntryId } from "xean";
import { z } from "zod";

import { nonblank, roleLabels } from "./roles";

// Guidance and its delivery boundary live in the campaign. These local calls
// make no provider request and leave the workflow's stopping rules unchanged.
const guidanceLabel = "xean-solve/guidance";
const explorerGuidanceLabel = "xean-solve/explorer-guidance";
const guidanceRequest = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonblank,
  text: nonblank,
});
const explorerGuidanceRequest = z.strictObject({
  schemaVersion: z.literal(1),
  after: z.number().int().positive(),
  through: z.number().int().positive(),
});

function guidanceEntries(records: readonly Entry[]) {
  return records.flatMap((entry) =>
    entry.kind === "call" && entry.label === guidanceLabel
      ? [
          {
            call: entry.seq,
            atMs: entry.atMs,
            ...guidanceRequest.parse(entry.request),
          },
        ]
      : [],
  );
}

function explorerGuidanceEntries(records: readonly Entry[]) {
  const guidance = guidanceEntries(records);
  let consumedThrough = 0;
  return records.flatMap((entry) => {
    if (entry.kind !== "call" || entry.label !== explorerGuidanceLabel)
      return [];
    const request = explorerGuidanceRequest.parse(entry.request);
    const included = guidance.filter(
      ({ call }) => call > consumedThrough && call <= request.through,
    );
    consumedThrough = request.through;
    return [{ call: entry.seq, ...request, guidance: included }];
  });
}

/** The call request itself is the durable guidance receipt, including when a
 * process stops before writing its local call-result. */
export async function appendGuidance(
  path: string,
  campaign: Campaign,
  text: string,
  id: string,
) {
  const request = guidanceRequest.parse({ schemaVersion: 1, id, text });
  let pending: ReturnType<Campaign["call"]>;
  {
    // Only guidance submitters take this short lock. The workflow keeps its
    // independent runner lock and may be awaiting a provider throughout.
    using lock = new Database(`${realpathSync(path)}.guidance.lock`, {
      create: true,
    });
    lock.run("PRAGMA busy_timeout = 5000");
    lock.run("BEGIN EXCLUSIVE");
    const existing = guidanceEntries(
      campaign.records({ kinds: ["call"], labels: [guidanceLabel] }),
    ).find((entry) => entry.id === id);
    if (existing !== undefined) {
      if (existing.text !== text)
        throw new Error(`guidance id already has different text: ${id}`);
      return existing;
    }
    // call() appends the request synchronously before its first await. Release
    // the lock after that append, so retrying an id cannot append it twice.
    pending = campaign.call(
      { label: guidanceLabel, request },
      async () => null,
    );
  }
  const receipt = await pending;
  return guidanceEntries([campaign.record(receipt.call)!])[0]!;
}

/** Freeze the guidance visible at this boundary, once for all retries of the
 * same explorer turn. A previously started unguided turn stays unguided. */
export async function freezeExplorerGuidance(
  campaign: Campaign,
  after: EntryId,
): Promise<boolean> {
  const through = campaign.lastSequence();
  const records = campaign.records({
    kinds: ["call"],
    labels: [guidanceLabel, explorerGuidanceLabel, roleLabels.explorer],
    through,
  });
  const bindings = explorerGuidanceEntries(records);
  const consumedThrough = bindings.at(-1)?.through ?? 0;
  if (
    !guidanceEntries(records).some((entry) => entry.call > consumedThrough) ||
    bindings.some((entry) => entry.after === after) ||
    records.some(
      (entry) =>
        entry.kind === "call" &&
        entry.label === roleLabels.explorer &&
        entry.seq > after,
    )
  )
    return false;
  await campaign.call(
    {
      label: explorerGuidanceLabel,
      request: { schemaVersion: 1, after, through },
    },
    async () => null,
  );
  return true;
}

export function explorerGuidance(
  records: readonly Entry[],
  after: EntryId,
  coordinatorGuidance: string,
): string {
  const bindings = explorerGuidanceEntries(records);
  const matches = bindings.filter((entry) => entry.after === after);
  if (matches.length > 1)
    throw new Error("duplicate explorer guidance boundary");
  const binding = matches[0];
  if (binding === undefined) return coordinatorGuidance;
  if (binding.through >= binding.call || binding.after >= binding.call)
    throw new Error("invalid explorer guidance boundary");
  return [coordinatorGuidance, ...binding.guidance.map((entry) => entry.text)]
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** Delivery means inclusion in a started explorer request, not mathematical
 * acceptance or a guarantee that the model followed the instruction. */
export function inspectGuidance(records: readonly Entry[]) {
  const bindings = explorerGuidanceEntries(records);
  return guidanceEntries(records).map((entry) => {
    const calls = records.flatMap((call) => {
      if (call.kind !== "call" || call.label !== roleLabels.explorer) return [];
      const binding = bindings.findLast((value) => value.call < call.seq);
      if (binding === undefined) return [];
      const nextTurn = records.some(
        (value) =>
          value.kind === "call" &&
          value.label === roleLabels.coordinator &&
          value.seq > binding.call &&
          value.seq < call.seq,
      );
      return !nextTurn &&
        binding.guidance.some((value) => value.call === entry.call)
        ? [call.seq]
        : [];
    });
    return { ...entry, calls, pending: calls.length === 0 };
  });
}
