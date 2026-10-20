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
  const byName = new Map(
    [...input.notes, ...input.support].map((note) => [note.id, note]),
  );
  const targets = new Set(roots),
    seen = new Set<string>(),
    pending = [...targets],
    notes: Note[] = [],
    support: Note[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    const note = byName.get(id)!;
    if (note.dead) throw new Error(`dead reconstruction note ${id}`);
    seen.add(id);
    if (!targets.has(id) && note.verification !== undefined) {
      if (!note.verified) throw new Error(`unverified source premise ${id}`);
      support.push(note);
      continue;
    }
    notes.push(note);
    pending.push(...note.support);
  }
  notes.sort((a, b) => byId(a.id, b.id));
  support.sort((a, b) => byId(a.id, b.id));
  return { task: input.task, notes, support };
}
