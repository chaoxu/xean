// Support-order helpers for conditional local verification.
import type { Note, ReconstructionInput } from "./contracts";

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

/** Immediate declared dependencies of selected roots, without transitive traversal. */
export function directSupport(
  roots: readonly Pick<Note, "support">[],
  known: readonly Note[],
): Note[] {
  const selected = new Set(roots.flatMap(({ support }) => support));
  return known.filter(({ id }) => selected.has(id));
}

/** Keep selected roots and their direct declared assumptions for one local check. */
export function reconstructionInput(
  input: ReconstructionInput,
  roots: readonly string[],
): ReconstructionInput {
  const selected = new Set(roots);
  const known = [...input.notes, ...input.support];
  const assumptions = directSupport(
    input.notes.filter(({ id }) => selected.has(id)),
    known,
  ).filter(({ id }) => !selected.has(id));
  return {
    task: input.task,
    notes: input.notes.filter(({ id }) => selected.has(id)),
    support: assumptions,
  };
}
