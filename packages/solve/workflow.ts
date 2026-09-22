import type { Campaign, Entry, EntryId, Json } from "xean";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { Projection } from "./projection";
import { boundaryLabels } from "./inbox";
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
  matchingCalls,
  RoleCallError,
  solveSettings,
  type CallEntry,
  type RoleCall,
} from "./pi-roles";
import {
  assertApplication,
  coordinatorInput,
  explorerInput,
  journalVerdicts,
  jsonSnapshot,
  noteIdAfter,
  pick,
  succeededSubmission,
  savedExplorerSubmission,
  task,
  verificationComplete,
  verificationLabel,
  verifierInput,
  roleLabels,
  literatureInput,
  workflowRecords,
  type CoordinatorInput,
  type CoordinatorResult,
  type ExplorerInput,
  type LiteratureInput,
  type LiteratureStatus,
  type Note,
  type Roles,
  type Task,
  type Verification,
  type VerifierInput,
} from "./roles";

export const workflowSchemaVersion = 29;
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
type ExplorerPhase = {
  readonly kind: "explorer";
  readonly input: ExplorerInput;
};
type VerifierPhase = {
  readonly kind: "verifier";
  readonly input: VerifierInput;
  readonly candidate?: EntryId;
};
type OverlapPhase = {
  readonly kind: "overlap";
  /** The settled coordinator decision owning both roles and every retry. */
  readonly after: EntryId;
  readonly request: Json;
  readonly opened?: EntryId;
  readonly explorer?: ExplorerPhase;
  readonly verifier?: VerifierPhase;
  readonly accepted?: AcceptedPhase;
};
export type WorkflowPhase =
  | ExplorerPhase
  | { readonly kind: "coordinator"; readonly input: CoordinatorInput }
  | {
      readonly kind: "literature";
      readonly input: LiteratureInput;
      /** The dispatching coordinator's settled entry; earlier calls are not reused. */
      readonly after: EntryId;
    }
  | VerifierPhase
  | OverlapPhase
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
  /** An unfrozen boundary where inbox entries may enter the next role input, used only by the driver. */
  readonly after?: EntryId;
  readonly noteSubmissions: readonly {
    readonly call: EntryId;
    readonly noteIds: readonly string[];
  }[];
}

function parseConfig(declaration: Entry | undefined): WorkflowConfig {
  assertApplication(declaration);
  const parsed = workflowConfig.safeParse(declaration.config);
  if (!parsed.success) {
    throw new Error(`invalid workflow campaign: ${parsed.error.message}`);
  }
  return parsed.data;
}

function firstCall(
  records: readonly Entry[],
  after: EntryId,
  label: string,
  request: Json | RoleCall<z.ZodType>,
): CallEntry | undefined {
  for (const call of matchingCalls(records, after, label, request)) return call;
  return undefined;
}

