import type { Campaign, Entry, EntryId, Json } from "elenx";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { Projection } from "./projection";
import { explorerGuidance, freezeExplorerGuidance } from "./guidance";
import { freezeSubmittedNotes, submittedNotesBoundary } from "./notes";
import { byId, SupportGraph } from "./support";
import {
  codexSource,
  coordinatorCall,
  explorerCall,
  sameRequest,
  solveSettings,
  sourceCall,
  verifierCall,
  type RoleCall,
} from "./pi-roles";
import {
  applicationId,
  coordinatorInput,
  explorerContinuationResult,
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

export const workflowSchemaVersion = 37;
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
    throw new Error("not an Elenx workflow campaign");
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
  graph?: SupportGraph,
): Promise<Verification[]> {
  const support = graph ?? new SupportGraph(notes);
  try {
    await support.prepare(verify.map(({ note }) => note));
    const read = new Set<string>();
    let reading = 0;
    let taken = 0;
    for (const entry of verify) {
      const note = pick(notes, entry.note);
      const added = [note.id, ...(await support.closure([note]))].filter(
        (id) => !read.has(id),
      );
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
  } finally {
    if (graph === undefined) support.close();
  }
}

export async function deriveWorkflow(
  records: readonly Entry[],
): Promise<WorkflowSnapshot> {
  const config = parseConfig(records[0]);
  const verdicts = journalVerdicts(records);
  const projection = await Projection.open(verdicts);
  let graph: SupportGraph | undefined;
  let graphSize = -1;
  const supportGraph = (notes: readonly Note[]) => {
    // Notes and support edges are immutable; filings and verdicts only change
    // metadata. Rebuild only when replay has added another note.
    if (notes.length !== graphSize) {
      graph?.close();
      graph = new SupportGraph(notes);
      graphSize = notes.length;
    }
    return graph!;
  };
  try {
    // Replay projections use this historical cursor, not the journal's latest state.
    let cursor = records[0]!.seq;
    let guidance = "";
    let support: readonly string[] = [];
    let turns = 0;
    const noteSubmissions: { call: EntryId; noteIds: string[] }[] = [];
    const includeSubmitted = async (after: EntryId) => {
      const boundary = submittedNotesBoundary(records, after);
      if (boundary === undefined) return false;
      let count = (await projection.at(after)).length;
      for (const submission of boundary.submissions) {
        const entries = submission.notes.map((entry, index) => ({
          id: noteIdAfter(count, index),
          ...entry,
        }));
        await projection.add(entries, boundary.call);
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
      let included = await includeSubmitted(cursor);
      if (!included) {
        let after = cursor;
        let known = await projection.at(cursor);
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
                ...(await supportGraph(known).closure(
                  selected.map((id) => pick(known, id)),
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
          const completed = succeededSubmission(
            records,
            call.seq,
            roleCall.tool,
          );
          const saved =
            config.settings.explorerContinuation === true
              ? savedExplorerSubmission(records, call.seq)
              : completed;
          if (saved !== undefined) {
            const value = roleCall.schema.parse(saved.input);
            const notes = value.notes.map((entry, position) => ({
              id: noteIdAfter(known.length, position),
              ...entry,
            }));
            if (notes.length > 0) await projection.add(notes, saved.settled);
            selected.push(...notes.map(({ id }) => id));
            known = await projection.at(saved.settled);
          }
          if (completed !== undefined) {
            const lastSubmission = records.findLast(
              (entry) =>
                entry.kind === "tool-call" &&
                entry.call === call.seq &&
                entry.tool === roleCall.tool,
            );
            emptySubmission =
              config.settings.explorerContinuation === true &&
              lastSubmission?.kind === "tool-call" &&
              explorerContinuationResult.parse(lastSubmission.input).notes
                .length === 0;
            cursor = completed.settled;
            turns += 1;
            break;
          }
          after = call.seq;
        }
        included = await includeSubmitted(cursor);
      }
      const coordinatorRequest = coordinatorInput.parse({
        task: config.task,
        notes: await projection.at(cursor),
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
      await projection.file(coordinated.value.filings, cursor);
      guidance = coordinated.value.explorerGuidance;
      support = coordinated.value.support;
      let remaining = coordinated.value.verify;
      while (remaining.length > 0) {
        const filed = await projection.at(cursor);
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
          supportGraph(filed),
        );
        const listed = verify.map(({ note }) => pick(filed, note));
        const verifierRequest = await verifierInput.parseAsync({
          task: config.task,
          verify,
          notes: listed,
          support: (await supportGraph(filed).closure(listed)).map((id) =>
            pick(filed, id),
          ),
        });
        // The source call opens every verification: a Codex request matched
        // exactly, or a Pi call matched by its prompt bytes.
        const judged = judgedBy(verifierRequest, [], "source");
        const first = firstCall(
          records,
          cursor,
          "verifier",
          verifierLabels.source,
          codexSource(config.settings.source)
            ? jsonSnapshot(
                (
                  await sourceCall(
                    config.settings.source,
                    verifierRequest,
                    judged,
                    supportGraph(filed),
                  )
                ).request,
              )
            : await verifierCall(
                "source",
                verifierRequest,
                judged,
                supportGraph(filed),
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
        const accepted = await projection.accepted(cursor);
        const acceptedId = verify
          .map(({ note }) => note)
          .find((id) => accepted.includes(id));
        if (acceptedId !== undefined) {
          const notes = await projection.at(cursor);
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
              closure: await supportGraph(notes).closure([
                pick(notes, acceptedId),
              ]),
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
            notes: await projection.at(cursor),
            phase: { kind: "verifier", input: verifierRequest, candidate },
          };
        }
        // Completed entries leave the queue even when their verdict was not PASS.
        remaining = remaining.slice(verify.length);
      }
    }
    const ended = await projection.at(cursor);
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
  } finally {
    graph?.close();
    projection.close();
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
  readonly settings: z.output<typeof solveSettings>;
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
