// Policy derived from Xean v1.0.0 (949a385), with closure reconstruction.
import type { Note, ReconstructionInput } from "./contracts";

/** Note ids in numeric order. */
export const byId = (left: string, right: string): number =>
  Number(left.slice(1)) - Number(right.slice(1));

/** The transitive support outside the roots, visiting shared ancestors once. */
export async function supportClosure(
  notes: readonly Pick<Note, "id" | "support">[],
  known: readonly Pick<Note, "id" | "support">[],
): Promise<string[]> {
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

/** Expand validated input, stopping only at admitted source dependencies. */
export function reconstructionInput(
  input: ReconstructionInput,
  roots: readonly string[],
): ReconstructionInput {
  const needed = new Set(roots),
    notes: Note[] = [],
    support: Note[] = [];
  // Validated dependencies have earlier IDs, so visit consumers first.
  for (const note of [...input.notes, ...input.support].sort((a, b) =>
    byId(b.id, a.id),
  )) {
    if (!needed.has(note.id)) continue;
    if (note.dead) throw new Error(`dead reconstruction note ${note.id}`);
    if (!roots.includes(note.id) && note.verification !== undefined) {
      if (!note.verified)
        throw new Error(`unverified source premise ${note.id}`);
      support.push(note);
    } else {
      notes.push(note);
      for (const id of note.support) needed.add(id);
    }
  }
  return {
    task: input.task,
    notes: notes.reverse(),
    support: support.reverse(),
  };
}
