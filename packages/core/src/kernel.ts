import { isDeepStrictEqual } from "node:util";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AgentDoc,
  createRegistry,
  defineTask,
  ROOT_CONVERSATION_ID,
  type Tx,
  type HarnessOptions,
  type EntryId,
  type EntryRecord,
  type Storage,
  type TaskId,
  type TaskOutcome,
  type TaskRecord,
  type Registry,
} from "@earendil-works/pi-durable";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { Check } from "typebox/value";
import { errorText, json } from "./json.ts";
import { openXeanStorage } from "./storage.ts";
import {
  inputs,
  readView,
  reference,
  work,
  type ViewReference,
} from "./history.ts";
import { campaignVersion, limitsSchema, TransientError } from "./types.ts";
import type { CallRecorder } from "./calls.ts";
import {
  COORDINATOR,
  Store,
  WORKER,
  initialAttempt,
  isXeanTask,
  taskVersion,
  type Input,
  type Runtime,
  type AttemptState,
  type PiTask,
  type Transaction,
  type TerminalState,
} from "./store.ts";
import type {
  Campaign,
  CampaignInput,
  CampaignState,
  CampaignView,
  Decision,
  Execution,
  JsonValue,
  Limits,
  RecordProjection,
  Signal,
  WorkRequest,
  XeanOptions,
  XeanStatus,
} from "./types.ts";

type Calls = { pending: Set<Promise<void>>; failure?: Error };
type Reserved = {
  task: PiTask;
  attemptId: string;
  input: JsonValue;
};
const stopped = (status: XeanStatus) =>
  status === "cancelled" || status === "completed";
const owners = new WeakSet<Storage>();

function limits(input: Partial<Limits> = {}): Limits {
  const { concurrency = 4, attempts = 3 } = input;
  const value = { ...input, concurrency, attempts };
  if (!Check(limitsSchema, value)) throw new Error("Invalid campaign limits");
  return json(value);
}

function view(tx: Transaction): CampaignView {
  // Borrowed projection; copy once at each external boundary.
  return {
    task: tx.state.task,
    status: tx.state.status,
    state: tx.state.state,
    work: tx.tasks.filter((t) => t.kind === WORKER).map(work),
    inputs: inputs(tx.tasks),
  };
}

function snapshot(tx: Transaction): Campaign {
  return json({
    ...tx.state,
    ...view(tx),
    pendingSignals: tx.tasks.filter(
      (t) => t.kind === COORDINATOR && t.state.status !== "terminal",
    ).length,
  });
}

function terminal(
  task: PiTask,
  outcome: Extract<
    TaskOutcome<JsonValue>,
    { status: "completed" | "failed" | "aborted" }
  >,
  publicationId: TaskId<JsonValue> | null = null,
): TerminalState {
  if (task.kind === WORKER && task.state.status !== "terminal") {
    outcome = {
      ...outcome,
      result: {
        output: outcome.result ?? null,
        attempts: task.state.checkpoint!.attempts,
        attemptId: task.state.checkpoint!.attemptId,
        publicationId,
      },
    };
  }
  return { status: "terminal", outcome };
}

/** Xean's campaign policy over pi-durable's native atomic record storage. */
export class Xean {
  private runPromise?: Promise<Campaign>;
  private runRequested = false;
  private closePromise?: Promise<void>;
  private closing = false;
  private fault: unknown;

  private constructor(
    private readonly store: Store,
    private readonly options: XeanOptions,
    private readonly registry: Registry,
    private readonly models: MutableModels,
  ) {}

