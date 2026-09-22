import type { Campaign, Entry, EntryId, Json } from "xean";
import { isDeepStrictEqual } from "node:util";
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
  readPiSubmission,
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
  task,
  verificationComplete,
  verificationLabel,
  verifierInput,
  roleLabels,
  literatureInput,
  workflowRecords,
  type CoordinatorInput,
  type CoordinatorAction,
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

export const workflowSchemaVersion = 32;
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
  readonly verification: EntryId;
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
  readonly verification?: EntryId;
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
    const submission = readPiSubmission(records, call.seq, roleCall);
    if (submission !== undefined) return submission;
  }
  return undefined;
}

/**
 * The longest prefix of the coordinator's verify list whose note and support
 * texts fit the window, and always its first entry. Texts shared by several
 * notes are read once, so they count once.
 */
export function verificationPrefix(
  verify: readonly Verification[],
  notes: readonly Note[],
  window: number,
): Verification[] {
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
      ...(closed ? [] : supportClosure([note], notes)),
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
  /** Pending work may expose saved notes beyond its last completed phase. */
  through?: EntryId;
  after?: EntryId;
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

function explorerInputFor(
  task: Task,
  known: readonly Note[],
  selected: readonly string[],
  advice: string,
): ExplorerInput {
  return explorerInput.parse({
    task,
    explorerGuidance: advice,
    notes: known.map(({ text, ...rest }) => rest),
    support: [
      ...new Set([
        ...selected,
        ...supportClosure(
          selected.map((id) => pick(known, id)),
          known,
        ),
      ]),
    ]
      .sort(byId)
      .map((id) => pick(known, id)),
  });
}

/**
 * Replay one Explorer call from the cursor. Returns the pending explorer
 * phase, or advances past the settled call and reports whether it ended
 * with an empty submission. The caller counts the turn.
 */
function replayExplorerTurn(
  fold: Fold,
  guidance: string,
  support: readonly string[],
  savedProjection?: Projection,
): ExplorerPhase | { readonly emptySubmission: boolean } {
  const { records, base } = fold;
  let after = fold.cursor;
  let through = fold.cursor;
  let known = fold.projection.at(fold.cursor);
  const selected = [...support];
  // Advice stays frozen for the turn. A fresh call after interruption
  // also receives every note already saved by this turn, in full.
  const advice = explorerGuidance(records, fold.cursor, guidance);
  for (;;) {
    const explorerRequest = explorerInputFor(
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
      fold.after = fold.cursor;
      fold.through = through;
      return { kind: "explorer", input: explorerRequest };
    }
    const saved = readPiSubmission(records, call.seq, roleCall, true);
    // Saved notes become visible at the last tool call; the next phase
    // starts only at the outer call-result, which can occur later.
    if (saved !== undefined) {
      const notes = saved.value.notes.map((entry, position) => ({
        id: noteIdAfter(known.length, position),
        ...entry,
      }));
      if (notes.length > 0) {
        fold.projection.add(notes, saved.settled);
        savedProjection?.add(notes, saved.settled);
      }
      selected.push(...notes.map(({ id }) => id));
      known = fold.projection.at(saved.settled);
      through = saved.settled;
    }
    if (saved?.completed !== undefined) {
      fold.cursor = saved.completed;
      return { emptySubmission: saved?.emptySubmission === true };
    }
    after = call.seq;
  }
}

/**
 * Replay the coordinator's verification list in window-fitting batches.
 * Returns the pending verifier or accepted phase, or undefined once every
 * batch is complete.
 */
function replayVerification(
  fold: Fold,
  listed: readonly Verification[],
): VerifierPhase | AcceptedPhase | undefined {
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
    const verify = verificationPrefix(
      remaining,
      filed,
      base.config.settings.window,
    );
    const listedNotes = verify.map(({ note }) => pick(filed, note));
    const verifierRequest = verifierInput.parse({
      task: base.config.task,
      verify,
      notes: listedNotes,
      support: supportClosure(listedNotes, filed).map((id) => pick(filed, id)),
    });
    // The local opening freezes the exact input even when earlier checks are reused.
    const first = firstCall(
      records,
      fold.cursor,
      verificationLabel,
      jsonSnapshot(verifierRequest),
    );
    if (first === undefined)
      return { kind: "verifier", input: verifierRequest };
    const verification = first.seq;
    const recorded = fold.verdicts.filter(
      (entry) => entry.verification === verification,
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
      return {
        kind: "accepted",
        turns: fold.turns,
        note: pick(notes, acceptedId),
        notes,
        verification,
        closure: supportClosure([pick(notes, acceptedId)], notes),
      };
    }
    if (
      !verificationComplete(
        verifierRequest,
        recorded.map(({ verdict }) => verdict),
      )
    )
      return {
        kind: "verifier",
        input: verifierRequest,
        verification,
      };
    // Completed entries leave the queue even when their verdict was not PASS.
    remaining = remaining.slice(verify.length);
  }
  return undefined;
}

