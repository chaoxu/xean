import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type Cursor,
  type EntryId,
  type TaskId,
  type TaskRecord,
  type TaskOutcome,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { verificationTargets, type Plan } from "./math/contracts.ts";
import {
  noteInfo,
  sourceEvidence,
  validatePlan,
  validateResult,
} from "./math/notes.ts";
import { closure } from "./math/argument.ts";
import { Events, readView } from "./math/state.ts";
import { readCommand, validateCommand } from "./math/commands.ts";
import { readDefinition } from "./definition.ts";
import { isDeepStrictEqual } from "node:util";
import { resolveResult } from "./math/results.ts";
import { RoleFailure } from "./roles/types.ts";

// These are application admission choices. Pi retains all execution state.
export const Control = defineDoc({
  kind: "research.control",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): {
    paused: boolean;
    cancelled: boolean;
    accepted: string | null;
  } => ({ paused: false, cancelled: false, accepted: null }),
});
const DecisionView = defineEntry("research.decision-view");

type Runtime = TaskRuntime<any, any, any, object>;
type Source = { root: ConversationId; cutoff: EntryId };
type Role = (
  input: any,
  runtime: Runtime,
  context: Context,
  source?: Source,
) => Promise<any>;
export const roleNames = [
  "coordinator",
  "explorer",
  "verifier",
  "reconstruct",
  "literature",
  "codex",
  "review",
] as const;
export type RoleName = (typeof roleNames)[number];
export type Roles = Record<RoleName, Role> & {
  capabilities: (input: any) => {
    explorer: boolean;
    literature: boolean;
    codex: boolean;
    sourceRetrieval?: boolean;
  };
};
type Request = NonNullable<Plan["work"]>;
export type WorkerInput = { retryOf?: TaskId } & (
  { at: EntryId; request: Request } | { standalone: true }
);
type DecisionInput = {
  retryOf?: TaskId;
  order?: TaskId;
};
type DecisionResult = null | { deferred: true };
type NativeRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
const failedDecision = (task: NativeRecord) =>
  task.state.outcome !== undefined &&
  ["failed", "faulted", "orphaned"].includes(task.state.outcome.status);
const deferredDecision = (task: NativeRecord) =>
  task.state.outcome?.status === "completed" &&
  (task.state.outcome.result as { deferred?: boolean } | null)?.deferred ===
    true;

/** Undelivered decisions remain native task records, including deferred work. */
export function pendingDecisions(
  tasks: readonly NativeRecord[],
): NativeRecord[] {
  const decisions = tasks.filter(
    (task) => task.kind === "research.coordinator",
  );
  const replaced = new Set(
    decisions.map((task) => (task.input as DecisionInput).retryOf),
  );
  return decisions.filter(
    (task) =>
      !replaced.has(task.id) &&
      (task.state.status !== "terminal" ||
        failedDecision(task) ||
        deferredDecision(task)),
  );
}

/** A successor can clear a failed decision only by explicitly referring to it. */
export function blockedDecision(
  tasks: readonly NativeRecord[],
): NativeRecord | undefined {
  return pendingDecisions(tasks).find(failedDecision);
}

const decisionOrder = (task: NativeRecord) =>
  (task.input as DecisionInput).order ?? task.id;

export async function scanTasks(tx: Tx, root: ConversationId, kind?: string) {
  const tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks(
      { conversationId: root, ...(kind ? { kind } : {}) },
      128,
      cursor,
    );
    tasks.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return tasks;
}

async function abort(_task: unknown, runtime: Runtime, context: Context) {
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  );
}

