import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  defineTask,
  type ConversationId,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  Notebook,
  admitNotes,
  definition,
  project,
  readNotebook,
} from "./state.ts";
import {
  campaignKind,
  completed,
  createWorkers,
  nominatedSupport,
  readWorkers,
  workerKind,
  type NativeTask,
  type SourceExecutor,
  type WorkerRequest,
  type WorkerTask,
} from "./workers.ts";

type Runtime = TaskRuntime<any, any, any, any>;
export { campaignKind } from "./workers.ts";
export type { SourceExecutor } from "./workers.ts";
export type CampaignState = ({ phase: "run" } | { phase: "retry" }) & {
  turns: number;
  guidanceThrough: number;
  children: number[];
  publicationCount: number;
  afterWorkerId: number;
};
export type CampaignResult = {
  outcome: "accepted" | "turn-limit" | "call-failure";
  turns: number;
  accepted?: string;
  error?: string;
  resume?: CampaignState;
};

/** Account for a completed job once, retaining unfinished and failed identities. */
function reconcile(state: CampaignState, records: readonly NativeTask[]) {
  const active: WorkerTask[] = [],
    failed: WorkerTask[] = [];
  for (const id of state.children) {
    const child = records.find((task) => task.id === id) as
      WorkerTask | undefined;
    if (!child) throw new Error("Worker " + id + " is missing");
    if (child.state.status !== "terminal") active.push(child);
    else if (child.state.outcome.status !== "completed") failed.push(child);
    else if (child.input.kind === "explorer") state.turns++;
  }
  state.children = [...active, ...failed].map(({ id }) => id);
  return { active, failed };
}

/** Retries keep the publication frontier of their original public invocation. */
function admissionId(job: WorkerTask, records: readonly NativeTask[]): number {
  const previous = job.input.previousTasks?.[0] ?? job.owner;
  const parent = records.find((task) => task.id === previous);
  return parent?.kind === workerKind
    ? admissionId(parent as WorkerTask, records)
    : job.id;
}

/** Completed selections consume actual batches; empty selections consume their offer. */
function consumed(
  records: readonly NativeTask[],
  after: number,
  nominated: ReadonlySet<string>,
) {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.kind !== workerKind) continue;
    const job = record as WorkerTask;
    if (job.input.kind === "explorer" || admissionId(job, records) <= after)
      continue;
    if (job.input.kind === "verify") {
      for (const entry of job.input.input.verify) ids.add(entry.note);
    } else if (
      job.input.kind === "verifier" &&
      job.state.outcome?.status === "completed" &&
      (job.state.outcome.result as { status?: string })?.status === "no-work"
    ) {
      for (const id of job.input.verify?.map((entry) => entry.note) ??
        job.input.input.notes.map((note) => note.id))
        if (
          !nominated.has(id) ||
          job.input.input.nominatedSupport?.includes(id)
        )
          ids.add(id);
    }
  }
  return ids;
}

const abort = async (_task: unknown, runtime: Runtime, context: Context) => {
  await runtime.commit(async (tx, task) => {
    const state = { ...task.state.checkpoint } as CampaignState;
    // Pi settles ordinary descendants before invoking their owner's abort handler.
    reconcile(state, (await readWorkers(tx, task.conversationId)).records);
    return {
      status: "terminal",
      outcome: {
        status: "aborted",
        result: {
          outcome: "call-failure",
          turns: state.turns,
          error: "Campaign aborted",
          resume: state,
        },
      },
    };
  }, context);
};

export async function lastCampaign(tx: Tx, root: ConversationId) {
  return (
    await tx.scanTasks(
      { conversationId: root, kind: campaignKind, order: "descending" },
      1,
    )
  ).items[0];
}

