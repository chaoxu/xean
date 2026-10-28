import { isDeepStrictEqual } from "node:util";
import { Notebook as NoteStore, ConflictError } from "@chaoxu/notebook-store";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import { nonblank, submittedNotes } from "./policy/contracts.ts";
import { definition, Notebook, project, readNotebook } from "./state.ts";

/** Queue caller notes; the workflow assigns IDs only at its next intake boundary. */
export async function submitNotes(
  tx: Tx,
  root: ConversationId,
  idValue: string,
  input: z.input<typeof submittedNotes>,
) {
  const id = nonblank.parse(idValue),
    { notes } = submittedNotes.parse(input);
  await definition(tx, root);
  const ref = await tx.doc(Notebook, root);
  const book = readNotebook(ref);
  const existing = book.inputs.find((value) => value.id === id);
  if (existing) {
    if (!isDeepStrictEqual(existing.notes, notes))
      throw new Error(`notes id already has a different submission: ${id}`);
    return { id, notes };
  }
  using store = new NoteStore(ref.path, { readonly: true });
  if (store.snapshot() !== ref.version)
    throw new ConflictError(
      "Notebook changed. Recover pending publication or resolve the external conflict before adding input",
    );
  const live = new Set(
    project(book)
      .notes.filter((note) => !note.dead)
      .map((note) => note.id),
  );
  for (const note of notes)
    if (note.support.some((support) => !live.has(support)))
      throw new Error(
        "submitted support must name distinct existing notes that are not dead",
      );
  book.inputs.push({ id, notes, consumed: false });
  return { id, notes };
}

/** Queue advice once without changing a frozen Explorer request or terminal result. */
export async function guide(
  tx: Tx,
  root: ConversationId,
  idValue: string,
  textValue: string,
) {
  const id = nonblank.parse(idValue),
    text = nonblank.parse(textValue);
  await definition(tx, root);
  const book = await tx.doc(Notebook, root);
  const existing = book.guidance.find((value) => value.id === id);
  if (existing) {
    if (existing.text !== text)
      throw new Error(`guidance id already has different text: ${id}`);
    return { id, text };
  }
  book.guidance.push({ id, text });
  return { id, text };
}
