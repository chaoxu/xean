import type { Campaign, Entry, EntryId, Json } from "xean";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { Projection } from "./projection";
import { turnAllowances } from "./allowance";
import { explorerGuidance, freezeExplorerGuidance } from "./guidance";
import {
  freezeSubmittedNotes,
  hasSubmittedNotes,
  submittedNotesBoundary,
} from "./notes";
import { byId, supportClosure } from "./support";
import {
  coordinatorCall,
  explorerCall,
  literatureCall,
  literatureNotesId,
  literatureOutcome,
  RoleCallError,
  sameRequest,
  solveSettings,
  verifierCall,
  type RoleCall,
} from "./pi-roles";
import {
  applicationId,
  coordinatorInput,
  explorerInput,
  journalVerdicts,
  jsonSnapshot,
  judgedBy,
  noteIdAfter,
  pick,
  succeededSubmission,
  savedExplorerSubmission,
  task,
  verificationComplete,
  verifierInput,
  verifierLabels,
  roleLabels,
  literatureInput,
  workflowRecords,
  type CoordinatorInput,
  type CoordinatorResult,
  type ExplorerInput,
  type LiteratureInput,
  type LiteratureStatus,
  type Note,
  type RoleName,
  type Roles,
  type Task,
  type Verification,
  type VerifierInput,
} from "./roles";

export const workflowSchemaVersion = 24;
export const workflowConfig = z.strictObject({
  kind: z.literal("workflow"),
  schemaVersion: z.literal(workflowSchemaVersion),
  task,
  settings: solveSettings,
});
export type WorkflowConfig = z.output<typeof workflowConfig>;

type AcceptedPhase = {
  readonly kind: "accepted";
  readonly turns: number;
  readonly note: Note;
  readonly notes: readonly Note[];
  readonly candidate: EntryId;
  /** The accepted note's transitive support, in id order. */
  readonly closure: readonly string[];
};
type TurnLimitPhase = {
  readonly kind: "turn-limit";
  readonly turns: number;
  readonly notes: readonly Note[];
};

export type WorkflowTerminal = AcceptedPhase | TurnLimitPhase;
export type WorkflowPhase =
  | { readonly kind: "explorer"; readonly input: ExplorerInput }
  | { readonly kind: "coordinator"; readonly input: CoordinatorInput }
  | {
      readonly kind: "literature";
      readonly input: LiteratureInput;
      /** The dispatching coordinator's settled entry; earlier calls are not reused. */
      readonly after: EntryId;
    }
  | {
      readonly kind: "verifier";
      readonly input: VerifierInput;
      readonly candidate?: EntryId;
    }
  | WorkflowTerminal;

export type WorkflowResult =
  | (Omit<AcceptedPhase, "kind" | "closure"> & { readonly outcome: "accepted" })
  | (Omit<TurnLimitPhase, "kind"> & { readonly outcome: "turn-limit" });

export interface WorkflowSnapshot {
  readonly config: WorkflowConfig;
  readonly allowances: ReturnType<typeof turnAllowances>;
  readonly maxTurns: number;
  readonly notes: readonly Note[];
  readonly phase: WorkflowPhase;
  /** Journal boundary before the next explorer turn, used only by the driver. */
  readonly explorerAfter?: EntryId;
  /** An unfrozen boundary where submitted notes may enter the coordinator. */
  readonly notesAfter?: EntryId;
  readonly noteSubmissions: readonly {
    readonly call: EntryId;
    readonly noteIds: readonly string[];
  }[];
}

function parseConfig(declaration: Entry | undefined): WorkflowConfig {
  if (
    declaration?.kind !== "campaign" ||
    declaration.application !== applicationId
  ) {
    throw new Error("not a Xean workflow campaign");
  }
  const parsed = workflowConfig.safeParse(declaration.config);
  if (!parsed.success) {
    throw new Error(`invalid workflow campaign: ${parsed.error.message}`);
  }
  return parsed.data;
}

type CallEntry = Extract<Entry, { readonly kind: "call" }>;