  static async open(storage: Storage, options: XeanOptions): Promise<Xean> {
    if (owners.has(storage))
      throw new Error("Storage already has a Xean owner");
    owners.add(storage);
    let store: Store | undefined;
    const initialized = Promise.withResolvers<void>();
    initialized.promise.catch(() => {});
    try {
      const names = new Set<string>();
      for (const role of options.roles) {
        if (!role.name || names.has(role.name))
          throw new Error(`Duplicate or empty role: ${role.name}`);
        names.add(role.name);
      }
      if (!options.coordinator.name)
        throw new Error("Coordinator requires a name");
      const campaignLimits = limits(options.limits);
      const initial: CampaignState | undefined =
        options.task === undefined
          ? undefined
          : {
              version: campaignVersion,
              task: json(options.task),
              coordinator: options.coordinator.name,
              status: "running",
              state: null,
              limits: campaignLimits,
              providerCalls: 0,
              result: null,
              error: null,
            };
      let xean: Xean;
      const registry = createRegistry();
      registry.install({
        name: "xean",
        tasks: [WORKER, COORDINATOR].map((name) =>
          defineTask<Input, AttemptState, JsonValue, object>({
            name,
            version: taskVersion,
            initial: initialAttempt,
            phases: {
              run: (task, runtime, context) =>
                xean.execute(task, runtime, context),
            },
            abort: (task, runtime) =>
              xean.store.mutateTask(runtime, () =>
                terminal(task, { status: "aborted", reason: "cancelled" }),
              ),
          }),
        ),
      });
      const models = createModels();
      const runtime: HarnessOptions = {
        models,
        registry,
        settings: {
          compaction: { enabled: false },
          retry: { enabled: false },
          toolExecution: "sequential",
        },
        admitTasks: (tx, candidates, active) =>
          xean.reserve(tx, candidates, active),
        onTaskRecovery: async (tx, task) => {
          if (!isXeanTask(task)) return;
          await tx.appendEntry(ROOT_CONVERSATION_ID, {
            kind: "xean.attempt.interrupted",
            data: {
              attemptId: (task.state.checkpoint as AttemptState).attemptId,
            },
            byTaskId: task.id,
          });
        },
        onTaskFailure: async (tx, task, outcome) => {
          if (!isXeanTask(task)) return false;
          await initialized.promise;
          await xean.failTask(
            await xean.store.transaction(tx),
            task as PiTask,
            outcome.status === "faulted"
              ? outcome.error.message
              : outcome.reason,
          );
          return true;
        },
        onReport: (error) => xean?.fail(error),
      };
      store = await Store.open(storage, initial, runtime, (state, tasks) => {
        if (state.coordinator !== options.coordinator.name)
          throw new Error(
            "Coordinator identity differs from the recorded campaign",
          );
        if (
          initial !== undefined &&
          !isDeepStrictEqual(initial.task, json(state.task))
        )
          throw new Error("Task differs from the recorded campaign");
        if (
          options.limits !== undefined &&
          !isDeepStrictEqual(campaignLimits, json(state.limits))
        )
          throw new Error("Limits differ from the recorded campaign");
        for (const task of tasks) {
          if (task.state.status === "terminal") continue;
          if (
            task.kind === WORKER &&
            !names.has((task.input as WorkRequest).role)
          )
            throw new Error(
              `Missing role: ${(task.input as WorkRequest).role}`,
            );
        }
      });
      xean = new Xean(store, options, registry, models);
      initialized.resolve();
      await xean.mutate(async (tx) => {
        if (tx.tasks.length === 0)
          await tx.newTask(COORDINATOR, { kind: "start", value: null });
        if (tx.state.status === "pausing") tx.state.status = "paused";
      });
      return xean;
    } catch (error) {
      initialized.reject(error);
      await (store ? store.close() : storage.close(BACKGROUND_CONTEXT)).catch(
        () => {},
      );
      owners.delete(storage);
      throw error;
    }
  }

  private fail(error: unknown): void {
    this.fault ??= this.store.failure ?? error;
    this.store.harness.pause({ interrupt: true });
  }

  private async mutate<T>(fn: (tx: Transaction) => T | Promise<T>): Promise<T> {
    try {
      return await this.store.mutate(fn);
    } catch (error) {
      if (this.store.failure) {
        this.fail(error);
      }
      throw error;
    }
  }

  inspect(): Promise<Campaign> {
    return this.store.mutate(snapshot);
  }
  /** Read campaign state and its journal at the same serialized point. */
  inspectWithRecords(project?: RecordProjection): Promise<{
    campaign: Campaign;
    records: EntryRecord[];
  }> {
    return this.store.mutate(async (tx) => ({
      campaign: snapshot(tx),
      records: await tx.entries(project),
    }));
  }
  records(): Promise<EntryRecord[]> {
    return this.store.mutate((tx) => tx.entries());
  }

