import { lstatSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createHost,
  defineFacet,
  findDocument,
  loadDocument,
  openStore,
  sqliteBackend,
  type SingletonHandle,
  type Store,
} from "@earendil-works/chord/next";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createRegistry,
  createSession,
  Harness,
  type Conversation,
  type Session,
  type Storage,
} from "@earendil-works/pi-durable";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import { task as taskSchema } from "./policy/contracts.ts";
import { solveSettings } from "./policy/settings.ts";
import {
  project,
  initializeNotebook,
  readNotebook,
  readonlyNotebook,
  type Definition,
} from "./state.ts";
import { createWorkflow, initialCampaign } from "./workflow.ts";
import {
  createWorkers,
  type SourceExecutor,
  type WorkerRequest,
} from "./workers.ts";
import {
  ResearchState,
  ResearchType,
  copy,
  type ResearchData,
} from "./records.ts";
import { acceptedArgument, readStatus } from "./report.ts";
import { codexExec } from "./source-runtime.ts";
import { createRoleRuntime, roleGenerationPolicy } from "./role-runtime.ts";

export class ResearchOwnedError extends Error {
  constructor() {
    super("Research database already has an owner");
    this.name = "ResearchOwnedError";
  }
}
export type OpenOptions = {
  create?: Definition;
  /** Initialize an automatic campaign. False leaves manual worker admission available. */
  startCampaign?: boolean;
  /** Activate jobs and native call recovery. Passive openings only read or change state. */
  execute?: boolean;
  models?: Models;
  source?: SourceExecutor;
  report?: (error: unknown) => void;
};

function validateDefinition(value: unknown): Definition {
  if (!value || typeof value !== "object")
    throw new Error("Not an initialized xean campaign");
  const input = value as Definition;
  return {
    task: taskSchema.parse(input.task),
    settings: solveSettings.parse(input.settings),
  };
}

async function canonicalPath(path: string, create: boolean) {
  const absolute = resolve(path);
  if (create) await mkdir(dirname(absolute), { recursive: true });
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT")
      throw error;
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Research database symlink must have an existing target");
    return join(await realpath(dirname(absolute)), basename(absolute));
  }
}

function acquireOwnership(path: string) {
  const lock = new DatabaseSync(`${path}.owner.sqlite`);
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new ResearchOwnedError();
  }
  // Retain the lock file: unlinking it would permit locks on different inodes.
  return () => lock.close();
}

function assertSingleLink(nlink: number) {
  if (nlink > 1)
    throw new Error("Hard-linked research database paths are unsupported");
}

/** Reject SQL writes and missing files while allowing SQLite to maintain WAL sidecars. */
function openReadDatabase(path: string) {
  const database = new Database(path, {
    create: false,
    readwrite: true,
    strict: true,
  });
  try {
    database.exec("PRAGMA query_only = ON; BEGIN");
    return new NodeSqliteDatabase(database, { readOnly: true });
  } catch (error) {
    database.close();
    throw error;
  }
}