function firstCall(
  records: readonly Entry[],
  after: EntryId,
  role: RoleName,
  label: string,
  request: Json | RoleCall<z.ZodType>,
): CallEntry | undefined {
  const call = records.find(
    (entry): entry is CallEntry =>
      entry.kind === "call" &&
      entry.seq > after &&
      entry.label === label &&
      entry.role === role,
  );
  if (call === undefined) return undefined;
  if (!sameRequest(call.request, request)) {
    throw new Error(
      `call ${call.seq} does not match the derived ${role} request`,
    );
  }
  return call;
}

function settledCall<S extends z.ZodType>(
  records: readonly Entry[],
  after: EntryId,
  roleCall: RoleCall<S>,
): { readonly settled: EntryId; readonly value: z.output<S> } | undefined {
  for (
    let call = firstCall(
      records,
      after,
      roleCall.role,
      roleCall.label,
      roleCall,
    );
    call !== undefined;
    call = firstCall(records, call.seq, roleCall.role, roleCall.label, roleCall)
  ) {
    const submission = succeededSubmission(records, call.seq, roleCall.tool);
    if (submission === undefined) continue;
    const parsed = roleCall.schema.safeParse(submission.input);
    if (!parsed.success) {
      throw new Error(
        `malformed ${roleCall.role} submission in call ${call.seq}`,
      );
    }
    return { settled: submission.settled, value: parsed.data };
  }
  return undefined;
}

/**
 * The longest prefix of the coordinator's verify list whose note and support
 * texts fit the window, and always its first entry. Texts shared by several
 * notes are read once, so they count once.
 */
export async function verificationPrefix(
  verify: readonly Verification[],
  notes: readonly Note[],
  window: number,
): Promise<Verification[]> {
  const read = new Set<string>();
  let reading = 0;
  let taken = 0;
  for (const entry of verify) {
    const note = pick(notes, entry.note);
    // The first closure validates all known IDs, including disconnected notes.
    const closed =
      taken > 0 &&
      note.support.every((id) => read.has(id) && byId(id, note.id) < 0);
    const added = [
      note.id,
      ...(closed ? [] : await supportClosure([note], notes)),
    ].filter((id) => !read.has(id));
    const cost = added.reduce(
      (sum, id) => sum + pick(notes, id).text.length,
      0,
    );
    if (taken > 0 && reading + cost > window) break;
    for (const id of added) read.add(id);
    reading += cost;
    taken += 1;
  }
  return verify.slice(0, taken);
}

/** The replay state of one derivation; the cursor is historical, never the journal's latest entry. */
interface Fold {
  readonly records: readonly Entry[];
  readonly base: Pick<WorkflowSnapshot, "config" | "allowances" | "maxTurns">;
  readonly verdicts: ReturnType<typeof journalVerdicts>;
  readonly projection: Projection;
  readonly noteSubmissions: { call: EntryId; noteIds: string[] }[];
  cursor: EntryId;
  turns: number;
}

function openFold(records: readonly Entry[]): Fold {
  const config = parseConfig(records[0]);
  const allowances = turnAllowances(records);
  const maxTurns = allowances.at(-1)?.maxTurns;
  if (maxTurns === undefined)
    throw new Error("campaign has no initial turn allowance; run init first");
  const verdicts = journalVerdicts(records);
  return {
    records,
    base: { config, allowances, maxTurns },
    verdicts,
    projection: new Projection(verdicts),
    noteSubmissions: [],
    cursor: records[0]!.seq,
    turns: 0,
  };
}

function snapshot(
  fold: Fold,
  phase: WorkflowPhase,
  notes: readonly Note[] = fold.projection.at(fold.cursor),
  boundaries: Pick<WorkflowSnapshot, "explorerAfter" | "notesAfter"> = {},
): WorkflowSnapshot {
  return {
    ...fold.base,
    noteSubmissions: fold.noteSubmissions,
    notes,
    phase,
    ...boundaries,
  };
}

function turnLimit(fold: Fold): WorkflowSnapshot {
  const notes = fold.projection.at(fold.cursor);
  return snapshot(
    fold,
    { kind: "turn-limit", turns: fold.turns, notes },
    notes,
  );
}

