import type { CampaignView, JsonValue } from "../types.ts";
import { json } from "../json.ts";
import type { SolverCommand } from "./commands.ts";
import { declarationVersion, verificationStages } from "./contracts.ts";
import type {
  Check,
  Exploration,
  Note,
  NoteInfo,
  SolverResult,
  SourceEvidence,
  Task,
  VerificationStage,
} from "./contracts.ts";

/** Shared correction policy for mathematical checks and source checks. */
export const correctionInstructions =
  "On PASS, you may supply correction with the complete text and consistent summary and detailedSummary for harmless typos, formatting, or unambiguous notation. When this check otherwise warrants PASS and a mismatch is confined to the summaries, correct them to match the authoritative full statement and proof instead of failing only for that mismatch. Copy text exactly. Restore only hypotheses, conclusions, bounds, conditionality, and limitations already explicit in that text, and explain the correction in report. Preserve dependencies and external premises. Never add assumptions to the full statement, repair a proof gap, or use a summary correction to satisfy an unmet task criterion; substantive changes require a new note.";

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
): Check[Stage] {
  let result: Check[Stage] = undefined;
  for (const check of note.checks) {
    const value = check[name];
    if (!value) continue;
    if (value.verdict === "FAIL") return value;
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
      evidence.set(id, { id, statement, url, quote });
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

/** Solver runners and library campaigns share notes; standalone roles do not. */
export function isSolverCampaign(view: Pick<CampaignView, "task">): boolean {
  const kind = (view.task as { kind?: string } | null)?.kind;
  return (
    kind === "xean.solve" ||
    kind === "xean.solve.offline" ||
    kind === "xean.solve.library"
  );
}

/** Project immutable worker results and accepted inputs without modifying either. */
export function project(view: CampaignView): Note[] {
  const declaration = view.task as { version?: number } | null;
  if (declaration?.version !== declarationVersion)
    throw new Error("Unsupported solver declaration; use its matching runtime");
  const notes = new Map<string, Note>();
  const append = (
    prefix: string,
    drafts: Exploration["notes"],
    candidate: boolean,
    imported = false,
  ) => {
    const local = new Set(drafts.map((note) => note.id));
    for (const [index, draft] of drafts.entries()) {
      const id = `${prefix}/${draft.id}`;
      if (notes.has(id)) throw new Error("Duplicate note IDs");
      notes.set(id, {
        ...draft,
        id,
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
      });
    }
  };
  // Dispatch order is not publication order. Replay worker commits and inputs
  // together so a late verifier cannot overwrite an intervening correction.
  const events = [
    ...view.work
      .filter((work) => work.status === "completed")
      .map((work) => {
        if (work.publicationId === null)
          throw new Error(`Missing publication ID: ${work.id}`);
        return { id: work.publicationId, work };
      }),
    ...view.inputs.map((input) => ({
      id: input.id,
      command: input.value as SolverCommand,
    })),
  ].sort((a, b) => a.id - b.id);
  for (const event of events) {
    if ("work" in event) {
      const work = event.work;
      const result = work.result as unknown as SolverResult;
      if (result.kind === "notes")
        append(work.id, result.notes, result.candidate);
      else if (result.kind === "verification") {
        for (const check of result.checks) {
          const note = notes.get(check.noteId);
          if (!note)
            throw new Error(
              `Verification refers to unknown note: ${check.noteId}`,
            );
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
      } else throw new Error(`Invalid solver result from ${work.id}`);
      continue;
    }
    const command = event.command;
    if (command.kind === "submit")
      append(`input/${command.id}`, command.notes, command.candidate, true);
    else if (command.kind === "correct") {
      const note = notes.get(command.note);
      if (!note || note.revision !== command.revision)
        throw new Error(
          `Invalid correction history: ${command.note}@${command.revision}`,
        );
      note.text = command.text;
      note.summary = command.summary;
      note.detailedSummary = command.detailedSummary;
      note.revision++;
    } else if (command.kind !== "guide")
      throw new Error("Invalid solver input");
  }
  return refresh([...notes.values()]);
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
