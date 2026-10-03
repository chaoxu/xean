import { lstatSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Database, constants } from "bun:sqlite";
import type { Storage } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { UninitializedCampaignError } from "./types.ts";

/** Pi supplies statements, transactions, and records; Xean configures owned connections. */
export async function openXeanStorage(
  path: string,
  options: Parameters<typeof SqliteStorage.open>[1] = {},
): Promise<Storage> {
  const { readOnly = false } = options;
  if (!path) throw new Error("Xean storage requires a database path.");
  const cleanup = new AsyncDisposableStack();
  try {
    if (!readOnly && path !== ":memory:") {
      await mkdir(dirname(path), { recursive: true });
      const file = statSync(path, { throwIfNoEntry: false });
      if (!file && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
        throw new Error(
          "Campaign database symlink must have an existing target",
        );
      if (file && file.nlink !== 1)
        throw new Error("Campaign databases must not have hard links");
      path = file
        ? realpathSync(path)
        : join(realpathSync(dirname(path)), basename(path));
      // Never unlink the lock file: ownership follows this inode across opens.
      const owner = cleanup.use(new Database(`${path}.lock`, { create: true }));
      owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    }
    const native = new Database(path, {
      readonly: readOnly,
      create: !readOnly,
      strict: true,
    });
    const database = new NodeSqliteDatabase(
      {
        exec: (sql) => native.exec(sql),
        prepare: (sql) => native.prepare(sql),
        close: () => native.close(true),
      },
      { readOnly },
    );
    cleanup.defer(database.close.bind(database));
    // Closing checkpoints are optional while independent readers remain open.
    cleanup.defer(() => database.exec("PRAGMA busy_timeout = 0"));
    // Match Pi's native opener: concurrent readers may briefly own WAL recovery.
    await database.exec("PRAGMA busy_timeout = 5000");
    if (readOnly) {
      await database.exec("BEGIN");
      if (!(await database.get("SELECT 1 FROM sqlite_schema LIMIT 1")))
        throw new UninitializedCampaignError();
    } else {
      // Read-only WAL connections need these files after the owner closes.
      if (
        path !== ":memory:" &&
        native.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1) !== 0
      )
        throw new Error(
          "SQLite cannot preserve WAL files for read-only inspection",
        );
      await database.exec(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL",
      );
    }
    // Readers close without a writer checkpoint; owners release their lock last.
    database.close = () => cleanup.disposeAsync();
    return await SqliteStorage.open(database, { readOnly });
  } catch (error) {
    await cleanup.disposeAsync();
    throw error;
  }
}
