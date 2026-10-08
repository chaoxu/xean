import type { Note, VerificationStage } from "./contracts.ts";

export function verdict<Stage extends VerificationStage>(
  note: Note,
  name: Stage,
): Note["checks"][number][Stage] {
  let result: Note["checks"][number][Stage] = undefined;
  for (const check of note.checks) {
    const value = check[name];
    if (!value) continue;
    if (value.verdict === "FAIL") return value;
    if (value.verdict === "PASS" || result?.verdict !== "PASS") result = value;
  }
  return result;
}

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
    .map(
      (note) =>
        `## ${note.id}\n\n${note.text}` +
        (note.imported && note.id === noteId
          ? `\n\n### Independent proof\n\n${verdict(note, "reconstruction")!.proof}`
          : ""),
    )
    .join("\n\n");
}
