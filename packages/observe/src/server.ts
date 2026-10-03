#!/usr/bin/env bun
import { resolve, dirname, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { decode } from "xean/solve";
import { statusText } from "xean/report";
import {
  defaultProcessTask,
  observationInterval,
  readProcess,
  readRun,
  sourceSchema,
  type Source,
  type Run,
} from "./read.ts";
import { verifyInstall } from "../../../scripts/dependencies.ts";
import index from "../web/index.html";

export function readSources(value: unknown, directory: string): Source[] {
  const ids = new Set<string>();
  return decode(Type.Array(sourceSchema), value).map((source) => {
    if (ids.has(source.id)) throw new Error("Duplicate run ID");
    ids.add(source.id);
    if (source.review !== undefined && isAbsolute(source.review))
      throw new Error("Review receipt must be a nonempty relative path");
    if (source.host && (!source.runtime || !isAbsolute(source.directory)))
      throw new Error(
        "Remote runs require a host, absolute directory, and absolute runtime path",
      );
    return {
      ...source,
      directory: source.host
        ? source.directory
        : resolve(directory, source.directory),
    };
  });
}

function runStatus(run: Run) {
  const { process, review, heartbeat } = run;
  const snapshot = run.summary ?? run.snapshot;
  return {
    id: run.id,
    source: run.source,
    kind: run.kind,
    observedAt: snapshot?.observedAt ?? run.observedAt,
    stale: run.stale ?? false,
    snapshot: snapshot && {
      status: snapshot.status,
      usageAvailable: snapshot.usageAvailable,
    },
    process: process && {
      job: process.job,
      task: process.task,
      allocation: process.allocation,
      status: process.status,
      observedAt: process.observedAt,
    },
    review: review && {
      state: review.state,
      receipt: review.receipt && {
        reviewer: review.receipt.reviewer,
        reviewedAt: review.receipt.reviewedAt,
        verdict: review.receipt.verdict,
      },
      error: statusText(review.error) ?? undefined,
    },
    heartbeat: heartbeat && { rounds: heartbeat.rounds },
    error: statusText(run.error) ?? undefined,
  };
}

export function api(
  sources: Source[] | (() => Promise<Source[]>),
  fleet: string,
  signal?: AbortSignal,
) {
  type Refresh = {
    sources: Promise<Source[]>;
    runs: Map<string, Promise<Run>>;
    processes: Map<string, ReturnType<typeof readProcess>>;
    expiresAt: number;
  };
  const identity = (source: Source, compact: boolean) =>
    JSON.stringify([source.id, source.host ?? null, source.directory, compact]);
  let current: Refresh | undefined;
  let known = new Map<string, { fingerprint: string; run?: Run }>();
  const inFlight = new Map<string, Promise<Run>>();
  const refresh = () => {
    if (current && Date.now() < current.expiresAt) return current;
    const batch: Refresh = {
      sources: Promise.resolve().then(() =>
        Array.isArray(sources) ? sources : sources(),
      ),
      runs: new Map(),
      processes: new Map(),
      expiresAt: Infinity,
    };
    current = batch;
    void batch.sources.then(
      () => {
        batch.expiresAt = Date.now() + observationInterval;
      },
      () => {
        if (current === batch) current = undefined;
      },
    );
    return batch;
  };
  const read = (
    source: Source,
    batch: Refresh,
    compact: boolean,
  ): Promise<Run> => {
    const key = identity(source, compact);
    let pending = batch.runs.get(key);
    if (pending) return pending;
    const fingerprint = known.get(key)!.fingerprint;
    let observation = inFlight.get(fingerprint);
    if (!observation) {
      let processObservation;
      if (source.job) {
        const processKey = JSON.stringify([
          source.job,
          source.task ?? defaultProcessTask,
          compact,
        ]);
        processObservation =
          batch.processes.get(processKey) ??
          readProcess(source, fleet, signal, compact);
        batch.processes.set(processKey, processObservation);
      }
      observation = readRun(
        source,
        fleet,
        processObservation,
        signal,
        compact,
      ).finally(() => inFlight.delete(fingerprint));
      inFlight.set(fingerprint, observation);
    }
    pending = observation.then((run) => {
      const state = known.get(key);
      const retained = state?.run;
      const result =
        run.error &&
        !run.snapshot &&
        !run.summary &&
        !run.heartbeat &&
        (retained?.snapshot || retained?.summary || retained?.heartbeat)
          ? {
              ...run,
              kind: retained.kind,
              observedAt: retained.observedAt,
              snapshot: retained.snapshot,
              summary: retained.summary,
              heartbeat: retained.heartbeat,
              stale: true,
            }
          : run;
      if (state?.fingerprint === fingerprint) state.run = result;
      return result;
    });
    batch.runs.set(key, pending);
    return pending;
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      (request.headers.has("origin") &&
        request.headers.get("origin") !== url.origin)
    )
      return new Response("Forbidden", { status: 403 });
    if (request.method !== "GET")
      return new Response("Read-only", { status: 405 });
    let id: string | undefined;
    if (url.pathname !== "/api/runs") {
      if (!url.pathname.startsWith("/api/runs/"))
        return new Response("Not found", { status: 404 });
      try {
        id = decodeURIComponent(url.pathname.slice("/api/runs/".length));
      } catch {
        return new Response("Invalid run ID", { status: 400 });
      }
    }
    const view = url.searchParams.get("view");
    if (view !== null && view !== "status")
      return new Response("Unknown view", { status: 400 });
    const batch = refresh();
    let configured: Source[];
    try {
      configured = await batch.sources;
    } catch (error) {
      return new Response(
        `Source configuration unavailable: ${String(error)}`,
        { status: 500 },
      );
    }
    const selected =
      id === undefined
        ? configured
        : configured.filter((source) => source.id === id);
    if (id !== undefined && selected.length === 0)
      return new Response("Not found", { status: 404 });
    if (batch.runs.size === 0) {
      const next: typeof known = new Map();
      for (const source of configured)
        for (const compact of [false, true]) {
          const key = identity(source, compact);
          const fingerprint = JSON.stringify([source, compact]);
          next.set(key, { fingerprint, run: known.get(key)?.run });
        }
      known = next;
    }
    const runs = await Promise.all(
      selected.map((source) => read(source, batch, view === "status")),
    );
    const values = view === "status" ? runs.map(runStatus) : runs;
    return Response.json(id === undefined ? values : values[0], {
      headers: { "cache-control": "no-store" },
    });
  };
}

if (import.meta.main) {
  await verifyInstall(resolve(import.meta.dir, "../../.."));
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      port: { type: "string", default: "8797" },
      fleet: {
        type: "string",
        default: resolve(import.meta.dir, "../../../../fleet-infra"),
      },
    },
  });
  if (positionals.length !== 1)
    throw new Error(
      "Usage: server.ts CONFIG.json [--port 8797] [--fleet FLEET_INFRA]",
    );
  const config = resolve(positionals[0]!);
  const sources = () =>
    Bun.file(config)
      .json()
      .then((value) => readSources(value, dirname(config)));
  const controller = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(values.port),
    routes: {
      "/": index,
      "/api/*": api(sources, values.fleet!, controller.signal),
    },
    fetch(request) {
      if (request.method !== "GET")
        return new Response("Read-only", { status: 405 });
      return new Response("Not found", { status: 404 });
    },
    development: false,
  });
  console.log(`Xean Observe: ${server.url}`);
  const close = () => {
    controller.abort();
    void server.stop(true);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
