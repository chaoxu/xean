#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { decode } from "../../src/math/contracts.ts";
import { statusText } from "../../src/report.ts";
import { readRun, sourceSchema, type Source, type Run } from "./read.ts";
import type { Summary } from "./snapshot.ts";
import index from "./web/index.html";

export function readSources(value: unknown, directory: string): Source[] {
  const ids = new Set<string>();
  return decode(Type.Array(sourceSchema), value).map((source) => {
    if (ids.has(source.id)) throw new Error("Duplicate run ID");
    ids.add(source.id);
    return { ...source, database: resolve(directory, source.database) };
  });
}

function runStatus(run: Run) {
  return {
    id: run.id,
    database: run.database,
    problem: run.summary?.task.problem ?? null,
    observedAt: run.observedAt,
    stale: run.stale ?? false,
    snapshot: run.summary && { status: run.summary.status },
    error: statusText(run.error) ?? undefined,
  };
}

export type RunStatus = ReturnType<typeof runStatus>;

export function api(sources: Source[] | (() => Promise<Source[]>)) {
  // Retain only compact evidence; the browser owns its last full detail view.
  const previous = new Map<string, { observedAt: string; summary: Summary }>();
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
    let configured: Source[];
    try {
      configured = Array.isArray(sources) ? sources : await sources();
    } catch (error) {
      return new Response(
        `Source configuration unavailable: ${String(error)}`,
        { status: 500 },
      );
    }
    const databases = new Set(configured.map((source) => source.database));
    for (const database of previous.keys())
      if (!databases.has(database)) previous.delete(database);
    const selected =
      id === undefined
        ? configured
        : configured.filter((source) => source.id === id);
    if (id !== undefined && selected.length === 0)
      return new Response("Not found", { status: 404 });
    const compact = view === "status";
    const runs = await Promise.all(
      selected.map(async (source) => {
        const run = await readRun(source, compact);
        if (compact) {
          if (run.summary)
            previous.set(source.database, {
              observedAt: run.observedAt,
              summary: run.summary,
            });
          else {
            const retained = previous.get(source.database);
            if (retained) return { ...run, ...retained, stale: true };
          }
        }
        return run;
      }),
    );
    const values = compact ? runs.map(runStatus) : runs;
    return Response.json(id === undefined ? values : values[0], {
      headers: { "cache-control": "no-store" },
    });
  };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { port: { type: "string", default: "8797" } },
  });
  if (positionals.length !== 1)
    throw new Error("Usage: server.ts CONFIG.json [--port 8797]");
  const config = resolve(positionals[0]!);
  const sources = () =>
    Bun.file(config)
      .json()
      .then((value) => readSources(value, dirname(config)));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(values.port),
    routes: { "/": index, "/api/*": api(sources) },
    fetch(request) {
      if (request.method !== "GET")
        return new Response("Read-only", { status: 405 });
      return new Response("Not found", { status: 404 });
    },
    development: false,
  });
  console.log(`Xean Observe: ${server.url}`);
  const close = () => {
    void server.stop(true);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
