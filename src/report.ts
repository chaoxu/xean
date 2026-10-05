import type {
  ConversationId,
  Cursor,
  EntryRecord,
  TaskRecord,
  Tx,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { readDefinition } from "./definition.ts";
import {
  Control,
  scanTasks,
  blockedDecision,
  pendingDecisions,
  type WorkerInput,
} from "./workflow.ts";
import { readView } from "./math/state.ts";
import { resolveResult } from "./math/results.ts";
import { closure } from "./math/argument.ts";
import { stagePassed, verdict } from "./math/notes.ts";
import { verificationStages, type SolverResult } from "./math/contracts.ts";
import { CodexLog, CodexRequest } from "./roles/codex.ts";

export const statusText = (value: string | null | undefined): string | null =>
  value == null ? null : value.length > 500 ? `${value.slice(0, 499)}…` : value;
const preview = <T, R>(items: readonly T[], select: (item: T) => R) => ({
  items: items.slice(0, 10).map(select),
  omitted: Math.max(0, items.length - 10),
});
const errorOf = (
  task: TaskRecord<JsonValue, JsonValue, JsonValue>,
): string | null => {
  const outcome = task.state.outcome;
  return outcome?.error?.message ?? outcome?.reason ?? null;
};

/** Native assistant entries are responses, not a count of outbound retries. */
export async function readUsage(tx: Tx, includeRecords = false) {
  type UsageGroup = {
    provider: string;
    model: string;
    servedModel: string | null;
    api?: string;
    responses: number;
    invocations: number;
    unknownUsage: number;
    reportedUsage: Record<string, number>;
  };
  const groups = new Map<string, UsageGroup>();
  const accumulate = (
    identity: Pick<UsageGroup, "provider" | "model" | "api"> & {
      responseModel?: string;
    },
    counter: "responses" | "invocations",
    usage: Record<string, number> | null,
  ) => {
    const { provider, model, api } = identity;
    const servedModel = identity.responseModel ?? null;
    const key = JSON.stringify([counter, provider, model, api, servedModel]);
    const group = groups.get(key) ?? {
      provider,
      model,
      api,
      servedModel,
      responses: 0,
      invocations: 0,
      unknownUsage: 0,
      reportedUsage: {},
    };
    group[counter]++;
    if (usage === null) group.unknownUsage++;
    for (const [name, value] of Object.entries(usage ?? {}))
      group.reportedUsage[name] = (group.reportedUsage[name] ?? 0) + value;
    groups.set(key, group);
  };
  const records: EntryRecord[] = [];
  const codex = new Map<string, string>();
  const settlements = new Map<string, Record<string, number> | null>();
  let cursor: Cursor | undefined;
  do {
    const conversations = await tx.scanConversations({}, 128, cursor);
    for (const conversation of conversations.items) {
      let entriesCursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries(
          { conversationId: conversation.id },
          128,
          entriesCursor,
        );
        for (const entry of page.items) {
          if (entry.conversationId !== conversation.id) continue;
          if (includeRecords) records.push(entry);
          if (CodexRequest.is(entry))
            codex.set(entry.data.operationId, entry.data.model);
          if (CodexLog.is(entry)) {
            const receipt = entry.data;
            if (!settlements.has(receipt.operationId))
              settlements.set(receipt.operationId, receipt.usage);
          }
          for (const message of entry.model ?? []) {
            if (message.role !== "assistant") continue;
            const reported = message.usageReported;
            const numeric = Object.entries(message.usage ?? {}).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1]),
            );
            // Pi initializes missing provider usage to zero. Without an explicit
            // marker, a zero-only record cannot distinguish absence from zero.
            const measured =
              reported !== false &&
              (reported === true || numeric.some(([, value]) => value !== 0));
            accumulate(
              message,
              "responses",
              measured && numeric.length ? Object.fromEntries(numeric) : null,
            );
          }
        }
        entriesCursor = page.next;
      } while (entriesCursor);
    }
    cursor = conversations.next;
  } while (cursor);
  for (const [operationId, requestedModel] of codex)
    accumulate(
      { provider: "codex-cli", model: requestedModel, api: "codex-exec" },
      "invocations",
      settlements.get(operationId) ?? null,
    );
  const byModel = [...groups.values()];
  const total = (field: "responses" | "invocations" | "unknownUsage") =>
    byModel.reduce((sum, group) => sum + group[field], 0);
  return {
    calls: {
      recordedResponses: total("responses"),
      codexInvocations: total("invocations"),
      unknownUsage: total("unknownUsage"),
      byModel: preview(byModel, (item) => item),
    },
    ...(includeRecords ? { records: records.sort((a, b) => a.id - b.id) } : {}),
  };
}