const overlapJoinLabel = "xean-solve/overlap-join";

/** Fork historical evidence without allowing either role's cursor to move the other. */
function forkFold(fold: Fold, verdicts: Fold["verdicts"]): Fold {
  const projection = new Projection(verdicts);
  const notes = fold.projection.at(fold.cursor);
  projection.add(notes, fold.cursor);
  projection.file(
    notes.flatMap(({ id, summary }) =>
      summary === undefined ? [] : [{ note: id, summary }],
    ),
    fold.cursor,
  );
  return { ...fold, verdicts, projection };
}

/** Replay the bounded pair within its durable opening and join. */
function replayOverlap(
  fold: Fold,
  action: Extract<CoordinatorAction, { role: "verifier" }> & {
    explorerGuidance: string;
    support: string[];
  },
): OverlapPhase | AcceptedPhase | { readonly emptySubmission: boolean } {
  const after = fold.cursor;
  const advice = explorerGuidance(fold.records, after, action.explorerGuidance);
  const input = explorerInputFor(
    fold.base.config.task,
    fold.projection.at(after),
    action.support,
    advice,
  );
  const request = jsonSnapshot({
    schemaVersion: 1,
    after,
    explorer: input,
    verify: action.verify,
  });
  const opening = firstCall(
    fold.records,
    after,
    boundaryLabels.overlap,
    request,
  );
  if (opening === undefined) return { kind: "overlap", after, request };

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
  // Caller notes enter only after the join. Explorer alone assigns new note IDs.
  const pendingVerifier = replayVerification(
    { ...fold, records, cursor: opening.seq },
    action.verify,
  );
  const exploring = replayExplorerTurn(
    { ...explorer, records, cursor: opening.seq },
    advice,
    action.support,
    fold.projection,
  );
  const pendingExplorer = "kind" in exploring ? exploring : undefined;
  const through = joined?.seq ?? records.at(-1)!.seq;
  const notes = fold.projection.at(through);
  if (joined !== undefined) {
    if (pendingVerifier?.kind === "accepted") {
      fold.through = through;
      return {
        ...pendingVerifier,
        notes,
        note: pick(notes, pendingVerifier.note.id),
      };
    }
    if (pendingExplorer !== undefined || pendingVerifier !== undefined)
      throw new Error("overlap joined before both roles completed");
    fold.cursor = joined.seq;
    return {
      emptySubmission:
        "emptySubmission" in exploring && exploring.emptySubmission,
    };
  }
  fold.through = through;
  return {
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
  };
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
function replay(fold: Fold): WorkflowPhase {
  const { records, base } = fold;
  const settings = base.config.settings;
  let emptySubmission = false;
  for (;;) {
    const included = includeSubmitted(fold, fold.cursor);
    const notes = fold.projection.at(fold.cursor);
    if (fold.turns >= base.maxTurns)
      return { kind: "turn-limit", turns: fold.turns, notes };
    const input = coordinatorInput.parse({
      task: base.config.task,
      notes,
      literatureStatus: literatureSearchStatus(records, fold.cursor),
      coordinatorBehavior: settings.coordinatorBehavior,
      ...(emptySubmission ? { emptySubmission: true } : {}),
    });
    const coordinated = settledCall<z.ZodType<CoordinatorResult>>(
      records,
      fold.cursor,
      coordinatorCall(input),
    );
    if (coordinated === undefined) {
      if (!included) fold.after = fold.cursor;
      return { kind: "coordinator", input };
    }
    fold.cursor = coordinated.settled;
    fold.projection.file(coordinated.value.filings, fold.cursor);
    emptySubmission = false;
    const { action } = coordinated.value;
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
        return {
          kind: "literature",
          input,
          after: fold.cursor,
        };
      fold.cursor = settled;
    } else if (action.role === "explorer") {
      // A caller's submission while this phase waited returns to the
      // coordinator with the new notes.
      if (includeSubmitted(fold, fold.cursor)) continue;
      const turn = replayExplorerTurn(
        fold,
        action.explorerGuidance,
        action.support,
      );
      if ("kind" in turn) return turn;
      emptySubmission = turn.emptySubmission;
    } else if ("explorerGuidance" in action) {
      const overlap = replayOverlap(fold, action);
      if ("kind" in overlap) return overlap;
      emptySubmission = overlap.emptySubmission;
    } else {
      const verification = replayVerification(fold, action.verify);
      if (verification !== undefined) return verification;
    }
  }
}

