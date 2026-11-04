import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type EntryId,
  type TaskId,
  type TaskRecord,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { createRoleRuntime, Assignment } from "./role-runtime.ts";
import {
  Notebook,
  admitNotes,
  appendNotes,
  definition,
  project,
  readNotebook,
} from "./state.ts";
import {
  establishes,
  explorerResultFor,
  invalidatesNote,
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
import type { CallDescriptor } from "./policy/prompts.ts";
import type { PiRoleProfile, SolveSettings } from "./policy/settings.ts";
import { reconstructionInput, supportClosure } from "./policy/support.ts";
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
  reconstruction: { note: string; call: number }[];
  targets: string[];
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
export type VerifierResult = {
  status: "completed" | "no-work" | "busy";
  verify: Verification[];
};
type WorkerState = { phase: "run" } | { phase: "collect"; child: number };
const workerKind = "xean.worker";
const campaignKind = "xean.campaign";
const ResultEntry = defineEntry<{
  key: string;
  value: JsonValue;
  descriptor?: JsonValue;
}>("xean.role-result");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const completed = (result: JsonValue) => ({
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
      ? input.targets
      : [];
  });
}

/** Only this attempt's evidence changes a frozen verification input. */
function refreshAttempt(
  input: VerifierInput,
  recorded: Verdict[],
): VerifierInput {
  const refreshed = copy(input);
  const known = new Map(
    [...refreshed.notes, ...refreshed.support].map((note) => [note.id, note]),
  );
  for (const id of refreshed.order) {
    const note = known.get(id)!;
    const values = recorded.filter((value) => value.note === id);
    note.verdicts.push(...values);
    note.dead ||=
      values.some(invalidatesNote) ||
      note.support.some((parent) => known.get(parent)?.dead);
    note.verified =
      !note.dead &&
      (note.verified ||
        establishes((name) =>
          values.some(
            (value) => value.verifier === name && value.verdict === "PASS",
          ),
        )) &&
      note.support.every((parent) => known.get(parent)?.verified);
  }
  return refreshed;
}