  /** Resolve an attempt-start entry to its exact historical callback input. */
  attemptInput(entryId: EntryId): Promise<JsonValue> {
    return this.store.mutate(async (tx) => {
      const entry = await tx.native.entry(entryId);
      if (!entry || entry.kind !== "xean.attempt.started")
        throw new Error("Expected an attempt-start entry");
      const task =
        entry.byTaskId === undefined
          ? undefined
          : await tx.native.task(entry.byTaskId);
      if (!task) throw new Error("Attempt task is missing");
      if (task.kind === WORKER) return json((task.input as WorkRequest).input);
      return {
        signal: json({ id: task.id, ...(task.input as Omit<Signal, "id">) }),
        view: await readView(tx.native, entryId),
      };
    });
  }

  /** Run until waiting, paused, blocked, or terminal. Waiting is not acceptance. */
  run(): Promise<Campaign> {
    if (this.closing)
      return Promise.reject(new Error("Xean is closing or closed"));
    this.runRequested = true;
    if (!this.runPromise)
      this.runPromise = (async () => {
        try {
          let result: Campaign;
          do {
            this.runRequested = false;
            result = await this.drive();
          } while (this.runRequested && !this.closing);
          return result;
        } finally {
          this.runPromise = undefined;
        }
      })();
    return this.runPromise;
  }

  private async drive(): Promise<Campaign> {
    for (;;) {
      if (!this.closing) this.store.harness.resume();
      await this.store.harness.waitForQuiescence(BACKGROUND_CONTEXT);
      if (this.fault) throw this.fault;
      const idle = await this.mutate((tx) => {
        if (
          !this.closing &&
          tx.state.status === "running" &&
          tx.tasks.some((task) => task.state.status === "pending")
        )
          return null;
        if (tx.state.status === "pausing") tx.state.status = "paused";
        this.store.harness.pause();
        return snapshot(tx);
      });
      if (idle) return idle;
    }
  }

  private async reserve(
    native: Tx,
    candidates: readonly TaskRecord<JsonValue, JsonValue, JsonValue>[],
    activeIds: readonly TaskId[],
  ) {
    if (!candidates.length || this.closing || this.fault) return [];
    const tx = await this.store.transaction(native);
    const active = new Set(activeIds);
    const out: { id: TaskId; checkpoint: JsonValue }[] = [];
    // Native descendants retain their checkpoints and finish inside the admitted
    // owner's slot, including during pause and blocking.
    // Pi excludes terminal/completing candidates, so each has a checkpoint.
    for (const candidate of candidates) {
      if (candidate.abortRequested) {
        out.push({ id: candidate.id, checkpoint: candidate.state.checkpoint! });
        continue;
      }
      if (isXeanTask(candidate)) continue;
      let owner: typeof candidate | undefined = candidate;
      while (owner && !isXeanTask(owner)) {
        const parent: TaskId | undefined =
          owner.owner ??
          (await native.conversation(owner.conversationId))?.owner?.taskId;
        owner = parent === undefined ? undefined : await native.task(parent);
      }
      if (!owner || !active.has(owner.id)) continue;
      const agent = await native.doc(AgentDoc, candidate.conversationId);
      if (
        (Array.isArray(agent.extensions)
          ? agent.extensions
          : (agent.extensions?.add ?? [])
        ).every((name) => this.registry.snapshot().extension(name))
      )
        out.push({ id: candidate.id, checkpoint: candidate.state.checkpoint! });
    }
    if (tx.state.status !== "running") return out;
    const roots = candidates.filter(
      (task) => isXeanTask(task) && !task.abortRequested,
    ) as PiTask[];
    const selected: PiTask[] = [];
    // Later signals wait for the oldest decision, including recovery cleanup.
    const oldest = tx.tasks
      .filter((t) => t.kind === COORDINATOR && t.state.status !== "terminal")
      .sort((a, b) => a.id - b.id)[0];
    const coordinator = roots.find(
      (t) => t.id === oldest?.id && t.state.status === "pending",
    );
    if (coordinator) selected.push(coordinator);
    const occupied = tx.tasks.filter(
      (t) => t.kind === WORKER && active.has(t.id),
    ).length;
    selected.push(
      ...roots
        .filter((t) => t.kind === WORKER && t.state.status === "pending")
        .slice(0, Math.max(0, tx.state.limits.concurrency - occupied)),
    );
    const exhausted = selected.find(
      (task) =>
        task.state.checkpoint &&
        task.state.checkpoint.attempts >= tx.state.limits.attempts,
    );
    if (exhausted) {
      this.exhaust(tx, exhausted);
      return out;
    }
    // Read frozen Coordinator views before the first table write in the batch.
    let frozen: ViewReference | undefined;
    const previous = coordinator?.state.checkpoint;
    if (
      previous?.inputId !== undefined &&
      previous.error === null &&
      (await native.scanConversations({ ownerTaskId: coordinator!.id }, 1))
        .items.length
    ) {
      const entry = await native.entry(previous.inputId);
      frozen = (entry!.data as { snapshot: ViewReference }).snapshot;
    }
    for (const task of selected) {
      if (!task.state.checkpoint) continue;
      const attemptId = crypto.randomUUID();
      const checkpoint: AttemptState = {
        ...task.state.checkpoint,
        attempts: task.state.checkpoint.attempts + 1,
        attemptId,
        error: null,
      };
      const inputId = await tx.entry(
        "xean.attempt.started",
        {
          attemptId,
          attempt: checkpoint.attempts,
          ...(task.kind === COORDINATOR
            ? {
                snapshot: frozen ?? reference(view(tx)),
              }
            : {}),
        },
        task.id,
      );
      if (task.kind === COORDINATOR) checkpoint.inputId = inputId;
      out.push({ id: task.id, checkpoint });
    }
    return out;
  }

