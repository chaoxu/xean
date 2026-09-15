import type { Campaign, Entry, EntryId, Json } from "xean";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { Projection } from "./projection";
import { explorerGuidance, freezeExplorerGuidance } from "./guidance";
import { freezeSubmittedNotes, submittedNotesBoundary } from "./notes";
import { byId, supportClosure } from "./support";
import {
  coordinatorCall,
  explorerCall,
  RoleCallError,
  sameRequest,
  solveSettings,
  sourceCall,
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
  workflowRecords,
  type CoordinatorInput,
  type ExplorerInput,
  type Note,
  type RoleName,
  type Roles,
  type Task,
  type Verification,
  type VerifierInput,
} from "./roles";

export const workflowSchemaVersion = 7;
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

export async function deriveWorkflow(
  records: readonly Entry[],
): Promise<WorkflowSnapshot> {
  const config = parseConfig(records[0]);
  const verdicts = journalVerdicts(records);
  const projection = new Projection(verdicts);
  // Replay projections use this historical cursor, not the journal's latest state.
  let cursor = records[0]!.seq;
  let guidance = "";
  let support: readonly string[] = [];
  let turns = 0;
  const noteSubmissions: { call: EntryId; noteIds: string[] }[] = [];
  const includeSubmitted = (after: EntryId) => {
    const boundary = submittedNotesBoundary(records, after);
    if (boundary === undefined) return false;
    let count = projection.at(after).length;
    for (const submission of boundary.submissions) {
      const entries = submission.notes.map((entry, index) => ({
        id: noteIdAfter(count, index),
        ...entry,
      }));
      projection.add(entries, boundary.call);
      noteSubmissions.push({
        call: submission.call,
        noteIds: entries.map(({ id }) => id),
      });
      count += entries.length;
    }
    cursor = boundary.call;
    return true;
  };
  while (turns < config.settings.maxExplorerTurns) {
    let emptySubmission = false;
    // A submitted note goes directly to the coordinator. Otherwise the
    // next explorer writes notes, which may be joined by pending submissions.
    let included = includeSubmitted(cursor);
    if (!included) {
      let after = cursor;
      let known = projection.at(cursor);
      const selected = [...support];
      // Advice stays frozen for the turn. A fresh call after interruption
      // also receives every note already saved by this turn, in full.
      const advice = explorerGuidance(records, cursor, guidance);
      for (;;) {
        const explorerRequest = explorerInput.parse({
          task: config.task,
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
          config.settings.explorerContinuation === true,
          config.settings.explorerContextBudgetTokens,
          config.settings.maxExplorerResponses,
        );
        const call = firstCall(
          records,
          after,
          roleCall.role,
          roleCall.label,
          roleCall,
        );
        if (call === undefined) {
          return {
            config,
            noteSubmissions,
            notes: known,
            phase: { kind: "explorer", input: explorerRequest },
            explorerAfter: cursor,
            notesAfter: cursor,
          };
        }
        const savedContinuation =
          config.settings.explorerContinuation === true
            ? savedExplorerSubmission(records, call.seq)
            : undefined;
        const completed = succeededSubmission(
          records,
          call.seq,
          roleCall.tool,
          savedContinuation,
        );
        // Saved notes become visible at the last tool call; the next phase
        // starts only at the outer call-result, which can occur later.
        const saved = savedContinuation ?? completed;
        if (saved !== undefined) {
          const value = roleCall.schema.parse(saved.input);
          const notes = value.notes.map((entry, position) => ({
            id: noteIdAfter(known.length, position),
            ...entry,
          }));
          if (notes.length > 0) projection.add(notes, saved.settled);
          selected.push(...notes.map(({ id }) => id));
          known = projection.at(saved.settled);
        }
        if (completed !== undefined) {
          emptySubmission = savedContinuation?.emptySubmission === true;
          cursor = completed.settled;
          turns += 1;
          break;
        }
        after = call.seq;
      }
      included = includeSubmitted(cursor);
    }
    const coordinatorRequest = coordinatorInput.parse({
      task: config.task,
      notes: projection.at(cursor),
      ...(emptySubmission ? { emptySubmission: true } : {}),
    });
    const coordinated = settledCall(
      records,
      cursor,
      coordinatorCall(coordinatorRequest),
    );
    if (coordinated === undefined) {
      return {
        config,
        noteSubmissions,
        notes: coordinatorRequest.notes,
        phase: { kind: "coordinator", input: coordinatorRequest },
        ...(included ? {} : { notesAfter: cursor }),
      };
    }
    cursor = coordinated.settled;
    projection.file(coordinated.value.filings, cursor);
    guidance = coordinated.value.explorerGuidance;
    support = coordinated.value.support;
    let remaining = coordinated.value.verify;
    while (remaining.length > 0) {
      const filed = projection.at(cursor);
      const available = new Set(
        filed.filter(({ verified }) => verified).map(({ id }) => id),
      );
      // Earlier batches may have refuted or left support inconclusive.
      // Retain independent work, and dependencies scheduled before their use.
      remaining = remaining.filter(({ note, verifiers }) => {
        const target = pick(filed, note);
        if (target.dead || target.support.some((id) => !available.has(id)))
          return false;
        if (verifiers.includes("correctness")) available.add(note);
        return true;
      });
      if (remaining.length === 0) break;
      const verify = await verificationPrefix(
        remaining,
        filed,
        config.settings.window,
      );
      const listed = verify.map(({ note }) => pick(filed, note));
      const verifierRequest = await verifierInput.parseAsync({
        task: config.task,
        verify,
        notes: listed,
        support: (await supportClosure(listed, filed)).map((id) =>
          pick(filed, id),
        ),
      });
      // The source call opens every verification with an exact Codex request.
      const judged = judgedBy(verifierRequest, [], "source");
      const first = firstCall(
        records,
        cursor,
        "verifier",
        verifierLabels.source,
        jsonSnapshot(
          (await sourceCall(config.settings.source, verifierRequest, judged))
            .request,
        ),
      );
      if (first === undefined) {
        return {
          config,
          noteSubmissions,
          notes: filed,
          phase: { kind: "verifier", input: verifierRequest },
        };
      }
      const candidate = first.candidate;
      if (candidate === undefined) {
        throw new Error(
          `verifier call ${first.seq} is not bound to a candidate`,
        );
      }
      const recorded = verdicts.filter(
        (entry) => entry.candidate === candidate,
      );
      cursor = Math.max(cursor, ...recorded.map(({ seq }) => seq));
      const accepted = projection.accepted(cursor);
      const acceptedId = verify
        .map(({ note }) => note)
        .find((id) => accepted.includes(id));
      if (acceptedId !== undefined) {
        const notes = projection.at(cursor);
        return {
          config,
          noteSubmissions,
          notes,
          phase: {
            kind: "accepted",
            turns,
            note: pick(notes, acceptedId),
            notes,
            candidate,
            closure: await supportClosure([pick(notes, acceptedId)], notes),
          },
        };
      }
      if (
        !verificationComplete(
          verifierRequest,
          recorded.map(({ verdict }) => verdict),
        )
      ) {
        return {
          config,
          noteSubmissions,
          notes: projection.at(cursor),
          phase: { kind: "verifier", input: verifierRequest, candidate },
        };
      }
      // Completed entries leave the queue even when their verdict was not PASS.
      remaining = remaining.slice(verify.length);
    }
  }
  const ended = projection.at(cursor);
  return {
    config,
    noteSubmissions,
    notes: ended,
    phase: {
      kind: "turn-limit",
      turns: config.settings.maxExplorerTurns,
      notes: ended,
    },
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
