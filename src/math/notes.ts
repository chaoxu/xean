import { isDeepStrictEqual } from "node:util";
import { closure } from "./argument.ts";
import {
  decode,
  planSchema,
  solverResultSchema,
  verificationStages,
  verificationTargets,
  type Exploration,
  type Note,
  type NoteInfo,
  type Plan,
  type SolverResult,
  type SourceEvidence,
  type VerificationStage,
} from "./contracts.ts";

/** Shared correction policy for mathematical checks and source checks. */
export const correctionInstructions =
  "On PASS, you may supply correction for harmless typos, formatting, or unambiguous notation. Supply the complete replacement for each changed field, and null for each unchanged field; code retains unchanged bytes. Keep statement, argument, summary, and detailedSummary consistent. When this check otherwise warrants PASS and a mismatch is confined to the summaries, correct them to match the authoritative full statement and proof instead of failing only for that mismatch. Leave statement and argument null for summary-only corrections. Restore only hypotheses, conclusions, bounds, conditionality, and limitations already explicit in the statement and argument, and explain the correction in report. Preserve dependencies and external premises. Never add assumptions to the full statement, repair a proof gap, or use a summary correction to satisfy an unmet task criterion; substantive changes require a new note.";

const fatalStages = ["correctness", "reconstruction"] as const;
const stageRank = (stage: VerificationStage) =>
  verificationStages.indexOf(stage);

/** Verification runs an ordered prefix of stages through the requested one. */
export const stageWithin = (
  stage: VerificationStage,
  through: VerificationStage,
) => stageRank(stage) <= stageRank(through);

/** Targets reach their requested stage; dependencies need correctness and source. */
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

/** Caller trust establishes an import's correctness and sources. */
export function stagePassed(note: Note, stage: VerificationStage): boolean {
  const result = verdict(note, stage);
  return (
    result?.verdict === "PASS" ||
    (note.imported &&
      (stage === "correctness" || stage === "source") &&
      result?.verdict !== "FAIL")
  );
}

/** Source verdicts and FAIL outcomes are final per note ID. */
export function stagePending(note: Note, stage: VerificationStage): boolean {
  if (
    note.dead ||
    verdict(note, stage)?.verdict === "FAIL" ||
    stagePassed(note, stage)
  )
    return false;
  if (stage === "correctness") return true;
  if (stage === "source")
    return stagePassed(note, "correctness") && !verdict(note, "source");
  return note.verified;
}

/** Reuse quotations with their original immutable statement bindings. */
export function sourceEvidence(
  notes: readonly Note[],
  prior: readonly SourceEvidence[] = [],
): SourceEvidence[] {
  const evidence = new Map<string, SourceEvidence>();
  const add = ({ id, statement, url, quote }: SourceEvidence) => {
    const passage = { id, statement, url, quote };
    const previous = evidence.get(passage.id);
    if (previous && !isDeepStrictEqual(previous, passage))
      throw new Error(`Conflicting source evidence: ${passage.id}`);
    evidence.set(passage.id, passage);
  };
  prior.forEach(add);
  for (const note of notes) {
    const source = verdict(note, "source");
    if (
      !note.verified ||
      note.dead ||
      source?.verdict !== "PASS" ||
      !("passages" in source)
    )
      continue;
    source.passages.forEach(add);
  }
  return [...evidence.values()];
}

/** All status flags are derived from immutable evidence and declared support. */
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
      fatalStages.some((stage) => verdict(note, stage)?.verdict === "FAIL");
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
      const result = verdict(note, stage);
      return result && result.verdict !== "PASS"
        ? [`${stage}: ${result.report}`]
        : [];
    }),
  };
}

/** Final-task reconstruction requires verified targets meeting requirements. */
export const reconstructionTargets = (
  stages: ReadonlyMap<Note, VerificationStage>,
) =>
  [...stages].flatMap(([note, through]) =>
    through === "reconstruction" &&
    note.verified &&
    stagePassed(note, "requirements")
      ? [note.id]
      : [],
  );

/** Shared by planning and admission so completed checks are never repeated. */
export function verificationPending(
  targets: Parameters<typeof requiredStages>[0],
  notes: readonly Note[],
): boolean {
  const ordered = requiredStages(targets, notes);
  const reconstruction = reconstructionTargets(ordered);
  return (
    [...ordered].some(([note, through]) =>
      verificationStages.some(
        (stage) =>
          stageWithin(stage, through) &&
          stagePending(note, stage) &&
          (stage !== "reconstruction" || reconstruction.includes(note.id)),
      ),
    ) ||
    closure(reconstruction, notes).some(
      (note) => !note.imported && stagePending(note, "reconstruction"),
    )
  );
}

export function validatePlan(
  value: unknown,
  notes: readonly Note[],
  capabilities: Parameters<typeof planSchema>[0],
  allowEmptyPlan = true,
): Plan {
  const plan = decode(planSchema(capabilities), value);
  if (!allowEmptyPlan && plan.work.length === 0)
    throw new Error(
      "Return useful work while Explorer is available and no worker is active",
    );
  for (const request of plan.work)
    if (request.kind === "codex") closure(request.notes, notes);
  if (plan.work.filter(({ kind }) => kind === "literature").length > 1)
    throw new Error("Literature already dispatched");
  const targets = verificationTargets(plan);
  for (const { id } of targets) {
    const note = notes.find((note) => note.id === id);
    if (!note || note.dead) throw new Error(`Unknown or dead note: ${id}`);
  }
  if (targets.length && !verificationPending(targets, notes))
    throw new Error("Requested verification has no pending checks");
  return plan;
}

/** Validate on the publication commit line; a committed source verdict is final. */
export function validateResult(
  value: unknown,
  notes: readonly Note[],
  failed = false,
): SolverResult {
  const result = decode(solverResultSchema, value);
  if (failed && result.kind !== "verification")
    throw new Error(
      "Failed work can publish only completed verification checks",
    );
  if (result.kind === "notes")
    // Frozen support can become dead while a worker runs. Preserve its result;
    // refresh derives invalidation from the now-dead dependency.
    validateNotes(
      result.notes,
      notes.map(({ id }) => ({ id, dead: false })),
    );
  else {
    const checked = new Set<string>();
    for (const check of result.checks) {
      if (checked.has(check.noteId))
        throw new Error(`Duplicate check: ${check.noteId}`);
      checked.add(check.noteId);
      const note = notes.find((note) => note.id === check.noteId);
      if (!note)
        throw new Error(`Verification refers to unknown note: ${check.noteId}`);
      const correctness = verdict(note, "correctness");
      const source = verdict(note, "source");
      if (
        check.correctness?.verdict === "PASS" &&
        (correctness?.verdict === "PASS" || source) &&
        !isDeepStrictEqual(
          check.correctness.premises,
          correctness?.premises ?? [],
        )
      )
        throw new Error(`Correctness premises are final: ${check.noteId}`);
      if (check.source && source)
        throw new Error(`Source verdict already committed: ${check.noteId}`);
      if (check.source && "premises" in check.source) {
        const premises = (check.correctness ?? correctness)?.premises ?? [];
        if (!isDeepStrictEqual(premises, check.source.premises))
          throw new Error(
            `Source-checked premises do not match correctness for ${note.id}`,
          );
      }
    }
  }
  return result;
}