  private exhaust(tx: Transaction, task: PiTask): void {
    // Pi cancels and joins private descendants before finalizing this outcome.
    tx.writeTask({
      ...task,
      memos: undefined,
      state: {
        status: "completing",
        checkpoint: task.state.checkpoint!,
        outcome: {
          status: "faulted",
          error: { message: `Attempt limit reached for task ${task.id}` },
        },
      },
    });
  }

  private async execute(
    task: PiTask,
    runtime: Runtime,
    nativeContext: Context,
  ): Promise<void> {
    if (task.state.status !== "running")
      throw new Error("Pi invoked a non-running task");
    const attempt = task.state.checkpoint.attempts;
    const item: Reserved = {
      task,
      attemptId: task.state.checkpoint.attemptId!,
      input:
        task.kind === WORKER
          ? json((task.input as WorkRequest).input)
          : await this.attemptInput(task.state.checkpoint.inputId!),
    };
    const active = withCancel(nativeContext);
    const calls: Calls = { pending: new Set() };
    const telemetry = this.options.telemetry ?? NOOP_TELEMETRY_CONTEXT;
    try {
      await runtime.commit(() => undefined, nativeContext);
      await telemetry.startSpan(
        {
          name: item.task.kind,
          attributes: {
            "xean.task": item.task.id,
            "xean.attempt": item.attemptId,
          },
        },
        async (span) => {
          const context = active.context;
          const execution: Execution = {
            attemptId: item.attemptId,
            inputId: task.state.checkpoint?.inputId,
            attempt,
            recorder: this.recorder(item, runtime, context, calls),
            telemetry: span,
            durable: {
              taskId: runtime.taskId,
              conversation: runtime.conversation,
              snapshot: runtime.snapshot,
              memo: runtime.memo,
              context: runtime.context,
              registry: this.registry,
              models: this.models,
              async commit(change, context) {
                let result: Awaited<ReturnType<typeof change>>;
                await runtime.commit(async (tx) => {
                  result = await change(tx);
                  return undefined;
                }, context);
                return result!;
              },
            },
          };
          let result: JsonValue;
          if (item.task.kind === WORKER) {
            const role = this.options.roles.find(
              (r) => r.name === (item.task.input as WorkRequest).role,
            )!;
            result = json(await role.run(item.input, execution, context));
          } else {
            const { signal, view } = item.input as {
              signal: Signal;
              view: CampaignView;
            };
            result = json(
              await this.options.coordinator.run(
                signal,
                view,
                execution,
                context,
              ),
            );
          }
          await this.joinOwned(runtime.taskId, context);
          if (calls.failure) throw calls.failure;
          if (calls.pending.size > 0)
            throw new Error("Role returned with unsettled provider calls");
          await this.store.mutateTask(runtime, async (tx, current) => {
            const next =
              item.task.kind === WORKER
                ? await this.finishWorker(tx, current, {
                    status: "completed",
                    result,
                  })
                : await this.commitDecision(tx, current, result as Decision);
            await tx.entry(
              "xean.attempt.completed",
              { attemptId: item.attemptId },
              current.id,
            );
            return next;
          });
        },
      );
    } catch (error) {
      active.cancel(error);
      // A rejected Promise.all can leave sibling calls cleaning up after abort.
      // Keep the attempt alive until their accounting writes have settled.
      await Promise.all(calls.pending);
      if (this.store.failure) throw error;
      if (this.closing || nativeContext.abortSignal?.aborted) return;
      await this.joinOwned(runtime.taskId, nativeContext, true);
      await this.store.mutateTask(runtime, async (tx, task) => {
        if (task.state.status !== "running") return;
        const message = errorText(error);
        await tx.entry(
          "xean.attempt.failed",
          { attemptId: item.attemptId, error: message },
          task.id,
        );
        const checkpoint = { ...task.state.checkpoint, error: message };
        if (
          error instanceof TransientError &&
          checkpoint.attempts < tx.state.limits.attempts
        ) {
          tx.writeTask({ ...task, state: { status: "pending", checkpoint } });
          return;
        }
        return this.failureState(tx, task, message);
      });
    } finally {
      active.cancel();
    }
  }

