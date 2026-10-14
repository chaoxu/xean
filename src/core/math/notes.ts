import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { closure, keepsPrior } from "./argument.ts";
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
  type VerificationBackend,
  type VerificationStage,
} from "./contracts.ts";

/** Shared correction policy for mathematical checks and source checks. */
export const correctionInstructions =
  "On PASS, you may correct only summary and detailedSummary to match the authoritative text. Return complete replacement summary fields or null when unchanged. Never edit proof text, hypotheses, claims, premises, or dependencies. Substantive changes require an Explorer edit.";

const fatalStages = ["correctness", "reconstruction"] as const;
type GraphNote = Pick<Note, "id" | "support"> &
  Partial<Pick<Note, "retired" | "dead">>;
function validateSupport(
  note: GraphNote,
  all: readonly GraphNote[],
  previous?: GraphNote,
) {
  if (new Set(note.support).size !== note.support.length)
    throw new Error(`Duplicate support for note: ${note.id}`);
  for (const id of note.support) {
    const support = all.find((other) => other.id === id);
    if (!support || (support.retired && !previous?.support.includes(id)))
      throw new Error(`Unknown or retired support: ${id}`);
  }
}
export function validateNotes(
  drafts: Exploration["notes"],
  known: readonly GraphNote[],
): void {
  const ids = new Set(known.map((note) => note.id));
  for (const note of drafts) {
    if (ids.has(note.id))
      throw new Error(
        `Duplicate new note: ${note.id}. Choose another name, or edit the existing note with its current revision.`,
      );
    ids.add(note.id);
  }
  const all = [...known, ...drafts];
  for (const note of drafts) validateSupport(note, all);
  closure(
    all.map((note) => note.id),
    all,
  );
}

/** Validate the final batch graph; repairs may remove an existing defective edge. */
export function validateExploration(
  value: Exploration,
  known: readonly Note[],
  prefix?: string,
): void {
  if (prefix) {
    const invalid = value.notes.filter(
      ({ id }) =>
        !id.startsWith(prefix) ||
        !/^[A-Za-z0-9_-]+$/.test(id.slice(prefix.length)),
    );
    if (invalid.length)
      throw new Error(
        `New note IDs must use prefix ${prefix} followed by a short name: ${invalid.map(({ id }) => id).join(", ")}. Use the full permanent ID in text and support.`,
      );
  }
  const edited = known.map((note) => ({ ...note }));
  const ids = new Set<string>();
  for (const edit of value.edits ?? []) {
    if (ids.has(edit.id)) throw new Error(`Duplicate edit: ${edit.id}`);
    ids.add(edit.id);
    const note = edited.find((other) => other.id === edit.id);
    if (!note) throw new Error(`Unknown edit target: ${edit.id}`);
    if (note.revision !== edit.revision)
      throw new Error(`Stale note revision: ${edit.id}`);
    if (edit.support !== undefined) note.support = edit.support;
    if (edit.retired !== undefined) note.retired = edit.retired;
  }
  validateNotes(value.notes, edited);
  const all = [...edited, ...value.notes];
  for (const edit of value.edits ?? []) {
    const note = edited.find((other) => other.id === edit.id)!;
    validateSupport(
      note,
      all,
      known.find((other) => other.id === note.id),
    );
  }
}

export function statementPrepared(note: Note): boolean {
  const check = note.checks.correctness;
  return check?.verdict === "PASS" && !!check.statement;
}

/** External grants and completed checks establish the same mathematical stages. */
export function stagePassed(note: Note, stage: VerificationStage): boolean {
  const result = note.checks[stage];
  if (result?.verdict === "FAIL") return false;
  if (note.checks.external && (stage === "correctness" || stage === "source"))
    return true;
  return statementPrepared(note) && result?.verdict === "PASS";
}

/** Codex can reassess uncertainty; native checks require changed inputs. */
export function stagePending(
  note: Note,
  stage: VerificationStage,
  backend: VerificationBackend = "native",
): boolean {
  if (note.dead || note.checks.correctness?.statement === null) return false;
  const result = note.checks[stage];
  if (stagePassed(note, stage) || result?.verdict === "FAIL") return false;
  if (result) {
    const reassess =
      stage === "source" ? note.sourceChanged : backend === "external";
    if (result.verdict !== "INCONCLUSIVE" || !reassess) return false;
  }
  if (stage === "correctness") return true;
  if (stage === "source") return stagePassed(note, "correctness");
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
    const source = note.checks.source;
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

/** Receipt IDs are not new evidence. Only exact relevant quotations reopen a source check. */
export function sourceInputKeys(
  note: Note,
  evidence: readonly SourceEvidence[],
): string[] {
  const premises = note.checks.correctness?.premises ?? [];
  const keys = new Set<string>();
  for (const { statement, url, quote } of evidence)
    if (premises.includes(statement))
      keys.add(
        createHash("sha256")
          .update(JSON.stringify([statement, url, quote]))
          .digest("hex"),
      );
  return [...keys].sort();
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
      fatalStages.some((stage) => note.checks[stage]?.verdict === "FAIL");
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
      stagePassed(note, "reconstruction")
    )
      reconstructed.add(note.id);
    note.accepted =
      !note.retired &&
      reconstructed.has(note.id) &&
      note.checks.requirements?.verdict === "PASS";
  }
  return notes;
}