function settledCall<S extends z.ZodType>(
  records: readonly Entry[],
  after: EntryId,
  roleCall: RoleCall<S>,
): { readonly settled: EntryId; readonly value: z.output<S> } | undefined {
  for (const call of matchingCalls(records, after, roleCall.label, roleCall)) {
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
  boundary: Pick<WorkflowSnapshot, "after"> = {},
): WorkflowSnapshot {
  return {
    ...fold.base,
    noteSubmissions: fold.noteSubmissions,
    notes,
    phase,
    ...boundary,
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
  for (const submission of boundary.receipts) {
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

async function explorerInputFor(
  task: Task,
  known: readonly Note[],
  selected: readonly string[],
  advice: string,
): Promise<ExplorerInput> {
  return explorerInput.parse({
    task,
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
  savedProjection?: Projection,
): Promise<WorkflowSnapshot | { readonly emptySubmission: boolean }> {
  const { records, base } = fold;
  let after = fold.cursor;
  let known = fold.projection.at(fold.cursor);
  const selected = [...support];
  // Advice stays frozen for the turn. A fresh call after interruption
  // also receives every note already saved by this turn, in full.
  const advice = explorerGuidance(records, fold.cursor, guidance);
  for (;;) {
    const explorerRequest = await explorerInputFor(
      base.config.task,
      known,
      selected,
      advice,
    );
    const roleCall = explorerCall(
      explorerRequest,
      base.config.settings.explorerContextBudgetTokens,
      base.config.settings.maxExplorerResponses,
    );
    const call = firstCall(records, after, roleCall.label, roleCall);
    if (call === undefined) {
      return snapshot(
        fold,
        { kind: "explorer", input: explorerRequest },
        known,
        { after: fold.cursor },
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
      if (notes.length > 0) {
        fold.projection.add(notes, saved.settled);
        savedProjection?.add(notes, saved.settled);
      }
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
    // The local opening freezes the exact input even when earlier checks are reused.
    const first = firstCall(
      records,
      fold.cursor,
      verificationLabel,
      jsonSnapshot(verifierRequest),
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
    fold.cursor = Math.max(
      fold.cursor,
      first.seq,
      ...recorded.map(({ seq }) => seq),
    );
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

const overlapJoinLabel = "xean-solve/overlap-join";

/** Fork historical evidence without allowing either role's cursor to move the other. */
function forkFold(fold: Fold, verdicts = fold.verdicts): Fold {
  const projection = new Projection(verdicts);
  const notes = fold.projection.at(fold.cursor);
  projection.add(
    notes.map(({ id, text, support, verification }) => ({
      id,
      text,
      support,
      ...(verification === undefined ? {} : { verification }),
    })),
    fold.cursor,
  );
  projection.file(
    notes.flatMap(({ id, summary }) =>
      summary === undefined ? [] : [{ note: id, summary }],
    ),
    fold.cursor,
  );
  return { ...fold, verdicts, projection };
}

/** Replay the bounded pair within its durable opening and join. */
async function replayOverlap(
  fold: Fold,
  coordinated: CoordinatorResult,
): Promise<WorkflowSnapshot | { readonly emptySubmission: boolean }> {
  const after = fold.cursor;
  const advice = explorerGuidance(
    fold.records,
    after,
    coordinated.explorerGuidance!,
  );
  const input = await explorerInputFor(
    fold.base.config.task,
    fold.projection.at(after),
    coordinated.support!,
    advice,
  );
  const request = jsonSnapshot({
    schemaVersion: 1,
    after,
    explorer: input,
    verify: coordinated.verify,
  });
  const opening = firstCall(
    fold.records,
    after,
    boundaryLabels.overlap,
    request,
  );
  if (opening === undefined)
    return snapshot(fold, { kind: "overlap", after, request });

  const joined = firstCall(fold.records, opening.seq, overlapJoinLabel, {
    schemaVersion: 1,
    after: opening.seq,
  });
  const records =
    joined === undefined
      ? fold.records
      : fold.records.filter((entry) => entry.seq <= joined.seq);
  const explorer = forkFold(
    fold,
    fold.verdicts.filter((entry) => entry.seq <= after),
  );
  const verifier = forkFold(fold);
  // Caller notes enter only after the join. Explorer alone assigns new note IDs.
  explorer.cursor = verifier.cursor = opening.seq;
  const exploring = await replayExplorerTurn(
    { ...explorer, records },
    advice,
    coordinated.support!,
    fold.projection,
  );
  const verifying = await replayVerification(
    { ...verifier, records },
    coordinated.verify,
  );
  const pendingExplorer = "phase" in exploring ? exploring.phase : undefined;
  const pendingVerifier = verifying?.phase;
  if (pendingExplorer !== undefined && pendingExplorer.kind !== "explorer")
    throw new Error("invalid overlap explorer phase");
  if (
    pendingVerifier !== undefined &&
    pendingVerifier.kind !== "verifier" &&
    pendingVerifier.kind !== "accepted"
  )
    throw new Error("invalid overlap verifier phase");
  const through = joined?.seq ?? records.at(-1)!.seq;
  const notes = fold.projection.at(through);
  if (joined !== undefined) {
    if (pendingVerifier?.kind === "accepted") {
      return snapshot(
        fold,
        {
          ...pendingVerifier,
          notes,
          note: pick(notes, pendingVerifier.note.id),
        },
        notes,
      );
    }
    if (pendingExplorer !== undefined || pendingVerifier !== undefined)
      throw new Error("overlap joined before both roles completed");
    fold.cursor = joined.seq;
    return {
      emptySubmission:
        "emptySubmission" in exploring && exploring.emptySubmission,
    };
  }
  return snapshot(
    fold,
    {
      kind: "overlap",
      after,
      request,
      opened: opening.seq,
      ...(pendingExplorer === undefined ? {} : { explorer: pendingExplorer }),
      ...(pendingVerifier?.kind === "verifier"
        ? { verifier: pendingVerifier }
        : {}),
      ...(pendingVerifier?.kind === "accepted"
        ? { accepted: pendingVerifier }
        : {}),
    },
    notes,
  );
}

/**
 * Replay one coordinator call from the cursor. Returns the pending
 * coordinator snapshot, with the unfrozen submission boundary unless a
 * frozen one was just included, or the settled coordination after filing.
 */
function replayCoordinator(
  fold: Fold,
  input: CoordinatorInput,
  included: boolean,
): WorkflowSnapshot | CoordinatorResult {
  const coordinated = settledCall(
    fold.records,
    fold.cursor,
    coordinatorCall(input),
  );
  if (coordinated === undefined) {
    return snapshot(
      fold,
      { kind: "coordinator", input },
      input.notes,
      included ? {} : { after: fold.cursor },
    );
  }
  fold.cursor = coordinated.settled;
  fold.projection.file(coordinated.value.filings, fold.cursor);
  return coordinated.value;
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
  for (const entry of matchingCalls(records, after, call.label, call.request)) {
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
 * Every completed role returns to a fresh coordinator decision; literature
 * notes enter the ordinary note graph, never a verifier result. A turn is one
 * coordinator call and its dispatched work, so the journaled allowance
 * bounds the whole loop and no role has a separate cap. A verifier dispatch
 * checks the whole list; later dispatches can check other ready notes or
 * extend completed checks without requiring more exploration.
 */
export async function deriveWorkflow(
  records: readonly Entry[],
): Promise<WorkflowSnapshot> {
  const fold = openFold(records);
  const { base } = fold;
  const settings = base.config.settings;
  let emptySubmission = false;
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
      }),
      included,
    );
    if ("phase" in coordinated) return coordinated;
    emptySubmission = false;
    const { action } = coordinated;
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
      // coordinator with the new notes.
      if (includeSubmitted(fold, fold.cursor)) continue;
      const turn = await replayExplorerTurn(
        fold,
        // coordinatorResultFor requires these fields for Explorer actions;
        // the assertions keep that action-specific contract local to this
        // branch while verifier/literature results may omit them.
        coordinated.explorerGuidance!,
        coordinated.support!,
      );
      if ("phase" in turn) return turn;
      emptySubmission = turn.emptySubmission;
    } else if (coordinated.explorerGuidance !== undefined) {
      const overlap = await replayOverlap(fold, coordinated);
      if ("phase" in overlap) return overlap;
      emptySubmission = overlap.emptySubmission;
    } else {
      const verification = await replayVerification(fold, coordinated.verify);
      if (verification !== undefined) return verification;
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

/** Drive only the two roles belonging to this opening, then drain before joining. */
async function runOverlap(
  campaign: Campaign,
  roles: Roles,
  initial: OverlapPhase,
  dependencies: WorkflowDependencies,
): Promise<void> {
  if (initial.opened === undefined) {
    await freezeExplorerGuidance(campaign, initial.after);
    const { phase } = await deriveWorkflow(workflowRecords(campaign));
    if (phase.kind !== "overlap" || phase.after !== initial.after)
      throw new Error("overlap boundary changed");
    await campaign.call(
      { label: boundaryLabels.overlap, request: phase.request },
      async () => null,
    );
    return;
  }
  const explorer = new AbortController();
  const verifier = new AbortController();
  const signals = {
    explorer:
      dependencies.signal === undefined
        ? explorer.signal
        : AbortSignal.any([explorer.signal, dependencies.signal]),
    verifier:
      dependencies.signal === undefined
        ? verifier.signal
        : AbortSignal.any([verifier.signal, dependencies.signal]),
  };
  const current = async (): Promise<OverlapPhase> => {
    const { phase } = await deriveWorkflow(workflowRecords(campaign));
    if (phase.kind !== "overlap" || phase.opened !== initial.opened)
      throw new Error("overlap changed before join");
    return phase;
  };
  const run = async (role: "explorer" | "verifier") => {
    let recoveries = 0;
    for (;;) {
      const phase = await current();
      if (phase.accepted !== undefined) {
        explorer.abort();
        return;
      }
      const step = phase[role];
      if (
        step === undefined ||
        signals[role].aborted ||
        dependencies.pauseRequested?.()
      )
        return;
      try {
        if (step.kind === "explorer")
          await roles.explorer(step.input, signals.explorer);
        else await roles.verifier(step.input, step.candidate, signals.verifier);
        recoveries = 0;
      } catch (error) {
        if (
          !(error instanceof RoleCallError) ||
          !error.retryable ||
          recoveries >= 3 ||
          signals[role].aborted
        )
          throw error;
        recoveries += 1;
        if (dependencies.pauseRequested?.()) return;
        dependencies.status?.(
          `${role}: retrying with a fresh call (${recoveries}/3)`,
        );
        await delay(1000 * 2 ** (recoveries - 1), undefined, {
          signal: signals[role],
        });
        continue;
      }
      const next = await current();
      if (next.accepted !== undefined) explorer.abort();
      // A replacement role that made no durable progress leaves a resumable phase.
      if (isDeepStrictEqual(next[role], step)) return;
    }
  };
  let failure: unknown;
  const guarded = async (role: "explorer" | "verifier") => {
    try {
      await run(role);
    } catch (error) {
      failure ??= error;
      explorer.abort();
      verifier.abort();
    }
  };
  await Promise.allSettled([guarded("explorer"), guarded("verifier")]);
  const phase = await current();
  if (
    phase.accepted !== undefined ||
    (phase.explorer === undefined && phase.verifier === undefined)
  ) {
    await campaign.call(
      {
        label: overlapJoinLabel,
        request: { schemaVersion: 1, after: initial.opened },
      },
      async () => null,
    );
  }
  if (phase.accepted !== undefined) return;
  if (failure !== undefined) throw failure;
  dependencies.signal?.throwIfAborted();
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
    // Notes freeze first in every phase; guidance follows in the explorer phase.
    if (
      snapshot.after !== undefined &&
      (await freezeSubmittedNotes(campaign, snapshot.after))
    ) {
      snapshot = await deriveWorkflow(workflowRecords(campaign));
      phase = snapshot.phase;
      continue;
    }
    dependencies.status?.(phase.kind);
    const verifying = phase.kind === "verifier" ? phase.input : undefined;
    const overlapping = phase.kind === "overlap" ? phase : undefined;
    try {
      if (phase.kind === "overlap") {
        await runOverlap(campaign, roles, phase, dependencies);
      } else if (phase.kind === "explorer") {
        if (await freezeExplorerGuidance(campaign, snapshot.after!)) {
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
        overlapping !== undefined ||
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
    if (phase.kind === "overlap" && overlapping?.opened !== undefined)
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
