import type { EntryId } from "xean";

import { byId } from "./support";
import {
  note as noteSchema,
  verifierNames,
  type JournalVerdict,
  type Note,
  type Verdict,
} from "./roles";

type StoredNote = Pick<Note, "id" | "text" | "support" | "verification">;
type Snapshot = { notes: Note[]; accepted: string[] };

/** Replayed journal facts. Support always precedes its note, so flags need one pass. */
export class Projection {
  private readonly notes = new Map<string, StoredNote & { seq: EntryId }>();
  private readonly summaries = new Map<
    string,
    { seq: EntryId; summary: string }
  >();
  private snapshot: { seq: EntryId; value: Snapshot } | undefined;

  constructor(private readonly verdicts: readonly JournalVerdict[]) {
    this.verdicts = verdicts.toSorted((a, b) => a.seq - b.seq);
  }

  add(entries: readonly StoredNote[], seq: EntryId): void {
    for (const entry of entries) this.notes.set(entry.id, { ...entry, seq });
    this.snapshot = undefined;
  }

  file(
    filings: readonly { note: string; summary: string }[],
    seq: EntryId,
  ): void {
    for (const { note, summary } of filings)
      this.summaries.set(note, { seq, summary });
    if (filings.length > 0) this.snapshot = undefined;
  }

  at(seq: EntryId): Note[] {
    return this.read(seq).notes;
  }

  accepted(seq: EntryId): string[] {
    return this.read(seq).accepted;
  }

  private read(seq: EntryId): Snapshot {
    if (this.snapshot?.seq === seq) return this.snapshot.value;
    const reports = new Map<string, Verdict[]>();
    const passes = new Map<string, Map<EntryId, Set<string>>>();
    const failures = new Set<string>();
    for (const entry of this.verdicts) {
      if (entry.seq > seq) break;
      const { note, verifier, verdict } = entry.verdict;
      const history = reports.get(note) ?? [];
      history.push(entry.verdict);
      reports.set(note, history);
      if (verdict === "FAIL" && verifier !== "requirements") failures.add(note);
      if (verdict !== "PASS") continue;
      const candidates = passes.get(note) ?? new Map<EntryId, Set<string>>();
      const passed = candidates.get(entry.candidate) ?? new Set<string>();
      passed.add(verifier);
      candidates.set(entry.candidate, passed);
      passes.set(note, candidates);
    }
    const projected = new Map<string, Note>();
    const accepted: string[] = [];
    for (const { seq: created, ...entry } of [...this.notes.values()].sort(
      (a, b) => byId(a.id, b.id),
    )) {
      if (created > seq) continue;
      const support = entry.support.map((id) => projected.get(id));
      const candidates = [...(passes.get(entry.id)?.values() ?? [])];
      const established =
        entry.verification !== undefined ||
        candidates.some(
          (passed) => passed.has("source") && passed.has("correctness"),
        );
      const dead = failures.has(entry.id) || support.some((note) => note?.dead);
      const verified =
        established && !dead && support.every((note) => note?.verified);
      const summary = this.summaries.get(entry.id);
      const note = noteSchema.parse({
        ...entry,
        support: [...entry.support].sort(byId),
        ...(summary !== undefined && summary.seq <= seq
          ? { summary: summary.summary }
          : {}),
        verdicts: reports.get(entry.id) ?? [],
        verified,
        dead,
      });
      projected.set(note.id, note);
      if (
        verified &&
        candidates.some((passed) =>
          verifierNames.every((name) => passed.has(name)),
        )
      )
        accepted.push(note.id);
    }
    const value = { notes: [...projected.values()], accepted };
    this.snapshot = { seq, value };
    return value;
  }
}
