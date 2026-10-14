import { lstatSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
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
  type Session,
  type Tx,
} from "@earendil-works/pi-durable";
import {
  SqliteStorage,
  type SqliteValue,
} from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createRuntime, readSettings } from "./roles/config.ts";
import {
  DefinitionDoc,
  readDefinition,
  UninitializedResearchError,
  validateDefinition,
  type Definition,
} from "./core/definition.ts";
import { createRoles } from "./roles/index.ts";
import type { ExternalRoles } from "./roles/backend.ts";
import {
  Control,
  createResearch,
  roleNames,
  type RoleName,
  type Roles,
} from "./core/workflow.ts";
import {
  Catalog,
  readSnapshot,
  type SnapshotReader,
} from "./core/math/state.ts";
import { acceptedArgument } from "./report.ts";

export class ResearchOwnedError extends Error {
  constructor() {
    super("Research database already has an owner");
    this.name = "ResearchOwnedError";
  }
}
export type OpenOptions = {
  create?: Definition;
  models?: Models;
  roles?: (
    builtins: ReturnType<typeof createRoles>,
  ) => Partial<Roles> & { external?: ExternalRoles };
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

export function acquireOwnership(path: string) {
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
  const database = new Database(path, {
    create: false,
    readwrite: true,
    strict: true,
  });
  try {
    database.exec("PRAGMA query_only = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function recognize(path: string) {
  using database = openReadDatabase(path);
  const tables = database
    .query(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  const native = tables.some(({ name }) => name === "durable_schema");
  if (!native && tables.length)
    throw new Error("Not a Pi Durable research database");
  return native;
}

async function openOwnedStorage(path: string) {
  const database = piDatabase(
    new Database(path, { create: true, strict: true }),
  );
  try {
    await database.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 0",
    );
    return await SqliteStorage.open(database);
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}

/** Keep Pi's queue and transactions, with Bun's deterministic statement cleanup. */
function piDatabase(database: Database, readOnly = false) {
  const driver = {
    exec: (sql: string) => database.exec(sql),
    prepare: (sql: string) => {
      // query() gives Bun ownership so close() finalizes retained statements.
      const statement = database.query(sql);
      return {
        run: statement.run.bind(statement),
        all: statement.all.bind(statement),
        get: (...args: SqliteValue[]) => statement.get(...args) ?? undefined,
      };
    },
    get isTransaction() {
      return database.inTransaction;
    },
    close: () => database.close(true),
  };
  // Pi uses this subset of DatabaseSync; Bun returns null for absent rows.
  return new NodeSqliteDatabase(driver as unknown as DatabaseSync, {
    readOnly,
  });
}

/** Own one native Harness. Close it to suspend; reopen it to recover. */
export async function open(path: string, options: OpenOptions = {}) {
  const requested = options.create && validateDefinition(options.create);
  if (requested) readSettings(requested.settings);
  const canonical = await canonicalPath(path, requested !== undefined);
  const release = acquireOwnership(canonical);
  let storage: Storage | undefined;
  let harness: Harness | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        if (harness) {
          try {
            await harness.close(context);
          } finally {
            const end = await harness.closed;
            if (end.reason === "failed") throw end.error;
          }
        } else await storage?.close(context);
      } finally {
        release();
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
    if (existing?.size) recognize(canonical);
    storage = await openOwnedStorage(canonical);
    const value = await createSession(storage, {
      documentRetentionMs: 0,
    }).snapshot(DefinitionDoc, ROOT_CONVERSATION_ID, context);
    const stored = value === undefined ? undefined : validateDefinition(value);
    if (stored && requested && !isDeepStrictEqual(stored, requested))
      throw new Error("Research task and settings are frozen");
    const definition = stored ?? requested;
    if (!definition) throw new UninitializedResearchError();
    if (!stored && (await storage.conversation(ROOT_CONVERSATION_ID, context)))
      throw new UninitializedResearchError();
    const settings = readSettings(definition.settings);
    if (options.usagePrefix !== undefined)
      settings.usagePrefix = options.usagePrefix;
    const runtime = createRuntime(settings, {
      models: options.models,
      key: options.key,
    });
    const builtins = createRoles({ ...settings, profiles: runtime.profiles });
    const roles = Object.assign(builtins, options.roles?.({ ...builtins }));
    const workflow = createResearch(roles);
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
        settings: {
          compaction: { enabled: false },
          contextRetentionMs: 0,
          documentRetentionMs: 0,
        },
        onReport: (error) => console.error("Pi report:", error),
      },
      context,
    );
    // Native failure closes storage before releasing this host's owner lock.
    void harness.closed.then(close).catch(() => {});
    const root = await harness.root(context, {
      init: async (tx, root) => {
        Object.assign(await tx.doc(DefinitionDoc, root), definition);
        await tx.doc(Control, root);
        await tx.doc(Catalog, root);
        if (options.initialize) await options.initialize(tx, root);
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
    throw error;
  }
}

/** Inspect one SQLite read transaction through Pi without recovering work. */
async function inspectSession<T>(
  path: string,
  read: (session: Session, root: ConversationId) => T | Promise<T>,
): Promise<T> {
  assertSingleLink((await stat(path)).nlink);
  if (!recognize(path)) throw new UninitializedResearchError();
  using database = openReadDatabase(path);
  database.exec("BEGIN");
  const storage = await SqliteStorage.open(piDatabase(database, true), {
    readOnly: true,
  });
  const session = createSession(storage, { documentRetentionMs: 0 });
  try {
    validateDefinition(
      (await session.snapshot(DefinitionDoc, ROOT_CONVERSATION_ID, context)) ??
        {},
    );
    await session.snapshot(Control, ROOT_CONVERSATION_ID, context);
    return await read(session, ROOT_CONVERSATION_ID);
  } finally {
    await session.close(context);
  }
}

export function inspect<T>(
  path: string,
  read: (tx: Tx, root: ConversationId) => T | Promise<T>,
): Promise<T> {
  return inspectSession(path, (session, root) =>
    session.commit((tx) => read(tx, root), context),
  );
}

/** Export the immutable notebook snapshot sealed by acceptance. */
export function exportAccepted(path: string): Promise<string> {
  return inspectSession(path, async (session, root) => {
    const accepted = await session.commit(async (tx) => {
      if ((await readDefinition(tx, root)).mode)
        throw new Error("No accepted argument");
      const accepted = (await tx.doc(Control, root)).accepted;
      return accepted && { ...accepted };
    }, context);
    if (!accepted) throw new Error("No accepted argument");
    const reader: SnapshotReader = {
      snapshotAsOf: session.snapshotAsOf.bind(session),
      getTask: (id, context) => session.commit((tx) => tx.task(id), context),
      entry: (id, context) => session.commit((tx) => tx.entry(id), context),
    };
    const view = await readSnapshot(
      reader,
      root,
      accepted.snapshotEntry,
      context,
      { inputs: false },
    );
    return acceptedArgument(view.notes, accepted.candidateId);
  });
}