  /** Pi owns descendant joins and aborts; shared publication waits for them. */
  private async joinOwned(
    taskId: TaskId,
    context: Context,
    abort = false,
  ): Promise<void> {
    const graph = await this.store.harness.taskGraph(context);
    const conversations = graph.value.tasks[taskId]?.conversations ?? [];
    const children = Object.values(graph.value.tasks).filter(
      (task) => task.owner === taskId,
    );
    graph.dispose();
    await Promise.all([
      ...conversations.map(async (id) => {
        const conversation = (await this.store.harness.conversation(
          id,
          context,
        ))!;
        if (abort) await conversation.abort(context, { background: true });
        else await conversation.waitForIdle(context);
      }),
      ...children.map(async (child) => {
        if (abort) await this.store.harness.abortTask(child.id, context);
        await this.store.harness.waitForTask(child.id, context);
      }),
    ]);
  }

  private async failTask(
    tx: Transaction,
    task: PiTask,
    message: string,
  ): Promise<void> {
    const state = await this.failureState(tx, task, message);
    if (state) tx.writeTask({ ...task, memos: undefined, state });
  }

  private async failureState(
    tx: Transaction,
    task: PiTask,
    message: string,
  ): Promise<TerminalState | undefined> {
    if (task.state.status === "terminal") return;
    if (!task.state.checkpoint)
      throw new Error("Xean failure lost its attempt checkpoint");
    if (stopped(tx.state.status))
      return terminal(task, { status: "aborted", reason: tx.state.status });
    const outcome = { status: "failed" as const, error: { message } };
    if (task.kind === WORKER) return this.finishWorker(tx, task, outcome);
    tx.writeTask({
      ...task,
      state: {
        status: "pending",
        checkpoint: { ...task.state.checkpoint, error: message },
      },
    });
    tx.state.status = "blocked";
    tx.state.error = message;
    return undefined;
  }

  private async finishWorker(
    tx: Transaction,
    task: PiTask,
    outcome:
      | { status: "completed"; result: JsonValue }
      | { status: "failed"; error: { message: string } },
  ): Promise<TerminalState> {
    const signalId = await tx.newTask(COORDINATOR, {
      kind: outcome.status,
      value: { workId: (task.input as WorkRequest).id, taskId: task.id },
    });
    return terminal(
      task,
      outcome,
      outcome.status === "completed" ? signalId : null,
    );
  }

