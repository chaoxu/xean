import {
  defineDoc,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import type { Task, Note, Verdict } from "./policy/contracts.ts";
import {
  establishes,
  invalidatesNote,
  note as noteSchema,
  noteIdAfter,
  verifierNames,
} from "./policy/contracts.ts";
import type { SolveSettings } from "./policy/settings.ts";
import { noteOrder } from "./policy/support.ts";

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
export type StoredNote = Omit<
  Note,
  "verdicts" | "checked" | "verified" | "dead"
>;
export type Check = { candidate: number; call: number; values: Verdict[] };
export type NotebookState = {
  notes: StoredNote[];
  checks: Check[];
  guidance: { id: string; text: string }[];
  inputs: {
    id: string;
    namespace: string;
    notes: Omit<StoredNote, "id">[];
    consumed: boolean;
  }[];
};

/** Intake publishes each queued submission under its original native identity. */
export async function admitNotes(
  tx: Tx,
  root: ConversationId,
): Promise<boolean> {
  const ref = await tx.doc(Notebook, root);
  const pending = ref.inputs.filter((input) => !input.consumed);
  for (const input of pending) {
    appendNotes(
      tx,
      ref,
      input.notes.map((note, index) => ({
        ...note,
        id: noteIdAfter(input.namespace, index),
      })),
      `input/${input.namespace}`,
    );
    input.consumed = true;
  }
  return pending.length > 0;
}
export type Publication = { id: string; version: number; notes: string[] };
export type NotebookReference = Omit<NotebookState, "notes"> & {
  path: string;
  publications: Publication[];
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
    publications: [],
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
  return {
    checks: ref.checks,
    guidance: ref.guidance,
    inputs: ref.inputs,
    notes: [...ref.publications]
      .sort((a, b) => a.version - b.version)
      .flatMap((publication) => {
        const records = store.read(
          publication.version,
          publication.notes,
        ).notes;
        return publication.notes.map((id) => {
          const note = records[id];
          if (!note) throw new Error(`Missing pinned note: ${id}`);
          return note as StoredNote;
        });
      }),
  };
}

/** Store receipts survive Pi rollback; every admitted batch keeps its exact snapshot. */
export function appendNotes(
  tx: Tx,
  ref: NotebookReference,
  notes: StoredNote[],
  requestId: string,
) {
  if (readOnly.has(tx)) throw new Error("Cannot change a read-only notebook");
  if (!ref.path) throw new Error("External notebook is not initialized");
  const ids = notes.map((note) => note.id);
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error("A publication requires distinct notes");
  const prior = ref.publications.find(
    (publication) => publication.id === requestId,
  );
  if (
    prior &&
    (prior.notes.length !== ids.length ||
      prior.notes.some((id, index) => id !== ids[index]))
  )
    throw new Error("Publication admission has different note order");
  using store = new NoteStore(ref.path);
  const version = store.append(
    requestId,
    Object.fromEntries(notes.map((note) => [note.id, note])),
  );
  if (prior) {
    if (prior.version !== version)
      throw new Error("Publication receipt mismatch");
  } else ref.publications.push({ id: requestId, version, notes: ids });
  return version;
}

/** Local proof checks establish a note once its immutable dependencies verify. */
export function project(book: NotebookState): {
  notes: Note[];
  accepted: string[];
} {
  const reports: Record<string, Verdict[]> = Object.create(null);
  const passes: Record<string, Record<number, Set<string>>> = Object.create(
    null,
  );
  for (const check of book.checks)
    for (const verdict of check.values) {
      (reports[verdict.note] ??= []).push(verdict);
      if (verdict.verdict !== "PASS") continue;
      const attempts = (passes[verdict.note] ??= {});
      const passed = (attempts[check.candidate] ??= new Set());
      passed.add(verdict.verifier);
    }
  const notes = new Map<string, Note>(),
    accepted: string[] = [];
  const order = noteOrder(book.notes);
  for (const entry of book.notes) {
    for (const parent of entry.support)
      if (order(parent, entry.id) >= 0)
        throw new Error(`support ${parent} must precede ${entry.id}`);
    const support = entry.support.map((id) => notes.get(id));
    const attempts = Object.values(passes[entry.id] ?? {});
    const failed = reports[entry.id]?.some(invalidatesNote) ?? false;
    const checked =
      !failed &&
      (entry.verification !== undefined ||
        attempts.some((p) => establishes((name) => p.has(name))));
    const dead = failed || support.some((note) => note?.dead);
    const verified =
      checked && !dead && support.every((note) => note?.verified);
    const note = noteSchema.parse({
      ...entry,
      support: [...entry.support].sort(order),
      verdicts: reports[entry.id] ?? [],
      checked,
      dead,
      verified,
    });
    notes.set(note.id, note);
    if (
      verified &&
      attempts.some((p) => verifierNames.every((name) => p.has(name)))
    )
      accepted.push(note.id);
  }
  return { notes: [...notes.values()], accepted };
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
