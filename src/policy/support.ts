// Policy derived from Xean v1.0.0 (949a385), with closure reconstruction.
import type {
  Note,
  ReconstructionInput,
  ReconstructionPremise,
} from "./contracts";

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

/** Reconstruct roots and unproved support; retain earlier certified statements as premises. */
export function reconstructionInput(
  input: ReconstructionInput,
  roots: readonly string[],
  reusable: Readonly<Record<string, string>> = {},
): ReconstructionInput {
  const needed = new Set(roots),
    notes: Note[] = [],
    support: Note[] = [],
    premises: ReconstructionPremise[] = [];
  const known = [...input.notes, ...input.support].sort((a, b) =>
    byId(a.id, b.id),
  );
  // A selected root cannot return as an assumption inside a reused descendant.
  const fresh = new Set(roots);
  for (const note of known)
    if (note.support.some((id) => fresh.has(id))) fresh.add(note.id);
  // Validated dependencies have earlier IDs, so visit consumers first.
  for (const note of known.reverse()) {
    if (!needed.has(note.id)) continue;
    if (note.dead) throw new Error(`dead reconstruction note ${note.id}`);
    if (!roots.includes(note.id) && note.verification !== undefined) {
      if (!note.verified)
        throw new Error(`unverified source premise ${note.id}`);
      support.push(note);
    } else {
      const statement = reusable[note.id];
      if (statement !== undefined && note.verified && !fresh.has(note.id))
        premises.push({ note: note.id, statement, support: note.support });
      else notes.push(note);
      for (const id of note.support) needed.add(id);
    }
  }
  return {
    task: input.task,
    notes: notes.reverse(),
    support: support.reverse(),
    ...(premises.length ? { premises: premises.reverse() } : {}),
  };
}
