import type { Campaign, Entry } from "xean";
import { z } from "zod";

import { inbox } from "./inbox";
import { nonblank, submittedNotes } from "./roles";
import type { RecordSource } from "./history";

const requestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonblank,
  notes: submittedNotes.shape.notes,
});
export const notesInbox = inbox("notes", requestSchema);

/** Caller notes validate a captured prefix before appending their receipt. */
export async function appendSubmittedNotes(
  campaign: Campaign,
  input: z.input<typeof submittedNotes>,
  id: string,
  caller: {
    readonly path: string;
    readonly validate: (source: RecordSource) => Promise<void>;
  },
) {
  const request = requestSchema.parse({
    schemaVersion: 1,
    id,
    notes: submittedNotes.parse(input).notes,
  });
  return notesInbox.appendLocked(
    caller.path,
    campaign,
    request,
    caller.validate,
  );
}

/** Delivery records a coordinator request, not a model verification verdict. */
export function inspectSubmittedNotes(
  records: readonly Entry[],
  assigned: readonly { call: number; noteIds: readonly string[] }[] = [],
) {
  return notesInbox.delivery(records).map(({ receipt, binding }) => {
    const coordinatorCall = binding?.calls[0];
    const assignment = assigned.find((entry) => entry.call === receipt.call);
    return {
      ...receipt,
      pending: coordinatorCall === undefined,
      boundary: binding?.call ?? null,
      coordinatorCall: coordinatorCall ?? null,
      ...(assignment ? { noteIds: assignment.noteIds } : {}),
    };
  });
}
