import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { batchResults, decode, object } from "./contracts.ts";

const text = Type.String({ minLength: 1, pattern: "\\S" });
export const editorAuditSchema = object({
  entries: Type.Array(
    object({
      noteId: Type.String({
        ...text,
        description:
          "Exactly one original note ID. Every supplied note must appear in exactly one entry.",
      }),
      disposition: StringEnum(["retain", "merge", "obsolete", "dead"] as const),
      capability: Type.String({
        ...text,
        description:
          "Useful mathematical knowledge in this note, including its hypotheses, guarantees, limitations, and unresolved status.",
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
    audit.entries.map((entry) => ({ noteId: entry.noteId, result: entry })),
  );
  return audit;
}
