import type { Cursor, EntryId, Tx } from "@earendil-works/pi-durable";
import { json } from "./json.ts";
import { campaign, COORDINATOR, WORKER, type PiTask } from "./store.ts";
import type {
  CampaignInput,
  CampaignView,
  JsonValue,
  Signal,
  Work,
  WorkRequest,
} from "./types.ts";

export function work(task: PiTask): Work {
  const input = task.input as WorkRequest;
  const { outcome, checkpoint, status } = task.state;
  const receipt = outcome?.result as
    | (Pick<Work, "attempts" | "attemptId" | "publicationId"> & {
        output: JsonValue;
      })
    | undefined;
  return {
    ...input,
    taskId: task.id,
    status:
      status === "pending"
        ? "queued"
        : status !== "terminal"
          ? "active"
          : outcome?.status === "completed"
            ? "completed"
            : outcome?.status === "aborted"
              ? "cancelled"
              : "failed",
    // Attempt counts for terminal work are retained in its result receipt's metadata.
    attempts: checkpoint?.attempts ?? receipt?.attempts ?? 0,
    attemptId: checkpoint?.attemptId ?? receipt?.attemptId ?? null,
    result: outcome?.status === "completed" ? (receipt?.output ?? null) : null,
    publicationId:
      outcome?.status === "completed" ? (receipt?.publicationId ?? null) : null,
    error: outcome?.error?.message ?? checkpoint?.error ?? null,
  };
}

/** Accepted input receipts in ascending receipt ID order. */
export function inputs(tasks: readonly PiTask[]): CampaignInput[] {
  return tasks
    .filter(
      (task) =>
        task.kind === COORDINATOR &&
        "kind" in task.input &&
        task.input.kind === "input",
    )
    .map((task) => {
      const signal = task.input as Omit<Signal, "id">;
      return { id: task.id, key: signal.key ?? null, value: signal.value };
    })
    .sort((a, b) => a.id - b.id);
}

/** Mutable fields are frozen here; immutable input/results stay in Pi tasks. */
export type ViewReference = Omit<CampaignView, "task" | "work" | "inputs"> & {
  work: Pick<Work, "taskId" | "status" | "attempts" | "attemptId" | "error">[];
  /** Last visible receipt ID, or zero; input receipts are append-only. */
  inputs: CampaignView["inputs"][number]["id"] | 0;
};

export function reference(view: CampaignView): ViewReference {
  const { task: _task, work, inputs, ...frozen } = view;
  return {
    ...frozen,
    inputs: inputs.at(-1)?.id ?? 0,
    work: work.map(({ taskId, status, attempts, attemptId, error }) => ({
      taskId,
      status,
      attempts,
      attemptId,
      error,
    })),
  };
}

export function materialize(
  snapshot: ViewReference,
  current: Pick<CampaignView, "task" | "work" | "inputs">,
): CampaignView {
  const workers = new Map(current.work.map((work) => [work.taskId, work]));
  return {
    ...snapshot,
    task: current.task,
    inputs: current.inputs.filter(({ id }) => id <= snapshot.inputs),
    work: snapshot.work.map((saved) => {
      const work = workers.get(saved.taskId);
      if (!work) throw new Error(`Snapshot task is missing: ${saved.taskId}`);
      return {
        ...work,
        ...saved,
        result: saved.status === "completed" ? work.result : null,
        publicationId: saved.status === "completed" ? work.publicationId : null,
      };
    }),
  };
}

/** Reconstruct a detached Coordinator view from its immutable input entry. */
export async function readView(
  tx: Tx,
  entryId: EntryId,
): Promise<CampaignView> {
  const entry = await tx.entry(entryId);
  if (
    entry?.kind !== "xean.attempt.started" ||
    entry.byTaskId === undefined ||
    (await tx.task(entry.byTaskId))?.kind !== COORDINATOR
  )
    throw new Error("Expected a Coordinator attempt-start entry");
  const saved = (entry.data as { snapshot?: ViewReference } | null)?.snapshot;
  if (!saved) throw new Error("Coordinator snapshot is missing");
  const workers: Work[] = [];
  for (const item of saved.work) {
    const task = await tx.task(item.taskId);
    if (!task || task.kind !== WORKER)
      throw new Error(`Snapshot task is missing: ${item.taskId}`);
    const current = work(task as PiTask);
    if (
      item.status === "completed" &&
      (current.status !== "completed" || current.publicationId === null)
    )
      throw new Error(`Snapshot publication is missing: ${item.taskId}`);
    workers.push(current);
  }
  const receipts: CampaignInput[] = [];
  let cursor: Cursor | undefined;
  if (saved.inputs !== 0)
    do {
      const page = await tx.scanTasks({ kind: COORDINATOR }, 256, cursor);
      receipts.push(
        ...inputs(
          page.items.filter((task) => task.id <= saved.inputs) as PiTask[],
        ),
      );
      cursor =
        (page.items.at(-1)?.id ?? 0) >= saved.inputs ? undefined : page.next;
    } while (cursor);
  if (saved.inputs !== 0 && receipts.at(-1)?.id !== saved.inputs)
    throw new Error(`Snapshot input is missing: ${saved.inputs}`);
  return json(
    materialize(saved, {
      task: (await tx.doc(campaign)).task,
      work: workers,
      inputs: receipts,
    }),
  );
}
