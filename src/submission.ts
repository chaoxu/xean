import { z } from "zod";

import { entryId as entryIdSchema } from "./schemas";
import { type Entry, type EntryId, type Json } from "./types";

export function returnedToolSubmission(
  records: readonly Entry[],
  callValue: EntryId,
  toolValue: string,
): {
  readonly toolCall: EntryId;
  readonly toolResult: EntryId;
  readonly input: Json;
  readonly output: Json;
} {
  const call = entryIdSchema.parse(callValue);
  const tool = z.string().min(1).parse(toolValue);
  const submissions = records.filter(
    (entry): entry is Extract<Entry, { kind: "tool-call" }> =>
      entry.kind === "tool-call" && entry.call === call && entry.tool === tool,
  );
  if (submissions.length !== 1) {
    throw new Error(`${tool} requires exactly one submission`);
  }
  const submission = submissions[0]!;
  const results = records.filter(
    (entry): entry is Extract<Entry, { kind: "tool-result" }> =>
      entry.kind === "tool-result" && entry.parent === submission.seq,
  );
  if (results.length !== 1 || results[0]!.state !== "returned") {
    throw new Error(`${tool} requires one returned tool result`);
  }
  const result = results[0]!;
  return {
    toolCall: submission.seq,
    toolResult: result.seq,
    input: submission.input,
    output: result.output,
  };
}