export function noteInfo(note: Note): NoteInfo {
  return {
    id: note.id,
    summary: note.summary,
    support: note.support,
    external: note.checks.external,
    verified: note.verified,
    dead: note.dead,
    candidate: note.candidate,
    revision: note.revision,
    retired: note.retired,
    passed: verificationStages.filter((stage) => stagePassed(note, stage)),
    feedback: verificationStages.flatMap((stage) => {
      const result = note.checks[stage];
      return result && result.verdict !== "PASS"
        ? [`${stage} ${result.verdict}: ${result.report}`]
        : [];
    }),
  };
}

/** Shared selection retains the note objects updated by each completed stage. */
export function pendingChecks(
  targets: readonly string[],
  through: VerificationStage,
  notes: readonly Note[],
  backend: VerificationBackend = "native",
) {
  const ordered = closure(targets, notes);
  const requested = ordered.filter((note) => targets.includes(note.id));
  const support = new Set(ordered.flatMap((note) => note.support));
  return (stage: VerificationStage): Note[] => {
    const needsCheck = (note: Note) => {
      if (stage === "reconstruction" && !statementPrepared(note)) return false;
      // Statement preparation follows the same retry rules as other checks.
      return stagePending(
        stage === "correctness" &&
          through === "reconstruction" &&
          note.checks.external
          ? { ...note, checks: { ...note.checks, external: undefined } }
          : note,
        stage,
        backend,
      );
    };
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
      );
    }
    const eligible = new Map<string, boolean>();
    if (stage === "correctness" || stage === "reconstruction")
      for (const note of ordered)
        eligible.set(
          note.id,
          note.support.every((id) => eligible.get(id)) &&
            (stagePassed(note, stage) || needsCheck(note)),
        );

    return selected.filter(
      (note) => needsCheck(note) && eligible.get(note.id) !== false,
    );
  };
}

export function validatePlan(
  value: unknown,
  notes: readonly Note[],
  capabilities: Parameters<typeof planSchema>[0],
): Plan {
  const plan = decode(planSchema(capabilities), value);
  if (plan.work?.kind === "implementation") closure(plan.work.notes, notes);
  if (plan.work?.kind === "verifier") {
    for (const id of plan.work.notes) {
      const note = notes.find((note) => note.id === id);
      if (!note || note.dead) throw new Error(`Unknown or dead note: ${id}`);
      if (note.retired) throw new Error(`Retired note: ${id}`);
    }
    const pending = pendingChecks(
      plan.work.notes,
      plan.work.through,
      notes,
      plan.work.backend,
    );
    if (!verificationStages.some((stage) => pending(stage).length))
      throw new Error("Requested verification has no pending checks");
  }
  return plan;
}

/** Validate structured evidence against its exact supplied claim and premises. */
export function validateResult(
  value: unknown,
  notes: readonly Note[],
  failed = false,
  prefix?: string,
): SolverResult {
  const result = decode(solverResultSchema, value);
  if (failed && result.kind !== "verification")
    throw new Error(
      "Failed work can publish only completed verification checks",
    );
  if (result.kind === "notes") validateExploration(result, notes, prefix);
  else {
    const checked = new Set<string>();
    for (const check of result.checks) {
      if (checked.has(check.noteId))
        throw new Error(`Duplicate check: ${check.noteId}`);
      checked.add(check.noteId);
      const note = notes.find((note) => note.id === check.noteId);
      if (!note)
        throw new Error(`Verification refers to unknown note: ${check.noteId}`);
      const correctness = note.checks.correctness;
      const source = note.checks.source;
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
      if (check.source && "premises" in check.source) {
        const premises =
          (keepsPrior(correctness, check.correctness)
            ? correctness
            : check.correctness
          )?.premises ?? [];
        if (!isDeepStrictEqual(premises, check.source.premises))
          throw new Error(
            `Source-checked premises do not match correctness for ${note.id}`,
          );
      }
    }
  }
  return result;
}
