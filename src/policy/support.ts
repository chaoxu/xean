// Policy derived from Xean v1.0.0 (949a385), with closure reconstruction.
import type {
  Note,
  ReconstructionInput,
  ReconstructionPremise,
} from "./contracts";

/** Compare opaque note IDs by their authoritative notebook order. */
export function noteOrder(known: readonly Pick<Note, "id">[]) {
  const positions = new Map(known.map(({ id }, index) => [id, index]));
  if (positions.size !== known.length)
    throw new Error("duplicate note in notebook order");
  return (left: string, right: string): number => {
    const a = positions.get(left),
      b = positions.get(right);
    if (a === undefined || b === undefined)
      throw new Error("unknown note in notebook order");
    return a - b;
  };
}

/** The transitive support outside the roots, visiting shared ancestors once. */
export function supportClosure(
  notes: readonly Pick<Note, "id" | "support">[],
  known: readonly Pick<Note, "id" | "support">[],
): string[] {
  const byName = new Map(known.map((note) => [note.id, note]));
  if (byName.size !== known.length)
    throw new Error("duplicate note in support closure");
  const order = noteOrder(known);
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
      if (!byName.has(parent))
        throw new Error(`missing support note ${parent}`);
      if (order(parent, id) >= 0)
        throw new Error(`support ${parent} must precede ${id}`);
      pending.push(parent);
    }
  }
  return [...seen].filter((id) => !roots.has(id)).sort(order);
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
  const order = noteOrder(input.order.map((id) => ({ id })));
  const known = [...input.notes, ...input.support].sort((a, b) =>
    order(a.id, b.id),
  );
  // A selected root cannot return as an assumption inside a reused descendant.
  const fresh = new Set(roots);
  for (const note of known)
    if (note.support.some((id) => fresh.has(id))) fresh.add(note.id);
  // Validated dependencies occur earlier in notebook order; visit consumers first.
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
    order: [...input.order],
    notes: notes.reverse(),
    support: support.reverse(),
    ...(premises.length ? { premises: premises.reverse() } : {}),
  };
}
