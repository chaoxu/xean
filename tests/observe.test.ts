import { expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Xean,
  inspectCampaign,
  openXeanStorage,
} from "../packages/core/src/index.ts";
import { declarationVersion } from "xean/solve";
import {
  readSnapshot,
  readSummary,
  snapshot,
} from "../packages/observe/src/snapshot.ts";
import { observe } from "../packages/observe/src/publish.ts";
import {
  observationInterval,
  readRun,
  type Run,
} from "../packages/observe/src/read.ts";
import {
  api,
  readSources,
  type RunStatus,
} from "../packages/observe/src/server.ts";

async function fakeNomad(
  directory: string,
  failLogs?: "stdout" | "stderr",
  task = "solver",
  stdout = "worker output",
) {
  await mkdir(join(directory, "bin"), { recursive: true });
  await writeFile(
    join(directory, "bin/fleet-nomad"),
    `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "job") console.log(JSON.stringify([{ ID: "allocation", CreateIndex: 1, ClientStatus: "failed" }]));
else if (args.at(-1) !== ${JSON.stringify(task)}) throw new Error("wrong Nomad task");
else if ((args.includes("-stderr") ? "stderr" : "stdout") === ${JSON.stringify(failLogs)}) throw new Error("logs unavailable");
else if (args.includes("-stderr")) console.log("worker stopped");
else console.log(${JSON.stringify(stdout)});
`,
    { mode: 0o700 },
  );
}

