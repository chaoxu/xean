import type { Campaign, Entry, EntryId, Json } from "xean";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { Projection } from "./projection";
import { boundaryLabels } from "./inbox";
import { allowanceLabel, turnAllowances } from "./allowance";
import { historyAt, recordSource, type RecordSource } from "./history";
import { explorerGuidance, guidanceInbox } from "./guidance";
import { notesInbox } from "./notes";
import { byId, supportClosure } from "./support";
import {
  literatureOutcome,
  callsAfter,
  readRoleSubmission,
  assertRoleInput,
  type CallEntry,
} from "./role-records";
import { solveSettings } from "./pi-roles";
import {
  assertApplication,
  coordinatorInput,
  coordinatorResultFor,
  explorerResultFor,
  explorerInput,
  VerdictHistory,
  jsonSnapshot,
  noteIdAfter,
  pick,
  task,
  verificationComplete,
  verificationLabel,
  verifierInput,
  roleLabels,
  literatureInput,
  roleCallRecords,
  type CoordinatorInput,
  type CoordinatorAction,
  type CoordinatorResult,
  type ExplorerInput,
  type LiteratureInput,
  type LiteratureStatus,
  type Note,
  type RoleHost,
  type Task,
  type Verification,
  type VerifierInput,
} from "./roles";

export const workflowSchemaVersion = 36;
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
  readonly parent: EntryId;
};
type VerifierPhase = {
  readonly kind: "verifier";
  readonly input: VerifierInput;
  readonly verification?: EntryId;
  readonly parent: EntryId;
};
type OverlapPhase = {
  readonly kind: "overlap";
  /** The settled coordinator decision owning both roles and every retry. */
  readonly after: EntryId;
  readonly parent: EntryId;
  readonly request: Json;
  readonly opened?: EntryId;
  readonly explorer?: ExplorerPhase;
  readonly verifier?: VerifierPhase;
  readonly accepted?: AcceptedPhase;
};
export type WorkflowPhase =
  | ExplorerPhase
  | {
      readonly kind: "coordinator";
      readonly input: CoordinatorInput;
      readonly parent: EntryId;
    }
  | {
      readonly kind: "literature";
      readonly input: LiteratureInput;
      readonly parent: EntryId;
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
  records: RecordSource,
  after: EntryId,
  label: string,
  parent: EntryId,
  request?: Json,
): CallEntry | undefined {
  for (const call of callsAfter(records, after, label, parent)) {
    if (request !== undefined && !isDeepStrictEqual(call.request, request))
      throw new Error("frozen call input does not match its dispatch");
    return call;
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
  readonly source: RecordSource;
  readonly inboxRecords: readonly Entry[];
  readonly base: Pick<WorkflowSnapshot, "config" | "allowances" | "maxTurns">;
  readonly verdicts: ReturnType<VerdictHistory["read"]>;
  readonly projection: Projection;
  readonly noteSubmissions: Array<WorkflowSnapshot["noteSubmissions"][number]>;
  cursor: EntryId;
  owner: EntryId;
  turns: number;
  emptySubmission: boolean;
  literatureStatus: LiteratureStatus;
  /** Pending work may expose saved notes beyond its last completed phase. */
  through?: EntryId;
  after?: EntryId;
}

function openFold(source: RecordSource): Fold {
  const declaration = source.record(1);
  const config = parseConfig(declaration);
  const allowances = turnAllowances(
    source.records({ kinds: ["call"], labels: [allowanceLabel] }),
  );
  const maxTurns = allowances.at(-1)?.maxTurns;
  if (maxTurns === undefined)
    throw new Error("campaign has no initial turn allowance; run init first");
  return {
    source,
    inboxRecords: [],
    base: { config, allowances, maxTurns },
    verdicts: [],
    projection: new Projection([]),
    noteSubmissions: [],
    cursor: declaration!.seq,
    owner: allowances[0]!.call,
    turns: 0,
    emptySubmission: false,
    literatureStatus: "not-started",
  };
}

/** Frozen caller submissions at this boundary enter the note graph before the next coordinator. */
function includeSubmitted(fold: Fold, after: EntryId): boolean {
  const boundary = notesInbox.at(fold.inboxRecords, after);
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
  known: readonly Note[] = fold.projection.at(fold.cursor),
): ExplorerPhase | { readonly emptySubmission: boolean } {
  const { source, base } = fold;
  let after = fold.cursor;
  let through = fold.cursor;
  const selected = [...support];
  // Advice stays frozen for the turn. A fresh call after interruption
  // also receives every note already saved by this turn, in full.
  const advice = explorerGuidance(fold.inboxRecords, fold.cursor, guidance);
  for (;;) {
    const explorerRequest = explorerInputFor(
      base.config.task,
      known,
      selected,
      advice,
    );
    const call = firstCall(source, after, roleLabels.explorer, fold.owner);
    if (call === undefined) {
      fold.after = fold.cursor;
      fold.through = through;
      return { kind: "explorer", input: explorerRequest, parent: fold.owner };
    }
    assertRoleInput(call, explorerRequest);
    const submission = {
      call: call.seq,
      noteIds: [] as string[],
    };
    fold.noteSubmissions.push(submission);
    const saved = readRoleSubmission(
      roleCallRecords(source, call.seq),
      call.seq,
      { schema: explorerResultFor(known) },
      true,
    );
    // Saved notes become visible at the last tool call; the next phase
    // starts only at the outer call-result, which can occur later.
    if (saved !== undefined) {
      const notes = saved.value.notes.map((entry, position) => ({
        id: noteIdAfter(known.length, position),
        ...entry,
        support: [...entry.support].sort(byId),
        verdicts: [],
        verified: false,
        dead: false,
      }));
      submission.noteIds = notes.map((note) => note.id);
      if (notes.length > 0) fold.projection.add(notes, saved.settled);
      selected.push(...notes.map(({ id }) => id));
      // New notes have no checks in this turn's frozen view. The canonical
      // projection separately applies concurrent evidence and support failures.
      known = [...known, ...notes];
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
  const { source, base } = fold;
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
      source,
      fold.cursor,
      verificationLabel,
      fold.owner,
      jsonSnapshot(verifierRequest),
    );
    if (first === undefined)
      return { kind: "verifier", input: verifierRequest, parent: fold.owner };
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
        parent: fold.owner,
      };
    // Completed entries leave the queue even when their verdict was not PASS.
    remaining = remaining.slice(verify.length);
  }
  return undefined;
}