/** Refill shared capacity after any native worker completion. */
export function createWorkflow(options: { source?: SourceExecutor } = {}) {
  const workers = createWorkers(options);
  const Campaign = defineTask<
    { resume?: CampaignState },
    CampaignState,
    CampaignResult
  >({
    name: campaignKind,
    version: 1,
    initial: ({ resume }) =>
      resume
        ? { ...resume, phase: resume.children.length ? "retry" : "run" }
        : {
            phase: "run",
            turns: 0,
            guidanceThrough: 0,
            children: [],
            publicationCount: -1,
            afterWorkerId: 0,
          },
    abort,
    phases: {
      async retry(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const state = { ...task.state.checkpoint };
          state.children = await workers.createGroup(
            tx,
            task.conversationId,
            state.children.map((task) => ({ kind: "retry", task })),
            task.id,
          );
          return { status: "running", checkpoint: { ...state, phase: "run" } };
        }, context);
      },
      async run(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const state = { ...task.state.checkpoint };
          const history = await readWorkers(tx, task.conversationId);
          const { active, failed } = reconcile(state, history.records);
          const config = await definition(tx, task.conversationId);
          await admitNotes(tx, task.conversationId);
          const ref = await tx.doc(Notebook, task.conversationId);
          const book = readNotebook(ref),
            { notes, accepted } = project(book);
          if (state.publicationCount !== ref.publications.length) {
            state.publicationCount = ref.publications.length;
            state.afterWorkerId = history.jobs.at(-1)?.id ?? 0;
          }
          // Never freeze acceptance before admitted workers and adverse receipts settle.
          if (failed.length || accepted.length) {
            if (active.length)
              return {
                status: "waiting",
                on: active.map(({ id }) => id),
                policy: "anySettled",
                checkpoint: state,
              };
            if (failed.length)
              return completed<CampaignResult>({
                outcome: "call-failure",
                turns: state.turns,
                error: failed
                  .map(
                    (child) =>
                      child.state.outcome?.error?.message ??
                      "Worker " + child.id + " did not complete",
                  )
                  .join("\n"),
                resume: state,
              });
            return completed<CampaignResult>({
              outcome: "accepted",
              turns: state.turns,
              accepted: accepted[0]!,
            });
          }
          const unavailable = consumed(
            history.records,
            state.afterWorkerId,
            new Set(
              config.settings.verifyOnSolution
                ? nominatedSupport(history.records, notes)
                : [],
            ),
          );
          for (const id of [...history.claimed, ...history.offered])
            unavailable.add(id);
          const eligible = notes
            .filter((note) => !note.dead && !unavailable.has(note.id))
            .map((note) => note.id);
          const free = config.settings.maxWorkers - active.length;
          const verifying = Math.min(free, eligible.length);
          const exploring = Math.min(
            free - verifying,
            config.settings.maxExplorerTurns -
              state.turns -
              active.filter((job) => job.input.kind === "explorer").length,
          );
          const guidance = book.guidance
            .slice(state.guidanceThrough)
            .map((entry) => entry.text)
            .join("\n\n");
          const requests: WorkerRequest[] = [
            ...Array.from({ length: verifying }, () => ({
              kind: "verifier" as const,
            })),
            ...Array.from({ length: exploring }, () => ({
              kind: "explorer" as const,
              guidance,
            })),
          ];
          if (exploring) state.guidanceThrough = book.guidance.length;
          if (requests.length)
            state.children = [
              ...state.children,
              ...(await workers.createGroup(
                tx,
                task.conversationId,
                requests,
                task.id,
                eligible,
              )),
            ];
          if (!state.children.length)
            return completed<CampaignResult>({
              outcome: "turn-limit",
              turns: state.turns,
            });
          return {
            status: "waiting",
            on: state.children as TaskId[],
            policy: "anySettled",
            checkpoint: state,
          };
        }, context);
      },
    },
  });
  const extension = defineExtension({
    ...workers.extension,
    tasks: [...workers.extension.tasks!, Campaign],
  });
  return {
    extension,
    workers,
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
