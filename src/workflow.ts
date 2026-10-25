import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type EntryId,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { createRoleRuntime, Assignment } from "./role-runtime.ts";
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
  type ReconstructionRef,
  type ReconstructionPremise,
} from "./policy/contracts.ts";
import type { CallDescriptor } from "./policy/prompts.ts";
import type { PiRoleProfile, SolveSettings } from "./policy/settings.ts";
import { supportClosure, byId } from "./policy/support.ts";
import { verificationPrefix } from "./policy/verification.ts";
import type { CodexRequest, CodexResult } from "./policy/source.ts";
import { verify } from "./verification.ts";

type Runtime = TaskRuntime<any, any, any, any>;
export type SourceExecutor = (
  request: CodexRequest,
  signal: AbortSignal,
) => Promise<CodexResult>;
type WorkerInput = (
  | { kind: "call"; descriptor: CallDescriptor; profile: PiRoleProfile }
  | {
      kind: "verify";
      input: VerifierInput;
      settings: SolveSettings;
      candidate?: number;
      reconstruction?: ReconstructionRef[];
    }
) & { previousTasks?: number[] };
type Step = "explorer" | "coordinator" | "verifier";
export type CampaignState = ({ phase: "next" } | { phase: "collect" }) & {
  step: Step;
  turns: number;
  guidance: string;
  guidanceThrough: number;
  support: string[];
  pending: Verification[];
  child?: number;
};
export type CampaignResult = {
  outcome: "accepted" | "turn-limit" | "call-failure";
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
}>("xean.role-result");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const abort = async (_task: unknown, runtime: Runtime, context: Context) => {
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  );
};

export async function lastCampaign(tx: Tx, root: ConversationId) {
  return (
    await tx.scanTasks(
      { conversationId: root, kind: campaignKind, order: "descending" },
      1,
    )
  ).items[0];
}

