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
  saveNotebook,
} from "./state.ts";
import {
  coordinatorResultFor,
  establishes,
  pick,
  type Verification,
} from "./policy/contracts.ts";
import { supportClosure } from "./policy/support.ts";
import {
  createWorkers,
  type SourceExecutor,
  type WorkerInput,
  type WorkerRequest,
} from "./workers.ts";

type Runtime = TaskRuntime<any, any, any, any>;
export type { SourceExecutor } from "./workers.ts";
type Step = "explorer" | "coordinator" | "verifier";
export type CampaignState = ({ phase: "next" } | { phase: "collect" }) & {
  step: Step;
  turns: number;
  guidanceThrough: number;
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
          const ref = await tx.doc(Notebook, task.conversationId);
          const book = readNotebook(ref);
          const { notes, accepted } = project(book);
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
          let request: WorkerRequest;
          if (state.child !== undefined) {
            request = { kind: "retry", task: state.child };
          } else {
            if (state.step === "verifier") {
              const available = new Set(
                notes.filter((n) => n.verified).map((n) => n.id),
              );
              state.pending = state.pending.filter((entry) => {
                const note = pick(notes, entry.note);
                if (note.dead || note.support.some((id) => !available.has(id)))
                  return false;
                if (establishes((name) => entry.verifiers.includes(name)))
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
              if (admitNotes(book)) {
                saveNotebook(tx, ref, book);
                if (state.step === "explorer") state.step = "coordinator";
              }
            }
            if (state.step === "explorer") {
              const guidance = book.guidance
                .slice(state.guidanceThrough)
                .map((v) => v.text)
                .join("\n\n");
              state.guidanceThrough = book.guidance.length;
              request = { kind: "explorer", guidance };
            } else if (state.step === "coordinator") {
              request = { kind: "coordinator" };
            } else {
              request = { kind: "verifier", verify: state.pending };
            }
          }
          const child = await workers.create(
            tx,
            task.conversationId,
            request,
            task.id,
          );
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
                    outcome?.error?.message ??
                    `Worker ${child.id} did not complete`,
                  resume: state,
                },
              },
            };
          }
          if (state.step === "explorer") {
            if (
              request.kind !== "call" ||
              request.descriptor.kind !== "explorer"
            )
              throw new Error("Explorer request mismatch");
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