async function openOwnedStore(path: string) {
  const database = new NodeSqliteDatabase(
    new Database(path, { create: true, strict: true }),
  );
  try {
    await database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0",
    );
    return await openStore(sqliteBackend(database), context);
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

/** Own the shared Chord store; only execute:true restores workers and model calls. */
export async function open(path: string, options: OpenOptions = {}) {
  const requested = options.create && validateDefinition(options.create);
  const canonical = await canonicalPath(path, requested !== undefined);
  const release = acquireOwnership(canonical);
  const report = options.report ?? console.error;
  let store: Store | undefined;
  let storage: Storage | undefined;
  let harness: Harness | undefined;
  let root: Conversation | undefined;
  let host: ReturnType<typeof createHost> | undefined;
  let data!: SingletonHandle<ResearchData>;
  let workers: ReturnType<typeof createWorkers> | undefined;
  let workflow: ReturnType<typeof createWorkflow> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Seal Chord admission before suspending Pi's conversations.
      const stopped = host?.close(context);
      try {
        const outcomes = await Promise.allSettled([
          stopped,
          harness ? harness.close(context) : storage?.close(context),
        ]);
        for (const outcome of outcomes)
          if (outcome.status === "rejected") throw outcome.reason;
        if (harness) {
          const end = await harness.closed;
          if (end.kind === "failed") throw end.error;
        }
      } finally {
        try {
          await store?.close(context);
        } finally {
          release();
        }
      }
    })());
  try {
    const existing = await stat(canonical).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (existing) assertSingleLink(existing.nlink);
    // Reject historical layouts through a read-only snapshot before opening a writer.
    const stored = existing?.size
      ? await inspect(canonical, (value) => value.definition)
      : undefined;
    if (stored && requested && !isDeepStrictEqual(stored, requested))
      throw new Error("Research task and settings are frozen");
    const definition = stored ?? requested;
    if (!definition) throw new Error("Campaign is not initialized");
    store = await openOwnedStore(canonical);
    storage = await StoreStorage.open(store, "pi", context);
    const roles = options.execute
      ? createRoleRuntime(() => readNotebook(data.value.notebook))
      : undefined;
    if (roles) {
      const registry = createRegistry();
      registry.install(roles.extension);
      harness = await Harness.open(
        storage,
        {
          registry,
          models: options.models ?? builtinModels(),
          settings: {
            compaction: { enabled: false },
            retry: { enabled: true, maxRetries: 8 },
            restartLimit: Infinity,
            generation: roleGenerationPolicy,
            progress: { persistWithinMs: 0 },
            toolExecution: "sequential",
            contextRetentionMs: 0,
            documentRetentionMs: 0,
          },
          onReport: report,
        },
        context,
      );
      void harness.closed.then(close).catch(() => {});
      root = await harness.root(context);
    }
    host = createHost({ store, onError: report });
    await host.load(
      [
        {
          name: "xean",
          facet: defineFacet((h) => {
            h.serve(ResearchType, (_, self) => {
              data = self.state(ResearchState);
              if (options.execute) {
                workers = createWorkers(
                  self,
                  data,
                  definition,
                  {
                    call: (origin, attempt, key, descriptor, profile, ctx) =>
                      roles!.call(
                        harness!,
                        origin,
                        attempt,
                        key,
                        descriptor,
                        profile,
                        ctx,
                        report,
                      ),
                  },
                  options.source ?? codexExec(),
                );
                workflow = createWorkflow(self, data, workers);
              }
              return {};
            });
          }),
        },
      ],
      context,
    );
    if (!data.value.definition) {
      await data.change((draft) => {
        draft.definition = definition;
        draft.notebook = initializeNotebook(`${canonical}.notes.sqlite`);
        draft.campaign =
          options.startCampaign === false ? null : initialCampaign();
      }, context);
    }
    const active = () => {
      if (!workers) throw new Error("Open with execute:true to run workers");
      return workers;
    };
    return {
      get harness() {
        if (!harness) throw new Error("Open with execute:true to use Pi");
        return harness;
      },
      get root() {
        if (!root) throw new Error("Open with execute:true to use Pi");
        return root;
      },
      close,
      snapshot: () => copy(data.value),
      get state() {
        return copy(data.value);
      },
      change: <T>(fn: (draft: ResearchData) => T) => data.change(fn, context),
      start: (request: WorkerRequest) => active().start(request),
      startGroup: (requests: WorkerRequest[]) => active().startGroup(requests),
      get running() {
        return active().running;
      },
      get history() {
        return copy(data.value.history);
      },
      wait: () => {
        if (!workflow)
          throw new Error("Open with execute:true to run a campaign");
        return workflow.wait();
      },
      resume: () => {
        if (!workflow)
          throw new Error("Open with execute:true to resume a campaign");
        return workflow.resume();
      },
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** Read Chord state and Pi receipts on one snapshot without activating either runtime. */
export async function inspect<T>(
  path: string,
  read: (data: ResearchData, session: Session) => T | Promise<T>,
): Promise<T> {
  path = await canonicalPath(path, false);
  assertSingleLink((await stat(path)).nlink);
  const database = openReadDatabase(path);
  let store: Store | undefined;
  let session: Session | undefined;
  try {
    store = await openStore(sqliteBackend(database), context);
    const record = await findDocument(database, {
      owner: ResearchType.name,
      namespace: "chord",
      kind: ResearchState.name,
    });
    if (
      !record ||
      record.version !== ResearchState.version ||
      record.fingerprint !== ResearchState.fingerprint
    )
      throw new Error("Not a current xean campaign; fresh campaigns only");
    const data = (await loadDocument(database, record)).value as ResearchData;
    validateDefinition(data.definition);
    if (data.notebook.path !== `${path}.notes.sqlite`)
      throw new Error("Notebook path does not match campaign");
    readNotebook({ ...data.notebook, publications: [] });
    readonlyNotebook(data.notebook);
    const storage = await StoreStorage.open(store, "pi", context);
    session = createSession(storage, { documentRetentionMs: 0 });
    return await read(data, session);
  } finally {
    try {
      await session?.close(context);
    } finally {
      if (store) await store.close(context);
      else await database.close();
    }
  }
}

export function exportAccepted(path: string): Promise<string> {
  return inspect(path, (data) => {
    const status = readStatus(data);
    if (
      status.status !== "terminal" ||
      status.outcome !== "accepted" ||
      !status.accepted
    )
      throw new Error("No accepted argument");
    return acceptedArgument(
      project(readNotebook(data.notebook)).notes,
      status.accepted,
    );
  });
}
