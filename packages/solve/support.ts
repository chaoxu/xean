import { CozoDb } from "./cozo";
import type { Note } from "./roles";

/** Note ids in numeric order. */
export const byId = (left: string, right: string): number =>
  Number(left.slice(1)) - Number(right.slice(1));

type SupportedNote = Pick<Note, "id" | "support">;

/** One immutable support graph, owned and closed by a derivation or verifier. */
export class SupportGraph {
  private readonly byName: Map<string, SupportedNote>;
  private readonly edges: string[][];
  private readonly reachable = new Map<string, readonly string[]>();
  private db: InstanceType<typeof CozoDb> | undefined;
  private closed = false;

  constructor(known: readonly SupportedNote[]) {
    this.byName = new Map(
      known.map(({ id, support }) => [id, { id, support: [...support] }]),
    );
    if (this.byName.size !== known.length)
      throw new Error("duplicate note in support closure");
    this.edges = known.flatMap(({ id, support }) =>
      support.map((parent) => [id, parent]),
    );
  }

  /** Batch query roots without validating notes that the caller may not use. */
  async prepare(roots: readonly string[]): Promise<void> {
    if (this.closed) throw new Error("support graph is closed");
    const missing = [...new Set(roots)].filter((id) => !this.reachable.has(id));
    if (missing.length === 0) return;
    this.db ??= new CozoDb("mem", "");
    const result = await this.db.run(
      `edge[note, support] <- $edges
root[note] <- $roots
reachable[root, root] := root[root]
reachable[root, support] := reachable[root, note], edge[note, support]
?[root, note] := reachable[root, note]`,
      {
        roots: missing.map((id) => [id]),
        edges: this.edges,
      },
    );
    const found = new Map(missing.map((id) => [id, [] as string[]]));
    for (const [root, id] of result.rows)
      found.get(root as string)!.push(id as string);
    for (const [root, ids] of found) this.reachable.set(root, ids);
  }

  /** Transitive support outside the supplied roots, in numeric ID order. */
  async closure(notes: readonly SupportedNote[]): Promise<string[]> {
    const own = new Set(notes.map(({ id }) => id));
    await this.prepare([...own]);
    const reachable = new Set(
      [...own].flatMap((id) => this.reachable.get(id)!),
    );
    for (const id of reachable) {
      const note = this.byName.get(id);
      if (note === undefined) throw new Error(`missing support note ${id}`);
      for (const parent of note.support) {
        if (byId(parent, id) >= 0)
          throw new Error(`support ${parent} must precede ${id}`);
      }
    }
    return [...reachable].filter((id) => !own.has(id)).sort(byId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reachable.clear();
    this.byName.clear();
    this.edges.length = 0;
    this.db?.close();
    this.db = undefined;
  }
}

/** The transitive support of `notes` outside them, once each in id order. */
export async function supportClosure(
  notes: readonly SupportedNote[],
  known: readonly SupportedNote[],
): Promise<string[]> {
  const graph = new SupportGraph(known);
  try {
    return await graph.closure(notes);
  } finally {
    graph.close();
  }
}
