import type { JsonValue } from "../types.ts";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { json } from "../json.ts";
import { verificationStages } from "./contracts.ts";
import type {
  Check,
  Editing,
  Exploration,
  Note,
  NoteInfo,
  SourceEvidence,
  Task,
  VerificationStage,
} from "./contracts.ts";

const fatalStages: readonly VerificationStage[] = verificationStages.filter(
  (stage) => stage !== "requirements",
);

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

const stageRank = (stage: VerificationStage) =>
  verificationStages.indexOf(stage);

/** Verification runs an ordered prefix of stages through the requested one. */
export const stageWithin = (
  stage: VerificationStage,
  through: VerificationStage,
) => stageRank(stage) <= stageRank(through);

/** Targets reach their requested stage; their dependencies need correctness and source. */
export function requiredStages<T extends Pick<Note, "id" | "support">>(
  targets: readonly { id: string; through: VerificationStage }[],
  notes: readonly T[],
): Map<T, VerificationStage> {
  const required = new Map<T, VerificationStage>();
  for (const target of targets)
    for (const note of closure([target.id], notes)) {
      const through = note.id === target.id ? target.through : "source";
      const prior = required.get(note);
      if (prior === undefined || stageRank(through) > stageRank(prior))
        required.set(note, through);
    }
  return required;
}

export function validateNotes(
  drafts: Exploration["notes"],
  known: readonly Pick<Note, "id" | "dead">[],
): void {
  const available = new Set(
    known.filter((note) => !note.dead).map((note) => note.id),
  );
  const local = new Set<string>();
  for (const note of drafts) {
    if (
      !note.text.trim() ||
      !note.summary.trim() ||
      !note.detailedSummary.trim()
    )
      throw new Error("Note text and summaries must not be blank");
    if (local.has(note.id)) throw new Error(`Duplicate new note: ${note.id}`);
    if (new Set(note.support).size !== note.support.length)
      throw new Error(`Duplicate support for note: ${note.id}`);
    for (const id of note.support)
      if (!available.has(id))
        throw new Error(`Unknown, dead, or forward support: ${id}`);
    local.add(note.id);
    available.add(note.id);
  }
}

/** A replacement must contain every premise it uses, including retained support. */
export function retainedNotes(
  result: Editing,
  available: readonly Note[],
): Note[] {
  const local = new Set(result.notes.map((note) => note.id));
  const retained = closure(
    [
      ...result.retained,
      ...result.notes.flatMap((note) =>
        note.support.filter((id) => !local.has(id)),
      ),
    ],
    available,
  );
  if (retained.some((note) => note.dead))
    throw new Error("Cannot retain dead notes");
  if (
    result.notes.some((draft) => retained.some((note) => note.id === draft.id))
  )
    throw new Error("New local IDs must not collide with retained notes");
  validateNotes(result.notes, retained);
  if (!retained.length && !result.notes.length)
    throw new Error("A replacement corpus must contain notes");
  return retained;
}

export function verdict<Stage extends VerificationStage>(
  note: Note,
  name: Stage,
): Check[Stage] {
  let result: Check[Stage] = undefined;
  for (const check of note.checks) {
    const value = check[name];
    if (!value) continue;
    if (value.verdict === "FAIL" && fatalStages.includes(name)) return value;
    if (value.verdict === "PASS" || result?.verdict !== "PASS") result = value;
  }
  return result;
}

/** Caller trust establishes an import's correctness and sources without model checks. */
export function stagePassed(note: Note, stage: VerificationStage): boolean {
  const result = verdict(note, stage);
  return (
    result?.verdict === "PASS" ||
    (note.imported &&
      (stage === "correctness" || stage === "source") &&
      result?.verdict !== "FAIL")
  );
}

/** A committed source verdict is final, including INCONCLUSIVE. */
export function stagePending(note: Note, stage: VerificationStage): boolean {
  if (note.dead || stagePassed(note, stage)) return false;
  if (stage === "correctness") return true;
  if (stage === "source")
    return stagePassed(note, "correctness") && !verdict(note, "source");
  return note.verified;
}

