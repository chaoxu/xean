import {
  defineDoc,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import { isDeepStrictEqual } from "node:util";
import type { Task, Note, Verdict } from "./policy/contracts.ts";
import { note as noteSchema, verifierNames } from "./policy/contracts.ts";
import type { SolveSettings } from "./policy/settings.ts";
import { byId } from "./policy/support.ts";

export type Definition = { task: Task; settings: SolveSettings };
export const DefinitionDoc = defineDoc({
  kind: "xean.v4.definition",
  version: 1,
  checkpointWhen: () => false,
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
export type Check = { candidate: number; call: number; values: Verdict[] };
export type NotebookState = {
  notes: StoredNote[];
  checks: Check[];
  guidance: { id: string; text: string }[];
  inputs: { id: string; notes: Omit<StoredNote, "id">[]; consumed: boolean }[];
};
type NotebookReference = Omit<NotebookState, "notes"> & {
  path: string;
  version: number;
  notes: string[];
};
export const Notebook = defineDoc({
  kind: "xean.notebook-reference",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): NotebookReference => ({
    path: "",
    version: 0,
    notes: [],
    checks: [],
    guidance: [],
    inputs: [],
  }),
});
const readOnly = new WeakSet<Tx>();
export const readonlyNotebook = (tx: Tx) => readOnly.add(tx);

export async function initializeNotebook(
  tx: Tx,
  root: ConversationId,
  path: string,
) {
  if (readOnly.has(tx))
    throw new Error("Cannot initialize a read-only notebook");
  const ref = await tx.doc(Notebook, root);
  using store = new NoteStore(path);
  if (store.snapshot() !== 0)
    throw new Error("New campaigns require an empty notebook");
  ref.path = path;
}

export function readNotebook(ref: NotebookReference) {
  if (!ref.path) throw new Error("External notebook is not initialized");
  using store = new NoteStore(ref.path, { readonly: true });
  const records = store.read(ref.version, ref.notes).notes;
  return {
    ...ref,
    notes: ref.notes.map((id) => {
      const note = records[id];
      if (!note) throw new Error(`Missing pinned note: ${id}`);
      return note as StoredNote;
    }),
  };
}

/** Store receipts survive Pi rollback; replay uses the same pinned base and changes. */
export function saveNotebook(
  tx: Tx,
  ref: NotebookReference,
  book: ReturnType<typeof readNotebook>,
) {
  if (readOnly.has(tx)) throw new Error("Cannot change a read-only notebook");
  if (ref.version !== book.version) throw new Error("Stale notebook snapshot");
  const before = readNotebook(ref).notes;
  const changes = Object.fromEntries(
    book.notes
      .filter((note, index) => !isDeepStrictEqual(before[index], note))
      .map((note) => [note.id, note]),
  );
  if (Object.keys(changes).length) {
    using store = new NoteStore(ref.path);
    ref.version = store.commit(ref.version, changes, `xean/${ref.version}`);
  }
  ref.notes = book.notes.map((note) => note.id);
}

/** Reconstruction can use earlier successful proofs of immutable dependencies. */
export function project(book: NotebookState): {
  notes: Note[];
  accepted: string[];
  reconstructed: Record<string, number>;
} {
  const reports: Record<string, Verdict[]> = {};
  const passes: Record<string, Record<number, Map<string, number>>> = {};
  for (const [index, check] of book.checks.entries())
    for (const verdict of check.values) {
      (reports[verdict.note] ??= []).push(verdict);
      if (verdict.verdict !== "PASS") continue;
      const attempts = (passes[verdict.note] ??= {});
      const passed = (attempts[check.candidate] ??= new Map());
      passed.set(verdict.verifier, index);
    }
  const notes = new Map<string, Note>(),
    accepted: string[] = [];
  const first = new Map<string, number>();
  const reconstructed: Record<string, number> = {};
  for (const entry of [...book.notes].sort((a, b) => byId(a.id, b.id))) {
    const support = entry.support.map((id) => notes.get(id));
    const attempts = Object.values(passes[entry.id] ?? {});
    const established =
      entry.verification !== undefined ||
      attempts.some((p) => p.has("source") && p.has("correctness"));
    const dead =
      reports[entry.id]?.some(
        ({ verdict, verifier }) =>
          verdict === "FAIL" && verifier !== "requirements",
      ) || support.some((note) => note?.dead);
    const verified =
      established && !dead && support.every((note) => note?.verified);
    const note = noteSchema.parse({
      ...entry,
      support: [...entry.support].sort(byId),
      verdicts: reports[entry.id] ?? [],
      dead,
      verified,
    });
    notes.set(note.id, note);
    // Each candidate records one joint reconstruction batch. Parents must pass
    // before that batch or within it; later evidence cannot repair its verdict.
    for (const passed of attempts)
      if (
        !verified ||
        !support.every(
          (parent) =>
            parent &&
            (parent.verification !== undefined ||
              (first.get(parent.id) ?? Infinity) <=
                passed.get("reconstruction")!),
        )
      )
        passed.delete("reconstruction");
    const receipts = attempts.flatMap((p) =>
      p.has("reconstruction") ? [p.get("reconstruction")!] : [],
    );
    if (receipts.length) {
      first.set(note.id, Math.min(...receipts));
      reconstructed[note.id] = book.checks[Math.max(...receipts)]!.call;
    }
    if (
      verified &&
      attempts.some((p) => verifierNames.every((name) => p.has(name)))
    )
      accepted.push(note.id);
  }
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