/** Frozen caller submissions at this boundary enter the note graph before the next coordinator. */
function includeSubmitted(fold: Fold, after: EntryId): boolean {
  const boundary = submittedNotesBoundary(fold.records, after);
  if (boundary === undefined) return false;
  let count = fold.projection.at(after).length;
  for (const submission of boundary.submissions) {
    const entries = submission.notes.map((entry, index) => ({
      id: noteIdAfter(count, index),
      ...entry,
      support: entry.support.map((reference) =>
        typeof reference === "number"
          ? noteIdAfter(count, reference - 1)
          : reference,
      ),
    }));
    fold.projection.add(entries, boundary.call);
    fold.noteSubmissions.push({
      call: submission.call,
      noteIds: entries.map(({ id }) => id),
    });
    count += entries.length;
  }
  fold.cursor = boundary.call;
  return true;
}

/**
 * Replay one Explorer call from the cursor. Returns the pending explorer
 * snapshot, or advances past the settled call and reports whether it ended
 * with an empty submission. The caller counts the turn.
 */
async function replayExplorerTurn(
  fold: Fold,
  guidance: string,
  support: readonly string[],
): Promise<WorkflowSnapshot | { readonly emptySubmission: boolean }> {
  const { records, base } = fold;
  let after = fold.cursor;
  let known = fold.projection.at(fold.cursor);
  const selected = [...support];
  // Advice stays frozen for the turn. A fresh call after interruption
  // also receives every note already saved by this turn, in full.
  const advice = explorerGuidance(records, fold.cursor, guidance);
  for (;;) {
    const explorerRequest = explorerInput.parse({
      task: base.config.task,
      explorerGuidance: advice,
      notes: known.map(({ text, ...rest }) => rest),
      support: [
        ...new Set([
          ...selected,
          ...(await supportClosure(
            selected.map((id) => pick(known, id)),
            known,
          )),
        ]),
      ]
        .sort(byId)
        .map((id) => pick(known, id)),
    });
    const roleCall = explorerCall(
      explorerRequest,
      base.config.settings.explorerContextBudgetTokens,
      base.config.settings.maxExplorerResponses,
    );
    const call = firstCall(
      records,
      after,
      roleCall.role,
      roleCall.label,
      roleCall,
    );
    if (call === undefined) {
      return snapshot(
        fold,
        { kind: "explorer", input: explorerRequest },
        known,
        { explorerAfter: fold.cursor, notesAfter: fold.cursor },
      );
    }
    const saved = savedExplorerSubmission(records, call.seq);
    const completed = succeededSubmission(
      records,
      call.seq,
      roleCall.tool,
      saved,
    );
    // Saved notes become visible at the last tool call; the next phase
    // starts only at the outer call-result, which can occur later.
    if (saved !== undefined) {
      const value = roleCall.schema.parse(saved.input);
      const notes = value.notes.map((entry, position) => ({
        id: noteIdAfter(known.length, position),
        ...entry,
      }));
      if (notes.length > 0) fold.projection.add(notes, saved.settled);
      selected.push(...notes.map(({ id }) => id));
      known = fold.projection.at(saved.settled);
    }
    if (completed !== undefined) {
      fold.cursor = completed.settled;
      return { emptySubmission: saved?.emptySubmission === true };
    }
    after = call.seq;
  }
}

/**
 * Replay the coordinator's verification list in window-fitting batches.
 * Returns the pending verifier or accepted snapshot, or undefined once every
 * batch is complete.
 */
