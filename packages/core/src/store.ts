import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  defineDoc,
  Harness,
  ROOT_CONVERSATION_ID,
  type Cursor,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type HarnessOptions,
  type RegistryReader,
  type RunningTask,
  type Session,
  type Storage,
  type Task,
  type TaskId,
  type TaskRecord,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { json } from "./json.ts";
import { campaignVersion, UninitializedCampaignError } from "./types.ts";
import type {
  CampaignState,
  JsonValue,
  RecordProjection,
  Signal,
  WorkRequest,
} from "./types.ts";

export type AttemptState = {
  phase: "run";
  attempts: number;
  attemptId: string | null;
  error: string | null;
  inputId?: EntryId;
};
export const initialAttempt = (): AttemptState => ({
  phase: "run",
  attempts: 0,
  attemptId: null,
  error: null,
});
export type Input = WorkRequest | Omit<Signal, "id">;
export type PiTask = TaskRecord<Input, AttemptState, JsonValue>;
export type TerminalState = Extract<PiTask["state"], { status: "terminal" }>;
type Definition = Task<Input, AttemptState, JsonValue, object>;
export type Runtime = TaskRuntime<Input, AttemptState, JsonValue, object>;
export const WORKER = "xean.worker";
export const COORDINATOR = "xean.coordinator";
export const taskVersion = 1;
export const isXeanTask = (task: { kind: string }): boolean =>
  task.kind === WORKER || task.kind === COORDINATOR;
export const campaignAddress = {
  kind: "xean.campaign",
  scope: { kind: "session" as const },
};
const context = BACKGROUND_CONTEXT;
export const campaign = defineDoc({
  kind: campaignAddress.kind,
  scope: "session",
  version: campaignVersion,
  initial(): CampaignState {
    throw new Error("Xean campaign document is missing");
  },
  checkpointWhen: () => true,
});

export interface Transaction {
  readonly native: Tx;
  state: CampaignState;
  providerCalls(): Promise<number>;
  readonly tasks: readonly PiTask[];
  newTask(kind: string, input: Input): Promise<TaskId<JsonValue>>;
  entry(kind: string, data: unknown, taskId?: TaskId): Promise<EntryId>;
  entries(project?: RecordProjection): Promise<EntryRecord[]>;
}

/** Pi publishes adopted commits; Xean retains the scheduling projection. */
export class Store {
  failure: Error | undefined;
  private providerCalls: number | undefined;

  private constructor(
    readonly storage: Storage,
    private readonly tasks: Map<TaskId, PiTask>,
    private readonly session: Session,
    private readonly registry?: RegistryReader,
  ) {
    this.session.subscribeCommits(({ changes }) => {
      for (const change of changes)
        if (change.type === "task" && isXeanTask(change.value))
          this.tasks.set(change.value.id, change.value as PiTask);
        else if (
          change.type === "entry" &&
          change.value.kind === "xean.call.started" &&
          change.value.conversationId === ROOT_CONVERSATION_ID &&
          this.providerCalls !== undefined
        )
          this.providerCalls++;
    });
  }

