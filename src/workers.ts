import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type TaskId,
  type TaskRecord,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { createRoleRuntime } from "./role-runtime.ts";
import {
  Notebook,
  admitNotes,
  appendNotes,
  definition,
  project,
  readNotebook,
} from "./state.ts";
import {
  explorerResultFor,
  noteIdAfter,
  pick,
  selectionResultFor,
  sourceVerdictsFor,
  type ExplorerInput,
  type Note,
  type SelectionInput,
  type Verification,
  type VerifierInput,
  type Verdict,
} from "./policy/contracts.ts";
import type { PiRoleProfile, SolveSettings } from "./policy/settings.ts";
import { directSupport, supportClosure } from "./policy/support.ts";
import { verificationPrefix } from "./policy/verification.ts";
import type { CodexRequest, CodexResult } from "./policy/source.ts";
import { verify } from "./verification.ts";

type Runtime = TaskRuntime<any, any, any, any>;
type NativeTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
export type SourceExecutor = (
  request: CodexRequest,
  signal: AbortSignal,
) => Promise<CodexResult>;
type Claim = {
  kind: "verify";
  input: VerifierInput;
  settings: SolveSettings;
};
export type WorkerInput = (
  | {
      kind: "explorer";
      input: Omit<ExplorerInput, "namespace">;
      profile: PiRoleProfile;
    }
  | {
      kind: "verifier";
      input: SelectionInput;
      settings: SolveSettings;
      verify?: Verification[];
    }
  | Claim
) & { previousTasks?: number[] };
export type WorkerRequest =
  | { kind: "explorer"; guidance?: string }
  | { kind: "verifier"; verify?: Verification[] }
  | { kind: "retry"; task: number };
type WorkerState = { phase: "run" } | { phase: "collect"; child: number };
const workerKind = "xean.worker";
const campaignKind = "xean.campaign";
const ResultEntry = defineEntry<{
  key: string;
  value: JsonValue;
  descriptor?: JsonValue;
}>("xean.role-result");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
export const completed = <Result extends JsonValue>(result: Result) => ({
  status: "terminal" as const,
  outcome: { status: "completed" as const, result },
});
const abort = async (_task: unknown, runtime: Runtime, context: Context) => {
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  );
};