/** One pinned native read supplies the mathematical view, operations, and usage. */
export async function readReport(
  tx: Tx,
  root: ConversationId,
  options: { records?: boolean } = {},
) {
  const definition = await readDefinition(tx, root);
  const view = await readView(tx, root);
  const control = await tx.doc(Control, root);
  const tasks = await scanTasks(tx, root);
  const workers = tasks.filter((task) => task.kind === "research.worker");
  const work = workers.map((task) => {
    const input = task.input as unknown as WorkerInput;
    const request = "request" in input ? input.request : undefined;
    const result =
      task.state.status === "terminal" &&
      (task.state.outcome.status === "completed" ||
        task.state.outcome.status === "failed")
        ? (task.state.outcome.result as unknown as SolverResult)
        : undefined;
    return {
      id: String(task.id),
      role: request?.kind ?? definition.mode?.role ?? task.kind,
      status:
        task.state.status === "terminal"
          ? task.state.outcome.status === "completed"
            ? "completed"
            : task.state.outcome.status === "aborted"
              ? "cancelled"
              : "failed"
          : task.state.status === "pending" ||
              task.state.status === "waiting" ||
              (task.state.checkpoint as { phase?: string } | undefined)
                ?.phase === "wait"
            ? "queued"
            : "active",
      retryOf: input.retryOf === undefined ? null : String(input.retryOf),
      error: errorOf(task),
      guidance:
        request?.kind === "explorer"
          ? request.guidance
          : request?.kind === "literature"
            ? request.query
            : request?.kind === "codex"
              ? request.assignment
              : null,
      noteIds: !request
        ? []
        : result?.kind === "verification"
          ? result.checks.map((check) => check.noteId)
          : view.notes
              .filter((note) => note.id.startsWith(`${task.id}/`))
              .map((note) => note.id),
      checkCount: result?.kind === "verification" ? result.checks.length : 0,
    };
  });
  const metadata = ({ id, role, status }: (typeof work)[number]) => ({
    id,
    role,
    status,
  });
  const acceptedNoteId = definition.mode ? null : control.accepted;
  if (
    acceptedNoteId !== null &&
    !view.notes.find((note) => note.id === acceptedNoteId)?.accepted
  )
    throw new Error("Accepted note is missing or no longer accepted");
  const standalone = definition.mode ? workers.at(-1) : undefined;
  const failure =
    standalone?.state.outcome?.status !== "completed" &&
    standalone?.state.status === "terminal"
      ? standalone
      : blockedDecision(tasks);
  const status =
    acceptedNoteId !== null || standalone?.state.outcome?.status === "completed"
      ? "completed"
      : control.cancelled
        ? "cancelled"
        : control.paused
          ? tasks.some((task) => task.state.status !== "terminal")
            ? "pausing"
            : "paused"
          : failure
            ? "blocked"
            : "running";
  const workCounts: Record<string, number> = {
    queued: 0,
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const item of work)
    workCounts[item.status] = (workCounts[item.status] ?? 0) + 1;
  const candidates = new Set(
    view.notes
      .filter((note) => note.candidate && !note.accepted)
      .map((note) => note.id),
  );
  const issues = closure([...candidates], view.notes).flatMap((note) =>
    verificationStages.flatMap((stage) => {
      if (
        (!candidates.has(note.id) &&
          (stage === "requirements" ||
            (stage === "reconstruction" && note.imported))) ||
        stagePassed(note, stage)
      )
        return [];
      const checked = verdict(note, stage);
      return [
        {
          noteId: note.id,
          stage,
          verdict: checked?.verdict ?? "unchecked",
          report: statusText(checked?.report),
        },
      ];
    }),
  );
  const usage = await readUsage(tx, options.records);
  const nextAction = {
    blocked: "Resolve the recorded failure, then resume with a fresh decision.",
    paused: "Resume when ready.",
    pausing: "Admitted work is draining.",
    completed: definition.mode
      ? "The standalone procedure completed. Its verdict remains separate."
      : "Export the accepted argument. Independent review is separate.",
    cancelled: "Start a new campaign to continue.",
    running: undefined,
  }[status];
  const summary = {
    status,
    error: statusText(failure ? errorOf(failure) : null),
    work: workCounts,
    pendingDecisions: pendingDecisions(tasks).length,
    acceptedNoteId,
    activity: preview(
      ["active", "queued"].flatMap((status) =>
        work.filter((item) => item.status === status),
      ),
      metadata,
    ),
    failures: preview(
      work.filter((item) => item.status === "failed").reverse(),
      (item) => ({ ...metadata(item), error: statusText(item.error) }),
    ),
    notes: {
      total: view.notes.length,
      imported: view.notes.filter((note) => note.imported).length,
      verified: view.notes.filter((note) => note.verified).length,
      dead: view.notes.filter((note) => note.dead).length,
      candidates: view.notes.filter((note) => note.candidate).length,
    },
    ...(nextAction ? { nextAction } : {}),
    ...(issues.length
      ? { verificationIssues: preview(issues, (item) => item) }
      : {}),
    calls: usage.calls,
    usageNote:
      "Counts describe native assistant responses, not outbound retries or Codex internal requests. Native numeric usage fields can overlap. Subscription usage stays unknown unless reported; price estimates are omitted. Direct ChatGPT Web usage is unmeasured and excluded.",
  };
  return {
    kind: definition.mode?.role ?? "solve",
    task: definition.task,
    status: summary,
    notes: view.notes,
    work,
    inputs: view.inputs,
    ...(standalone?.state.status === "terminal" &&
    (standalone.state.outcome.status === "completed" ||
      standalone.state.outcome.status === "failed") &&
    standalone.state.outcome.result !== undefined
      ? { result: await resolveResult(tx, standalone.state.outcome.result) }
      : {}),
    ...(options.records ? { records: usage.records, tasks } : {}),
  };
}
export type Report = Awaited<ReturnType<typeof readReport>>;
export type Status = Report["status"];
export type Work = Report["work"][number];
