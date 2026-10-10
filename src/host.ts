import { lstatSync } from "node:fs";
import { mkdir, mkdtempDisposable, realpath, stat } from "node:fs/promises";
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
  type Session,
  type Tx,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
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
import { readSnapshot, type SnapshotReader } from "./math/state.ts";
import { acceptedArgument } from "./math/argument.ts";

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

function recognize(path: string) {
  using database = openReadDatabase(path);
  const tables = database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  const native = tables.some(({ name }) => name === "durable_schema");
  if (!native && tables.length)
    throw new Error("Not a Pi Durable research database");
  return native;
}

async function openOwnedStorage(path: string) {
  const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 0 });
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
    const value = await createSession(storage).snapshot(
      DefinitionDoc,
      ROOT_CONVERSATION_ID,
      context,
    );
    const stored = value === undefined ? undefined : validateDefinition(value);
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
        settings: { compaction: { enabled: false }, contextRetentionMs: 0 },
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

/** Inspect a consistent backup through a fresh Session without recovering work. */
async function inspectSession<T>(
  path: string,
  read: (session: Session, root: ConversationId) => T | Promise<T>,
): Promise<T> {
  assertSingleLink((await stat(path)).nlink);
  await using directory = await mkdtempDisposable(
    join(tmpdir(), "research-snapshot-"),
  );
  const database = join(directory.path, "snapshot.sqlite");
  {
    using source = openReadDatabase(path);
    await backup(source, database);
  }
  if (!recognize(database)) throw new UninitializedResearchError();
  const storage = await openNodeSqliteStorage(database);
  const session = createSession(storage);
  try {
    await session.commit(async (tx) => {
      if (!(await tx.conversation(ROOT_CONVERSATION_ID)))
        throw new UninitializedResearchError();
      await readDefinition(tx, ROOT_CONVERSATION_ID);
      await tx.doc(Control, ROOT_CONVERSATION_ID);
    }, context);
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
