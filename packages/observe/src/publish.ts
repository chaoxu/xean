#!/usr/bin/env bun
import { realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Database } from "bun:sqlite";
import { inspectCampaign } from "xean";
import { usageRecord } from "xean/report";
import { verifyInstall } from "../../../scripts/dependencies.ts";
import { readSummary, snapshot } from "./snapshot.ts";

/** Publish matching observation and compact files under a separate publisher lock. */
export async function publish(directory: string): Promise<void> {
  directory = await realpath(directory);
  // Keep this inode: the native lock excludes competing publishers across processes.
  using owner = new Database(join(directory, ".publish.lock"), {
    create: true,
  });
  owner.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  const value = snapshot(
    await inspectCampaign(join(directory, "campaign.sqlite"), usageRecord),
  );
  for (const [name, content] of [
    ["observation.json", value],
    ["status.json", readSummary(value)],
  ] as const) {
    const file = join(directory, name);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(content) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export function observe(
  directory: string,
  onError: (error: unknown) => void = console.error,
) {
  const path = join(directory, "campaign.sqlite");
  let database: Database | undefined;
  let identity: string | undefined;
  let publishedVersion: number | undefined;
  const update = async () => {
    try {
      const file = await stat(path, { bigint: true });
      const currentIdentity = `${file.dev}:${file.ino}`;
      if (!database || currentIdentity !== identity) {
        database?.close();
        database = undefined;
        database = new Database(path, { readonly: true, create: false });
        identity = currentIdentity;
        publishedVersion = undefined;
      }
      // Keep this connection outside a read transaction so WAL commits remain visible.
      const version = database
        .query<{ data_version: number }, []>("PRAGMA data_version")
        .get()!.data_version;
      if (version === publishedVersion) return;
      await publish(directory);
      // A commit during publication must trigger another read on the next tick.
      publishedVersion = version;
    } catch (error) {
      database?.close();
      database = undefined;
      throw error;
    }
  };
  let pending: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const tick = () =>
    (pending ??= update()
      .catch(onError)
      .finally(() => {
        pending = undefined;
      }));
  void tick();
  const timer = setInterval(tick, 10_000);
  return () =>
    (stopping ??= (async () => {
      clearInterval(timer);
      try {
        await pending;
        await update().catch(onError);
      } finally {
        database?.close();
      }
    })());
}

if (import.meta.main) {
  await verifyInstall(resolve(import.meta.dir, "../../.."));
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { watch: { type: "boolean", default: false } },
  });
  if (positionals.length !== 1)
    throw new Error("Usage: xean-observe-publish RUN_DIRECTORY [--watch]");
  const directory = resolve(positionals[0]!);
  if (!values.watch) await publish(directory);
  else {
    const stop = observe(directory);
    const stopped = Promise.withResolvers<void>();
    const finish = () => {
      void stop().then(stopped.resolve, stopped.reject);
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    try {
      await stopped.promise;
    } finally {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      await stop();
    }
  }
}