/** Pi owns execution and recovery. These tasks retain v1's research decisions. */
export function createWorkflow(options: { source?: SourceExecutor } = {}) {
  const roles = createRoleRuntime();
  const Worker = defineTask<WorkerInput, { phase: "run" }, JsonValue>({
    name: "xean.worker",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort,
    phases: {
      async run(task, runtime, context) {
        let value: JsonValue;
        try {
          if (task.input.kind === "call") {
            const answer = await roles.run(
              runtime,
              "role",
              task.input.descriptor,
              task.input.profile,
              context,
              task.input.previousTasks,
            );
            value = answer.value;
          } else {
            const input = task.input;
            const candidate = input.candidate ?? task.id;
            const recorded = async (): Promise<Verdict[]> => {
              const book = await runtime.snapshot(
                Notebook,
                task.conversationId,
                context,
              );
              if (!book) throw new Error("Campaign notebook is missing");
              return copy(
                book.checks
                  .filter((c) => c.candidate === candidate)
                  .flatMap((c) => c.values),
              );
            };
            const premises: ReconstructionPremise[] = [];
            await runtime.commit(async (tx) => {
              for (const ref of input.reconstruction ?? []) {
                const entry = await tx.entry(ref.call as EntryId);
                const { descriptor } = await tx.doc(
                  Assignment,
                  entry!.conversationId,
                );
                if (descriptor?.kind !== "reconstruction")
                  throw new Error("Missing reconstruction assignment");
                const { statement } = descriptor.statement.statements.find(
                  (value) => value.note === ref.note,
                )!;
                const { support } = descriptor.input.notes.find(
                  (note) => note.id === ref.note,
                )!;
                premises.push({ ...ref, statement, support: [...support] });
              }
            }, context);
            await verify(input.input, input.settings, {
              premises,
              call: (key, descriptor, profile) =>
                roles.run(
                  runtime,
                  key,
                  descriptor,
                  profile,
                  context,
                  input.previousTasks,
                ),
              recorded,
              refresh: async (value) => {
                const refreshed = copy(value);
                const book = await runtime.snapshot(
                  Notebook,
                  task.conversationId,
                  context,
                );
                if (!book) throw new Error("Campaign notebook is missing");
                const current = new Map(
                  project(book).notes.map((note) => [note.id, note]),
                );
                for (const note of [...refreshed.notes, ...refreshed.support]) {
                  const latest = current.get(note.id);
                  if (latest === undefined) continue;
                  note.verdicts = copy(latest.verdicts);
                  note.verified = latest.verified;
                  note.dead = latest.dead;
                }
                return refreshed;
              },
              record: async (id, values, reused) => {
                await runtime.commit(async (tx) => {
                  const book = await tx.doc(Notebook, task.conversationId);
                  if (!book.checks.some((check) => check.call === id))
                    book.checks.push({
                      candidate,
                      call: id,
                      values: copy(values),
                      ...(reused?.length ? { reused: copy(reused) } : {}),
                    });
                }, context);
              },
              source: async (key, request, judged) => {
                if (!options.source)
                  throw new Error("Codex source execution is not registered");
                const validate = (output: CodexResult) => {
                  if (output.state !== "succeeded")
                    throw new Error(`verifier failed: ${output.error}`);
                  const value = sourceVerdictsFor(judged).parse(output.output);
                  if (
                    !request.search &&
                    value.verdicts.some((v) => v.sources.length)
                  )
                    throw new Error(
                      "Source citations require search to be enabled",
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
            value = null;
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: {
                status: "failed",
                error: {
                  message:
                    error instanceof Error ? error.message : String(error),
                },
              },
            }),
            context,
          );
          return;
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: value },
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
          let { notes, accepted, reconstructed } = project(book);
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
          let request: WorkerInput;
          if (state.child !== undefined) {
            const previous = (await tx.task(state.child as TaskId))!;
            request = copy(previous.input) as WorkerInput;
            request.previousTasks = [
              ...(request.previousTasks ?? []),
              state.child,
            ];
            if (request.kind === "verify") request.candidate ??= state.child;
          } else {
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
                notes = project(book).notes;
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
                  ...supportClosure(
                    state.support.map((id) => pick(notes, id)),
                    notes,
                  ),
                ]),
              ].sort(byId);
              const input = explorerInput.parse({
                task: config.task,
                explorerGuidance: guidance,
                notes: notes.map(
                  ({ text: _text, detailedSummary: _detail, ...note }) => note,
                ),
                support: ids.map((id) => pick(notes, id)),
              });
              request = {
                kind: "call",
                profile: config.settings.explorer,
                descriptor: {
                  kind: "explorer",
                  input,
                },
              };
            } else if (state.step === "coordinator") {
              request = {
                kind: "call",
                profile: config.settings.coordinator,
                descriptor: {
                  kind: "coordinator",
                  input: {
                    task: config.task,
                    notes,
                    ...(config.settings.verifyOnSolution
                      ? { verifyOnSolution: true }
                      : {}),
                  },
                },
              };
            } else {
              const batch = verificationPrefix(
                state.pending,
                notes,
                config.settings.window,
              );
              const listed = batch.map((entry) => pick(notes, entry.note));
              const input = verifierInput.parse({
                task: config.task,
                verify: batch,
                notes: listed,
                support: supportClosure(listed, notes).map((id) =>
                  pick(notes, id),
                ),
              });
              request = {
                kind: "verify",
                input,
                settings: config.settings,
                reconstruction: [...input.notes, ...input.support].flatMap(
                  (note) =>
                    reconstructed[note.id] === undefined
                      ? []
                      : [{ note: note.id, call: reconstructed[note.id]! }],
                ),
              };
            }
          }
          const child = await tx.createTask(Worker, request, {
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
          const child = (await tx.task(state.child! as TaskId))!;
          const request = child.input as WorkerInput;
          const outcome = child.state.outcome;
          const result =
            outcome?.status === "completed" ? outcome.result : undefined;
          if (result === undefined) {
            state.phase = "next";
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  outcome: "call-failure",
                  turns: state.turns,
                  error:
                    outcome?.status === "failed"
                      ? outcome.error.message
                      : `Worker ${child.id} did not complete`,
                  resume: state,
                },
              },
            };
          }
          const book = await tx.doc(Notebook, task.conversationId);
          if (state.step === "explorer") {
            if (
              request.kind !== "call" ||
              request.descriptor.kind !== "explorer"
            )
              throw new Error("Explorer request mismatch");
            const value = explorerResultFor(
              request.descriptor.input.notes,
            ).parse(result);
            for (const note of value.notes)
              book.notes.push({
                ...note,
                id: noteIdAfter(book.notes.length, 0),
              });
            state.turns++;
            state.step = "coordinator";
          } else if (state.step === "coordinator") {
            if (
              request.kind !== "call" ||
              request.descriptor.kind !== "coordinator"
            )
              throw new Error("Coordinator request mismatch");
            const value = coordinatorResultFor(
              request.descriptor.input.notes,
            ).parse(result);
            for (const filing of value.filings)
              pick(book.notes, filing.note).summary = filing.summary;
            state.guidance = value.explorerGuidance;
            state.support = value.support;
            state.pending = value.verify;
            if (request.descriptor.input.verifyOnSolution) {
              const notes = request.descriptor.input.notes;
              const roots = value.verify
                .filter((entry) => entry.verifiers.includes("reconstruction"))
                .map((entry) => pick(notes, entry.note));
              const selected = new Set([
                ...roots.map((note) => note.id),
                ...supportClosure(roots, notes),
              ]);
              state.pending = value.verify.filter((entry) =>
                selected.has(entry.note),
              );
            }
            state.step = "verifier";
          } else {
            if (request.kind !== "verify")
              throw new Error("Verifier request mismatch");
            state.pending = state.pending.slice(request.input.verify.length);
          }
          delete state.child;
          return { status: "running", checkpoint: { ...state, phase: "next" } };
        }, context);
      },
    },
  });

  const extension = defineExtension({
    ...roles.extension,
    tasks: [Campaign, Worker],
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
        throw new Error("Campaign has no failed work to resume");
      return tx.createTask(
        Campaign,
        { resume: result.resume },
        { conversationId: root, ownership: { kind: "conversation" } },
      );
    },
  };
}
