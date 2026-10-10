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
  type Tx,
} from "@earendil-works/pi-durable";
import {
  workPlan,
  type Plan,
  type planSchema,
  type SolverResult,
} from "./math/contracts.ts";
import { noteInfo, sourceEvidence, validatePlan } from "./math/notes.ts";
import { closure } from "./math/argument.ts";
import {
  Catalog,
  readView,
  readSnapshot,
  publishResult,
  publishCommand,
} from "./math/state.ts";
import { readCommand } from "./math/commands.ts";
import { readDefinition } from "./definition.ts";
import { resolveResult } from "./math/results.ts";
import {
  RoleFailure,
  type NoteReference,
  type RoleRuntime,
} from "./roles/types.ts";

// These are application admission choices. Pi retains all execution state.
export const Control = defineDoc({
  kind: "research.control",
  version: 4,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: (): {
    paused: boolean;
    cancelled: boolean;
    accepted: { candidateId: string; snapshotEntry: EntryId } | null;
  } => ({ paused: false, cancelled: false, accepted: null }),
});
const DecisionView = defineEntry("research.decision-view");
const Acceptance = defineEntry<{ candidateId: string }>("research.acceptance");

type Role = (
  input: any,
  runtime: RoleRuntime,
  context: Context,
  source?: NoteReference,
) => Promise<any>;
export const roleNames = [
  "coordinator",
  ...workPlan.anyOf.map((plan) => plan.properties.kind.const),
  "reconstruct",
  "review",
] as const;
export type RoleName = (typeof roleNames)[number];
export type Roles = Record<RoleName, Role> & {
  capabilities: (input: any) => Parameters<typeof planSchema>[0] & {
    sourceRetrieval?: boolean;
  };
};
type Request = NonNullable<Plan["work"]>;
export type WorkerInput = { retryOf?: TaskId } & (
  { at: EntryId; request: Request } | { standalone: true }
);
type DecisionInput = { after?: TaskId };
type NativeRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;
const failedTask = (task: NativeRecord) =>
  task.state.outcome !== undefined &&
  ["failed", "faulted", "orphaned"].includes(task.state.outcome.status);
/** The newest decision owns the campaign's next step or its recorded failure. */
export function pendingDecisions(
  tasks: readonly NativeRecord[],
): NativeRecord[] {
  const latest = tasks.findLast((task) => task.kind === "research.coordinator");
  return latest && (latest.state.status !== "terminal" || failedTask(latest))
    ? [latest]
    : [];
}

export function blockedDecision(
  tasks: readonly NativeRecord[],
): NativeRecord | undefined {
  return pendingDecisions(tasks).find(failedTask);
}

