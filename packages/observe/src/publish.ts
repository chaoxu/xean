#!/usr/bin/env bun
import { rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectCampaign } from "xean";
import { usageRecord } from "xean/report";
import { verifyInstall } from "../../../scripts/dependencies.ts";
import { snapshot } from "./snapshot.ts";

/** Read independently of the campaign owner and atomically replace its export. */
export async function publish(directory: string): Promise<void> {
  const value = snapshot(
    await inspectCampaign(join(directory, "campaign.sqlite"), usageRecord),
  );
  const { observedAt, status, usageAvailable } = value;
  for (const [name, content] of [
    ["observation.json", value],
    ["status.json", { observedAt, status, usageAvailable }],
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
  let pending: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const tick = () => {
    if (pending) return;
    pending = publish(directory)
      .catch(onError)
      .finally(() => {
        pending = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, 10_000);
  return () =>
    (stopping ??= (async () => {
      clearInterval(timer);
      await pending;
      await publish(directory).catch(onError);
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
