import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { batchResults, decode, object } from "./contracts.ts";

const text = Type.String({ minLength: 1, pattern: "\\S" });
export const editorAuditSchema = object({
  entries: Type.Array(
    object({
      noteIds: Type.Array(text, {
        minItems: 1,
        uniqueItems: true,
        description:
          "Original note IDs considered together. Cover every supplied note exactly once across all entries.",
      }),
      disposition: StringEnum(["retain", "merge", "obsolete", "dead"] as const),
      capability: Type.String({
        ...text,
        description:
          "Useful mathematical knowledge in these notes, including its hypotheses, guarantees, limitations, and unresolved status.",
      }),
      preservation: Type.String({
        ...text,
        description:
          "What the replacement must preserve to make this knowledge usable, including necessary arguments and scoped negative results. Explain any justified omission.",
      }),
      rationale: Type.String({
        ...text,
        description:
          "Why this disposition is justified. Identify what supersedes obsolete material; rejected claims can still contain useful failure information.",
      }),
    }),
  ),
  report: text,
});
export type EditorAudit = Static<typeof editorAuditSchema>;

/** Validate coverage, leaving mathematical dispositions to independent review. */
export function validateEditorAudit(
  ids: readonly string[],
  value: unknown,
): EditorAudit {
  const audit = decode(editorAuditSchema, value);
  batchResults(
    ids,
    audit.entries.flatMap((entry) =>
      entry.noteIds.map((noteId) => ({ noteId, result: entry })),
    ),
  );
  return audit;
}