export async function scanTasks(
  tx: Tx,
  root: ConversationId,
  kind?: string,
  status?: NativeRecord["state"]["status"],
) {
  const tasks: TaskRecord<JsonValue, JsonValue, JsonValue>[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks(
      {
        conversationId: root,
        ...(kind ? { kind } : {}),
        ...(status ? { status } : {}),
      },
      128,
      cursor,
    );
    tasks.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return tasks;
}

async function abort(_task: unknown, runtime: RoleRuntime, context: Context) {
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
        let source: NoteReference | undefined;
        let predecessor: TaskId | undefined;
        let frozen: Awaited<ReturnType<typeof readView>> | undefined;
        let definition!: Awaited<ReturnType<typeof readDefinition>>;
        let stopped = false;
        await runtime.commit(async (tx) => {
          const control = await tx.doc(Control, task.conversationId);
          if (control.accepted !== null || control.cancelled) {
            stopped = true;
            return { status: "terminal", outcome: { status: "aborted" } };
          }
          definition = await readDefinition(tx, task.conversationId);
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
          const at = task.input.at;
          predecessor = (await tx.entry(DecisionView, at))?.byTaskId;
          if (predecessor === undefined)
            throw new Error("Worker admission requires a Coordinator decision");
          source = { root: task.conversationId, cutoff: at };
        }, context);
        if (stopped) return;
        if (predecessor !== undefined)
          await runtime.waitForTask(predecessor, context);
        if (!("standalone" in task.input)) {
          const { request, at } = task.input;
          const view = (frozen = await readSnapshot(
            runtime,
            task.conversationId,
            at,
            context,
            { inputs: false, bodies: request.kind !== "literature" },
          ));
          const { kind, ...assignment } = request;
          name = kind;
          value = {
            ...assignment,
            task: definition.task,
            notes:
              "notes" in request
                ? closure(request.notes, view.notes)
                : kind === "literature"
                  ? view.notes.map(noteInfo)
                  : view.notes,
            ...(kind === "verifier"
              ? {
                  targets: request.notes,
                  evidence: sourceEvidence(view.notes),
                }
              : {}),
          };
        }
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
            await publishResult(
              tx,
              task.conversationId,
              outcome.result,
              task.id,
              frozen!,
              outcome.status === "failed",
            );
          return {
            status: "terminal",
            outcome,
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
    if (!("standalone" in input)) await enqueue(tx, root, id);
  }

  const Coordinator = defineTask<
    DecisionInput,
    { phase: "freeze" } | { phase: "decide"; at: EntryId },
    null
  >({
    name: "research.coordinator",
    version: 2,
    initial: () => ({ phase: "freeze" }),
    phases: {
      async freeze(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const after = task.input.after;
          if (
            after !== undefined &&
            (await tx.task(after))?.state.status !== "terminal"
          )
            return {
              status: "waiting",
              on: [after],
              policy: "allSettled",
              checkpoint: { phase: "freeze" },
            };
          const state = await tx.doc(Control, task.conversationId);
          if (state.cancelled || state.paused || state.accepted !== null)
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
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
        const workers: {
          id: TaskId;
          role: Request["kind"] | "standalone";
          completed: boolean;
          failed: boolean;
          error: string | null;
          request?: Request;
          result?: { notes: number; edits: number } | { checks: number };
        }[] = [];
        await runtime.commit(async (tx) => {
          definition = await readDefinition(tx, task.conversationId);
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanTasks(
              {
                conversationId: task.conversationId,
                kind: Worker.definition.name,
              },
              128,
              cursor,
            );
            for (const worker of page.items) {
              if (worker.id >= at) continue;
              workers.push({
                id: worker.id,
                role:
                  (worker.input as WorkerInput & { request?: Request }).request
                    ?.kind ?? "standalone",
                completed: worker.state.outcome?.status === "completed",
                failed: failedTask(worker),
                error:
                  worker.state.outcome?.error?.message ??
                  worker.state.outcome?.reason ??
                  null,
                request: (worker.input as { request?: Request }).request,
              });
            }
            cursor = page.next;
          } while (cursor);
          for (const worker of workers.slice(-4)) {
            const outcome = (await tx.task(worker.id))?.state.outcome;
            if (outcome?.result === undefined) continue;
            const result = (await resolveResult(
              tx,
              outcome.result,
              worker.id,
            )) as SolverResult;
            if (result?.kind === "notes")
              worker.result = {
                notes: result.notes.length,
                edits: result.edits?.length ?? 0,
              };
            else if (result?.kind === "verification")
              worker.result = { checks: result.checks.length };
          }
        }, context);
        frozen = await readSnapshot(runtime, task.conversationId, at, context, {
          bodies: false,
        });
        let next: WorkerInput | undefined;
        const acceptedNote =
          !definition.mode && frozen.notes.find((note) => note.accepted);
        if (definition.mode) {
          const prior = workers.at(-1);
          if (!prior?.completed)
            next = {
              standalone: true,
              ...(prior ? { retryOf: prior.id } : {}),
            };
        } else if (!acceptedNote) {
          // Freeze waits for prior workers to settle. Their outcomes are immutable.
          const explorerUsed = workers.some(
            (worker) => worker.role === "explorer",
          );
          const coordination = {
            task: definition.task,
            notes: frozen.notes,
            guidance: frozen.guidance,
            literatureUsed: workers.some(
              (worker) => worker.role === "literature" && worker.completed,
            ),
            explorerUsed,
            failures: workers
              .filter((worker) => worker.failed)
              .map(({ id, role, error }) => ({ id: String(id), role, error })),
            recent: workers
              .slice(-4)
              .map(({ id, ...worker }) => ({ id: String(id), ...worker })),
          };
          const capabilities = roles.capabilities(coordination);
          const plan = await roles.coordinator(
            { ...coordination, capabilities },
            runtime,
            context,
            { root: task.conversationId, cutoff: at },
          );
          const { work } = validatePlan(plan, frozen.notes, capabilities);
          if (work) next = { at, request: work };
        }
        await runtime.commit(async (tx) => {
          const control = await tx.doc(Control, task.conversationId);
          const catalog = await tx.doc(Catalog, task.conversationId);
          if (
            !control.paused &&
            !control.cancelled &&
            control.accepted === null
          ) {
            // A fresh task keeps its private model conversation separate from this stale decision.
            if ((catalog.inputs.at(-1)?.entry ?? 0) > at)
              await enqueue(tx, task.conversationId, task.id);
            else if (acceptedNote) {
              const entry = await tx.appendEntry(
                Acceptance,
                task.conversationId,
                { data: { candidateId: acceptedNote.id } },
              );
              control.accepted = {
                candidateId: acceptedNote.id,
                snapshotEntry: entry.id,
              };
            } else if (next) await worker(tx, task.conversationId, next);
          }
          return {
            status: "terminal",
            outcome: {
              status: "completed",
              result: null,
            },
          };
        }, context);
      },
    },
    abort,
  });

  const enqueue = (tx: Tx, root: ConversationId, after?: TaskId) =>
    tx.createTask(Coordinator, after === undefined ? {} : { after }, {
      conversationId: root,
      ownership: { kind: "conversation" },
    });
  const latest = async (tx: Tx, root: ConversationId, kind: string) =>
    (await tx.scanTasks({ conversationId: root, kind, order: "descending" }, 1))
      .items[0];
  async function requestDecision(tx: Tx, root: ConversationId) {
    const decision = await latest(tx, root, Coordinator.definition.name);
    if (decision && decision.state.outcome === undefined) return decision.id;
    const worker = await latest(tx, root, Worker.definition.name);
    return enqueue(
      tx,
      root,
      worker && (!decision || worker.id > decision.id)
        ? worker.id
        : decision?.id,
    );
  }
  return {
    extension: defineExtension({
      name: "research",
      tasks: [Coordinator, Worker],
    }),
    /** Pi calls this once when creating the root; later decisions use resume. */
    initialize: (tx: Tx, root: ConversationId) => enqueue(tx, root),
    async resume(tx: Tx, root: ConversationId) {
      const control = await tx.doc(Control, root);
      if (control.cancelled || control.accepted !== null)
        throw new Error("Campaign is terminal");
      control.paused = false;
      return [await requestDecision(tx, root)];
    },
    async input(tx: Tx, root: ConversationId, value: unknown) {
      if ((await readDefinition(tx, root)).mode)
        throw new Error("Standalone procedures do not accept solver inputs");
      const decision = await latest(tx, root, Coordinator.definition.name);
      const state = await tx.doc(Control, root);
      const result = await publishCommand(tx, root, readCommand(value));
      if (!result.created) return result.entry;
      // Pi rolls back the new input if admission is rejected.
      if (decision && failedTask(decision))
        throw new Error("Campaign is blocked; resume it before adding input");
      if (state.cancelled || state.accepted !== null)
        throw new Error("Campaign is terminal");
      if (!decision || decision.state.outcome !== undefined)
        await enqueue(tx, root, decision?.id);
      return result.entry;
    },
  };
}