/** Reuse quotations from established live notes, retaining their original bindings. */
export function sourceEvidence(
  notes: readonly Note[],
  prior: readonly SourceEvidence[] = [],
): SourceEvidence[] {
  const evidence = new Map(prior.map((passage) => [passage.id, passage]));
  for (const note of notes) {
    const source = verdict(note, "source");
    if (
      !note.verified ||
      note.dead ||
      source?.verdict !== "PASS" ||
      !("passages" in source)
    )
      continue;
    for (const { id, statement, url, quote } of source.passages)
      if (id && statement) evidence.set(id, { id, statement, url, quote });
  }
  return [...evidence.values()];
}

export function refresh(notes: Note[]): Note[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  const reconstructed = new Set<string>();
  for (const note of closure(
    notes.map((note) => note.id),
    notes,
  )) {
    const support = note.support.map((id) => byId.get(id)!);
    note.dead =
      support.some((other) => other.dead) ||
      fatalStages.some((name) => verdict(note, name)?.verdict === "FAIL");
    note.verified =
      !note.dead &&
      support.every((other) => other.verified) &&
      stagePassed(note, "correctness") &&
      stagePassed(note, "source");
    const supportReconstructed = support.every((other) =>
      reconstructed.has(other.id),
    );
    if (
      note.verified &&
      supportReconstructed &&
      (note.imported || stagePassed(note, "reconstruction"))
    )
      reconstructed.add(note.id);
    note.accepted =
      note.verified &&
      supportReconstructed &&
      verdict(note, "requirements")?.verdict === "PASS" &&
      verdict(note, "reconstruction")?.verdict === "PASS";
  }
  return notes;
}

/** Apply committed judgments to their exact notes, preserving correction revisions. */
export function applyChecks(notes: Note[], checks: readonly Check[]): void {
  for (const check of checks) {
    const note = notes.find((note) => note.id === check.noteId);
    if (!note)
      throw new Error(`Verification refers to unknown note: ${check.noteId}`);
    if (check.correction && note.revision === check.correction.revision) {
      const { revision: _revision, ...content } = check.correction;
      Object.assign(note, content);
      note.revision++;
    }
    // Edit proposals stay in immutable worker evidence, not later inputs.
    const projected = json(check);
    delete projected.correction;
    for (const stage of verificationStages)
      if (projected[stage]) delete projected[stage]!.correction;
    note.checks.push(projected);
  }
  refresh(notes);
}

/** Assign durable identities without transferring checks to newly written mathematics. */
export function materializeNotes(
  prefix: string,
  drafts: Exploration["notes"],
  candidate = false,
  imported = false,
): Note[] {
  const local = new Set(drafts.map((note) => note.id));
  return drafts.map((draft, index) => ({
    ...draft,
    id: `${prefix}/${draft.id}`,
    revision: 0,
    imported,
    support: draft.support.map((id) =>
      local.has(id) ? `${prefix}/${id}` : id,
    ),
    checks: [],
    verified: false,
    dead: false,
    accepted: false,
    candidate: candidate && index === drafts.length - 1,
  }));
}

/** Size of the complete current note packet, not prompt usage or billing. */
export function corpusStats(notes: readonly Note[]) {
  return {
    noteCount: notes.length,
    estimatedTokens: notes.length
      ? estimateTextTokens(JSON.stringify(notes))
      : 0,
  };
}

export function noteInfo(note: Note): NoteInfo {
  return {
    id: note.id,
    summary: note.summary,
    support: note.support,
    imported: note.imported,
    verified: note.verified,
    dead: note.dead,
    candidate: note.candidate,
    passed: verificationStages.filter((stage) => stagePassed(note, stage)),
    feedback: verificationStages.flatMap((stage) => {
      const value = verdict(note, stage);
      return value && value.verdict !== "PASS"
        ? [`${stage}: ${value.report}`]
        : [];
    }),
  };
}

export function completion(
  task: Task,
  notes: readonly Note[],
): JsonValue | undefined {
  const acceptedNote = notes.find((note) => note.accepted);
  if (!acceptedNote) return undefined;
  const argument = closure([acceptedNote.id], notes);
  return {
    task,
    noteId: acceptedNote.id,
    argument: argument
      .map((note) => `## ${note.id}\n\n${note.text}`)
      .join("\n\n"),
    checks: argument.map((note) => ({
      noteId: note.id,
      imported: note.imported,
      checks: note.checks,
    })) as unknown as JsonValue,
  };
}
