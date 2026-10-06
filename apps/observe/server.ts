#!/usr/bin/env bun
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { Type, type Static } from "typebox";
import { decode } from "../../src/math/contracts.ts";
import { readReport, statusText, type Report } from "../../src/report.ts";
import { inspect } from "../../src/host.ts";
import index from "./web/index.html";

const sourceSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$" }),
    database: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: false },
);
type Source = Static<typeof sourceSchema>;
export type Run = Source & {
  observedAt: string;
  stale?: boolean;
  snapshot?: Pick<
    Report,
    "task" | "status" | "kind" | "notes" | "work" | "result"
  >;
  error?: string;
};
export type RunStatus = Omit<Run, "snapshot"> & {
  problem: string | null;
  stale: boolean;
  snapshot?: Pick<Report, "status">;
};

export function readSources(value: unknown, directory: string): Source[] {
  const ids = new Set<string>();
  return decode(Type.Array(sourceSchema), value).map((source) => {
    if (ids.has(source.id)) throw new Error("Duplicate run ID");
    ids.add(source.id);
    return { ...source, database: resolve(directory, source.database) };
  });
}

export function api(sources: Source[] | (() => Promise<Source[]>)) {
  // Retain only compact evidence; the browser owns its last full detail view.
  const previous = new Map<
    string,
    Pick<RunStatus, "observedAt" | "problem" | "snapshot">
  >();
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
        const run = { ...source, observedAt: new Date().toISOString() };
        try {
          const { task, status, kind, notes, work, result } = await inspect(
            source.database,
            readReport,
            { live: true },
          );
          if (!compact)
            return {
              ...run,
              snapshot: { task, status, kind, notes, work, result },
            };
          const evidence = {
            observedAt: run.observedAt,
            problem: task.problem,
            snapshot: { status },
          };
          previous.set(source.database, evidence);
          return { ...run, ...evidence, stale: false };
        } catch (error) {
          if (!compact) return { ...run, error: String(error) };
          const retained = previous.get(source.database);
          return {
            ...run,
            problem: null,
            ...retained,
            stale: !!retained,
            error: statusText(String(error)),
          };
        }
      }),
    );
    return Response.json(id === undefined ? runs : runs[0], {
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