test("pooled runs share process reads and failures only within each refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-observe-pool-"));
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    const mode = join(directory, "mode");
    const calls = join(directory, "calls.jsonl");
    await mkdir(join(directory, "bin"));
    await writeFile(
      join(directory, "task.json"),
      JSON.stringify({
        problem: "Task",
        completionCriteria: "Proof",
      }),
    );
    await writeFile(mode, "stderr");
    await writeFile(
      join(directory, "bin/fleet-nomad"),
      `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const mode = readFileSync(${JSON.stringify(mode)}, "utf8");
if (args[0] === "job") {
  if (mode === "allocs") throw new Error("allocations unavailable");
  console.log(JSON.stringify([{ ID: "allocation", CreateIndex: 1, ClientStatus: "running" }]));
} else {
  const task = args.at(-1);
  const stream = args.includes("-stderr") ? "stderr" : "stdout";
  if (mode === "stderr" && task === "solver" && stream === "stderr") throw new Error("solver stderr unavailable");
  console.log(task + " " + stream);
}
`,
      { mode: 0o700 },
    );
    const handle = api(
      [
        { id: "first", directory, job: "pool" },
        { id: "second", directory, job: "pool", task: "solver" },
        { id: "worker", directory, job: "pool", task: "worker" },
        { id: "missing", directory: join(directory, "missing"), job: "pool" },
      ],
      directory,
    );
    const read = async () =>
      (await (
        await handle(new Request("http://127.0.0.1/api/runs"))
      ).json()) as Run[];
    const commands = async () =>
      (await Bun.file(calls).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    const compact = await (
      await handle(new Request("http://127.0.0.1/api/runs/first?view=status"))
    ).json();
    expect(await commands()).toEqual([["job", "allocs", "-json", "pool"]]);
    const [first, concurrent] = await Promise.all([read(), read()]);
    expect(concurrent).toEqual(first);
    expect(compact.heartbeat).toEqual({ rounds: 0 });
    expect(compact.process).toMatchObject({
      job: "pool",
      task: "solver",
      allocation: "allocation",
      status: "running",
    });
    expect(compact.error).toBeUndefined();
    expect((await commands()).filter((args) => args[0] === "job")).toHaveLength(
      3,
    );
    expect(await commands()).toHaveLength(7);
    expect(first[0]?.error).toContain("solver stderr unavailable");
    expect(first[1]?.error).toBe(first[0]?.error);
    expect(first[0]?.process).toMatchObject({
      job: "pool",
      task: "solver",
      allocation: "allocation",
      log: "solver stdout\n",
      errorLog: "",
    });
    expect(first[2]?.process).toMatchObject({
      job: "pool",
      task: "worker",
      allocation: "allocation",
      log: "worker stdout\n",
      errorLog: "worker stderr\n",
    });
    expect(first[2]?.error).toBeUndefined();
    expect(first[3]?.error).toContain("No observation or task file");
    expect(first[0]?.error).not.toContain("No observation or task file");
    await writeFile(mode, "allocs");
    clock.mockReturnValue(Date.now() + 10_001);
    const failed = await read();
    expect(await commands()).toHaveLength(9);
    expect(failed[0]?.error).toContain("allocations unavailable");
    expect(failed[1]?.error).toBe(failed[0]?.error);
    expect(failed[0]?.process).toBeUndefined();
    await writeFile(mode, "ok");
    clock.mockReturnValue(Date.now() + 10_001);
    const recovered = await read();
    expect(await commands()).toHaveLength(15);
    expect(recovered.slice(0, 3).every((run) => run.error === undefined)).toBe(
      true,
    );
    expect(recovered[0]?.process?.errorLog).toBe("solver stderr\n");
  } finally {
    clock.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the external observer reads coherent live snapshots without changing a locked campaign", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-observe-"));
  const database = join(directory, "campaign.sqlite");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const engine = await Xean.open(await openXeanStorage(database), {
    task: {
      kind: "xean.solve",
      version: declarationVersion,
      task: {
        problem: "Observer fixture",
        completionCriteria: "Retain exact text",
      },
    },
    coordinator: {
      name: "fixture",
      run: (signal) => ({
        state: null,
        ...(signal.kind === "start"
          ? { dispatch: [{ id: "work", role: "explorer", input: null }] }
          : {}),
      }),
    },
    roles: [
      {
        name: "explorer",
        async run(_, execution) {
          const call = await execution.recorder.begin({
            provider: "fixture",
            api: "fixture",
            id: "fixture",
          });
          await call.recordRequest({ private: "request body" });
          entered.resolve();
          await release.promise;
          await call.settle(
            { private: "response body" },
            { input_tokens: 0, output_tokens: 9 },
          );
          return {
            kind: "notes",
            candidate: false,
            notes: [
              {
                id: "n1",
                summary: "Fixture note",
                detailedSummary:
                  "For every integer $n$, $4n$ is even because it is twice $2n$.",
                text: "<script>unsafe()</script> For every $n$, $4n$ is even.",
                support: [],
              },
            ],
          };
        },
      },
    ],
  });
  const running = engine.run();
  try {
    await entered.promise;
    const failures: unknown[] = [];
    // The publisher gets only a path, in another process while ownership is held.
    const publisher = Bun.spawnSync([
      process.execPath,
      "--no-install",
      "--no-env-file",
      new URL("../packages/observe/src/publish.ts", import.meta.url).pathname,
      directory,
    ]);
    expect(publisher.exitCode).toBe(0);
    expect(publisher.stderr.toString()).toBe("");
    const before = await readRun({ id: "fixture", directory }, directory);
    expect(before.error).toBeUndefined();
    expect(before.snapshot?.notes).toHaveLength(0);
    expect(before.snapshot?.status.calls.unsettled).toBe(1);
    release.resolve();
    await running;
    const committed = await engine.inspectWithRecords();
    const omitted = readSnapshot(
      snapshot(await inspectCampaign(database, false)),
    );
    expect(omitted.usageAvailable).toBe(false);
    expect(omitted.status.calls).toEqual({
      admitted: 1,
      settled: null,
      unknownUsage: null,
      unsettled: null,
      byModel: [],
      byModelOmitted: null,
    });
    const stop = observe(directory, (error) => {
      failures.push(error);
    });
    await stop();
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(await engine.inspectWithRecords()).toEqual(committed);
    const after = await readRun({ id: "fixture", directory }, directory);
    const published = await Bun.file(
      join(directory, "observation.json"),
    ).json();
    expect(published).toEqual({
      ...after.snapshot,
      observedAt: published.observedAt,
    });
    expect(published.schema).toBe("xean-observe/v5");
    const summary = await Bun.file(join(directory, "status.json")).json();
    expect(summary).toEqual({
      ...readSummary(published),
      observedAt: summary.observedAt,
    });
    const extra = {
      ...published,
      status: { ...published.status, ignored: "preserved input" },
      ignored: () => "unrelated fields must not be cloned",
    };
    expect(readSummary(extra)).toEqual({
      ...summary,
      observedAt: published.observedAt,
    });
    expect(extra.status.ignored).toBe("preserved input");
    expect(() => readSummary({ ...published, status: {} })).toThrow(
      "Malformed compact observation",
    );
    expect(after.snapshot?.notes[0]?.id).toBe("work/n1");
    expect(after.snapshot?.notes[0]?.detailedSummary).toContain("twice $2n$");
    const history = await engine.inspect();
    const library = snapshot({
      campaign: {
        ...history,
        task: { kind: "xean.solve.library", version: declarationVersion },
      },
    });
    expect(library.notes).toEqual(after.snapshot!.notes);
    expect(library.status.notes).toEqual(after.snapshot?.status.notes);
    for (const kind of ["xean.role", "xean.review"])
      expect(
        readSnapshot(
          snapshot({
            campaign: { ...history, task: { kind, task: published.task } },
          }),
        ).task,
      ).toEqual(published.task);
    for (const kind of [
      "xean.solve",
      "xean.solve.offline",
      "xean.solve.library",
    ])
      expect(() =>
        snapshot({
          campaign: {
            ...history,
            task: { kind, version: declarationVersion - 1 },
          },
        }),
      ).toThrow("Unsupported solver declaration");
    const exported = join(directory, "exported");
    await mkdir(exported);
    const observationFile = join(exported, "observation.json");
    const exportedRun = () =>
      readRun({ id: "exported", directory: exported }, directory);
    await writeFile(observationFile, JSON.stringify(published));
    const readback = await exportedRun();
    expect(readback.error).toBeUndefined();
    expect(readback.kind).toBe("snapshot");
    expect(readback.snapshot).toEqual(published);
    const support = {
      ...published.notes[0],
      id: "support",
      support: [],
      accepted: false,
    };
    const target = {
      ...published.notes[0],
      support: [support.id],
      accepted: true,
    };
    const accepted = {
      ...published,
      status: {
        ...published.status,
        status: "completed",
        phase: "terminal",
        allowedActions: [],
        acceptedNoteId: target.id,
      },
      notes: [support, target],
      result: { noteId: target.id },
    };
    await writeFile(observationFile, JSON.stringify(accepted));
    expect((await exportedRun()).snapshot).toEqual(accepted);
    const invalidUsage = structuredClone(published);
    invalidUsage.status.calls.byModel[0].reportedUsage = {
      proof: "Extra saved proof",
    };
    for (const invalid of [
      { ...published, schema: "xean-observe/v3" },
      { ...published, task: { label: "Invalid snapshot" } },
      { ...published, notes: [{ ...published.notes[0], support: undefined }] },
      { ...published, notes: [{ ...published.notes[0], text: undefined }] },
      {
        ...published,
        status: {
          ...published.status,
          calls: { ...published.status.calls, byModel: [null] },
        },
      },
      { ...published, status: { ...published.status, error: "x".repeat(501) } },
      invalidUsage,
      { ...accepted, notes: [support] },
      { ...accepted, notes: [support, { ...target, accepted: false }] },
      { ...accepted, notes: [target] },
      {
        ...accepted,
        notes: [{ ...support, support: [target.id] }, target],
      },
      { ...accepted, notes: [support, target, support] },
    ]) {
      await writeFile(observationFile, JSON.stringify(invalid));
      const unavailable = await exportedRun();
      expect(unavailable.error).toBeString();
      expect(unavailable.snapshot).toBeUndefined();
    }
    await writeFile(observationFile, JSON.stringify(published));
    const resultFile = join(exported, "result.json");
    await writeFile(resultFile, "receipt contents are not read");
    await utimes(observationFile, 1, 1);
    await utimes(resultFile, 2, 2);
    expect((await exportedRun()).snapshot).toEqual(published);
    // Execution receipts neither supply campaign details nor invalidate observations.
    await writeFile(observationFile, "{invalid JSON");
    expect((await exportedRun()).snapshot).toBeUndefined();
    expect((await exportedRun()).error).toBeString();
    await writeFile(observationFile, JSON.stringify(published));
    expect(after.snapshot?.status.calls.byModel[0]?.reportedUsage).toEqual({
      input_tokens: 0,
      output_tokens: 9,
    });
    expect(JSON.stringify(after)).not.toContain("request body");
    expect(JSON.stringify(after)).not.toContain("response body");
    await fakeNomad(directory, undefined, "worker");
    const supervised = await readRun(
      { id: "fixture", directory, job: "fixture-job", task: "worker" },
      directory,
    );
    expect(supervised.error).toBeUndefined();
    expect(supervised.kind).toBe("database");
    expect(supervised.snapshot?.notes).toEqual(after.snapshot?.notes);
    expect(supervised.process).toMatchObject({
      job: "fixture-job",
      task: "worker",
      allocation: "allocation",
      status: "failed",
      log: "worker output\n",
      errorLog: "worker stopped\n",
    });
    await fakeNomad(directory);
    const saved = structuredClone(published);
    saved.status.argument = "Extra saved proof";
    saved.status.calls.privateBody = "Extra saved proof";
    await writeFile(observationFile, JSON.stringify(saved));
    const statusFile = join(exported, "status.json");
    await writeFile(
      statusFile,
      JSON.stringify({
        observedAt: saved.observedAt,
        status: saved.status,
        usageAvailable: saved.usageAvailable,
        task: saved.task,
      }),
    );
    const receipt = {
      reviewer: "Independent reviewer",
      reviewedAt: "2026-10-01T00:00:00Z",
      verdict: "PASS" as const,
      report: "Private review prose",
    };
    await writeFile(join(exported, "review.json"), JSON.stringify(receipt));
    const handle = api(
      [
        { id: "fixture", directory },
        { id: "missing", directory: join(directory, "missing") },
        {
          id: "exported",
          directory: exported,
          job: "fixture-job",
          review: "review.json",
        },
      ],
      directory,
    );
    const response = await handle(new Request("http://127.0.0.1/api/runs"));
    const rows = (await response.json()) as Run[];
    expect(rows[0]?.snapshot?.notes).toHaveLength(1);
    expect(rows[1]?.error).toBeString();
    expect(rows[2]?.snapshot?.status).toEqual(published.status);
    expect(rows[2]?.review?.receipt).toEqual(receipt);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now());
    const refresh = async () => {
      clock.mockReturnValue(Date.now() + 10_001);
      return (await (
        await handle(new Request("http://127.0.0.1/api/runs"))
      ).json()) as Run[];
    };
    try {
      await writeFile(observationFile, "{invalid JSON");
      await utimes(observationFile, 3, 3);
      await fakeNomad(directory, undefined, "solver", "new-work");
      // Compact reads use the sidecar even when the full observation is invalid.
      const compact = await (
        await handle(new Request("http://127.0.0.1/api/runs?view=status"))
      ).json();
      const single = await (
        await handle(
          new Request("http://127.0.0.1/api/runs/exported?view=status"),
        )
      ).json();
      expect(single).toEqual(compact[2]);
      expect(single.observedAt).toBe(published.observedAt);
      expect(single.stale).toBe(false);
      expect(single.problem).toBe(published.task.problem);
      expect(single.snapshot).toEqual({
        status: published.status,
        usageAvailable: true,
      });
      expect(single.review).toEqual({
        state: "reviewed",
        receipt: {
          reviewer: receipt.reviewer,
          reviewedAt: receipt.reviewedAt,
          verdict: receipt.verdict,
        },
      });
      for (const text of [
        "unsafe()",
        "twice $2n$",
        "worker output",
        "worker stopped",
        "Extra saved proof",
        receipt.report,
      ])
        expect(JSON.stringify(compact)).not.toContain(text);
      expect(compact[0].snapshot.status).toEqual(rows[0]?.snapshot?.status);
      await writeFile(statusFile, "invalid compact status");
      for (let i = 0; i < 2; i++) {
        const failed = await refresh();
        // Full evidence expires with the refresh; only compact status is retained.
        expect(failed[2]?.snapshot).toBeUndefined();
        expect(failed[2]?.stale).toBeUndefined();
        expect(failed[2]?.process?.log).toBe("new-work\n");
        expect(failed[2]?.error).toBeString();
        expect(failed[0]).not.toHaveProperty("stale");
        expect(failed[1]?.snapshot).toBeUndefined();
        expect(failed[1]).not.toHaveProperty("stale");
      }
      const stale = await (
        await handle(
          new Request("http://127.0.0.1/api/runs/exported?view=status"),
        )
      ).json();
      expect(stale.stale).toBe(true);
      expect(stale.observedAt).toBe(single.observedAt);
      expect(stale.snapshot).toEqual(single.snapshot);
      const recovered = { ...published, notes: [] };
      await writeFile(observationFile, JSON.stringify(recovered));
      await writeFile(statusFile, JSON.stringify(readSummary(recovered)));
      await fakeNomad(directory, "stderr");
      const refreshed = await refresh();
      expect(refreshed[2]?.snapshot).toEqual(recovered);
      expect(refreshed[2]).not.toHaveProperty("stale");
      expect(refreshed[2]?.error).toContain("logs unavailable");
    } finally {
      clock.mockRestore();
    }
    expect(
      (await handle(new Request("http://127.0.0.1/api/runs/unknown"))).status,
    ).toBe(404);
    expect(
      (
        await handle(
          new Request("http://127.0.0.1/api/runs", { method: "POST" }),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handle(
          new Request("http://127.0.0.1/api/runs", {
            headers: { origin: "https://example.com" },
          }),
        )
      ).status,
    ).toBe(403);
    expect(failures).toEqual([]);
  } finally {
    release.resolve();
    await running;
    await engine.close();
    await rm(directory, { recursive: true });
  }
});

