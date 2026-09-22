import type { Campaign, Entry, EntryId } from "xean";
import { z } from "zod";

import { inbox } from "./inbox";
import { nonblank, roleLabels } from "./roles";

const guidanceRequest = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonblank,
  text: nonblank,
});
const guidance = inbox("guidance", guidanceRequest);

export async function appendGuidance(
  path: string,
  campaign: Campaign,
  text: string,
  id: string,
) {
  return guidance.appendLocked(
    path,
    campaign,
    guidanceRequest.parse({ schemaVersion: 1, id, text }),
  );
}

/** Freeze the guidance visible at this boundary, once for all retries of the
 * same explorer turn. A previously started unguided turn stays unguided. */
export const freezeExplorerGuidance = guidance.freeze;

export function explorerGuidance(
  records: readonly Entry[],
  after: EntryId,
  coordinatorGuidance: string,
): string {
  const binding = guidance.at(records, after);
  if (binding === undefined) return coordinatorGuidance;
  return [coordinatorGuidance, ...binding.receipts.map((entry) => entry.text)]
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** Delivery means inclusion in a started explorer request, not mathematical
 * acceptance or a guarantee that the model followed the instruction. */
export function inspectGuidance(records: readonly Entry[]) {
  const bindings = guidance.boundaries(records);
  return guidance.receipts(records).map((entry) => {
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
        binding.receipts.some((value) => value.call === entry.call)
        ? [call.seq]
        : [];
    });
    return { ...entry, calls, pending: calls.length === 0 };
  });
}
