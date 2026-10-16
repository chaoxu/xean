import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { createRoleRuntime } from "./role-runtime.ts";
import { Notebook, definition, project } from "./state.ts";
import {
  coordinatorResultFor,
  explorerInput,
  explorerResultFor,
  noteIdAfter,
  pick,
  sourceVerdictsFor,
  verifierInput,
  type Verification,
  type VerifierInput,
  type Verdict,
} from "./policy/contracts.ts";
import { resolveCall, type CallDescriptor } from "./policy/prompts.ts";
import type { PiRoleProfile, SolveSettings } from "./policy/settings.ts";
import { supportClosure, byId } from "./policy/support.ts";
import { verificationPrefix } from "./policy/verification.ts";
import {
  codexTranscript,
  type CodexRequest,
  type CodexResult,
} from "./policy/source.ts";
import { verify } from "./verification.ts";

type Runtime = TaskRuntime<any, any, any, any>;
export type Executor = (
  descriptor: CallDescriptor,
  profile: PiRoleProfile,
  runtime: Runtime,
  context: Context,
) => Promise<{ value: JsonValue; call?: number; fresh?: boolean }>;
export type SourceExecutor = (
  request: CodexRequest,
  signal: AbortSignal,
) => Promise<CodexResult>;
type CallResult = { value: JsonValue; call: number; fresh: boolean };
type WorkerInput = (
  | { kind: "call"; descriptor: CallDescriptor; profile: PiRoleProfile }
  | {
      kind: "verify";
      input: VerifierInput;
      settings: SolveSettings;
      candidate?: number;
    }
) & { previousTasks?: number[] };
type WorkerResult =
  { ok: true; value: JsonValue } | { ok: false; error: string };
type Step = "explorer" | "coordinator" | "verifier";
export type CampaignState = ({ phase: "next" } | { phase: "collect" }) & {
  step: Step;
  turns: number;
  guidance: string;
  guidanceThrough: number;
  support: string[];
  pending: Verification[];
  child?: number;
  request?: WorkerInput;
  batchSize?: number;
};
export type CampaignResult = {
  outcome: "accepted" | "turn-limit" | "call-failure" | "paused";
  turns: number;
  accepted?: string;
  error?: string;
  resume?: CampaignState;
};
export const campaignKind = "xean.campaign";
const ResultEntry = defineEntry<{
  key: string;
  value: JsonValue;
  descriptor?: JsonValue;
  profile?: JsonValue;
}>("xean.role-result");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const abort = async (_task: unknown, runtime: Runtime, context: Context) => {
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  );
};

