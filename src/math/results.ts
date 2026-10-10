import type { JsonValue } from "@earendil-works/chord";
import {
  ToolResultEntry,
  type EntryId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  decode,
  explorationSchema,
  object,
  type Exploration,
  type NoteEdit,
} from "./contracts.ts";

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
  owner: TaskId,
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
      entry?.model?.length !== 1 ||
      message?.role !== "toolResult" ||
      message.toolName !== "submit_explorer" ||
      message.isError ||
      (await tx.conversation(entry.conversationId))?.owner?.taskId !== owner
    )
      throw new Error(`Invalid Explorer submission reference: ${id}`);
    submissions.push(decode(explorationSchema, message.details));
  }
  return { kind: "notes", ...mergeExploration(submissions) };
}

/** Private submissions coalesce field edits against one original published revision. */
export function mergeExploration(
  submissions: readonly Exploration[],
): Exploration {
  const edits = new Map<string, NoteEdit>();
  for (const submission of submissions)
    for (const edit of submission.edits ?? []) {
      const previous = edits.get(edit.id);
      if (previous && previous.revision !== edit.revision)
        throw new Error(`Conflicting edit revisions: ${edit.id}`);
      const merged = { ...previous, ...edit };
      if (previous?.cosmetic !== undefined || edit.cosmetic !== undefined)
        merged.cosmetic =
          (previous?.text === undefined || previous.cosmetic === true) &&
          (edit.text === undefined || edit.cosmetic === true);
      edits.set(edit.id, merged);
    }
  return {
    notes: submissions.flatMap((value) => value.notes),
    candidate: submissions.at(-1)?.candidate ?? false,
    ...(edits.size ? { edits: [...edits.values()] } : {}),
  };
}