  private async commitDecision(
    tx: Transaction,
    task: PiTask,
    decision: Decision,
  ): Promise<TerminalState> {
    const requests = decision.dispatch ?? [];
    const existing = new Map(
      tx.tasks
        .filter((t) => t.kind === WORKER)
        .map((t) => [(t.input as WorkRequest).id, t.input]),
    );
    const admitted: WorkRequest[] = [];
    for (const request of requests) {
      const prior = existing.get(request.id);
      if (prior) {
        if (!isDeepStrictEqual(prior, request))
          throw new Error(
            `Work ID reused with a different request: ${request.id}`,
          );
      } else {
        if (!this.options.roles.some((r) => r.name === request.role))
          throw new Error(`Unknown role: ${request.role}`);
        existing.set(request.id, request);
        admitted.push(request);
      }
    }
    if (decision.completion !== undefined) {
      if (admitted.length > 0)
        throw new Error("A completion decision cannot dispatch new work");
      const pendingSignal = tx.tasks.some(
        (other) =>
          other.id !== task.id &&
          other.kind === COORDINATOR &&
          other.state.status === "pending",
      );
      // Consume this decision, then let pending signals reach a fresh Coordinator view.
      if (!pendingSignal) {
        if (
          this.options.accept?.(json(decision.completion), json(view(tx))) !==
          true
        )
          throw new Error("Completion was not accepted by the application");
        this.halt(tx, "completed", null, task.id);
        tx.state.result = decision.completion;
      }
    }
    tx.state.state = decision.state;
    for (const request of admitted) await tx.newTask(WORKER, request);
    return terminal(task, { status: "completed", result: decision });
  }

  private recorder(
    item: Reserved,
    runtime: Runtime,
    context: Context,
    calls: Calls,
  ): CallRecorder {
    return {
      begin: async (model) => {
        model = json(model);
        // Register before admission can yield, so returning during begin()
        // cannot bypass the unsettled-call guard.
        const completion = Promise.withResolvers<void>();
        calls.pending.add(completion.promise);
        const finish = () => {
          calls.pending.delete(completion.promise);
          completion.resolve();
        };
        let id!: EntryId;
        try {
          await this.store.mutateTask(runtime, async (tx) => {
            context.abortSignal?.throwIfAborted();
            tx.state.providerCalls++;
            id = await tx.entry(
              "xean.call.started",
              { attemptId: item.attemptId, model },
              item.task.id,
            );
          });
        } catch (error) {
          finish();
          throw error;
        }
        let requestRecorded = false;
        let settled = false;
        return {
          recordRequest: async (payload) => {
            if (requestRecorded || settled)
              throw new Error(
                "Provider call request already recorded or settled",
              );
            requestRecorded = true;
            payload = json(payload);
            await this.store.mutateTask(runtime, async (tx) => {
              context.abortSignal?.throwIfAborted();
              await tx.entry(
                "xean.call.request",
                { callId: id, payload },
                item.task.id,
              );
            });
          },
          settle: async (message, usage) => {
            if (settled) throw new Error("Provider call already settled");
            settled = true;
            // Operational accounting survives failure/cancellation of mathematical work.
            try {
              const data = JSON.parse(
                JSON.stringify({ callId: id, message, usage }),
              ) as JsonValue;
              await this.mutate((tx) =>
                tx.entry("xean.call.settled", data, item.task.id),
              );
            } catch (error) {
              calls.failure = new Error(errorText(error));
              throw error;
            } finally {
              finish();
            }
          },
        };
      },
    };
  }

  private halt(
    tx: Transaction,
    status: "cancelled" | "completed",
    error: string | null,
    except?: TaskId,
  ): void {
    tx.state.status = status;
    tx.state.error = error;
    for (const task of tx.tasks)
      if (task.state.status !== "terminal" && task.id !== except) {
        tx.writeTask({
          ...task,
          abortRequested: true,
        });
      }
  }

