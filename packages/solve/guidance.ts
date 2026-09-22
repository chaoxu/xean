import type { Campaign, Entry, EntryId } from "xean";
import { z } from "zod";

import { inbox } from "./inbox";
import { nonblank } from "./roles";

const guidanceRequest = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonblank,
  text: nonblank,
});
export const guidanceInbox = inbox("guidance", guidanceRequest);

export async function appendGuidance(
  path: string,
  campaign: Campaign,
  text: string,
  id: string,
) {
  return guidanceInbox.appendLocked(
    path,
    campaign,
    guidanceRequest.parse({ schemaVersion: 1, id, text }),
  );
}

export function explorerGuidance(
  records: readonly Entry[],
  after: EntryId,
  coordinatorGuidance: string,
): string {
  const binding = guidanceInbox.at(records, after);
  if (binding === undefined) return coordinatorGuidance;
  return [coordinatorGuidance, ...binding.receipts.map((entry) => entry.text)]
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/** Delivery means inclusion in a started explorer request, not mathematical
 * acceptance or a guarantee that the model followed the instruction. */
export function inspectGuidance(records: readonly Entry[]) {
  return guidanceInbox.delivery(records).map(({ receipt, binding }) => {
    const calls = binding?.calls ?? [];
    return { ...receipt, calls, pending: calls.length === 0 };
  });
}
