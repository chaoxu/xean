import { lstatSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  createRegistry,
  createSession,
  Harness,
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Storage,
  type Session,
  type Tx,
} from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { task as taskSchema } from "./policy/contracts.ts";
import { solveSettings } from "./policy/settings.ts";
import { DefinitionDoc, Notebook, project, type Definition } from "./state.ts";
import { createWorkflow, type SourceExecutor } from "./workflow.ts";
import { acceptedArgument, readStatus } from "./report.ts";
import { codexExec } from "./source-runtime.ts";
import { roleGenerationPolicy } from "./role-runtime.ts";

export class ResearchOwnedError extends Error {
  constructor() {
    super("Research database already has an owner");
    this.name = "ResearchOwnedError";
  }
}
export type OpenOptions = {
  create?: Definition;
  models?: Models;
  source?: SourceExecutor;
};

function validateDefinition(value: unknown): Definition {
  if (!value || typeof value !== "object")
    throw new Error("Not an initialized Xean 4 campaign");
  const input = value as Definition;
  const settings = solveSettings.parse(input.settings);
  return { task: taskSchema.parse(input.task), settings };
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
    database.exec("PRAGMA query_only = ON");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function openOwnedStorage(path: string) {
  const database = new NodeSqliteDatabase(
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

/** Own one native Harness. Closing suspends work; reopening recovers its checkpoints. */
export async function open(path: string, options: OpenOptions = {}) {
  const requested = options.create && validateDefinition(options.create);
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
    // Validate existing databases through a read-only transaction before opening a writer.
    const stored = existing?.size
      ? await inspectSession(canonical, (_session, _root, value) => value)
      : undefined;
    if (stored && requested && !isDeepStrictEqual(stored, requested))
      throw new Error("Research task and settings are frozen");
    const definition = stored ?? requested;
    if (!definition) throw new Error("Campaign is not initialized");
    storage = await openOwnedStorage(canonical);
    const workflow = createWorkflow({
      source: options.source ?? codexExec(),
    });
    const registry = createRegistry();
    registry.install(workflow.extension);
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
          toolExecution: "sequential",
          contextRetentionMs: 0,
          documentRetentionMs: 0,
        },
        onReport: (error) => console.error("Pi report:", error),
      },
      context,
    );
    void harness.closed.then(close).catch(() => {});
    const root = await harness.root(context, {
      init: async (tx, root) => {
        Object.assign(await tx.doc(DefinitionDoc, root), definition);
        await tx.doc(Notebook, root);
        await workflow.initialize(tx, root);
      },
    });
    return {
      harness,
      root,
      close,
      resume: async () => {
        await root.commit((tx) => workflow.resume(tx, root.id), context);
        harness!.resume();
      },
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

/** Read one SQLite transaction through Pi without recovering work or calling models. */
async function inspectSession<T>(
  path: string,
  read: (
    session: Session,
    root: ConversationId,
    definition: Definition,
  ) => T | Promise<T>,
): Promise<T> {
  assertSingleLink((await stat(path)).nlink);
  using database = openReadDatabase(path);
  database.exec("BEGIN");
  const storage = await SqliteStorage.open(
    new NodeSqliteDatabase(database, { readOnly: true }),
    {
      readOnly: true,
    },
  );
  const session = createSession(storage, { documentRetentionMs: 0 });
  try {
    const definition = validateDefinition(
      await session.snapshot(DefinitionDoc, ROOT_CONVERSATION_ID, context),
    );
    return await read(session, ROOT_CONVERSATION_ID, definition);
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

export function exportAccepted(path: string): Promise<string> {
  return inspect(path, async (tx, root) => {
    const status = await readStatus(tx, root);
    if (
      status.status !== "terminal" ||
      status.outcome !== "accepted" ||
      !status.accepted
    )
      throw new Error("No accepted argument");
    return acceptedArgument(
      project(await tx.doc(Notebook, root)).notes,
      status.accepted,
    );
  });
}
