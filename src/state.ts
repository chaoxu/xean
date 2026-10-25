import {
  defineDoc,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import type {
  Task,
  Note,
  Verdict,
  ReconstructionRef,
} from "./policy/contracts.ts";
import { note as noteSchema, verifierNames } from "./policy/contracts.ts";
import type { SolveSettings } from "./policy/settings.ts";
import { byId } from "./policy/support.ts";

export type Definition = { task: Task; settings: SolveSettings };
export const DefinitionDoc = defineDoc({
  kind: "xean.v4.definition",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): Definition | { task: null; settings: null } => ({
    task: null,
    settings: null,
  }),
});
export type StoredNote = Pick<
  Note,
  "id" | "text" | "support" | "verification" | "summary" | "detailedSummary"
>;
export type Check = {
  candidate: number;
  call: number;
  values: Verdict[];
  reused?: ReconstructionRef[];
};
export type NotebookState = {
  notes: StoredNote[];
  checks: Check[];
  guidance: { id: string; text: string }[];
  inputs: { id: string; notes: Omit<StoredNote, "id">[]; consumed: boolean }[];
};
export const Notebook = defineDoc({
  kind: "xean.notebook",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): NotebookState => ({
    notes: [],
    checks: [],
    guidance: [],
    inputs: [],
  }),
});

/** Reuse only earlier, dependency-closed reconstruction receipts explicitly cited by a check. */
export function project(book: NotebookState): {
  notes: Note[];
  accepted: string[];
  reconstructed: Record<string, number>;
} {
  const reports = new Map<string, Verdict[]>();
  const passes = new Map<string, Map<number, Set<string>>>();
  const failures = new Set<string>();
  for (const check of book.checks)
    for (const verdict of check.values) {
      const history = reports.get(verdict.note) ?? [];
      history.push(verdict);
      reports.set(verdict.note, history);
      if (verdict.verdict === "FAIL" && verdict.verifier !== "requirements")
        failures.add(verdict.note);
      if (verdict.verdict !== "PASS") continue;
      const attempts =
        passes.get(verdict.note) ?? new Map<number, Set<string>>();
      const passed = attempts.get(check.candidate) ?? new Set<string>();
      passed.add(verdict.verifier);
      attempts.set(check.candidate, passed);
      passes.set(verdict.note, attempts);
    }
  const notes = new Map<string, Note>();
  for (const entry of [...book.notes].sort((a, b) => byId(a.id, b.id))) {
    const support = entry.support.map((id) => notes.get(id));
    const attempts = [...(passes.get(entry.id) ?? [])];
    const established =
      entry.verification !== undefined ||
      attempts.some(([, p]) => p.has("source") && p.has("correctness"));
    const dead = failures.has(entry.id) || support.some((note) => note?.dead);
    const verified =
      established && !dead && support.every((note) => note?.verified);
    const note = noteSchema.parse({
      ...entry,
      support: [...entry.support].sort(byId),
      verdicts: reports.get(entry.id) ?? [],
      dead,
      verified,
    });
    notes.set(note.id, note);
    for (const [, passed] of attempts) passed.delete("reconstruction");
  }
  const reconstructed: Record<string, number> = {};
  for (const check of book.checks) {
    const available = new Set(
      (check.reused ?? [])
        .filter(({ note, call }) => reconstructed[note] === call)
        .map(({ note }) => note),
    );
    for (const value of [...check.values].sort((a, b) =>
      byId(a.note, b.note),
    )) {
      const note = notes.get(value.note)!;
      if (
        value.verifier !== "reconstruction" ||
        value.verdict !== "PASS" ||
        !note.verified ||
        !note.support.every(
          (id) =>
            notes.get(id)?.verification !== undefined || available.has(id),
        )
      )
        continue;
      available.add(note.id);
      reconstructed[note.id] = check.call;
      passes.get(note.id)!.get(check.candidate)!.add("reconstruction");
    }
  }
  const accepted = [...notes.values()]
    .filter(
      (note) =>
        note.verified &&
        [...(passes.get(note.id)?.values() ?? [])].some((p) =>
          verifierNames.every((name) => p.has(name)),
        ),
    )
    .map((note) => note.id);
  return { notes: [...notes.values()], accepted, reconstructed };
}

export async function definition(
  tx: Tx,
  root: ConversationId,
): Promise<Definition> {
  const value = await tx.doc(DefinitionDoc, root);
  if (!value.task || !value.settings)
    throw new Error("Campaign is not initialized");
  return value as Definition;
}