async function replayVerification(
  fold: Fold,
  listed: readonly Verification[],
): Promise<WorkflowSnapshot | undefined> {
  const { records, base } = fold;
  let remaining = listed;
  while (remaining.length > 0) {
    const filed = fold.projection.at(fold.cursor);
    const available = new Set(
      filed.filter(({ verified }) => verified).map(({ id }) => id),
    );
    // Earlier batches may have refuted or left support inconclusive.
    // Retain independent work, and dependencies scheduled before their use.
    remaining = remaining.filter(({ note, verifiers }) => {
      const target = pick(filed, note);
      if (target.dead || target.support.some((id) => !available.has(id)))
        return false;
      if (verifiers.includes("source")) available.add(note);
      return true;
    });
    if (remaining.length === 0) break;
    const verify = await verificationPrefix(
      remaining,
      filed,
      base.config.settings.window,
    );
    const listedNotes = verify.map(({ note }) => pick(filed, note));
    const verifierRequest = await verifierInput.parseAsync({
      task: base.config.task,
      verify,
      notes: listedNotes,
      support: (await supportClosure(listedNotes, filed)).map((id) =>
        pick(filed, id),
      ),
    });
    // Correctness opens every verification and freezes its complete proof input.
    const judged = judgedBy(verifierRequest, [], "correctness");
    const first = firstCall(
      records,
      fold.cursor,
      "verifier",
      verifierLabels.correctness,
      await verifierCall("correctness", verifierRequest, judged),
    );
    if (first === undefined)
      return snapshot(
        fold,
        { kind: "verifier", input: verifierRequest },
        filed,
      );
    const candidate = first.candidate;
    if (candidate === undefined)
      throw new Error(`verifier call ${first.seq} is not bound to a candidate`);
    const recorded = fold.verdicts.filter(
      (entry) => entry.candidate === candidate,
    );
    fold.cursor = Math.max(fold.cursor, ...recorded.map(({ seq }) => seq));
    const accepted = fold.projection.accepted(fold.cursor);
    const acceptedId = verify
      .map(({ note }) => note)
      .find((id) => accepted.includes(id));
    if (acceptedId !== undefined) {
      const notes = fold.projection.at(fold.cursor);
      return snapshot(
        fold,
        {
          kind: "accepted",
          turns: fold.turns,
          note: pick(notes, acceptedId),
          notes,
          candidate,
          closure: await supportClosure([pick(notes, acceptedId)], notes),
        },
        notes,
      );
    }
    if (
      !verificationComplete(
        verifierRequest,
        recorded.map(({ verdict }) => verdict),
      )
    )
      return snapshot(fold, {
        kind: "verifier",
        input: verifierRequest,
        candidate,
      });
    // Completed entries leave the queue even when their verdict was not PASS.
    remaining = remaining.slice(verify.length);
  }
  return undefined;
}

/**
 * Replay one coordinator call from the cursor. Returns the pending
 * coordinator snapshot, with the unfrozen submission boundary unless a
 * frozen one was just included, or the settled coordination after filing.
 */
function replayCoordinator(
  fold: Fold,
  input: CoordinatorInput,
  mode: "fixed" | "coordinator",
  included: boolean,
): WorkflowSnapshot | CoordinatorResult {
  const coordinated = settledCall(
    fold.records,
    fold.cursor,
    coordinatorCall(input, mode),
  );
  if (coordinated === undefined) {
    return snapshot(
      fold,
      { kind: "coordinator", input },
      input.notes,
      included ? {} : { notesAfter: fold.cursor },
    );
  }
  fold.cursor = coordinated.settled;
  fold.projection.file(coordinated.value.filings, fold.cursor);
  return coordinated.value;
}

export async function deriveWorkflow(
  records: readonly Entry[],
): Promise<WorkflowSnapshot> {
  const fold = openFold(records);
  if (fold.base.config.settings.workflowMode === "coordinator")
    return deriveCoordinatorWorkflow(fold);
  let guidance = "";
  let support: readonly string[] = [];
  while (fold.turns < fold.base.maxTurns) {
    let emptySubmission = false;
    // A submitted note goes directly to the coordinator. Otherwise the
    // next explorer writes notes, which may be joined by pending submissions.
    let included = includeSubmitted(fold, fold.cursor);
    if (!included) {
      const turn = await replayExplorerTurn(fold, guidance, support);
      if ("phase" in turn) return turn;
      fold.turns += 1;
      emptySubmission = turn.emptySubmission;
      included = includeSubmitted(fold, fold.cursor);
    }
    const coordinated = replayCoordinator(
      fold,
      coordinatorInput.parse({
        task: fold.base.config.task,
        notes: fold.projection.at(fold.cursor),
        ...(emptySubmission ? { emptySubmission: true } : {}),
      }),
      "fixed",
      included,
    );
    if ("phase" in coordinated) return coordinated;
    guidance = coordinated.explorerGuidance;
    support = coordinated.support;
    const verification = await replayVerification(fold, coordinated.verify);
    if (verification !== undefined) return verification;
  }
  return turnLimit(fold);
}

