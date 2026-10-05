import { lstatSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  createSession,
  Harness,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Registry,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  CURRENT_SQLITE_SCHEMA_VERSION,
  SqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite";
import {
  openNodeSqliteDatabase,
  openNodeSqliteStorage,
} from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRuntime } from "./config.ts";
import {
  DefinitionDoc,
  readDefinition,
  UninitializedResearchError,
  validateDefinition,
  type Definition,
} from "./definition.ts";
import { createRoles } from "./roles/index.ts";
import type { Research } from "./roles/research.ts";
import {
  Control,
  createResearch,
  roleNames,
  type RoleName,
  type Roles,
} from "./workflow.ts";

export class ResearchOwnedError extends Error {
  constructor() {
    super("Research database already has an owner");
    this.name = "ResearchOwnedError";
  }
}
export type OpenOptions = {
  create?: Definition;
  models?: Models;
  research?: Research;
  roles?: (builtins: Roles) => Partial<Roles>;
  key?: string;
  usagePrefix?: string;
  registry?: Registry;
  initialize?: (tx: Tx, root: ConversationId) => unknown | Promise<unknown>;
};

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

function acquire(path: string) {
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
export function openReadDatabase(path: string) {
  const database = new DatabaseSync(`${pathToFileURL(path).href}?mode=rw`);
  try {
    database.exec("PRAGMA query_only = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function recognize(path: string, live = false) {
  const database = openReadDatabase(path);
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string }[];
    const native = tables.some(({ name }) => name === "durable_schema");
    if (!native && tables.length)
      throw new Error("Not a Pi Durable research database");
    if (
      native &&
      live &&
      database
        .prepare("SELECT version FROM durable_schema WHERE singleton = 1")
        .get()?.version !== CURRENT_SQLITE_SCHEMA_VERSION
    )
      throw new Error("Live inspection requires the current Pi SQLite schema");
    return native;
  } finally {
    database.close();
  }
}

async function frozenDefinition(
  storage: Storage,
): Promise<Definition | undefined> {
  const record = await storage.findDocument(
    {
      kind: DefinitionDoc.definition.kind,
      scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID },
    },
    "current",
    context,
  );
  if (!record) return undefined;
  const stored = await storage.document(record.id, "current", context);
  if (!stored || stored.version !== DefinitionDoc.definition.version)
    throw new Error("Unsupported research definition version");
  return validateDefinition(stored.value);
}

async function openOwnedStorage(path: string) {
  const database = await openNodeSqliteDatabase(path);
  const nativeClose = database.close.bind(database);
  let closing: Promise<void> | undefined;
  database.close = () =>
    (closing ??= database.exec("PRAGMA busy_timeout = 0").finally(nativeClose));
  try {
    await database.exec("PRAGMA synchronous = FULL");
    return await SqliteStorage.open(database);
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

/** Own one native Harness. Close it to suspend; reopen it to recover. */
export async function open(path: string, options: OpenOptions = {}) {
  const requested = options.create && validateDefinition(options.create);
  const canonical = await canonicalPath(path, requested !== undefined);
  const release = acquire(canonical);
  let storage: Storage | undefined;
  let harness: Harness | undefined;
  let failure: unknown;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (harness) await harness.close(context);
        else await storage?.close(context);
      } finally {
        release();
      }
    })().then(
      () => {
        if (failure !== undefined) throw failure;
      },
      (error) => {
        throw failure ?? error;
      },
    ));
  const report = (error: unknown) => {
    console.error("Pi report:", error);
    if (!harness || closing) return;
    // Reports are nonfatal. A rejected native health commit identifies an
    // unusable Session; native close releases its outstanding waiters.
    void harness
      .commit(() => {}, context)
      .catch((unhealthy: unknown) => {
        if (closing) return;
        failure =
          unhealthy instanceof Error
            ? (unhealthy.cause ?? unhealthy)
            : unhealthy;
        void close().catch(() => {});
      });
  };
  try {
    const existing = await stat(canonical).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (existing) assertSingleLink(existing.nlink);
    if (existing?.size) recognize(canonical);
    storage = await openOwnedStorage(canonical);
    const stored = await frozenDefinition(storage);
    if (stored && requested && !isDeepStrictEqual(stored, requested))
      throw new Error("Research task and settings are frozen");
    const definition = stored ?? requested;
    if (!definition) throw new UninitializedResearchError();
    if (!stored && (await storage.conversation(ROOT_CONVERSATION_ID, context)))
      throw new UninitializedResearchError();
    const settings =
      options.usagePrefix === undefined
        ? definition.settings
        : {
            ...definition.settings,
            usagePrefix: options.usagePrefix,
          };
    const runtime = createRuntime(settings, {
      models: options.models,
      key: options.key,
    });
    const builtins = createRoles(
      { ...settings, profiles: runtime.profiles },
      options.research,
    );
    const roles = Object.assign(builtins, options.roles?.(builtins));
    const workflow = createResearch(roles, (id, context) =>
      harness!.abortTask(id, context),
    );
    const registry = options.registry ?? createRegistry();
    registry.install(builtins.extension);
    registry.install(workflow.extension);
    if (
      definition.mode &&
      !roleNames.includes(definition.mode.role as RoleName)
    )
      throw new Error("Unknown standalone role");
    harness = await Harness.open(
      storage,
      {
        registry,
        models: runtime.models,
        settings: { compaction: { enabled: false } },
        onReport: report,
      },
      context,
    );
    const root = await harness.root(context, {
      init: async (tx, root) => {
        Object.assign(await tx.doc(DefinitionDoc, root), definition);
        await tx.doc(Control, root);
        if (options.initialize) await options.initialize(tx, root);
        else if (definition.mode)
          await workflow.worker(tx, root, { standalone: true });
        else await workflow.initialize(tx, root);
      },
    });
    // The scheduler opens paused; reconcile cancellation before recovery.
    if ((await harness.snapshot(Control, root.id, context))?.cancelled)
      await root.abort(context);
    return {
      harness,
      root,
      workflow,
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw failure ?? error;
  }
}

/** Inspect through a fresh Session. Live reads may span commits. Default to a backup. */
export async function inspect<T>(
  path: string,
  read: (tx: Tx, root: ConversationId) => T | Promise<T>,
  { live = false }: { live?: boolean } = {},
): Promise<T> {
  assertSingleLink((await stat(path)).nlink);
  const directory = live
    ? undefined
    : await mkdtemp(join(tmpdir(), "research-snapshot-"));
  let session: ReturnType<typeof createSession> | undefined;
  try {
    const database = directory ? join(directory, "snapshot.sqlite") : path;
    if (directory) {
      const source = openReadDatabase(path);
      try {
        await backup(source, database);
      } finally {
        source.close();
      }
    }
    if (!recognize(database, live)) throw new UninitializedResearchError();
    const storage = await openNodeSqliteStorage(database);
    if (live)
      storage.commit = async () => {
        throw new Error("Live inspection cannot change campaign state");
      };
    session = createSession(storage);
    return await session.commit(async (tx) => {
      if (!(await tx.conversation(ROOT_CONVERSATION_ID)))
        throw new UninitializedResearchError();
      await readDefinition(tx, ROOT_CONVERSATION_ID);
      return read(tx, ROOT_CONVERSATION_ID);
    }, context);
  } finally {
    try {
      await session?.close(context);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
