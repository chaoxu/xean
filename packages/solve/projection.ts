import type { EntryId } from "elenx";

import { CozoDb } from "./cozo";
import { byId } from "./support";
import { note as noteSchema, type JournalVerdict, type Note } from "./roles";

// The journal is the only source of truth. The projection is an in-memory
// Cozo database of notes, summaries, support, and verdicts that the fold
// rebuilds on every derivation; notes, summaries, and verdicts carry the
// journal sequence that produced them, so a question about any point in the
// journal is a filter on that sequence.
const relations = [
  ":create note {id: String => seq: Int, text: String}",
  ":create summary {note: String => seq: Int, summary: String}",
  ":create support {note: String, support: String}",
  ":create external_verification {note: String => source: String, report: String}",
  ":create verdict {seq: Int, note: String => candidate: Int, verifier: String, verdict: String, report: String}",
];

// Verified, dead, and accepted are derived from recorded evidence and support.
// A note is dead when correctness, source, or
// reconstruction failed it or a note in its support is dead; verified after
// source and correctness pass or external verification is supplied, over
// verified support, and it is not dead; accepted after every verifier passes.
const derivedRules = `passed[candidate, note, verifier] := *verdict{seq, candidate, verifier, note, verdict: "PASS"}, seq <= $seq
dead[note] := *verdict{seq, verifier, note, verdict: "FAIL"}, seq <= $seq, verifier != "requirements"
dead[note] := *support{note, support}, dead[support]
established[note] := passed[candidate, note, "correctness"], passed[candidate, note, "source"]
established[note] := *external_verification{note}, *note{id: note, seq}, seq <= $seq
unverified[note] := *note{id: note, seq}, seq <= $seq, not established[note]
unverified[note] := *support{note, support}, unverified[support]
verified[note] := established[note], not unverified[note], not dead[note]
accepted[note] := passed[candidate, note, "correctness"], passed[candidate, note, "source"], passed[candidate, note, "requirements"], passed[candidate, note, "reconstruction"], verified[note]`;

export class Projection {
  private snapshot:
    | { seq: EntryId; value: Promise<{ notes: Note[]; accepted: string[] }> }
    | undefined;
  private constructor(private readonly db: InstanceType<typeof CozoDb>) {}

  static async open(verdicts: readonly JournalVerdict[]): Promise<Projection> {
    const projection = new Projection(new CozoDb("mem", ""));
    try {
      for (const relation of relations) await projection.db.run(relation);
      if (verdicts.length > 0) {
        await projection.db.run(
          "?[seq, note, candidate, verifier, verdict, report] <- $rows :put verdict {seq, note => candidate, verifier, verdict, report}",
          {
            rows: verdicts.map(({ seq, candidate, verdict }) => [
              seq,
              verdict.note,
              candidate,
              verdict.verifier,
              verdict.verdict,
              verdict.report,
            ]),
          },
        );
      }
      return projection;
    } catch (error) {
      projection.close();
      throw error;
    }
  }

  async add(
    entries: readonly {
      readonly id: string;
      readonly text: string;
      readonly support: readonly string[];
      readonly verification?: Note["verification"];
    }[],
    seq: EntryId,
  ): Promise<void> {
    this.snapshot = undefined;
    await this.db.run("?[id, seq, text] <- $rows :put note {id => seq, text}", {
      rows: entries.map(({ id, text }) => [id, seq, text]),
    });
    const edges = entries.flatMap(({ id, support }) =>
      support.map((supportId) => [id, supportId]),
    );
    if (edges.length > 0) {
      await this.db.run(
        "?[note, support] <- $rows :put support {note, support}",
        {
          rows: edges,
        },
      );
    }
    const external = entries.flatMap(({ id, verification }) =>
      verification === undefined
        ? []
        : [[id, verification.source, verification.report]],
    );
    if (external.length > 0) {
      await this.db.run(
        "?[note, source, report] <- $rows :put external_verification {note => source, report}",
        { rows: external },
      );
    }
  }