test("observer accepts generic campaign databases and published snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-observe-generic-"));
  const engine = await Xean.open(
    await openXeanStorage(join(directory, "campaign.sqlite")),
    {
      task: { task: { label: "Opaque kernel payload" } },
      roles: [],
      coordinator: { name: "fixture", run: () => ({ state: null }) },
    },
  );
  try {
    const value = await engine.inspectWithRecords();
    const exported = join(directory, "exported");
    await mkdir(exported);
    await writeFile(
      join(exported, "observation.json"),
      JSON.stringify(snapshot(value)),
    );
    for (const path of [directory, exported]) {
      const observed = await readRun(
        { id: "generic", directory: path },
        directory,
      );
      expect(observed.error).toBeUndefined();
      expect(observed.snapshot?.task).toBeNull();
      expect(observed.snapshot?.status.status).toBe(value.campaign.status);
    }
  } finally {
    await engine.close();
    await rm(directory, { recursive: true });
  }
});

test("observer sources preserve unavailable evidence and reject unsupported snapshots and unsafe remote commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-observe-artifacts-"));
  try {
    await writeFile(join(directory, "task.json"), "null");
    const malformed = await readRun({ id: "bad-task", directory }, directory);
    expect(malformed.error).toBeString();
    expect(malformed.heartbeat).toBeUndefined();
    await writeFile(
      join(directory, "task.json"),
      JSON.stringify({
        problem: "A run awaiting its publisher",
        completionCriteria: "Exact task",
      }),
    );
    await writeFile(
      join(directory, "round-1.json"),
      JSON.stringify({ round: 1 }),
    );
    const run = await readRun({ id: "unpublished", directory }, directory);
    expect(run.kind).toBe("heartbeat");
    expect(run.snapshot).toBeUndefined();
    expect(run.heartbeat?.rounds).toBe(1);
    const storage = await openXeanStorage(join(directory, "campaign.sqlite"));
    try {
      for (const compact of [false, true]) {
        const initializing = await readRun(
          { id: "initializing", directory },
          directory,
          undefined,
          undefined,
          compact,
        );
        expect(initializing.error).toBeUndefined();
        expect(initializing.kind).toBe("heartbeat");
        expect(initializing.heartbeat?.rounds).toBe(1);
      }
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
    const corrupt = join(directory, "corrupt");
    await mkdir(corrupt);
    await writeFile(
      join(corrupt, "task.json"),
      JSON.stringify(run.heartbeat!.task),
    );
    await writeFile(join(corrupt, "campaign.sqlite"), "Not a SQLite database");
    const unavailableDatabase = await readRun(
      { id: "corrupt", directory: corrupt },
      directory,
    );
    expect(unavailableDatabase.error).toBeString();
    expect(unavailableDatabase.heartbeat).toBeUndefined();
    await writeFile(
      join(directory, "observation.json"),
      JSON.stringify({
        schema: "xean-observe/v1",
        observedAt: new Date().toISOString(),
        status: { calls: {} },
        notes: [],
        work: [],
      }),
    );
    for (const failed of ["stdout", "stderr"] as const) {
      await fakeNomad(directory, failed);
      const unavailable = await readRun(
        { id: "unpublished", directory, job: "fixture-job" },
        directory,
      );
      expect(unavailable.error).toContain("Unsupported observation");
      expect(unavailable.error).toContain("logs unavailable");
      expect(unavailable.process).toMatchObject({
        status: "failed",
        ...(failed === "stdout"
          ? { log: "", errorLog: "worker stopped\n" }
          : {
              log: "worker output\n",
              errorLog: "",
            }),
      });
    }
    expect(() =>
      readSources(
        [
          { id: "run", directory },
          { id: "run", directory },
        ],
        directory,
      ),
    ).toThrow();
    expect(() =>
      readSources(
        [{ id: "run", directory, host: "jupiter", runtime: "/tmp/bun;exit" }],
        directory,
      ),
    ).toThrow();
    expect(() =>
      readSources([{ id: "run", directory, task: "" }], directory),
    ).toThrow("/0/task");
    let reads = 0;
    const handle = api(
      [
        {
          id: "known",
          get directory() {
            reads++;
            return directory;
          },
        },
      ],
      directory,
    );
    for (const [path, status] of [
      ["/api/unknown", 404],
      ["/api/runs/unknown", 404],
      ["/api/runs/", 404],
      ["/api/runs/%", 400],
      ["/api/runs/known?view=stats", 400],
    ] as const)
      expect(
        (await handle(new Request(`http://127.0.0.1${path}`))).status,
      ).toBe(status);
    expect(reads).toBe(0);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("source refresh reloads membership and retains stale evidence only for the same ID and location", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-observe-reload-"));
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    for (const id of ["first", "second"]) {
      await mkdir(join(directory, id));
      await writeFile(
        join(directory, id, "task.json"),
        JSON.stringify({ problem: id, completionCriteria: "Proof" }),
      );
    }
    const config = join(directory, "sources.json");
    const first = { id: "first", directory: "first" };
    const second = { id: "second", directory: "second" };
    await writeFile(config, JSON.stringify([first, second]));
    let reloads = 0;
    const handle = api(async () => {
      reloads++;
      return readSources(await Bun.file(config).json(), directory);
    }, directory);
    const request = (suffix = "") =>
      handle(new Request(`http://127.0.0.1/api/runs${suffix}?view=status`));
    const refresh = async (sources: unknown) => {
      await writeFile(config, JSON.stringify(sources));
      clock.mockReturnValue(Date.now() + 10_001);
      return (await (await request()).json()) as RunStatus[];
    };
    const [initial, concurrent] = await Promise.all([request(), request()]);
    const original = (await initial.json()) as RunStatus[];
    expect(await concurrent.json()).toEqual(original);
    expect(reloads).toBe(1);
    await writeFile(join(directory, "first/task.json"), "invalid");
    const reordered = await refresh([second, first]);
    expect(reordered.map((run) => run.id)).toEqual(["second", "first"]);
    expect(reordered[1]).toMatchObject({
      stale: true,
      heartbeat: original[0]!.heartbeat,
      observedAt: original[0]!.observedAt,
    });
    expect(reordered[0]?.problem).toBe("second");
    expect(reordered[0]?.stale).toBe(false);
    const relocated = await refresh([{ ...first, directory: "missing" }]);
    expect(relocated[0]?.heartbeat).toBeUndefined();
    expect(relocated[0]?.stale).toBe(false);
    expect((await request("/second")).status).toBe(404);
    const added = await refresh([second, { id: "third", directory: "second" }]);
    expect(added.map((run) => run.id)).toEqual(["second", "third"]);
    await writeFile(config, "not JSON");
    clock.mockReturnValue(Date.now() + 10_001);
    expect((await request()).status).toBe(500);
    expect((await refresh([second]))[0]?.heartbeat).toEqual(
      added[0]?.heartbeat,
    );
    expect(await refresh([])).toEqual([]);
    expect((await request("/second")).status).toBe(404);
  } finally {
    clock.mockRestore();
    await rm(directory, { recursive: true });
  }
});