const overlapJoinLabel = "xean-solve/overlap-join";

/** Replay the bounded pair within its durable opening and join. */
function replayOverlap(
  fold: Fold,
  action: Extract<CoordinatorAction, { role: "verifier" }> & {
    explorerGuidance: string;
    support: string[];
  },
): OverlapPhase | AcceptedPhase | { readonly emptySubmission: boolean } {
  const after = fold.cursor;
  const advice = explorerGuidance(
    fold.inboxRecords,
    after,
    action.explorerGuidance,
  );
  const known = fold.projection.at(after);
  const input = explorerInputFor(
    fold.base.config.task,
    known,
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
    fold.source,
    after,
    boundaryLabels.overlap,
    fold.owner,
    request,
  );
  if (opening === undefined)
    return { kind: "overlap", after, parent: fold.owner, request };

  const joined = firstCall(
    fold.source,
    opening.seq,
    overlapJoinLabel,
    opening.seq,
    {
      schemaVersion: 1,
      after: opening.seq,
    },
  );
  const through = joined?.seq ?? fold.source.lastSequence();
  const frame = {
    ...fold,
    source: historyAt(fold.source, through),
    inboxRecords: fold.inboxRecords.filter((entry) => entry.seq <= through),
    cursor: opening.seq,
    owner: opening.seq,
  };
  // Caller notes enter only after the join. Explorer alone assigns new note IDs.
  const pendingVerifier = replayVerification({ ...frame }, action.verify);
  const exploring = replayExplorerTurn(
    { ...frame },
    advice,
    action.support,
    known,
  );
  const pendingExplorer = "kind" in exploring ? exploring : undefined;
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
    parent: fold.owner,
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

/**
 * Every completed role returns to a fresh coordinator decision; literature
 * notes enter the ordinary note graph, never a verifier result. A turn is one
 * coordinator call and its dispatched work, so the journaled allowance
 * bounds the whole loop and no role has a separate cap. A verifier dispatch
 * checks the whole list; later dispatches can check other ready notes or
 * extend completed checks without requiring more exploration.
 */
function replay(fold: Fold, completed: (fold: Fold) => void): WorkflowPhase {
  const { source, base } = fold;
  const settings = base.config.settings;
  for (;;) {
    completed(fold);
    const included = includeSubmitted(fold, fold.cursor);
    const notes = fold.projection.at(fold.cursor);
    if (fold.turns >= base.maxTurns)
      return { kind: "turn-limit", turns: fold.turns, notes };
    const input = coordinatorInput.parse({
      task: base.config.task,
      notes,
      literatureStatus: fold.literatureStatus,
      coordinatorBehavior: settings.coordinatorBehavior,
      ...(fold.emptySubmission ? { emptySubmission: true } : {}),
    });
    let coordinated:
      { call: EntryId; settled: EntryId; value: CoordinatorResult } | undefined;
    for (const call of callsAfter(
      source,
      fold.cursor,
      roleLabels.coordinator,
      fold.owner,
    )) {
      assertRoleInput(call, input);
      const saved = readRoleSubmission(
        roleCallRecords(source, call.seq),
        call.seq,
        {
          schema: coordinatorResultFor(input),
        },
      );
      if (saved !== undefined) {
        coordinated = { call: call.seq, ...saved };
        break;
      }
    }
    if (coordinated === undefined) {
      if (!included) fold.after = fold.cursor;
      return { kind: "coordinator", input, parent: fold.owner };
    }
    fold.cursor = coordinated.settled;
    fold.owner = coordinated.call;
    fold.projection.file(coordinated.value.filings, fold.cursor);
    fold.emptySubmission = false;
    const { action } = coordinated.value;
    fold.turns += 1;
    if (action.role === "literature") {
      const input = literatureInput.parse({
        task: base.config.task,
        request: action.request,
      });
      let settled;
      for (const call of callsAfter(
        source,
        fold.cursor,
        roleLabels.literature,
        fold.owner,
      )) {
        assertRoleInput(call, input);
        fold.literatureStatus = "inconclusive";
        const outcome = literatureOutcome(
          roleCallRecords(source, call.seq),
          call.seq,
        );
        if (outcome !== undefined) {
          settled = { call: call.seq, ...outcome };
          break;
        }
      }
      if (settled === undefined)
        return {
          kind: "literature",
          input,
          parent: fold.owner,
        };
      if (settled.report !== undefined) fold.literatureStatus = "completed";
      const count = fold.projection.at(fold.cursor).length;
      const notes = (settled.report?.notes ?? []).map((note, index) => ({
        id: noteIdAfter(count, index),
        text: note.text,
        support: note.support.map((id) => noteIdAfter(count, id - 1)),
      }));
      fold.projection.add(notes, settled.settled);
      fold.noteSubmissions.push({
        call: settled.call,
        noteIds: notes.map((note) => note.id),
      });
      fold.cursor = settled.settled;
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
      fold.emptySubmission = turn.emptySubmission;
    } else if ("explorerGuidance" in action) {
      const overlap = replayOverlap(fold, action);
      if ("kind" in overlap) return overlap;
      fold.emptySubmission = overlap.emptySubmission;
    } else {
      const verification = replayVerification(fold, action.verify);
      if (verification !== undefined) return verification;
    }
  }
}

export class Workflow {
  private checkpoint: Fold;
  private readonly verdicts: VerdictHistory;
  private latest: { through: number; snapshot: WorkflowSnapshot } | undefined;

  constructor(private readonly source: RecordSource) {
    this.checkpoint = openFold(historyAt(source, source.lastSequence()));
    this.verdicts = new VerdictHistory(source);
  }

  read(): WorkflowSnapshot {
    const through = this.source.lastSequence();
    if (this.latest?.through === through) return this.latest.snapshot;
    const source = historyAt(this.source, through);
    const verdicts = this.verdicts.read(through);
    const allowances = turnAllowances(
      source.records({ kinds: ["call"], labels: [allowanceLabel] }),
    );
    const { after: _, through: __, ...checkpoint } = this.checkpoint;
    const fold: Fold = {
      ...checkpoint,
      source,
      inboxRecords: source.records({
        kinds: ["call"],
        labels: [
          "xean-solve/notes",
          "xean-solve/guidance",
          boundaryLabels.inbox,
        ],
      }),
      base: {
        ...checkpoint.base,
        allowances,
        maxTurns: allowances.at(-1)!.maxTurns,
      },
      verdicts,
      projection: checkpoint.projection.fork(verdicts),
      noteSubmissions: [...checkpoint.noteSubmissions],
    };
    const phase = replay(fold, (completed) => {
      this.checkpoint = {
        ...completed,
        inboxRecords: [],
        projection: completed.projection.fork(),
        noteSubmissions: [...completed.noteSubmissions],
      };
    });
    const snapshot = {
      ...fold.base,
      noteSubmissions: fold.noteSubmissions,
      notes: fold.projection.at(fold.through ?? fold.cursor),
      phase,
      ...(fold.after === undefined ? {} : { after: fold.after }),
    };
    this.latest = { through, snapshot };
    return snapshot;
  }
}

export function deriveWorkflow(
  records: readonly Entry[] | RecordSource,
): WorkflowSnapshot {
  return new Workflow(recordSource(records)).read();
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

type RolePhase = Exclude<WorkflowPhase, WorkflowTerminal | OverlapPhase>;

/** Serial and overlapping dispatches use the same owned calls and completion loop. */
export async function runWorkflow(
  campaign: Campaign,
  roles: RoleHost,
  dependencies: WorkflowDependencies = {},
  workflow = new Workflow(campaign),
): Promise<WorkflowPhase> {
  const read = () => workflow.read();
  let snapshot = read();
  const active = new Map<
    string,
    { controller: AbortController; done: Promise<RolePhase> }
  >();
  const blocked = new Set<string>();
  let failure: unknown;
  const cancel = () => {
    for (const call of active.values()) call.controller.abort();
  };
  const execute = async (step: RolePhase, signal: AbortSignal) => {
    switch (step.kind) {
      case "explorer":
        await roles.explorer(step.input, signal, step.parent);
        break;
      case "verifier":
        await roles.verifier(
          step.input,
          step.verification,
          signal,
          step.parent,
        );
        break;
      case "coordinator":
        await roles.coordinator(step.input, step.parent, signal);
        break;
      case "literature":
        await roles.literature(step.input, step.parent, signal);
        break;
    }
  };
  try {
    for (;;) {
      const phase = snapshot.phase;
      const accepted =
        phase.kind === "accepted" ||
        (phase.kind === "overlap" && phase.accepted !== undefined);
      if (accepted || failure !== undefined || dependencies.signal?.aborted)
        cancel();
      if (active.size === 0) {
        if (
          phase.kind === "overlap" &&
          phase.opened !== undefined &&
          (accepted ||
            (phase.explorer === undefined && phase.verifier === undefined))
        ) {
          await campaign.call(
            {
              label: overlapJoinLabel,
              parent: phase.opened,
              request: { schemaVersion: 1, after: phase.opened },
            },
            async () => null,
          );
          if (accepted) failure = undefined;
          snapshot = read();
          continue;
        }
        if (phase.kind === "accepted" || phase.kind === "turn-limit")
          return phase;
        if (failure !== undefined) throw failure;
        dependencies.signal?.throwIfAborted();
        if (dependencies.pauseRequested?.()) return phase;
        if (
          snapshot.after !== undefined &&
          (await notesInbox.freeze(campaign, snapshot.after))
        ) {
          snapshot = read();
          continue;
        }
        if (
          phase.kind === "explorer" ||
          (phase.kind === "overlap" && phase.opened === undefined)
        ) {
          if (
            await guidanceInbox.freeze(
              campaign,
              phase.kind === "overlap" ? phase.after : snapshot.after!,
            )
          ) {
            snapshot = read();
            continue;
          }
          if (phase.kind === "overlap") {
            await campaign.call(
              {
                label: boundaryLabels.overlap,
                parent: phase.parent,
                request: phase.request,
              },
              async () => null,
            );
            snapshot = read();
            continue;
          }
        }
      }
      dependencies.status?.(phase.kind);
      const ready =
        phase.kind === "overlap"
          ? [phase.explorer, phase.verifier]
          : phase.kind === "accepted" || phase.kind === "turn-limit"
            ? []
            : [phase];
      if (
        !accepted &&
        failure === undefined &&
        !dependencies.signal?.aborted &&
        !dependencies.pauseRequested?.()
      ) {
        for (const step of ready) {
          if (
            step === undefined ||
            active.has(step.kind) ||
            blocked.has(step.kind)
          )
            continue;
          const controller = new AbortController();
          const signal = dependencies.signal
            ? AbortSignal.any([controller.signal, dependencies.signal])
            : controller.signal;
          const done = execute(step, signal)
            .catch((error) => {
              failure ??= error;
              cancel();
            })
            .then(() => step);
          active.set(step.kind, { controller, done });
        }
      }
      if (active.size === 0) return phase;
      const completed = await Promise.race(
        [...active.values()].map((call) => call.done),
      );
      active.delete(completed.kind);
      snapshot = read();
      const next =
        snapshot.phase.kind === "overlap"
          ? completed.kind === "explorer"
            ? snapshot.phase.explorer
            : snapshot.phase.verifier
          : snapshot.phase;
      if (isDeepStrictEqual(next, completed)) blocked.add(completed.kind);
      else blocked.delete(completed.kind);
    }
  } finally {
    cancel();
    await Promise.all([...active.values()].map((call) => call.done));
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
