import type { Campaign, Entry, EntryId, Json } from "xean";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { Projection } from "./projection";
import { turnAllowances } from "./allowance";
import { explorerGuidance, freezeExplorerGuidance } from "./guidance";
import { freezeSubmittedNotes, submittedNotesBoundary } from "./notes";
import { byId, supportClosure } from "./support";
import {
  coordinatorCall,
  explorerCall,
  literatureCall,
  localLiteratureRequest,
  RoleCallError,
  sameRequest,
  solveSettings,
  verifierCall,
  type RoleCall,
} from "./pi-roles";
import { codexRequest, codexSubmission } from "./source";
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
  returnedOutput,
  literatureInput,
  literatureReport,
  literatureResult,
  workflowRecords,
  type CoordinatorInput,
  type ExplorerInput,
  type LiteratureInput,
  type LiteratureResult,
  type LiteratureStatus,
  type Note,
  type RoleName,
  type Roles,
  type Task,
  type Verification,
  type VerifierInput,
} from "./roles";

export const workflowSchemaVersion = 15;
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
  | { readonly kind: "literature"; readonly input: LiteratureInput }
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
  readonly maxExplorerTurns: number;
  readonly notes: readonly Note[];
  /** Discovery packets returned by the optional literature role. */
  readonly literature: readonly LiteratureResult[];
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
  if (config.settings.workflowMode === "coordinator")
    return deriveCoordinatorWorkflow(records);
  const allowances = turnAllowances(records);
  const maxExplorerTurns = allowances.at(-1)?.maxExplorerTurns;
  if (maxExplorerTurns === undefined)
    throw new Error("campaign has no initial turn allowance; run init first");
  const base = { config, allowances, maxExplorerTurns, literature: [] };
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
        support: entry.support.map((reference) =>
          typeof reference === "number"
            ? noteIdAfter(count, reference - 1)
            : reference,
        ),
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
  while (turns < maxExplorerTurns) {
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
            ...base,
            noteSubmissions,
            notes: known,
            phase: { kind: "explorer", input: explorerRequest },
            explorerAfter: cursor,
            notesAfter: cursor,
          };
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
          if (notes.length > 0) projection.add(notes, saved.settled);
          selected.push(...notes.map(({ id }) => id));
          known = projection.at(saved.settled);
        }
        if (completed !== undefined) {
          emptySubmission = saved?.emptySubmission === true;
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
      coordinatorBehavior: config.settings.coordinatorBehavior,
      ...(emptySubmission ? { emptySubmission: true } : {}),
    });
    const coordinated = settledCall(
      records,
      cursor,
      coordinatorCall(coordinatorRequest),
    );
    if (coordinated === undefined) {
      return {
        ...base,
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
        if (verifiers.includes("source")) available.add(note);
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
      // Correctness opens every verification and freezes its complete proof input.
      const judged = judgedBy(verifierRequest, [], "correctness");
      const first = firstCall(
        records,
        cursor,
        "verifier",
        verifierLabels.correctness,
        await verifierCall("correctness", verifierRequest, judged),
      );
      if (first === undefined) {
        return {
          ...base,
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
          ...base,
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
          ...base,
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
    ...base,
    noteSubmissions,
    notes: ended,
    phase: {
      kind: "turn-limit",
      turns,
      notes: ended,
    },
  };
}

/** Read successfully returned discovery packets without treating them as notes or proof evidence. */
function literatureRequestFromCall(request: Json): string | undefined {
  const local = localLiteratureRequest.safeParse(request);
  if (local.success) return literatureRequestFromCall(local.data.request);
  const codex = codexRequest.safeParse(request);
  if (!codex.success) return undefined;
  try {
    const value = JSON.parse(codex.data.prompt) as {
      readonly request?: unknown;
    };
    return typeof value.request === "string" ? value.request : undefined;
  } catch {
    return undefined;
  }
}

function recordedLiterature(
  records: readonly Entry[],
  through: EntryId,
): LiteratureResult[] {
  const packets: LiteratureResult[] = [];
  for (const entry of records) {
    if (
      entry.kind !== "call" ||
      entry.seq > through ||
      entry.role !== "literature" ||
      entry.label !== roleLabels.literature
    )
      continue;
    try {
      const local = localLiteratureRequest.safeParse(entry.request);
      const output = returnedOutput(records, entry.seq);
      const submission = codexSubmission(records, entry.seq);
      const expected = literatureRequestFromCall(entry.request);
      if (expected === undefined) continue;
      if (local.success && output !== undefined) {
        const parsed = literatureResult.safeParse(output.output);
        if (parsed.success && parsed.data.request === expected)
          packets.push(parsed.data);
      } else if (submission !== undefined) {
        const parsed = literatureReport.safeParse(submission.input);
        if (parsed.success)
          packets.push({ request: expected, report: parsed.data.report });
      }
    } catch {
      // An unfinished or malformed discovery call remains visible in the
      // journal, but it is not durable coordinator context.
    }
  }
  return packets;
}

function literatureSearchStatus(
  records: readonly Entry[],
  through: EntryId,
): LiteratureStatus {
  const attempted = records.some(
    (entry) =>
      entry.kind === "call" &&
      entry.seq <= through &&
      entry.role === "literature" &&
      entry.label === roleLabels.literature,
  );
  if (!attempted) return "not-started";
  for (const entry of records) {
    if (
      entry.kind !== "call" ||
      entry.seq > through ||
      entry.role !== "literature" ||
      entry.label !== roleLabels.literature ||
      localLiteratureRequest.safeParse(entry.request).success
    )
      continue;
    try {
      const submission = codexSubmission(records, entry.seq);
      if (
        submission !== undefined &&
        literatureReport.safeParse(submission.input).success
      )
        return "completed";
    } catch {
      // A failed or malformed provider call is inconclusive, even when its
      // local fallback report remains visible to the coordinator.
    }
  }
  return "inconclusive";
}

function firstLiteratureCall(
  records: readonly Entry[],
  after: EntryId,
  request: Json,
): CallEntry | undefined {
  for (const entry of records) {
    if (
      entry.kind === "call" &&
      entry.seq > after &&
      entry.role === "literature" &&
      entry.label === roleLabels.literature &&
      (isDeepStrictEqual(entry.request, request) ||
        (() => {
          const local = localLiteratureRequest.safeParse(entry.request);
          return (
            local.success && isDeepStrictEqual(local.data.request, request)
          );
        })())
    ) {
      return entry;
    }
  }
  return undefined;
}

function settledLiteratureCall(
  records: readonly Entry[],
  after: EntryId,
  request: Json,
  expectedRequest: string,
): { readonly settled: EntryId; readonly value: LiteratureResult } | undefined {
  for (
    let call = firstLiteratureCall(records, after, request);
    call !== undefined;
    call = firstLiteratureCall(records, call.seq, request)
  ) {
    try {
      const local = localLiteratureRequest.safeParse(call.request);
      const output = returnedOutput(records, call.seq);
      const submission = codexSubmission(records, call.seq);
      const value =
        local.success && output !== undefined
          ? (() => {
              const parsed = literatureResult.safeParse(output.output);
              return parsed.success && parsed.data.request === expectedRequest
                ? parsed.data
                : undefined;
            })()
          : submission === undefined
            ? undefined
            : (() => {
                const parsed = literatureReport.safeParse(submission.input);
                return parsed.success
                  ? { request: expectedRequest, report: parsed.data.report }
                  : undefined;
              })();
      if (value !== undefined) {
        return {
          settled: output !== undefined ? output.settled : submission!.settled,
          value,
        };
      }
    } catch {
      // Retry from the next journal boundary; the malformed call is retained.
    }
  }
  return undefined;
}

function acceptedControllerPhase(
  records: readonly Entry[],
  projection: Projection,
  cursor: EntryId,
  base: Omit<
    WorkflowSnapshot,
    "phase" | "notes" | "noteSubmissions" | "literature"
  > & {
    readonly literature: readonly LiteratureResult[];
  },
  turns: number,
  noteSubmissions: readonly {
    readonly call: EntryId;
    readonly noteIds: readonly string[];
  }[],
): Promise<WorkflowSnapshot | undefined> {
  const accepted = projection.accepted(cursor);
  if (accepted.length === 0) return Promise.resolve(undefined);
  const notes = projection.at(cursor);
  const noteId = accepted.at(-1)!;
  const candidate = journalVerdicts(
    records.filter((entry) => entry.seq <= cursor),
  ).findLast(({ verdict }) => verdict.note === noteId)?.candidate;
  if (candidate === undefined)
    throw new Error(`accepted note ${noteId} has no candidate`);
  return supportClosure([pick(notes, noteId)], notes).then((closure) => ({
    ...base,
    noteSubmissions,
    notes,
    phase: {
      kind: "accepted" as const,
      turns,
      note: pick(notes, noteId),
      notes,
      candidate,
      closure,
    },
  }));
}

/**
 * Experimental controller loop. Every completed role returns to a fresh
 * coordinator decision; literature discovery is durable context, never a
 * verifier result. The fixed Explorer -> coordinator -> verifier loop above
 * remains the default mode for comparison.
 */
async function deriveCoordinatorWorkflow(
  records: readonly Entry[],
): Promise<WorkflowSnapshot> {
  const config = parseConfig(records[0]);
  const allowances = turnAllowances(records);
  const maxExplorerTurns = allowances.at(-1)?.maxExplorerTurns;
  if (maxExplorerTurns === undefined)
    throw new Error("campaign has no initial turn allowance; run init first");
  const base = { config, allowances, maxExplorerTurns };
  const verdicts = journalVerdicts(records);
  const projection = new Projection(verdicts);
  let cursor = records[0]!.seq;
  let guidance = "";
  let support: readonly string[] = [];
  let turns = 0;
  let dispatches = 0;
  let pendingEmptySubmission = false;
  const noteSubmissions: { call: EntryId; noteIds: string[] }[] = [];
  const includeSubmitted = (after: EntryId): boolean => {
    const boundary = submittedNotesBoundary(records, after);
    if (boundary === undefined) return false;
    let count = projection.at(after).length;
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

  for (;;) {
    const literature = recordedLiterature(records, cursor);
    const accepted = await acceptedControllerPhase(
      records,
      projection,
      cursor,
      { ...base, literature },
      turns,
      noteSubmissions,
    );
    if (accepted !== undefined) return accepted;
    if (dispatches >= config.settings.maxCoordinatorSteps) {
      const notes = projection.at(cursor);
      return {
        ...base,
        literature,
        noteSubmissions,
        notes,
        phase: { kind: "turn-limit", turns, notes },
      };
    }

    const included = includeSubmitted(cursor);
    const literatureAtCoordinator = recordedLiterature(records, cursor);
    const literatureStatusAtCoordinator = literatureSearchStatus(
      records,
      cursor,
    );
    const coordinatorRequest = coordinatorInput.parse({
      task: config.task,
      notes: projection.at(cursor),
      literature: literatureAtCoordinator,
      literatureStatus: literatureStatusAtCoordinator,
      coordinatorBehavior: config.settings.coordinatorBehavior,
      ...(pendingEmptySubmission ? { emptySubmission: true } : {}),
    });
    const coordinated = settledCall(
      records,
      cursor,
      coordinatorCall(coordinatorRequest, "coordinator"),
    );
    if (coordinated === undefined) {
      return {
        ...base,
        literature: literatureAtCoordinator,
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
    pendingEmptySubmission = false;
    const action = coordinated.value.action;
    if (action === undefined)
      throw new Error("controller coordinator returned no role action");
    dispatches += 1;

    if (action.role === "literature") {
      const input = literatureInput.parse({
        task: config.task,
        request: action.request,
        prior: recordedLiterature(records, cursor),
      });
      const call = literatureCall(
        input,
        config.settings.source,
        config.settings.maxSourceWebActions,
      );
      const settled = settledLiteratureCall(
        records,
        cursor,
        call.request,
        input.request,
      );
      if (settled === undefined) {
        return {
          ...base,
          literature: recordedLiterature(records, cursor),
          noteSubmissions,
          notes: projection.at(cursor),
          phase: { kind: "literature", input },
        };
      }
      cursor = settled.settled;
      continue;
    }

    if (action.role === "explorer") {
      if (turns >= maxExplorerTurns) {
        const notes = projection.at(cursor);
        return {
          ...base,
          literature: recordedLiterature(records, cursor),
          noteSubmissions,
          notes,
          phase: { kind: "turn-limit", turns, notes },
        };
      }
      let after = cursor;
      let known = projection.at(cursor);
      const selected = [...support];
      const advice = explorerGuidance(records, cursor, guidance);
      for (;;) {
        const explorerRequest = explorerInput.parse({
          task: config.task,
          explorerGuidance: advice,
          notes: known.map(({ text, ...rest }) => rest),
          literature: recordedLiterature(records, cursor),
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
            ...base,
            literature: recordedLiterature(records, cursor),
            noteSubmissions,
            notes: known,
            phase: { kind: "explorer", input: explorerRequest },
            explorerAfter: cursor,
            notesAfter: cursor,
          };
        }
        const saved = savedExplorerSubmission(records, call.seq);
        const completed = succeededSubmission(
          records,
          call.seq,
          roleCall.tool,
          saved,
        );
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
          pendingEmptySubmission = saved?.emptySubmission === true;
          cursor = completed.settled;
          turns += 1;
          break;
        }
        after = call.seq;
      }
      continue;
    }

    const filed = projection.at(cursor);
    const verify = await verificationPrefix(
      coordinated.value.verify,
      filed,
      config.settings.window,
    );
    if (verify.length === 0)
      throw new Error("controller verifier action selected no fitting note");
    const listed = verify.map(({ note }) => pick(filed, note));
    const verifierRequest = await verifierInput.parseAsync({
      task: config.task,
      verify,
      notes: listed,
      support: (await supportClosure(listed, filed)).map((id) =>
        pick(filed, id),
      ),
    });
    const judged = judgedBy(verifierRequest, [], "correctness");
    const first = firstCall(
      records,
      cursor,
      "verifier",
      verifierLabels.correctness,
      await verifierCall("correctness", verifierRequest, judged),
    );
    if (first === undefined) {
      return {
        ...base,
        literature: recordedLiterature(records, cursor),
        noteSubmissions,
        notes: filed,
        phase: { kind: "verifier", input: verifierRequest },
      };
    }
    const candidate = first.candidate;
    if (candidate === undefined)
      throw new Error(`verifier call ${first.seq} is not bound to a candidate`);
    const recorded = verdicts.filter(({ candidate: id }) => id === candidate);
    cursor = Math.max(cursor, ...recorded.map(({ seq }) => seq));
    const acceptedAfterVerification = await acceptedControllerPhase(
      records,
      projection,
      cursor,
      { ...base, literature: recordedLiterature(records, cursor) },
      turns,
      noteSubmissions,
    );
    if (acceptedAfterVerification !== undefined)
      return acceptedAfterVerification;
    if (
      !verificationComplete(
        verifierRequest,
        recorded.map(({ verdict }) => verdict),
      )
    ) {
      return {
        ...base,
        literature: recordedLiterature(records, cursor),
        noteSubmissions,
        notes: projection.at(cursor),
        phase: { kind: "verifier", input: verifierRequest, candidate },
      };
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
        await roles.literature(phase.input);
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