test("stalled observation processes do not block individual reads or configuration recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-observe-stalled-"));
  const path = process.env.PATH;
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  let collection: Promise<Response> | undefined;
  let repeated: Promise<Response> | undefined;
  try {
    await mkdir(join(directory, "bin"));
    await writeFile(
      join(directory, "task.json"),
      JSON.stringify({
        problem: "Healthy local task",
        completionCriteria: "Proof",
      }),
    );
    for (const name of ["ssh", "fleet-nomad"]) {
      await writeFile(
        join(directory, "bin", name),
        `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(${JSON.stringify(join(directory, `${name}-stopped`))}, "stopped");
  process.exit(0);
});
appendFileSync(${JSON.stringify(join(directory, `${name}-started`))}, "ready");
while (!existsSync(${JSON.stringify(join(directory, "release"))})) await Bun.sleep(10);
if (existsSync(${JSON.stringify(join(directory, "fail"))})) { console.error("fixture failure"); process.exit(1); }
console.log(JSON.stringify({artifacts:{kind:"heartbeat",at:"2026-10-01T00:00:00Z",value:{task:{problem:"Remote task",completionCriteria:"Proof"},rounds:1}}}));
`,
        { mode: 0o700 },
      );
    }
    process.env.PATH = `${join(directory, "bin")}:${path ?? ""}`;
    const local = { id: "local", directory };
    const remote = {
      id: "remote",
      directory: "/fixture",
      host: "jupiter",
      runtime: process.execPath,
    };
    let sources = [local, remote, { id: "process", directory, job: "fixture" }];
    const handle = api(async () => sources, directory);
    const request = (suffix = "") =>
      handle(new Request(`http://127.0.0.1/api/runs${suffix}`));
    collection = request();
    for (const name of ["ssh", "fleet-nomad"])
      while (!existsSync(join(directory, `${name}-started`)))
        await Bun.sleep(10);

    const healthy = (await (await request("/local")).json()) as Run;
    expect(healthy.heartbeat?.task.problem).toBe("Healthy local task");
    expect(existsSync(join(directory, "ssh-stopped"))).toBe(false);
    clock.mockReturnValue(Date.now() + observationInterval + 1);
    repeated = request("/remote");
    await Bun.sleep(20);
    expect(await Bun.file(join(directory, "ssh-started")).text()).toBe("ready");
    sources = [local];
    clock.mockReturnValue(Date.now() + observationInterval + 1);
    expect((await (await request()).json()).map((run: Run) => run.id)).toEqual([
      "local",
    ]);
    expect((await request("/remote")).status).toBe(404);
    expect(existsSync(join(directory, "ssh-stopped"))).toBe(false);

    const completed = (await (await collection).json()) as Run[];
    expect(completed[0]?.error).toBeUndefined();
    expect(completed[1]?.error).toContain("timed out");
    expect(completed[2]?.error).toContain("timed out");
    expect(completed[2]?.heartbeat?.task.problem).toBe("Healthy local task");
    expect(await (await repeated).json()).toEqual(completed[1]);
    for (const name of ["ssh", "fleet-nomad"])
      expect(existsSync(join(directory, `${name}-stopped`))).toBe(true);

    await rm(join(directory, "ssh-started"));
    await rm(join(directory, "ssh-stopped"));
    const stop = new AbortController();
    const cancelled = readRun(remote, directory, undefined, stop.signal);
    while (!existsSync(join(directory, "ssh-started"))) await Bun.sleep(10);
    stop.abort();
    expect((await cancelled).error).toContain("canceled");
    expect(existsSync(join(directory, "ssh-stopped"))).toBe(true);

    await rm(join(directory, "ssh-started"));
    sources = [local, remote];
    clock.mockReturnValue(Date.now() + observationInterval + 1);
    repeated = request("/remote");
    while (!existsSync(join(directory, "ssh-started"))) await Bun.sleep(10);
    clock.mockReturnValue(Date.now() + observationInterval + 1);
    await request("/local");
    await writeFile(join(directory, "release"), "done");
    const late = await (await repeated).json();
    expect(late.heartbeat?.task.problem).toBe("Remote task");
    await writeFile(join(directory, "fail"), "bad");
    clock.mockReturnValue(Date.now() + observationInterval + 1);
    const retained = await (await request("/remote")).json();
    expect(retained.heartbeat).toBeUndefined();
    expect(retained.stale).toBeUndefined();
    expect(retained.error).toContain("fixture failure");
  } finally {
    await writeFile(join(directory, "release"), "done");
    await collection;
    await repeated;
    clock.mockRestore();
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("explicit external receipts refresh independently of campaign evidence locally and through one SSH read", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-observe-review-"));
  const path = process.env.PATH;
  try {
    await writeFile(
      join(directory, "task.json"),
      JSON.stringify({ problem: "Task", completionCriteria: "Proof" }),
    );
    const source = { id: "review", directory, review: "selected-review.json" };
    expect(
      (await readRun({ id: "unsupplied", directory }, directory)).review,
    ).toBeUndefined();
    expect(await readRun(source, directory)).toMatchObject({
      review: { state: "missing" },
      heartbeat: { task: { problem: "Task" } },
    });
    const receipt = {
      reviewer: "Independent reviewer",
      reviewedAt: "2026-10-01T00:00:00Z",
      verdict: "PASS" as const,
      report: "The proof checks.",
    };
    for (const value of ["not JSON", JSON.stringify({ verdict: "PASS" })]) {
      await writeFile(join(directory, source.review), value);
      const observed = await readRun(source, directory);
      expect(observed.review?.state).toBe("unavailable");
      expect(observed.review?.error).toBeString();
      expect(observed.error).toBeUndefined();
      expect(observed.heartbeat?.task.problem).toBe("Task");
    }
    await writeFile(join(directory, source.review), JSON.stringify(receipt));
    expect((await readRun(source, directory)).review).toEqual({
      state: "reviewed",
      receipt,
    });
    await mkdir(join(directory, "bin"));
    const calls = join(directory, "ssh-calls.jsonl");
    await writeFile(
      join(directory, "bin/ssh"),
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n");
const child=Bun.spawn([process.execPath,"--no-install","--no-env-file","run","-"],{stdin:new TextEncoder().encode(await Bun.stdin.text()),stdout:"inherit",stderr:"inherit"});
process.exit(await child.exited);
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${join(directory, "bin")}:${path ?? ""}`;
    const remote = { ...source, host: "jupiter", runtime: process.execPath };
    const changed = {
      ...receipt,
      verdict: "FAIL" as const,
      report: "A later review identifies a gap.",
    };
    await writeFile(join(directory, source.review), JSON.stringify(changed));
    const observed = await readRun(remote, directory);
    expect(observed.review).toEqual({ state: "reviewed", receipt: changed });
    expect(observed.heartbeat?.task.problem).toBe("Task");
    expect(observed.error).toBeUndefined();
    expect((await Bun.file(calls).text()).trim().split("\n")).toHaveLength(1);
    const engine = await Xean.open(
      await openXeanStorage(join(directory, "fixture.sqlite")),
      {
        task: null,
        roles: [],
        coordinator: { name: "fixture", run: () => ({ state: null }) },
      },
    );
    let exported;
    try {
      exported = await engine.inspectWithRecords();
    } finally {
      await engine.close();
    }
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({ status: "running", providerCalls: 0 }),
    );
    const unpublished = await readRun(remote, directory);
    expect(unpublished.error).toBeUndefined();
    expect(unpublished.kind).toBe("heartbeat");
    expect(unpublished.snapshot).toBeUndefined();
    expect(unpublished.review).toEqual({ state: "reviewed", receipt: changed });
    await writeFile(
      join(directory, "observation.json"),
      JSON.stringify(snapshot(exported)),
    );
    expect(await readRun(remote, directory)).toMatchObject({
      kind: "snapshot",
      review: { state: "reviewed", receipt: changed },
    });
    expect(
      (await readRun(source, directory, undefined, undefined, true)).error,
    ).toContain("snapshot publisher");
    await writeFile(
      join(directory, "observation.json"),
      "invalid snapshot".repeat(100_000),
    );
    await writeFile(
      join(directory, "status.json"),
      JSON.stringify(readSummary(snapshot(exported))),
    );
    const compact = await readRun(
      remote,
      directory,
      undefined,
      undefined,
      true,
    );
    expect(compact.error).toBeUndefined();
    expect(compact.summary?.status).toEqual(snapshot(exported).status);
    expect(compact.snapshot).toBeUndefined();
    await utimes(join(directory, "status.json"), 1, 1);
    expect(
      (await readRun(source, directory, undefined, undefined, true)).error,
    ).toContain("snapshot publisher");
    const unavailable = await readRun(remote, directory);
    expect(unavailable.error).toBeString();
    expect(unavailable.snapshot).toBeUndefined();
    expect(unavailable.review).toEqual({ state: "reviewed", receipt: changed });
    expect((await Bun.file(calls).text()).trim().split("\n")).toHaveLength(5);
    expect(() =>
      readSources([{ ...source, review: "/arbitrary/file" }], directory),
    ).toThrow("relative path");
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
    await rm(directory, { recursive: true });
  }
});