export function deriveWorkflow(records: readonly Entry[]): WorkflowSnapshot {
  const fold = openFold(records);
  const phase = replay(fold);
  return {
    ...fold.base,
    noteSubmissions: fold.noteSubmissions,
    notes: fold.projection.at(fold.through ?? fold.cursor),
    phase,
    ...(fold.after === undefined ? {} : { after: fold.after }),
  };
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
    const { phase } = deriveWorkflow(workflowRecords(campaign));
    if (phase.kind !== "overlap" || phase.after !== initial.after)
      throw new Error("overlap boundary changed");
    await campaign.call(
      { label: boundaryLabels.overlap, request: phase.request },
      async () => null,
    );
    return;
  }
  const controllers = {
    explorer: new AbortController(),
    verifier: new AbortController(),
  };
  const current = (): OverlapPhase => {
    const { phase } = deriveWorkflow(workflowRecords(campaign));
    if (phase.kind !== "overlap" || phase.opened !== initial.opened)
      throw new Error("overlap changed before join");
    return phase;
  };
  let failure: unknown;
  const run = async (role: "explorer" | "verifier") => {
    const signal = dependencies.signal
      ? AbortSignal.any([controllers[role].signal, dependencies.signal])
      : controllers[role].signal;
    try {
      for (;;) {
        const phase = current();
        if (phase.accepted !== undefined) {
          controllers.explorer.abort();
          return;
        }
        const step = phase[role];
        if (
          step === undefined ||
          signal.aborted ||
          dependencies.pauseRequested?.()
        )
          return;
        if (step.kind === "explorer") await roles.explorer(step.input, signal);
        else await roles.verifier(step.input, step.verification, signal);
        const next = current();
        if (next.accepted !== undefined) controllers.explorer.abort();
        // A replacement role that made no durable progress leaves a resumable phase.
        if (isDeepStrictEqual(next[role], step)) return;
      }
    } catch (error) {
      failure ??= error;
      controllers.explorer.abort();
      controllers.verifier.abort();
    }
  };
  await Promise.all([run("explorer"), run("verifier")]);
  const phase = current();
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
      : deriveWorkflow(workflowRecords(campaign));
  initial = undefined;
  let phase = snapshot.phase;
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
      snapshot = deriveWorkflow(workflowRecords(campaign));
      phase = snapshot.phase;
      continue;
    }
    dependencies.status?.(phase.kind);
    const verifying = phase.kind === "verifier" ? phase.input : undefined;
    const overlapping = phase.kind === "overlap" ? phase : undefined;
    if (phase.kind === "overlap") {
      await runOverlap(campaign, roles, phase, dependencies);
    } else if (phase.kind === "explorer") {
      if (await freezeExplorerGuidance(campaign, snapshot.after!)) {
        snapshot = deriveWorkflow(workflowRecords(campaign));
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
      await roles.verifier(phase.input, phase.verification);
    }
    snapshot = deriveWorkflow(workflowRecords(campaign));
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