function claimFor(
  input: Extract<WorkerInput, { kind: "verifier" }>,
  selected: Verification[],
  notes: Note[],
  reconstructed: Record<string, number>,
): Claim | undefined {
  if (input.input.verifyOnSolution) {
    const roots = selected
      .filter((entry) => entry.verifiers.includes("reconstruction"))
      .map((entry) => pick(notes, entry.note));
    const needed = new Set([
      ...roots.map((note) => note.id),
      ...supportClosure(roots, notes),
    ]);
    selected = selected.filter((entry) => needed.has(entry.note));
  }
  const batch = verificationPrefix(selected, notes, input.settings.window);
  if (!batch.length) return;
  const listed = batch.map((entry) => pick(notes, entry.note));
  const support = supportClosure(listed, notes).map((id) => pick(notes, id));
  const included = new Set([...listed, ...support].map((note) => note.id));
  const verifier: VerifierInput = {
    task: input.input.task,
    verify: batch,
    notes: listed,
    support,
    order: notes.filter((note) => included.has(note.id)).map((note) => note.id),
  };
  const reconstruction = [...listed, ...support].flatMap((note) =>
    reconstructed[note.id] === undefined
      ? []
      : [{ note: note.id, call: reconstructed[note.id]! }],
  );
  const roots = batch
    .filter((entry) => entry.verifiers.includes("reconstruction"))
    .map((entry) => entry.note);
  const targets = new Set(batch.map((entry) => entry.note));
  // Claims cover potential work after preceding checks pass. An attested
  // premise may become usable during this batch; execution keeps its real flags.
  const potentialPremise = (note: Note) =>
    note.verification === undefined ? note : { ...note, verified: true };
  // Shared admitted premises need no claim. Generated proof obligations do.
  for (const note of reconstructionInput(
    {
      ...verifier,
      notes: verifier.notes.map(potentialPremise),
      support: verifier.support.map(potentialPremise),
    },
    roots,
    Object.fromEntries(reconstruction.map((ref) => [ref.note, "reusable"])),
  ).notes)
    targets.add(note.id);
  return {
    kind: "verify",
    input: verifier,
    settings: input.settings,
    reconstruction,
    targets: [...targets],
  };
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
          let prior: NativeTask | undefined;
          await runtime.commit(async (tx) => {
            prior = (await tasks(tx, task.conversationId)).findLast(
              (child) =>
                child.kind === workerKind &&
                child.owner !== undefined &&
                input.previousTasks?.includes(child.owner) &&
                (child.input as WorkerInput).kind === "verify",
            );
          }, context);
          let selected = input.verify;
          if (!prior && selected === undefined) {
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
            if (prior?.state.outcome?.status === "completed")
              return completed(prior.state.outcome.result);
            const records = await tasks(tx, task.conversationId);
            let claim: WorkerInput;
            if (prior) {
              if (prior.state.status !== "terminal")
                throw new Error("Previous verification is still running");
              claim = copy(prior.input) as WorkerInput;
              claim.previousTasks = [...(claim.previousTasks ?? []), prior.id];
            } else {
              const { notes, reconstructed } = project(
                readNotebook(await tx.doc(Notebook, task.conversationId)),
              );
              const parsed = selectionResultFor(notes).safeParse({
                verify: selected,
              });
              if (!parsed.success)
                return completed({ status: "no-work", verify: [] });
              const next = claimFor(
                input,
                parsed.data.verify,
                notes,
                reconstructed,
              );
              if (!next) return completed({ status: "no-work", verify: [] });
              claim = next;
            }
            if (claim.kind !== "verify")
              throw new Error("Verification claim is missing");
            const occupied = new Set(claims(records));
            if (claim.targets.some((id) => occupied.has(id))) {
              if (prior)
                throw new Error(
                  "Verification claim is busy; retry after competing work settles",
                );
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
        const allowed = async (ids: readonly string[]) => {
          const book = await runtime.snapshot(
            Notebook,
            task.conversationId,
            context,
          );
          if (!book) throw new Error("Campaign notebook is missing");
          const current = new Map(
            project(readNotebook(book)).notes.map((note) => [note.id, note]),
          );
          return ids.every((id) => current.get(id)?.dead === false);
        };
        const relevant = (descriptor: CallDescriptor) => {
          if (descriptor.kind === "explorer" || descriptor.kind === "selection")
            throw new Error(
              "Verification cannot run an exploration or selection call",
            );
          const known = input.input.order.map((id) =>
            pick([...input.input.notes, ...input.input.support], id),
          );
          const roots =
            descriptor.kind === "verifier"
              ? descriptor.judged.map((id) => pick(known, id))
              : descriptor.input.notes;
          return [
            ...roots.map((note) => note.id),
            ...supportClosure(roots, known),
          ];
        };
        const premises: Record<string, string> = {};
        await runtime.commit(async (tx) => {
          for (const ref of input.reconstruction) {
            const entry = await tx.entry(ref.call as EntryId);
            if (!entry) throw new Error("Missing reconstruction receipt");
            const { descriptor } = await tx.doc(
              Assignment,
              entry.conversationId,
            );
            if (descriptor?.kind !== "reconstruction")
              throw new Error("Missing reconstruction assignment");
            const statement = descriptor.statement.statements.find(
              (value) => value.note === ref.note,
            );
            if (!statement) throw new Error("Missing reconstructed statement");
            premises[ref.note] = statement.statement;
          }
        }, context);
        await verify(input.input, input.settings, {
          premises,
          call: async (key, descriptor, profile) => {
            const prior = await roles.peek(
              runtime,
              key,
              context,
              input.previousTasks,
            );
            if (prior?.receipt) return prior.receipt;
            descriptor = prior?.descriptor ?? descriptor;
            if (!(await allowed(relevant(descriptor)))) return;
            return roles.run(
              runtime,
              key,
              descriptor,
              prior?.profile ?? profile,
              context,
              input.previousTasks,
            );
          },
          recorded,
          refresh: async () => refreshAttempt(input.input, await recorded()),
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
            let prior:
              { call: number; value: ReturnType<typeof validate> } | undefined;
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
            const known = input.input.order.map((id) =>
              pick([...input.input.notes, ...input.input.support], id),
            );
            const roots = judged.map((id) => pick(known, id));
            if (!(await allowed([...judged, ...supportClosure(roots, known)])))
              return;
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
    const parent =
      owner === undefined
        ? undefined
        : records.find((task) => task.id === owner);
    if (
      owner !== undefined &&
      (!parent ||
        parent.kind !== campaignKind ||
        parent.state.status === "terminal")
    )
      throw new Error("Worker owner must be an active campaign");
    const result = campaign?.state.outcome?.result as
      { resume?: { children?: number[] } } | undefined;
    if (
      campaign &&
      campaign.id !== owner &&
      (campaign.state.status !== "terminal" || result?.resume)
    )
      throw new Error(
        "Campaign work must settle or resume before outside admission",
      );
    const resume = (
      parent?.input as { resume?: { children?: number[] } } | undefined
    )?.resume;
    const origins = new Set<number>();
    const prepared = requests.map((request) => {
      const prior =
        request.kind === "retry"
          ? records.find((task) => task.id === request.task)
          : undefined;
      if (request.kind === "retry") {
        if (
          !prior ||
          prior.kind !== workerKind ||
          prior.state.status !== "terminal" ||
          !["faulted", "aborted"].includes(prior.state.outcome.status) ||
          (prior.input as WorkerInput).kind === "verify"
        )
          throw new Error(
            "Retry requires a faulted or aborted public worker from this campaign",
          );
        if (prior.owner !== owner && !resume?.children?.includes(prior.id))
          throw new Error("Retry must belong to the campaign's admitted group");
        const origin =
          (prior.input as WorkerInput).previousTasks?.[0] ?? prior.id;
        if (origins.has(origin))
          throw new Error("Worker group contains duplicate retries");
        origins.add(origin);
      }
      return {
        request,
        prior,
        kind: prior ? (prior.input as WorkerInput).kind : request.kind,
      };
    });
    const kind = prepared[0]!.kind;
    if (prepared.some((request) => request.kind !== kind))
      throw new Error("Explorer and Verifier groups cannot overlap");
    for (const live of records.filter(
      (task) => task.state.status !== "terminal" && task.id !== owner,
    )) {
      if (live.kind !== workerKind)
        throw new Error("Campaign already has live work");
      const input = live.input as WorkerInput;
      if (origins.has(input.previousTasks?.[0] ?? live.id))
        throw new Error("Worker already has a live retry");
      if (
        kind === "explorer"
          ? input.kind !== "explorer"
          : input.kind === "explorer"
      )
        throw new Error("Explorer and Verifier groups cannot overlap");
      if (
        owner !== undefined &&
        live.owner !== owner &&
        !records.some(
          (parent) => parent.id === live.owner && parent.owner === owner,
        )
      )
        throw new Error("Worker belongs to another admitted group");
    }
    const config = await definition(tx, root);
    if (
      requests.some((request) => request.kind === "explorer") ||
      (requests.some(
        (request) =>
          request.kind === "verifier" && request.verify === undefined,
      ) &&
        !records.some(
          (task) =>
            task.kind === workerKind && task.state.status !== "terminal",
        ))
    )
      await admitNotes(tx, root);
    const { notes, accepted } = project(
      readNotebook(await tx.doc(Notebook, root)),
    );
    if (requests[0]!.kind !== "retry" && accepted.length)
      throw new Error("Campaign is already accepted");
    const inputs: WorkerInput[] = prepared.map(({ request, prior }) => {
      if (prior) {
        const input = copy(prior.input) as WorkerInput;
        input.previousTasks = [...(input.previousTasks ?? []), prior.id];
        return input;
      }
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
            notes,
            claimed: [...new Set(claims(records))],
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
        await tx.createTask(Worker, input, {
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