/** Whether discovery has run at or before this cursor, and whether any run returned a usable report. */
function literatureSearchStatus(
  records: readonly Entry[],
  through: EntryId,
): LiteratureStatus {
  let status: LiteratureStatus = "not-started";
  for (const entry of records) {
    if (
      entry.kind !== "call" ||
      entry.seq > through ||
      entry.label !== roleLabels.literature
    )
      continue;
    status = "inconclusive";
    if (literatureOutcome(records, entry.seq)?.report !== undefined)
      return "completed";
  }
  return status;
}

/**
 * The settled literature call after the dispatching coordinator: a usable
 * report whose candidates are delivered, or a failed call, which ends
 * discovery without candidates. A cancelled or unusable call is replaced by
 * a fresh one, and an undelivered response waits for the runner.
 */
function settledLiteratureCall(
  records: readonly Entry[],
  after: EntryId,
  call: ReturnType<typeof literatureCall>,
): EntryId | undefined {
  for (
    let entry = firstCall(
      records,
      after,
      "literature",
      call.label,
      call.request,
    );
    entry !== undefined;
    entry = firstCall(
      records,
      entry.seq,
      "literature",
      call.label,
      call.request,
    )
  ) {
    const outcome = literatureOutcome(records, entry.seq);
    if (outcome === undefined) continue;
    if (
      outcome.report !== undefined &&
      outcome.report.notes.length > 0 &&
      !hasSubmittedNotes(records, literatureNotesId(entry.seq))
    )
      return undefined;
    return outcome.settled;
  }
  return undefined;
}

/**
 * Experimental coordinator workflow mode. Every completed role returns to a
 * fresh coordinator decision; literature notes enter the ordinary note graph,
 * never a verifier result. A turn is one coordinator call and the role it
 * dispatches, so the journaled allowance bounds the whole loop and no role
 * has a separate cap. A verifier dispatch checks the whole list, and the
 * verifier action stays unavailable until a note has been added, so two
 * verifications never run back to back over the same notes. The fixed
 * Explorer -> coordinator -> verifier loop above remains the default mode
 * for comparison.
 */
async function deriveCoordinatorWorkflow(
  fold: Fold,
): Promise<WorkflowSnapshot> {
  const { records, base } = fold;
  const settings = base.config.settings;
  let guidance = "";
  let support: readonly string[] = [];
  let emptySubmission = false;
  // The note count when the last verification completed, derived like every
  // other coordinator input from the records before the coordinator call.
  let notesAtLastVerification: number | undefined;
  for (;;) {
    const included = includeSubmitted(fold, fold.cursor);
    if (fold.turns >= base.maxTurns) return turnLimit(fold);
    const notes = fold.projection.at(fold.cursor);
    const coordinated = replayCoordinator(
      fold,
      coordinatorInput.parse({
        task: base.config.task,
        notes,
        literatureStatus: literatureSearchStatus(records, fold.cursor),
        coordinatorBehavior: settings.coordinatorBehavior,
        ...(emptySubmission ? { emptySubmission: true } : {}),
        ...(notes.length === notesAtLastVerification
          ? { afterVerification: true }
          : {}),
      }),
      "coordinator",
      included,
    );
    if ("phase" in coordinated) return coordinated;
    guidance = coordinated.explorerGuidance;
    support = coordinated.support;
    emptySubmission = false;
    const action = coordinated.action;
    if (action === undefined)
      throw new Error("coordinator workflow mode requires a role action");
    fold.turns += 1;
    if (action.role === "literature") {
      const input = literatureInput.parse({
        task: base.config.task,
        request: action.request,
      });
      const settled = settledLiteratureCall(
        records,
        fold.cursor,
        literatureCall(input, settings.source),
      );
      if (settled === undefined)
        return snapshot(fold, {
          kind: "literature",
          input,
          after: fold.cursor,
        });
      fold.cursor = settled;
    } else if (action.role === "explorer") {
      // A caller's submission while this phase waited returns to the
      // coordinator with the new notes, as in the fixed loop.
      if (includeSubmitted(fold, fold.cursor)) continue;
      const turn = await replayExplorerTurn(fold, guidance, support);
      if ("phase" in turn) return turn;
      emptySubmission = turn.emptySubmission;
    } else {
      const verification = await replayVerification(fold, coordinated.verify);
      if (verification !== undefined) return verification;
      notesAtLastVerification = fold.projection.at(fold.cursor).length;
    }
  }
}

