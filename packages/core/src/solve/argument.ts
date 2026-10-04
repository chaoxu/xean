import type { Note } from "./contracts.ts";

/** Support is a mathematical dependency, not a record of everything read. */
export function closure<T extends Pick<Note, "id" | "support">>(
  ids: readonly string[],
  notes: readonly T[],
): T[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  if (byId.size !== notes.length) throw new Error("Duplicate note IDs");
  const visiting = new Set<string>();
  const found = new Map<string, T>();
  const visit = (id: string): void => {
    if (found.has(id)) return;
    const note = byId.get(id);
    if (!note) throw new Error(`Unknown note: ${id}`);
    if (visiting.has(id)) throw new Error(`Cyclic support: ${id}`);
    visiting.add(id);
    for (const support of note.support) visit(support);
    visiting.delete(id);
    found.set(id, note);
  };
  ids.forEach(visit);
  return [...found.values()];
}

export function acceptedArgument(
  notes: readonly Note[],
  noteId: string,
): string {
  if (!notes.find((note) => note.id === noteId)?.accepted)
    throw new Error("No accepted argument");
  return closure([noteId], notes)
    .map((note) => `## ${note.id}\n\n${note.text}`)
    .join("\n\n");
}
