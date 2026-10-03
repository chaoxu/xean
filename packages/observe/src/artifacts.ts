import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** This module also runs over SSH. It only reads selected JSON artifacts. */
export async function readArtifacts(directory: string, compact = false) {
  const find = async (name: string) => {
    const file = join(directory, name);
    const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!info) return undefined;
    return {
      file: Bun.file(file),
      modified: info.mtimeMs,
      at: info.mtime.toISOString(),
    };
  };
  const [observation, summary] = await Promise.all([
    find("observation.json"),
    compact ? find("status.json") : undefined,
  ]);
  if (compact) {
    if (summary && (!observation || summary.modified >= observation.modified))
      return {
        kind: "status" as const,
        value: await summary.file.json(),
        at: summary.at,
      };
    if (observation)
      throw new Error(
        "Compact status is missing or older than the observation; run the snapshot publisher",
      );
  } else if (observation)
    return {
      kind: "snapshot" as const,
      value: await observation.file.json(),
      at: observation.at,
    };
  const task = await find("task.json");
  if (!task)
    throw new Error(
      compact
        ? "No compact status or task file; run the snapshot publisher"
        : "No observation or task file in this run",
    );
  const rounds = (await readdir(directory)).flatMap((name) => {
    const match = /^round-(\d+)\.json$/.exec(name);
    return match ? [Number(match[1])] : [];
  });
  const last = rounds.length
    ? await find(`round-${Math.max(...rounds)}.json`)
    : undefined;
  return {
    kind: "heartbeat" as const,
    value: {
      task: await task.file.json(),
      rounds: rounds.length,
      lastRound: compact ? undefined : await last?.file.json(),
    },
    at: last?.at ?? task.at,
  };
}

/** One remote invocation carries independently available campaign and review evidence. */
export async function readEvidence(
  directory: string,
  receipt?: string,
  compact = false,
) {
  const [review, evidence] = await Promise.all([
    readReview(directory, receipt),
    readArtifacts(directory, compact).then(
      (artifacts) => ({ artifacts }),
      (error: unknown) => ({ error: String(error) }),
    ),
  ]);
  return { review, ...evidence };
}

/** Read one operator-selected receipt without making campaign reads depend on it. */
export async function readReview(directory: string, receipt?: string) {
  if (receipt === undefined) return undefined;
  try {
    return {
      state: "reviewed" as const,
      receipt: (await Bun.file(join(directory, receipt)).json()) as unknown,
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" as const }
      : { state: "unavailable" as const, error: String(error) };
  }
}