  static async open(
    storage: Storage,
    initial?: CampaignState,
    runtime?: HarnessOptions,
    validate?: (state: CampaignState, tasks: readonly PiTask[]) => void,
  ): Promise<Store> {
    const documentId = (
      await storage.findDocument(campaignAddress, "current", context)
    )?.id;
    const saved =
      documentId === undefined
        ? undefined
        : await storage.document(documentId, "current", context);
    if (documentId === undefined) {
      if (
        (await storage.scanConversations({}, 1, undefined, context)).items
          .length ||
        (
          await storage.scanDocuments(
            { scope: campaignAddress.scope, at: "current" },
            1,
            undefined,
            context,
          )
        ).items.length
      ) {
        throw new Error("Storage already contains a non-Xean session");
      }
      if (!initial || !runtime) throw new UninitializedCampaignError();
    } else if (saved?.version !== campaignVersion)
      throw new Error("Unsupported Xean campaign version");
    const records: PiTask[] = [];
    for (const kind of [WORKER, COORDINATOR]) {
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanTasks({ kind }, 256, cursor, context);
        for (const task of page.items) {
          if (task.version !== taskVersion) {
            throw new Error(
              `Unsupported Xean task ${task.kind}@${task.version}`,
            );
          }
          records.push(task as PiTask);
        }
        cursor = page.next;
      } while (cursor);
    }
    const tasks = new Map(
      records.sort((a, b) => a.id - b.id).map((task) => [task.id, task]),
    );
    const state = (saved?.value as CampaignState | undefined) ?? initial!;
    validate?.(state, [...tasks.values()]);
    const session = runtime
      ? await Harness.open(storage, runtime, context)
      : createSession(storage);
    try {
      if (documentId === undefined)
        await (session as Harness).root(context, {
          async init(tx) {
            await tx.doc(
              defineDoc({ ...campaign.definition, initial: () => state }),
            );
          },
        });
      const store = new Store(storage, tasks, session, runtime?.registry);
      // Subscribe before refresh so asynchronous reads cannot lose newer commits.
      if (runtime)
        for (const task of tasks.values())
          if (
            task.state.status === "running" ||
            task.state.status === "completing"
          ) {
            const refreshed = await storage.task(task.id, context);
            if (tasks.get(task.id) === task)
              tasks.set(task.id, refreshed as PiTask);
          }
      return store;
    } catch (error) {
      await session.close(context).catch(() => {});
      throw error;
    }
  }

  get harness(): Harness {
    return this.session as Harness;
  }

  async transaction(tx: Tx): Promise<Transaction> {
    return {
      native: tx,
      state: await tx.doc(campaign),
      providerCalls: async () => {
        if (this.providerCalls === undefined)
          await this.scanEntries(tx, () => undefined);
        return this.providerCalls!;
      },
      tasks: [...this.tasks.values()],
      newTask: (kind, input) => {
        const task = this.registry!.snapshot().task(kind);
        return tx.createTask(task as Definition, json(input), {
          conversationId: ROOT_CONVERSATION_ID,
          ownership: { kind: "conversation" },
        });
      },
      entry: async (kind, data, taskId) => {
        // Pi copies after ID minting; snapshot at Xean's call boundary.
        const entry = await tx.appendEntry(ROOT_CONVERSATION_ID, {
          kind,
          data: json(data) as JsonValue,
          ...(taskId === undefined ? {} : { byTaskId: taskId }),
        });
        return entry.id;
      },
      entries: (project) => this.scanEntries(tx, project),
    };
  }

  /** Kernel supplies normalized JSON; results must detach draft references. */
  mutate<T>(action: (tx: Transaction) => T | Promise<T>): Promise<T> {
    return this.checked(
      this.session.commit(
        async (tx) => action(await this.transaction(tx)),
        context,
      ),
    );
  }

  async mutateTask(
    runtime: Runtime,
    action: (
      tx: Transaction,
      current: RunningTask<Input, AttemptState, JsonValue>,
    ) => TerminalState | void | Promise<TerminalState | void>,
    options?: Parameters<Runtime["commit"]>[2],
  ): Promise<void> {
    await this.checked(
      runtime.commit(
        async (tx, current) => {
          return (
            (await action(await this.transaction(tx), current)) ?? undefined
          );
        },
        context,
        options,
      ),
    );
  }

  private checked<T>(operation: Promise<T>): Promise<T> {
    return operation.catch(async (error) => {
      // Pi distinguishes rejected callbacks/batches from poisoned sessions.
      // A read-only commit checks that state without touching Storage.
      try {
        await this.session.commit(() => {}, context);
      } catch (failure) {
        const cause =
          failure instanceof Error ? (failure.cause ?? failure) : failure;
        this.failure ??=
          cause instanceof Error ? cause : new Error(String(cause));
      }
      throw error;
    });
  }

  private async scanEntries(
    tx: Tx,
    project?: RecordProjection,
  ): Promise<EntryRecord[]> {
    const entries = new Map<EntryId, EntryRecord>();
    let providerCalls = 0;
    const read = async (conversationId: ConversationId) => {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanEntries({ conversationId }, 64, cursor);
        for (const entry of page.items) {
          if (
            conversationId === ROOT_CONVERSATION_ID &&
            entry.kind === "xean.call.started"
          )
            providerCalls++;
          const selected = project ? project(entry) : entry;
          if (selected !== undefined) entries.set(selected.id, selected);
        }
        cursor = page.next;
      } while (cursor);
    };
    // Compact projections read only the root journal. Full inspection also
    // exposes the native transcripts referenced by Pi call receipts.
    if (project) await read(ROOT_CONVERSATION_ID);
    else {
      let cursor: Cursor | undefined;
      do {
        const page = await tx.scanConversations({}, 64, cursor);
        for (const conversation of page.items) await read(conversation.id);
        cursor = page.next;
      } while (cursor);
    }
    // Session serialization keeps later commit increments after this snapshot.
    this.providerCalls = providerCalls;
    return [...entries.values()].sort((a, b) => a.id - b.id);
  }

  async close(): Promise<void> {
    await this.session.close(context);
    this.tasks.clear();
  }
}
