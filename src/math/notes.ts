import { isDeepStrictEqual } from "node:util";
import { closure, verdict } from "./argument.ts";
import {
  decode,
  planSchema,
  solverResultSchema,
  verificationStages,
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
  "On PASS, you may supply correction for harmless typos, formatting, or unambiguous notation. Supply the complete replacement for each changed field, and null for each unchanged field; code retains unchanged bytes. Keep text, summary, and detailedSummary consistent. When a mismatch is confined to the summaries, correct them to match the authoritative full text instead of failing only for that mismatch. Leave text null for summary-only corrections. Restore only hypotheses, conclusions, bounds, conditionality, and limitations already explicit in the text, and explain the correction in report. Preserve dependencies, the checked claim, and external premises. Never add assumptions, repair a proof gap, or use a summary correction to satisfy an unmet task criterion; substantive changes require a new note.";

const fatalStages = ["correctness", "reconstruction"] as const;
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

/** Caller trust establishes an import's correctness and sources. */
export function stagePassed(note: Note, stage: VerificationStage): boolean {
  if (!verdict(note, "correctness")?.statement) return false;
  const result = verdict(note, stage);
  return (
    result?.verdict === "PASS" ||
    (note.imported && stage === "source" && result?.verdict !== "FAIL")
  );
}

/** Source verdicts and FAIL outcomes are final per note ID. */
export function stagePending(note: Note, stage: VerificationStage): boolean {
  if (verdict(note, "correctness")?.statement === null) return false;
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

/** Shared selection retains the note objects updated by each completed stage. */
export function pendingChecks(
  targets: readonly string[],
  through: VerificationStage,
  notes: readonly Note[],
) {
  const ordered = closure(targets, notes);
  const requested = ordered.filter((note) => targets.includes(note.id));
  const support = new Set(ordered.flatMap((note) => note.support));
  return (stage: VerificationStage): Note[] => {
    let selected = ordered;
    if (stage === "source" && through === "correctness")
      selected = ordered.filter((note) => support.has(note.id));
    if (stage === "requirements")
      selected =
        through === "requirements" || through === "reconstruction"
          ? requested
          : [];
    if (stage === "reconstruction") {
      const roots =
        through === "reconstruction"
          ? requested.filter(
              (note) => note.verified && stagePassed(note, "requirements"),
            )
          : [];
      selected = closure(
        roots.map((note) => note.id),
        ordered,
      ).filter((note) => !note.imported || roots.includes(note));
    }
    return selected.filter((note) => stagePending(note, stage));
  };
}

export function validatePlan(
  value: unknown,
  notes: readonly Note[],
  capabilities: Parameters<typeof planSchema>[0],
  allowEmptyPlan = true,
): Plan {
  const plan = decode(planSchema(capabilities), value);
  if (!allowEmptyPlan && plan.work === null)
    throw new Error("Return useful work while Explorer is available");
  if (plan.work?.kind === "codex") closure(plan.work.notes, notes);
  if (plan.work?.kind === "verifier") {
    for (const id of plan.work.notes) {
      const note = notes.find((note) => note.id === id);
      if (!note || note.dead) throw new Error(`Unknown or dead note: ${id}`);
    }
    const pending = pendingChecks(plan.work.notes, plan.work.through, notes);
    if (!verificationStages.some((stage) => pending(stage).length))
      throw new Error("Requested verification has no pending checks");
  }
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
  if (result.kind === "notes") validateNotes(result.notes, notes);
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
        check.correctness &&
        (correctness?.statement === null ||
          (check.correctness.verdict === "PASS" &&
            correctness?.verdict === "PASS")) &&
        check.correctness.statement !== correctness.statement
      )
        throw new Error(`Correctness statement is final: ${check.noteId}`);
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
