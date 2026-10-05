import type { JsonValue } from "@earendil-works/chord";
import {
  ToolResultEntry,
  type EntryId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { decode, explorationSchema, object } from "./contracts.ts";

export type SubmissionResult = { kind: "submissions"; entries: EntryId[] };
const schema = object({
  kind: Type.Literal("submissions"),
  entries: Type.Array(
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    { minItems: 1, uniqueItems: true },
  ),
});

/** Explorer output already lives in validated native tool results. */
export async function resolveResult(
  tx: Tx,
  value: JsonValue,
): Promise<JsonValue> {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    value.kind !== "submissions"
  )
    return value;
  const reference = decode(schema, value);
  const submissions = [];
  for (const id of reference.entries) {
    const entry = await tx.entry(ToolResultEntry, id as EntryId);
    const message = entry?.model?.[0];
    if (
      message?.role !== "toolResult" ||
      message.toolName !== "submit_explorer" ||
      message.isError
    )
      throw new Error(`Invalid Explorer submission reference: ${id}`);
    submissions.push(decode(explorationSchema, message.details));
  }
  return {
    kind: "notes",
    notes: submissions.flatMap((value) => value.notes),
    candidate: submissions.at(-1)!.candidate,
  };
}
