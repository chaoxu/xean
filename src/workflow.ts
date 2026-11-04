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
  createWorkers,
  type SourceExecutor,
  type WorkerRequest,
} from "./workers.ts";

type Runtime = TaskRuntime<any, any, any, any>;
export type { SourceExecutor } from "./workers.ts";
export type CampaignState = ({ phase: "next" } | { phase: "collect" }) & {
  step: "explorer" | "verifier";
  turns: number;
  guidanceThrough: number;
  children?: number[];
};
export type CampaignResult = {
  outcome: "accepted" | "turn-limit" | "call-failure";
  turns: number;
  accepted?: string;
  error?: string;
  resume?: CampaignState;
};
export const campaignKind = "xean.campaign";
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

/** Native ownership and waits seal each group before another is admitted. */
export function createWorkflow(options: { source?: SourceExecutor } = {}) {
  const workers = createWorkers(options);
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
        guidanceThrough: 0,
      },
    abort,
    phases: {
      async next(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const state = copy(task.state.checkpoint);
          const config = await definition(tx, task.conversationId);
          let requests: WorkerRequest[];
          // Settle interrupted members before considering a provisional acceptance.
          if (state.children?.length) {
            requests = state.children.map((task) => ({ kind: "retry", task }));
          } else {
            const book = readNotebook(
              await tx.doc(Notebook, task.conversationId),
            );
            const { accepted } = project(book);
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
            if (await admitNotes(tx, task.conversationId))
              state.step = "verifier";
            if (state.step === "explorer") {
              const guidance = book.guidance
                .slice(state.guidanceThrough)
                .map((entry) => entry.text)
                .join("\n\n");
              state.guidanceThrough = book.guidance.length;
              requests = Array.from(
                {
                  length: Math.min(
                    config.settings.explorers,
                    config.settings.maxExplorerTurns - state.turns,
                  ),
                },
                () => ({ kind: "explorer", guidance }),
              );
            } else {
              requests = Array.from(
                { length: config.settings.verifiers },
                () => ({ kind: "verifier" }),
              );
            }
          }
          const children = await workers.createGroup(
            tx,
            task.conversationId,
            requests,
            task.id,
          );
          return {
            status: "waiting",
            on: children,
            policy: "allSettled",
            checkpoint: { ...state, phase: "collect", children },
          };
        }, context);
      },
      async collect(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const state = copy(task.state.checkpoint);
          const failed: number[] = [];
          const errors: string[] = [];
          for (const id of state.children!) {
            const child = (await tx.task(id as TaskId))!;
            const outcome = child.state.outcome;
            if (outcome?.status === "completed") {
              if (state.step === "explorer") state.turns++;
            } else {
              failed.push(id);
              errors.push(
                outcome?.error?.message ?? `Worker ${id} did not complete`,
              );
            }
          }
          if (failed.length)
            return {
              status: "terminal",
              outcome: {
                status: "completed",
                result: {
                  outcome: "call-failure",
                  turns: state.turns,
                  error: errors.join("\n"),
                  resume: { ...state, phase: "next", children: failed },
                },
              },
            };
          delete state.children;
          state.step = state.step === "explorer" ? "verifier" : "explorer";
          return { status: "running", checkpoint: { ...state, phase: "next" } };
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