export function workflowResult(phase: WorkflowTerminal): WorkflowResult {
  if (phase.kind === "accepted") {
    const { kind, closure, ...result } = phase;
    return { ...result, outcome: kind };
  }
  const { kind, ...result } = phase;
  return { ...result, outcome: kind };
}

export interface WorkflowDependencies {
  readonly pauseRequested?: () => boolean;
  readonly status?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export async function runWorkflow(
  campaign: Campaign,
  roles: Roles,
  dependencies: WorkflowDependencies = {},
  initial?: { readonly snapshot: WorkflowSnapshot; readonly through: number },
): Promise<WorkflowPhase> {
  let snapshot =
    initial !== undefined && campaign.lastSequence() === initial.through
      ? initial.snapshot
      : await deriveWorkflow(workflowRecords(campaign));
  initial = undefined;
  let phase = snapshot.phase;
  let errorRecoveries = 0;
  for (;;) {
    if (phase.kind === "accepted" || phase.kind === "turn-limit") {
      return phase;
    }
    if (dependencies.pauseRequested?.()) return phase;
    if (
      snapshot.notesAfter !== undefined &&
      (await freezeSubmittedNotes(campaign, snapshot.notesAfter))
    ) {
      snapshot = await deriveWorkflow(workflowRecords(campaign));
      phase = snapshot.phase;
      continue;
    }
    dependencies.status?.(phase.kind);
    const verifying = phase.kind === "verifier" ? phase.input : undefined;
    try {
      if (phase.kind === "explorer") {
        if (await freezeExplorerGuidance(campaign, snapshot.explorerAfter!)) {
          snapshot = await deriveWorkflow(workflowRecords(campaign));
          phase = snapshot.phase;
          if (phase.kind !== "explorer")
            throw new Error("explorer boundary changed");
        }
        await roles.explorer(phase.input);
      } else if (phase.kind === "coordinator") {
        await roles.coordinator(phase.input);
      } else if (phase.kind === "literature") {
        await roles.literature(phase.input, phase.after);
      } else {
        await roles.verifier(phase.input, phase.candidate);
      }
      errorRecoveries = 0;
    } catch (error) {
      if (
        !(error instanceof RoleCallError) ||
        !error.retryable ||
        errorRecoveries >= 3 ||
        dependencies.signal?.aborted
      )
        throw error;
      errorRecoveries += 1;
      snapshot = await deriveWorkflow(workflowRecords(campaign));
      phase = snapshot.phase;
      if (!dependencies.pauseRequested?.()) {
        dependencies.status?.(
          `${phase.kind}: retrying with a fresh call (${errorRecoveries}/3)`,
        );
        await delay(1000 * 2 ** (errorRecoveries - 1), undefined, {
          signal: dependencies.signal,
        });
      }
      continue;
    }
    snapshot = await deriveWorkflow(workflowRecords(campaign));
    phase = snapshot.phase;
    if (
      verifying !== undefined &&
      phase.kind === "verifier" &&
      isDeepStrictEqual(phase.input, verifying)
    )
      return phase;
  }
}

export function workflowConfiguration(options: {
  readonly task: Task;
  readonly settings: z.input<typeof solveSettings>;
}): WorkflowConfig & Readonly<Record<string, Json>> {
  // Omit absent optional settings before the declaration reaches the journal.
  return jsonSnapshot(
    workflowConfig.parse({
      kind: "workflow",
      schemaVersion: workflowSchemaVersion,
      ...options,
    }),
  ) as WorkflowConfig & Readonly<Record<string, Json>>;
}
