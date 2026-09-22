import type { Note } from "./roles";

/** Note ids in numeric order. */
export const byId = (left: string, right: string): number =>
  Number(left.slice(1)) - Number(right.slice(1));

/** The transitive support outside the roots, visiting shared ancestors once. */
export function supportClosure(
  notes: readonly Pick<Note, "id" | "support">[],
  known: readonly Pick<Note, "id" | "support">[],
): string[] {
  const byName = new Map(known.map((note) => [note.id, note]));
  if (byName.size !== known.length)
    throw new Error("duplicate note in support closure");
  const roots = new Set(notes.map(({ id }) => id));
  const pending = [...roots],
    seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    const note = byName.get(id);
    if (note === undefined) throw new Error(`missing support note ${id}`);
    seen.add(id);
    for (const parent of note.support) {
      if (byId(parent, id) >= 0)
        throw new Error(`support ${parent} must precede ${id}`);
      pending.push(parent);
    }
  }
  return [...seen].filter((id) => !roots.has(id)).sort(byId);
}
