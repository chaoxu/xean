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
  const [observation, result, summary] = await Promise.all([
    find("observation.json"),
    find("result.json"),
    compact ? find("status.json") : undefined,
  ]);
  const useObservation =
    observation && (!result || observation.modified >= result.modified);
  const latest = useObservation ? observation : result;
  if (compact) {
    if (summary && (!latest || summary.modified >= latest.modified))
      return {
        kind: "status" as const,
        value: await summary.file.json(),
        at: summary.at,
      };
    if (latest)
      throw new Error(
        "Compact status is missing or older than campaign artifacts; use the run's matching snapshot publisher",
      );
  } else if (latest)
    return {
      kind: useObservation ? ("snapshot" as const) : ("export" as const),
      value: await latest.file.json(),
      at: latest.at,
    };
  const task = await find("task.json");
  if (!task)
    throw new Error(
      compact
        ? "No compact status or task file; use the run's matching snapshot publisher"
        : "No observation, result, or task file in this run",
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