export async function lastCampaign(tx: Tx, root: ConversationId) {
  const tasks: any[] = [];
  let cursor;
  do {
    const page = await tx.scanTasks(
      { conversationId: root, kind: campaignKind },
      128,
      cursor,
    );
    tasks.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return tasks.at(-1);
}

/** Pi owns execution and recovery. These tasks retain v1's research decisions. */
export function createWorkflow(
  options: { execute?: Executor; source?: SourceExecutor } = {},
) {
  const roles = createRoleRuntime();
  async function call(
    runtime: Runtime,
    context: Context,
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
    previousTasks: number[] = [],
  ): Promise<CallResult> {
    if (!options.execute)
      return roles.run(
        runtime,
        key,
        descriptor,
        profile,
        context,
        previousTasks as TaskId[],
      );
    const saved = await runtime.memo<CallResult>(`role/${key}`, context);
    if (saved) return { ...saved, fresh: false };
    let prior: CallResult | undefined;
    const owners = [runtime.taskId, ...previousTasks];
    await runtime.commit(async (tx) => {
      let cursor;
      do {
        const page = await tx.scanEntries(
          { conversationId: runtime.conversationId },
          128,
          cursor,
        );
        for (const entry of page.items)
          if (
            ResultEntry.is(entry) &&
            entry.byTaskId !== undefined &&
            owners.includes(entry.byTaskId) &&
            entry.data.key === key &&
            JSON.stringify(entry.data.descriptor) ===
              JSON.stringify(descriptor) &&
            JSON.stringify(entry.data.profile) === JSON.stringify(profile)
          ) {
            prior = { call: entry.id, value: entry.data.value, fresh: false };
            return;
          }
        cursor = page.next;
      } while (cursor);
    }, context);
    if (prior) return prior;
    const result = await options.execute(descriptor, profile, runtime, context);
    const spec = await resolveCall(descriptor);
    const value = (await spec.schema.parseAsync(result.value)) as JsonValue;
    let id!: number;
    await runtime.commit(async (tx) => {
      id = (
        await tx.appendEntry(ResultEntry, runtime.conversationId, {
          data: {
            key,
            value,
            descriptor: copy(descriptor) as JsonValue,
            profile,
          },
        })
      ).id;
    }, context);
    return runtime.memo(
      `role/${key}`,
      { value, call: id, fresh: result.fresh ?? true },
      context,
    );
  }

  const Worker = defineTask<WorkerInput, { phase: "run" }, WorkerResult>({
    name: "xean.worker",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort,
    phases: {
      async run(task, runtime, context) {
        let result: WorkerResult;
        try {
          if (task.input.kind === "call") {
            const answer = await call(
              runtime,
              context,
              "role",
              task.input.descriptor,
              task.input.profile,
              task.input.previousTasks as TaskId[],
            );
            result = { ok: true, value: answer.value };
          } else {
            const input = task.input;
            const candidate = input.candidate ?? task.id;
            const recorded = async (): Promise<Verdict[]> => {
              let values: Verdict[] = [];
              await runtime.commit(async (tx) => {
                const book = await tx.doc(Notebook, task.conversationId);
                values = copy(
                  book.checks
                    .filter((c) => c.candidate === candidate)
                    .flatMap((c) => c.values),
                );
              }, context);
              return values;
            };
            const values = await verify(input.input, input.settings, {
              call: (key, descriptor, profile) =>
                call(
                  runtime,
                  context,
                  key,
                  descriptor,
                  profile,
                  input.previousTasks,
                ),
              recorded,
              record: async (id, values) => {
                await runtime.commit(async (tx) => {
                  const book = await tx.doc(Notebook, task.conversationId);
                  if (!book.checks.some((check) => check.call === id))
                    book.checks.push({
                      candidate,
                      call: id,
                      values: copy(values),
                    });
                }, context);
              },
              source: async (key, request) => {
                if (!options.source)
                  throw new Error("Codex source execution is not registered");
                const judged = key.slice("source/".length).split(",");
                const validate = (output: CodexResult) => {
                  if (output.state !== "succeeded")
                    throw new Error(`verifier failed: ${output.error}`);
                  const parsed = codexTranscript(output.stdout);
                  const value = sourceVerdictsFor(judged).parse(
                    JSON.parse(parsed.message),
                  );
                  if (
                    (value.verdicts.some((v) => v.sources.length) &&
                      parsed.searches === 0) ||
                    (!request.search && parsed.searches !== 0)
                  )
                    throw new Error(
                      "Source claims do not match observed search activity",
                    );
                  return value;
                };
                let prior:
                  | { call: number; value: ReturnType<typeof validate> }
                  | undefined;
                const owners = [task.id, ...(input.previousTasks ?? [])];
                await runtime.commit(async (tx) => {
                  let cursor;
                  do {
                    const page = await tx.scanEntries(
                      { conversationId: task.conversationId },
                      128,
                      cursor,
                    );
                    for (const entry of page.items) {
                      if (
                        !ResultEntry.is(entry) ||
                        entry.byTaskId === undefined ||
                        !owners.includes(entry.byTaskId) ||
                        entry.data.key !== key ||
                        JSON.stringify(entry.data.descriptor) !==
                          JSON.stringify(request)
                      )
                        continue;
                      try {
                        prior = {
                          call: entry.id,
                          value: validate(entry.data.value as CodexResult),
                        };
                        return;
                      } catch {
                        /* Failed calls remain evidence, not reusable answers. */
                      }
                    }
                    cursor = page.next;
                  } while (cursor);
                }, context);
                if (prior) return prior;
                const output = await options.source(request, runtime.signal);
                let id!: number;
                await runtime.commit(async (tx) => {
                  id = (
                    await tx.appendEntry(ResultEntry, task.conversationId, {
                      data: {
                        key,
                        value: copy(output) as JsonValue,
                        descriptor: copy(request) as JsonValue,
                      },
                    })
                  ).id;
                }, context);
                return { call: id, value: validate(output) };
              },
            });
            result = { ok: true, value: copy(values) as JsonValue };
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          result = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result },
          }),
          context,
        );
      },
    },
  });

  const Campaign = defineTask<
    { resume?: CampaignState },
    CampaignState,
    CampaignResult
  >({
    name: campaignKind,
    version: 1,
    initial: (input) =>
      input.resume ?? {
        phase: "next",
        step: "explorer",
        turns: 0,
        guidance: "",
        guidanceThrough: 0,
        support: [],
        pending: [],
      },
    abort,
    phases: {
      async next(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const state: CampaignState = copy(
            task.state.checkpoint,
          ) as CampaignState;
          const config = await definition(tx, task.conversationId);
          const book = await tx.doc(Notebook, task.conversationId);
          let { notes, accepted } = project(copy(book));
          if (accepted.length)
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  outcome: "accepted",
                  turns: state.turns,
                  accepted: accepted[0]!,
                },
              },
            };
          if (!state.request) {
            if (state.step === "verifier") {
              const available = new Set(
                notes.filter((n) => n.verified).map((n) => n.id),
              );
              state.pending = state.pending.filter((entry) => {
                const note = pick(notes, entry.note);
                if (note.dead || note.support.some((id) => !available.has(id)))
                  return false;
                if (entry.verifiers.includes("correctness"))
                  available.add(note.id);
                return true;
              });
              if (!state.pending.length) state.step = "explorer";
            }
            if (
              state.step === "explorer" &&
              state.turns >= config.settings.maxExplorerTurns
            )
              return {
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: { outcome: "turn-limit", turns: state.turns },
                },
              };
            // V1 imports only before a fresh Explorer or its Coordinator handoff.
            // A failed request already names its future notes, so its intake stays frozen.
            if (state.step === "explorer" || state.step === "coordinator") {
              const imported = book.inputs.filter((input) => !input.consumed);
              for (const input of imported) {
                for (const note of input.notes)
                  book.notes.push({
                    ...copy(note),
                    id: noteIdAfter(book.notes.length, 0),
                  });
                input.consumed = true;
              }
              if (imported.length) {
                notes = project(copy(book)).notes;
                if (state.step === "explorer") state.step = "coordinator";
              }
            }
            if (state.step === "explorer") {
              const freshGuidance = book.guidance
                .slice(state.guidanceThrough)
                .map((v) => v.text);
              state.guidanceThrough = book.guidance.length;
              const guidance = [state.guidance, ...freshGuidance]
                .filter(Boolean)
                .join("\n\n");
              const ids = [
                ...new Set([
                  ...state.support,
                  ...(await supportClosure(
                    state.support.map((id) => pick(notes, id)),
                    notes,
                  )),
                ]),
              ].sort(byId);
              const input = explorerInput.parse({
                task: config.task,
                explorerGuidance: guidance,
                notes: notes.map(({ text: _text, ...note }) => note),
                support: ids.map((id) => pick(notes, id)),
              });
              state.request = {
                kind: "call",
                profile: config.settings.explorer,
                descriptor: {
                  kind: "explorer",
                  input,
                  continuation: config.settings.explorerContinuation === true,
                  ...(config.settings.explorerContextBudgetTokens
                    ? {
                        contextBudgetTokens:
                          config.settings.explorerContextBudgetTokens,
                      }
                    : {}),
                },
              };
            } else if (state.step === "coordinator") {
              state.request = {
                kind: "call",
                profile: config.settings.coordinator,
                descriptor: {
                  kind: "coordinator",
                  input: { task: config.task, notes },
                },
              };
            } else {
              const batch = await verificationPrefix(
                state.pending,
                notes,
                config.settings.window,
              );
              const listed = batch.map((entry) => pick(notes, entry.note));
              const input = await verifierInput.parseAsync({
                task: config.task,
                verify: batch,
                notes: listed,
                support: (await supportClosure(listed, notes)).map((id) =>
                  pick(notes, id),
                ),
              });
              state.batchSize = batch.length;
              state.request = {
                kind: "verify",
                input,
                settings: config.settings,
              };
            }
          }
          const child = await tx.createTask(Worker, state.request, {
            conversationId: task.conversationId,
            ownership: { kind: "task", taskId: task.id },
          });
          return {
            status: "waiting",
            on: [child],
            policy: "allSettled",
            checkpoint: { ...state, phase: "collect", child },
          };
        }, context);
      },
      async collect(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const state: CampaignState = copy(
            task.state.checkpoint,
          ) as CampaignState;
          const child = await tx.task(state.child! as TaskId);
          const outcome = child?.state.outcome;
          const result =
            outcome?.status === "completed"
              ? (outcome.result as WorkerResult)
              : undefined;
          if (!result || !result.ok) {
            const request = state.request!;
            request.previousTasks = [
              ...(request.previousTasks ?? []),
              state.child!,
            ];
            if (request.kind === "verify") request.candidate ??= state.child!;
            delete state.child;
            state.phase = "next";
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  outcome: "call-failure",
                  turns: state.turns,
                  error:
                    result && !result.ok
                      ? result.error
                      : `Worker ${child?.id} did not complete`,
                  resume: state,
                },
              },
            };
          }
          const book = await tx.doc(Notebook, task.conversationId);
          if (state.step === "explorer") {
            const request = state.request!;
            if (
              request.kind !== "call" ||
              request.descriptor.kind !== "explorer"
            )
              throw new Error("Explorer request mismatch");
            const value = explorerResultFor(
              request.descriptor.input.notes,
              request.descriptor.continuation,
            ).parse(result.value);
            for (const note of value.notes)
              book.notes.push({
                ...note,
                id: noteIdAfter(book.notes.length, 0),
              });
            state.turns++;
            state.step = "coordinator";
          } else if (state.step === "coordinator") {
            const request = state.request!;
            if (
              request.kind !== "call" ||
              request.descriptor.kind !== "coordinator"
            )
              throw new Error("Coordinator request mismatch");
            const value = await coordinatorResultFor(
              request.descriptor.input.notes,
            ).parseAsync(result.value);
            for (const filing of value.filings)
              pick(book.notes, filing.note).summary = filing.summary;
            state.guidance = value.explorerGuidance;
            state.support = value.support;
            state.pending = value.verify;
            state.step = "verifier";
          } else {
            state.pending = state.pending.slice(state.batchSize);
          }
          delete state.child;
          delete state.request;
          delete state.batchSize;
          return { status: "running", checkpoint: { ...state, phase: "next" } };
        }, context);
      },
    },
  });

  const extension = defineExtension({
    ...roles.extension,
    tasks: [...(roles.extension.tasks ?? []), Campaign, Worker],
  });
  return {
    extension,
    initialize: (tx: Tx, root: ConversationId) =>
      tx.createTask(
        Campaign,
        {},
        { conversationId: root, ownership: { kind: "conversation" } },
      ),
    async resume(tx: Tx, root: ConversationId) {
      const previous = await lastCampaign(tx, root);
      if (previous && previous.state.status !== "terminal") return previous.id;
      const result = previous?.state.outcome?.result as
        CampaignResult | undefined;
      if (!result?.resume)
        throw new Error("Campaign has no failed or paused work to resume");
      return tx.createTask(
        Campaign,
        { resume: result.resume },
        { conversationId: root, ownership: { kind: "conversation" } },
      );
    },
  };
}
