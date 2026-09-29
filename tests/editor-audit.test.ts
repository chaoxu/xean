import { expect, test } from "bun:test";
import {
  validateEditorAudit,
  type EditorAudit,
} from "../packages/core/src/solve/editor-audit.ts";

const entry = (
  noteId: string,
  disposition: EditorAudit["entries"][number]["disposition"] = "merge",
) => ({
  noteId,
  disposition,
  capability: "A restricted algorithm and its exact parameter bound.",
  preservation: "Keep its construction, proof, and unresolved general case.",
  rationale: "The same construction proves these results together.",
});

test("editor audit accounts for every original note once without fixing replacement note count", () => {
  const audit = {
    entries: [
      entry("old/b"),
      entry("old/a"),
      entry("old/c", "retain"),
      entry("old/d", "obsolete"),
      entry("old/e", "dead"),
    ],
    report: "Consolidate the shared construction; preserve the obstruction.",
  };
  const validated = validateEditorAudit(
    ["old/a", "old/b", "old/c", "old/d", "old/e"],
    audit,
  );
  expect(validated).toEqual(audit);
  expect(validated).not.toBe(audit);
  expect(
    validateEditorAudit([], { entries: [], report: "Empty corpus." }),
  ).toEqual({
    entries: [],
    report: "Empty corpus.",
  });
});

test("editor audit rejects missing, repeated, unknown, and unsupported dispositions", () => {
  for (const [ids, entries] of [
    [["a", "b"], [entry("a")]],
    [["a"], [entry("a"), entry("a")]],
    [["a"], [{ ...entry("a"), noteId: " " }]],
    [["a"], [entry("unexpected")]],
    [["a", "a"], [entry("a")]],
    [["a"], [{ ...entry("a"), noteId: "" }]],
    [["a"], [{ ...entry("a"), disposition: "delete" }]],
    [["a"], [{ ...entry("a"), preservation: " " }]],
    [["a"], [{ ...entry("a"), rationale: "" }]],
    [["a"], [{ ...entry("a"), approved: true }]],
  ] as const) {
    expect(() =>
      validateEditorAudit(ids, { entries, report: "Audit." }),
    ).toThrow();
  }
});
