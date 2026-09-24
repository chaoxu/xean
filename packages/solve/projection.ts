import type { EntryId } from "xean";

import { byId } from "./support";
import {
  note as noteSchema,
  correctedText,
  noteEvidence,
  type JournalVerdict,
  type Note,
} from "./roles";

type StoredNote = Pick<Note, "id" | "text" | "support" | "verification">;
type Snapshot = { notes: Note[]; accepted: string[] };

/** Replayed journal facts. Support always precedes its note, so flags need one pass. */
export class Projection {
  private readonly notes = new Map<string, StoredNote & { seq: EntryId }>();
  private readonly summaries = new Map<
    string,
    { seq: EntryId; summary: string }[]
  >();
  private snapshot: { seq: EntryId; value: Snapshot } | undefined;

  constructor(private readonly verdicts: readonly JournalVerdict[]) {
    this.verdicts = verdicts.toSorted((a, b) => a.seq - b.seq);
  }

  /** A pending turn may be replayed without changing the last completed turn. */
  fork(verdicts = this.verdicts): Projection {
    const copy = new Projection(verdicts);
    for (const [id, note] of this.notes) copy.notes.set(id, note);
    for (const [id, history] of this.summaries) copy.summaries.set(id, history);
    return copy;
  }

  add(entries: readonly StoredNote[], seq: EntryId): void {
    for (const { id, text, support, verification } of entries)
      this.notes.set(id, {
        id,
        text,
        support,
        ...(verification === undefined ? {} : { verification }),
        seq,
      });
    this.snapshot = undefined;
  }

  file(
    filings: readonly { note: string; summary: string }[],
    seq: EntryId,
  ): void {
    for (const { note, summary } of filings) {
      const history = this.summaries.get(note) ?? [];
      this.summaries.set(note, [...history, { seq, summary }]);
    }
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
    const visible = this.verdicts.filter((entry) => entry.seq <= seq);
    const entries = [...this.notes.values()]
      .filter((entry) => entry.seq <= seq)
      .sort((a, b) => byId(a.id, b.id));
    const evidence = noteEvidence(
      entries,
      visible.map(({ verdict }) => verdict),
    );
    const corrections = new Map<string, EntryId>();
    for (const entry of visible)
      if (entry.verdict.correctedText !== undefined)
        corrections.set(entry.verdict.note, entry.seq);
    const notes: Note[] = [],
      accepted: string[] = [];
    for (const { seq: _created, ...entry } of entries) {
      const {
        verdicts,
        verified,
        dead,
        accepted: complete,
      } = evidence.get(entry.id)!;
      const summary = this.summaries
        .get(entry.id)
        ?.findLast((entry) => entry.seq <= seq);
      const note = noteSchema.parse({
        ...entry,
        text: correctedText(entry.text, verdicts),
        support: [...entry.support].sort(byId),
        ...(summary !== undefined &&
        summary.seq <= seq &&
        summary.seq > (corrections.get(entry.id) ?? 0)
          ? { summary: summary.summary }
          : {}),
        verdicts,
        verified,
        dead,
      });
      notes.push(note);
      if (complete) accepted.push(note.id);
    }
    const value = { notes, accepted };
    this.snapshot = { seq, value };
    return value;
  }
}