  async cancel(): Promise<Campaign> {
    await this.mutate((tx) => {
      if (tx.state.status !== "cancelled" && tx.state.status !== "completed")
        this.halt(tx, "cancelled", "Cancelled by user");
    });
    this.store.harness.resume();
    await this.store.harness.waitForQuiescence(BACKGROUND_CONTEXT);
    this.store.harness.pause();
    return this.inspect();
  }

  async pause(): Promise<Campaign> {
    await this.mutate((tx) => {
      if (tx.state.status === "running") tx.state.status = "pausing";
    });
    await this.runPromise;
    await this.store.harness.waitForQuiescence(BACKGROUND_CONTEXT);
    await this.mutate((tx) => {
      if (tx.state.status === "pausing") tx.state.status = "paused";
    });
    return this.inspect();
  }

  async resume(): Promise<Campaign> {
    await this.mutate(async (tx) => {
      if (tx.state.status === "blocked") {
        for (const task of tx.tasks) {
          if (
            task.kind !== COORDINATOR ||
            task.state.status !== "pending" ||
            task.state.checkpoint.error === null
          )
            continue;
          await tx.entry(
            "xean.coordinator.resumed",
            task.state.checkpoint,
            task.id,
          );
          tx.writeTask({
            ...task,
            state: {
              status: "pending",
              checkpoint: {
                ...task.state.checkpoint,
                attempts: 0,
                attemptId: null,
                inputId: undefined,
                error: null,
              },
            },
          });
        }
        tx.state.error = null;
      } else if (tx.state.status !== "paused" && tx.state.status !== "running")
        throw new Error(`Cannot resume a ${tx.state.status} campaign`);
      tx.state.status = "running";
    });
    return this.run();
  }

  /** An exact keyed retry returns its original receipt without admitting again. */
  private keyedSignal(
    value: JsonValue,
    key: string | undefined,
    admit: (tx: Transaction) => void | Promise<void>,
  ): Promise<CampaignInput> {
    return this.mutate(async (tx) => {
      const prior =
        key === undefined
          ? undefined
          : inputs(tx.tasks).find((receipt) => receipt.key === key);
      if (prior) {
        if (!isDeepStrictEqual(prior.value, value))
          throw new Error(`Input key reused with a different value: ${key}`);
        return json(prior);
      }
      await admit(tx);
      const id = await tx.newTask(COORDINATOR, {
        kind: "input",
        value,
        ...(key === undefined ? {} : { key }),
      });
      return json({ id, key: key ?? null, value });
    });
  }

  async input(value: JsonValue, key?: string): Promise<CampaignInput> {
    const normalized = json(value);
    if (key !== undefined && typeof key !== "string")
      throw new TypeError("Input key must be a string");
    return this.keyedSignal(normalized, key, (tx) => {
      if (
        stopped(tx.state.status) ||
        tx.state.status === "blocked" ||
        this.closing
      )
        throw new Error("Campaign does not accept input");
      this.options.validateInput?.(normalized, json(view(tx)));
    });
  }

  /** Interrupt live attempts without cancelling their logical work. */
  close(): Promise<void> {
    if (!this.closePromise)
      this.closePromise = (async () => {
        this.closing = true;
        this.store.harness.pause({ interrupt: true });
        await this.store.harness.waitForQuiescence(BACKGROUND_CONTEXT);
        await this.runPromise?.catch(() => {});
        await this.store.close();
        owners.delete(this.store.storage);
      })();
    return this.closePromise;
  }
}

/** Read a pinned Pi storage snapshot without opening the kernel or recovering work. */
export async function inspectCampaign(
  path: string,
  records: boolean | RecordProjection = true,
) {
  await using cleanup = new AsyncDisposableStack();
  const storage = await openXeanStorage(path, { readOnly: true });
  cleanup.defer(() => storage.close(BACKGROUND_CONTEXT));
  const store = await Store.open(storage);
  cleanup.defer(() => store.close());
  return await store.mutate(async (tx) => ({
    campaign: snapshot(tx),
    records: records
      ? await tx.entries(typeof records === "function" ? records : undefined)
      : [],
  }));
}