export function createResearch(roles: Roles) {
  const Worker = defineTask<WorkerInput, { phase: "run" }, JsonValue>({
    name: "research.worker",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, context) {
        let value: unknown;
        let name: RoleName;
        let source: Source | undefined;
        let predecessor: TaskId | undefined;
        let stopped = false;
        await runtime.commit(async (tx) => {
          const control = await tx.doc(Control, task.conversationId);
          if (control.accepted !== null || control.cancelled) {
            stopped = true;
            return { status: "terminal", outcome: { status: "aborted" } };
          }
          const definition = await readDefinition(tx, task.conversationId);
          if ("standalone" in task.input) {
            const mode = definition.mode;
            if (!mode)
              throw new Error(
                "Standalone work requires a frozen procedure definition",
              );
            name = mode.role as RoleName;
            value = {
              ...(mode.input as object),
              task: definition.task,
            };
            return;
          }
          const { request } = task.input;
          const at = task.input.at;
          predecessor = (await tx.entry(DecisionView, at))?.byTaskId;
          if (predecessor === undefined)
            throw new Error("Worker admission requires a Coordinator decision");
          source = { root: task.conversationId, cutoff: at };
          const view = await readView(tx, task.conversationId, at);
          name = request.kind;
          switch (request.kind) {
            case "explorer":
              value = {
                task: definition.task,
                notes: view.notes,
                guidance: request.guidance,
              };
              break;
            case "verifier":
              value = {
                task: definition.task,
                notes: closure(request.notes, view.notes),
                targets: verificationTargets({ work: request }),
                evidence: sourceEvidence(view.notes),
              };
              break;
            case "literature":
              value = {
                task: definition.task,
                notes: view.notes.map(noteInfo),
                query: request.query,
              };
              break;
            case "codex":
              value = {
                task: definition.task,
                notes: closure(request.notes, view.notes),
                assignment: request.assignment,
              };
              break;
          }
        }, context);
        if (stopped) return;
        if (predecessor !== undefined)
          await runtime.waitForTask(predecessor, context);
        let outcome: TaskOutcome<JsonValue>;
        try {
          const result = await roles[name!](value, runtime, context, source);
          outcome = { status: "completed", result };
        } catch (error) {
          if (!(error instanceof RoleFailure)) throw error;
          outcome = {
            status: "failed",
            error: { message: error.message },
            ...(error.result ? { result: error.result } : {}),
          };
        }
        await runtime.commit(async (tx) => {
          const control = await tx.doc(Control, task.conversationId);
          if (control.accepted !== null || control.cancelled)
            return { status: "terminal", outcome: { status: "aborted" } };
          if (!("standalone" in task.input) && outcome.result !== undefined)
            validateResult(
              await resolveResult(tx, outcome.result),
              (await readView(tx, task.conversationId)).notes,
              outcome.status === "failed",
            );
          await tx.appendEntry(Events, task.conversationId, {
            data: { type: "result", task: task.id },
          });
          return {
            status: "terminal",
            outcome,
          };
        }, context);
      },
    },
    abort,
  });

  const Reporter = defineTask<TaskId, { phase: "deliver" }, null>({
    name: "research.reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      async deliver(task, runtime, context) {
        const source = await runtime.waitForTask(task.input, context);
        await runtime.commit(async (tx) => {
          // Worker.run publishes successful results and RoleFailure checks.
          // Pi faults and cancellations still need their result event.
          if (!["completed", "failed"].includes(source.state.outcome.status))
            await tx.appendEntry(Events, task.conversationId, {
              data: { type: "result", task: task.input },
            });
          if (!("standalone" in (source.input as object)))
            await enqueue(tx, task.conversationId);
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };
        }, context);
      },
    },
    abort,
  });

  async function worker(tx: Tx, root: ConversationId, input: WorkerInput) {
    const id = await tx.createTask(Worker, input, {
      conversationId: root,
      ownership: { kind: "conversation" },
    });
    await tx.createTask(Reporter, id, {
      conversationId: root,
      ownership: { kind: "conversation" },
    });
    return id;
  }

  const Coordinator = defineTask<
    DecisionInput,
    { phase: "freeze" } | { phase: "decide"; at: EntryId },
    DecisionResult
  >({
    name: "research.coordinator",
    version: 1,
    initial: () => ({ phase: "freeze" }),
    phases: {
      async freeze(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const tasks = await scanTasks(tx, task.conversationId);
          const decisions = tasks.filter(
            (other) => other.kind === Coordinator.definition.name,
          );
          const on = decisions
            .filter(
              (other) =>
                (decisionOrder(other) < decisionOrder(task) ||
                  (decisionOrder(other) === decisionOrder(task) &&
                    other.id < task.id)) &&
                other.state.status !== "terminal",
            )
            .map(({ id }) => id);
          on.push(
            ...tasks
              .filter(
                (worker) =>
                  [Worker.definition.name, Reporter.definition.name].includes(
                    worker.kind,
                  ) && worker.state.status !== "terminal",
              )
              .map(({ id }) => id),
          );
          // A manual resume preserves the failed decision's original order.
          if (on.length)
            return {
              status: "waiting",
              on,
              policy: "allSettled",
              checkpoint: { phase: "freeze" },
            };
          if (blockedDecision(decisions))
            return {
              status: "terminal",
              outcome: { status: "completed", result: { deferred: true } },
            };
          const state = await tx.doc(Control, task.conversationId);
          if (state.cancelled || state.accepted !== null)
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            };
          if (state.paused)
            return {
              status: "terminal",
              outcome: { status: "completed", result: { deferred: true } },
            };
          const at = (
            await tx.appendEntry(DecisionView, task.conversationId, {})
          ).id;
          return { status: "running", checkpoint: { phase: "decide", at } };
        }, context);
      },
      async decide(task, runtime, context) {
        const at = task.state.checkpoint.at;
        let frozen!: Awaited<ReturnType<typeof readView>>;
        let definition!: Awaited<ReturnType<typeof readDefinition>>;
        let workers!: Awaited<ReturnType<typeof scanTasks>>;
        await runtime.commit(async (tx) => {
          frozen = await readView(tx, task.conversationId, at);
          definition = await readDefinition(tx, task.conversationId);
          workers = (
            await scanTasks(tx, task.conversationId, Worker.definition.name)
          ).filter((worker) => worker.id < at);
        }, context);
        if (definition.mode) {
          await runtime.commit(async (tx) => {
            const control = await tx.doc(Control, task.conversationId);
            const prior = workers.at(-1);
            const needed =
              (!prior || prior.state.outcome?.status !== "completed") &&
              !control.cancelled &&
              !control.paused;
            if (needed)
              await worker(tx, task.conversationId, {
                standalone: true,
                ...(prior ? { retryOf: prior.id } : {}),
              });
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result:
                  control.paused && !control.cancelled
                    ? { deferred: true }
                    : null,
              },
            };
          }, context);
          return;
        }
        if (frozen.notes.some((note) => note.accepted)) {
          await runtime.commit(async (tx) => {
            const current = await readView(tx, task.conversationId);
            const control = await tx.doc(Control, task.conversationId);
            const accepted = current.notes.find((note) => note.accepted);
            if (control.paused && !control.cancelled)
              return {
                status: "terminal",
                outcome: { status: "completed", result: { deferred: true } },
              };
            if (!control.cancelled && accepted) control.accepted = accepted.id;
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            };
          }, context);
          return;
        }
        // Freeze waits for prior workers to settle. Their outcomes are immutable.
        const kind = (work: (typeof workers)[number]) =>
          (work.input as WorkerInput & { request?: Request }).request?.kind;
        const explorerUsed = workers.some(
          (worker) => kind(worker) === "explorer",
        );
        const coordination = {
          task: definition.task,
          notes: frozen.notes,
          guidance: frozen.guidance,
          literatureUsed: workers.some(
            (worker) =>
              kind(worker) === "literature" &&
              worker.state.outcome?.status === "completed",
          ),
          explorerUsed,
          failures: workers
            .filter((worker) =>
              ["failed", "faulted", "orphaned"].includes(
                worker.state.outcome?.status ?? "",
              ),
            )
            .map((worker) => ({
              id: String(worker.id),
              role: kind(worker) ?? "standalone",
              error:
                worker.state.outcome?.error?.message ??
                worker.state.outcome?.reason ??
                null,
            })),
        };
        const capabilities = roles.capabilities(coordination);
        const plan = await roles.coordinator(
          { ...coordination, capabilities },
          runtime,
          context,
          { root: task.conversationId, cutoff: at },
        );
        const validated = validatePlan(plan, frozen.notes, capabilities);
        await runtime.commit(async (tx) => {
          const control = await tx.doc(Control, task.conversationId);
          if (
            !control.paused &&
            !control.cancelled &&
            control.accepted === null
          ) {
            const request = validated.work;
            if (request) await worker(tx, task.conversationId, { at, request });
          }
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result:
                control.paused &&
                !control.cancelled &&
                control.accepted === null
                  ? { deferred: true }
                  : null,
            },
          };
        }, context);
      },
    },
    abort,
  });

  const enqueue = (tx: Tx, root: ConversationId) =>
    tx.createTask(
      Coordinator,
      {},
      {
        conversationId: root,
        ownership: { kind: "conversation" },
      },
    );
  return {
    extension: defineExtension({
      name: "research",
      tasks: [Coordinator, Worker, Reporter],
    }),
    initialize: enqueue,
    async resume(tx: Tx, root: ConversationId) {
      const tasks = await scanTasks(tx, root);
      const pending = pendingDecisions(tasks).filter(
        (task) => failedDecision(task) || deferredDecision(task),
      );
      const control = await tx.doc(Control, root);
      if (control.cancelled || control.accepted !== null)
        throw new Error("Campaign is terminal");
      control.paused = false;
      if (!pending.length) return [await enqueue(tx, root)];
      const resumed: TaskId[] = [];
      for (const previous of pending) {
        const input = previous.input as DecisionInput;
        resumed.push(
          await tx.createTask(
            Coordinator,
            {
              ...input,
              retryOf: previous.id,
              order: input.order ?? previous.id,
            },
            { conversationId: root, ownership: { kind: "conversation" } },
          ),
        );
      }
      return resumed;
    },
    async input(tx: Tx, root: ConversationId, value: unknown) {
      if ((await readDefinition(tx, root)).mode)
        throw new Error("Standalone procedures do not accept solver inputs");
      const view = await readView(tx, root);
      const command = readCommand(value);
      const existing = view.inputs.find(
        (input) => input.command.id === command.id,
      );
      if (existing) {
        if (!isDeepStrictEqual(existing.command, command))
          throw new Error("Input ID already has another value");
        return existing.id;
      }
      validateCommand(command, view);
      if (blockedDecision(await scanTasks(tx, root)))
        throw new Error("Campaign is blocked; resume it before adding input");
      const state = await tx.doc(Control, root);
      if (state.cancelled || state.accepted !== null)
        throw new Error("Campaign is terminal");
      const event = await tx.appendEntry(Events, root, {
        data: { type: "input", command },
      });
      await enqueue(tx, root);
      return event.id;
    },
  };
}
