import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { nonblank, submittedNotes } from "./policy/contracts.ts";
import { definition, project, readNotebook } from "./state.ts";
import type { ResearchData } from "./records.ts";

/** Queue caller notes with a stable identity before their publication. */
export function submitNotes(
  data: ResearchData,
  idValue: string,
  input: z.input<typeof submittedNotes>,
) {
  const id = nonblank.parse(idValue),
    { notes } = submittedNotes.parse(input);
  definition(data);
  const existing = data.notebook.inputs.find((value) => value.id === id);
  if (existing) {
    if (!isDeepStrictEqual(existing.notes, notes))
      throw new Error(`notes id already has a different submission: ${id}`);
    return { id, notes };
  }
  const live = new Set(
    project(readNotebook(data.notebook))
      .notes.filter((note) => !note.dead)
      .map((note) => note.id),
  );
  for (const note of notes)
    if (note.support.some((support) => !live.has(support)))
      throw new Error(
        "submitted support must name distinct existing notes that are not dead",
      );
  data.notebook.inputs.push({
    id,
    namespace: `i${data.nextNoteNamespace++}`,
    notes,
    consumed: false,
  });
  return { id, notes };
}

/** Queue advice once without changing a frozen Explorer request or terminal result. */
export function guide(data: ResearchData, idValue: string, textValue: string) {
  const id = nonblank.parse(idValue),
    text = nonblank.parse(textValue);
  definition(data);
  const existing = data.notebook.guidance.find((value) => value.id === id);
  if (existing) {
    if (existing.text !== text)
      throw new Error(`guidance id already has different text: ${id}`);
    return { id, text };
  }
  data.notebook.guidance.push({ id, text });
  return { id, text };
}