async function tasks(tx: Tx, root: ConversationId): Promise<NativeTask[]> {
  const found: NativeTask[] = [];
  let cursor;
  do {
    const page = await tx.scanTasks({ conversationId: root }, 128, cursor);
    found.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return found;
}

function claims(records: readonly NativeTask[]) {
  return records.flatMap((task) => {
    const input = task.input as WorkerInput;
    return task.kind === workerKind &&
      task.state.status !== "terminal" &&
      input.kind === "verify"
      ? input.input.verify.map((entry) => entry.note)
      : [];
  });
}

function claimFor(
  input: Extract<WorkerInput, { kind: "verifier" }>,
  selected: Verification[],
  notes: Note[],
): Claim | undefined {
  if (input.input.verifyOnSolution) {
    const roots = selected
      .filter(
        (entry) =>
          entry.verifiers.includes("requirements") &&
          entry.verifiers.includes("reconstruction"),
      )
      .map((entry) => pick(notes, entry.note));
    const related = new Set([
      ...roots.map((note) => note.id),
      ...supportClosure(roots, notes),
    ]);
    selected = selected.filter((entry) => related.has(entry.note));
  }
  const batch = verificationPrefix(selected, notes, input.settings.window);
  if (!batch.length) return;
  const listed = batch.map((entry) => pick(notes, entry.note));
  const selectedIds = new Set(listed.map((note) => note.id));
  const support = directSupport(listed, notes).filter(
    (note) => !selectedIds.has(note.id),
  );
  const verifier: VerifierInput = {
    task: input.input.task,
    verify: batch,
    notes: listed,
    support,
  };
  return { kind: "verify", input: verifier, settings: input.settings };
}

/** Independently invoked roles retain Pi's native execution and recovery. */
export function createWorkers(options: { source?: SourceExecutor } = {}) {
  const roles = createRoleRuntime();
  const Worker = defineTask<WorkerInput, WorkerState, JsonValue>({
    name: workerKind,
    version: 1,
    initial: () => ({ phase: "run" }),
    abort,
    phases: {
      async run(task, runtime, context) {
        const origin = task.input.previousTasks?.[0] ?? task.id;
        if (task.input.kind === "explorer") {
          const input = { ...task.input.input, namespace: `w${origin}` };
          const answer = await roles.run(
            runtime,
            "role",
            { kind: "explorer", input },
            task.input.profile,
            context,
            task.input.previousTasks,
          );
          const result = explorerResultFor(input.notes, input.namespace).parse(
            answer.value,
          );
          await runtime.commit(async (tx) => {
            appendNotes(
              tx,
              await tx.doc(Notebook, task.conversationId),
              result.notes.map((note, position) => ({
                ...note,
                id: noteIdAfter(input.namespace, position),
              })),
              `xean/${origin}`,
            );
            return completed(result);
          }, context);
          return;
        }
        if (task.input.kind === "verifier") {
          const input = task.input;
          if (input.verify === undefined && input.input.notes.length === 0) {
            await runtime.commit(
              () => completed({ status: "no-work", verify: [] }),
              context,
            );
            return;
          }
          let selected = input.verify;
          if (selected === undefined) {
            const answer = await roles.run(
              runtime,
              "selection",
              { kind: "selection", input: input.input },
              input.settings.correctness,
              context,
              input.previousTasks,
            );
            selected = selectionResultFor(input.input.notes).parse(
              answer.value,
            ).verify;
          }
          await runtime.commit(async (tx) => {
            const records = await tasks(tx, task.conversationId);
            const { notes } = project(
              readNotebook(await tx.doc(Notebook, task.conversationId)),
            );
            const parsed = selectionResultFor(notes).safeParse({
              verify: selected,
            });
            if (!parsed.success)
              return completed({ status: "no-work", verify: [] });
            const claim = claimFor(input, parsed.data.verify, notes);
            if (!claim) return completed({ status: "no-work", verify: [] });
            const occupied = new Set(claims(records));
            if (claim.input.verify.some((entry) => occupied.has(entry.note))) {
              return completed({ status: "busy", verify: [] });
            }
            const child = await tx.createTask(Worker, claim, {
              conversationId: task.conversationId,
              ownership: { kind: "task", taskId: task.id },
            });
            return {
              status: "waiting",
              on: [child],
              policy: "allSettled",
              checkpoint: { phase: "collect", child },
            };
          }, context);
          return;
        }
        const input = task.input;
        const recorded = async (): Promise<Verdict[]> => {
          const book = await runtime.snapshot(
            Notebook,
            task.conversationId,
            context,
          );
          if (!book) throw new Error("Campaign notebook is missing");
          return book.checks
            .filter((check) => check.candidate === origin)
            .flatMap((check) => check.values);
        };
        await verify(input.input, input.settings, {
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
          record: async (id, values) => {
            await runtime.commit(async (tx) => {
              const book = await tx.doc(Notebook, task.conversationId);
              // A receipt is atomic, including adverse results for other roots.
              if (!book.checks.some((check) => check.call === id))
                book.checks.push({
                  candidate: origin,
                  call: id,
                  values: copy(values),
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
                value.verdicts.some((value) => value.sources.length)
              )
                throw new Error(
                  "Source citations require search to be enabled",
                );
              return value;
            };
            const output = await options.source(request, runtime.signal);
            let value: ReturnType<typeof validate> | undefined;
            let error: unknown;
            try {
              value = validate(output);
            } catch (cause) {
              error = cause;
            }
            await runtime.commit(async (tx) => {
              const book = await tx.doc(Notebook, task.conversationId);
              const id = (
                await tx.appendEntry(ResultEntry, task.conversationId, {
                  data: {
                    key,
                    value: copy(output) as JsonValue,
                    descriptor: copy(request) as JsonValue,
                  },
                })
              ).id;
              if (value)
                book.checks.push({
                  candidate: origin,
                  call: id,
                  values: value.verdicts.map(({ note, verdict, report }) => ({
                    note,
                    verdict,
                    report,
                    verifier: "source",
                  })),
                });
            }, context);
            if (!value) throw error;
          },
        });
        await runtime.commit(
          () => completed({ status: "completed", verify: input.input.verify }),
          context,
        );
      },
      async collect(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const child = await tx.task(task.state.checkpoint.child as TaskId);
          const outcome = child?.state.outcome;
          if (outcome?.status !== "completed")
            throw new Error(
              outcome?.error?.message ?? `Worker ${child?.id} did not complete`,
            );
          return completed(outcome.result);
        }, context);
      },
    },
  });

  const extension = defineExtension({ ...roles.extension, tasks: [Worker] });
  async function createGroup(
    tx: Tx,
    root: ConversationId,
    requests: readonly WorkerRequest[],
    owner?: TaskId,
  ): Promise<TaskId<JsonValue>[]> {
    if (!requests.length) throw new Error("Worker group must be nonempty");
    if (
      requests.some((request) => request.kind === "retry") &&
      requests.some((request) => request.kind !== "retry")
    )
      throw new Error("A retry group cannot admit fresh work");
    const records = await tasks(tx, root);
    const campaign = records.findLast((task) => task.kind === campaignKind);
    const live = records.filter((task) => task.state.status !== "terminal");
    const result = campaign?.state.outcome?.result as
      { resume?: { children?: number[] } } | undefined;
    if (owner !== undefined) {
      if (
        campaign?.id !== owner ||
        live.some((task) => task.kind === workerKind)
      )
        throw new Error(
          "Campaign groups are sealed until their workers settle",
        );
    } else if (
      campaign &&
      (campaign.state.status !== "terminal" || result?.resume)
    )
      throw new Error(
        "Campaign work must settle or resume before outside admission",
      );
    const resume = (
      campaign?.input as { resume?: { children?: number[] } } | undefined
    )?.resume;
    const origins = new Set<number>();
    const prepared = requests.map((request) => {
      if (request.kind !== "retry") return request;
      const prior = records.find((task) => task.id === request.task);
      if (
        !prior ||
        prior.kind !== workerKind ||
        prior.state.status !== "terminal" ||
        !["faulted", "aborted"].includes(prior.state.outcome.status)
      )
        throw new Error(
          "Retry requires a faulted or aborted public worker from this campaign",
        );
      if (prior.owner !== owner && !resume?.children?.includes(prior.id))
        throw new Error("Retry must belong to the campaign's admitted group");
      // Ordinary ownership makes a terminal parent's child immutable as well.
      const child =
        (prior.input as WorkerInput).kind === "verifier"
          ? records.findLast(
              (task) =>
                task.owner === prior.id &&
                task.kind === workerKind &&
                (task.input as WorkerInput).kind === "verify",
            )
          : undefined;
      const previous = child ?? prior;
      const input = copy(previous.input) as WorkerInput;
      const origin = input.previousTasks?.[0] ?? previous.id;
      if (origins.has(origin))
        throw new Error("Worker group contains duplicate retries");
      origins.add(origin);
      if (child?.state.outcome?.status === "completed") return child.id;
      input.previousTasks = [...(input.previousTasks ?? []), previous.id];
      return input;
    });
    const role = (input: (typeof prepared)[number]) =>
      typeof input === "number" || input.kind === "verify"
        ? "verifier"
        : input.kind;
    const kind = role(prepared[0]!);
    if (prepared.some((input) => role(input) !== kind))
      throw new Error("Explorer and Verifier groups cannot overlap");
    const occupied = new Set(claims(records));
    for (const input of prepared)
      if (typeof input !== "number" && input.kind === "verify")
        for (const { note } of input.input.verify) {
          if (occupied.has(note))
            throw new Error(
              "Verification claim is busy; retry after competing work settles",
            );
          occupied.add(note);
        }
    for (const task of live.filter((task) => task.id !== owner)) {
      if (task.kind !== workerKind)
        throw new Error("Campaign already has live work");
      const input = task.input as WorkerInput;
      if (origins.has(input.previousTasks?.[0] ?? task.id))
        throw new Error("Worker already has a live retry");
      if (
        kind === "explorer"
          ? input.kind !== "explorer"
          : input.kind === "explorer"
      )
        throw new Error("Explorer and Verifier groups cannot overlap");
    }
    const config = await definition(tx, root);
    if (
      requests.some((request) => request.kind === "explorer") ||
      (requests.some(
        (request) =>
          request.kind === "verifier" && request.verify === undefined,
      ) &&
        !live.some((task) => task.kind === workerKind))
    )
      await admitNotes(tx, root);
    const { notes, accepted } = project(
      readNotebook(await tx.doc(Notebook, root)),
    );
    if (requests[0]!.kind !== "retry" && accepted.length)
      throw new Error("Campaign is already accepted");
    const claimed = [...new Set(claims(records))];
    const reserved = new Set([
      ...claimed,
      ...requests.flatMap((request) =>
        request.kind === "verifier"
          ? (request.verify ?? []).map((entry) => entry.note)
          : [],
      ),
    ]);
    const available = notes.filter(
      (note) => !note.dead && !reserved.has(note.id),
    );
    const selectors = requests.filter(
      (request) => request.kind === "verifier" && request.verify === undefined,
    ).length;
    const views = Array.from({ length: selectors }, (_, slot) => {
      const targets = available.filter(
        (_, index) => index % selectors === slot,
      );
      if (!config.settings.verifyOnSolution) return targets;
      const related = new Set([
        ...targets.map((note) => note.id),
        ...supportClosure(targets, notes),
      ]);
      return notes.filter((note) => related.has(note.id));
    });
    let slot = 0;
    const inputs = prepared.map((request): WorkerInput | TaskId<JsonValue> => {
      if (typeof request === "number" || "input" in request) return request;
      if (request.kind === "explorer")
        return {
          kind: "explorer",
          input: {
            task: config.task,
            explorerGuidance: request.guidance ?? "",
            notes: notes.map(
              ({ text: _text, detailedSummary: _detail, ...note }) => note,
            ),
          },
          profile: config.settings.explorer,
        };
      if (request.kind === "verifier")
        return {
          kind: "verifier",
          input: {
            task: config.task,
            notes: request.verify === undefined ? views[slot++]! : notes,
            claimed,
            ...(config.settings.verifyOnSolution
              ? { verifyOnSolution: true }
              : {}),
          },
          settings: config.settings,
          ...(request.verify === undefined
            ? {}
            : {
                verify: selectionResultFor(notes).parse({
                  verify: request.verify,
                }).verify,
              }),
        };
      throw new Error("Retry worker is missing");
    });
    // Pi forbids new scans after task writes in the same transaction.
    const created: TaskId<JsonValue>[] = [];
    for (const input of inputs)
      created.push(
        typeof input === "number"
          ? input
          : await tx.createTask(Worker, input, {
              conversationId: root,
              ownership:
                owner === undefined
                  ? { kind: "conversation" }
                  : { kind: "task", taskId: owner },
            }),
      );
    return created;
  }
  return {
    extension,
    Worker,
    createGroup,
    async create(
      tx: Tx,
      root: ConversationId,
      request: WorkerRequest,
      owner?: TaskId,
    ): Promise<TaskId<JsonValue>> {
      return (await createGroup(tx, root, [request], owner))[0]!;
    },
  };
}