  async file(
    filings: readonly { readonly note: string; readonly summary: string }[],
    seq: EntryId,
  ): Promise<void> {
    if (filings.length === 0) return;
    this.snapshot = undefined;
    await this.db.run(
      "?[note, seq, summary] <- $rows :put summary {note => seq, summary}",
      { rows: filings.map(({ note, summary }) => [note, seq, summary]) },
    );
  }

  /** Every note that exists at `seq`, with the summary, verdicts, and flags derived by then, in id order. */
  async at(seq: EntryId): Promise<Note[]> {
    return (await this.read(seq)).notes;
  }

  private read(seq: EntryId) {
    if (this.snapshot?.seq !== seq)
      this.snapshot = { seq, value: this.readAt(seq) };
    return this.snapshot.value;
  }

  private async readAt(
    seq: EntryId,
  ): Promise<{ notes: Note[]; accepted: string[] }> {
    const [notes, summaries, support, verdicts, flags, external] =
      await Promise.all([
        this.db.run("?[id, text] := *note{id, seq, text}, seq <= $seq", {
          seq,
        }),
        this.db.run(
          "?[note, summary] := *summary{note, seq, summary}, seq <= $seq",
          { seq },
        ),
        this.db.run("?[note, support] := *support{note, support}"),
        this.db.run(
          "?[seq, verifier, note, verdict, report] := *verdict{seq, note, verifier, verdict, report}, seq <= $seq :order seq, note",
          { seq },
        ),
        this.db.run(
          `${derivedRules}
?[note, flag] := verified[note], flag = "verified"
?[note, flag] := dead[note], flag = "dead"
?[note, flag] := accepted[note], flag = "accepted"`,
          { seq },
        ),
        this.db.run(
          "?[note, source, report] := *external_verification{note, source, report}",
        ),
      ]);
    const flagged = (flag: string): Set<unknown> =>
      new Set(
        flags.rows.filter(([, value]) => value === flag).map(([note]) => note),
      );
    const verifiedNotes = flagged("verified");
    const deadNotes = flagged("dead");
    const summaryOf = new Map(
      summaries.rows.map(([note, summary]) => [note, summary]),
    );
    const verificationOf = new Map(
      external.rows.map(([id, source, report]) => [id, { source, report }]),
    );
    const supportOf = new Map<unknown, string[]>();
    for (const [note, parent] of support.rows) {
      const values = supportOf.get(note) ?? [];
      values.push(parent as string);
      supportOf.set(note, values);
    }
    const verdictsOf = new Map<unknown, unknown[][]>();
    for (const row of verdicts.rows) {
      const values = verdictsOf.get(row[2]) ?? [];
      values.push(row);
      verdictsOf.set(row[2], values);
    }
    const projected = notes.rows
      .map(([id, text]) =>
        noteSchema.parse({
          id,
          ...(summaryOf.has(id) ? { summary: summaryOf.get(id) } : {}),
          text,
          support: (supportOf.get(id) ?? []).sort(byId),
          verdicts: (verdictsOf.get(id) ?? []).map(
            ([, verifier, note, verdict, report]) => ({
              verifier,
              note,
              verdict,
              report,
            }),
          ),
          verified: verifiedNotes.has(id),
          dead: deadNotes.has(id),
          ...(verificationOf.has(id)
            ? { verification: verificationOf.get(id) }
            : {}),
        }),
      )
      .sort((left, right) => byId(left.id, right.id));
    return {
      notes: projected,
      accepted: [...flagged("accepted")].map((id) => id as string).sort(byId),
    };
  }

  /** The notes accepted at `seq`: every verifier passed them on one candidate, in id order. */
  async accepted(seq: EntryId): Promise<string[]> {
    return (await this.read(seq)).accepted;
  }

  close(): void {
    this.snapshot = undefined;
    this.db.close();
  }
}
