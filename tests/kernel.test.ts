import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  Xean,
  inspectCampaign,
  openXeanStorage,
} from "../packages/core/src/index.ts";
import type {
  Campaign,
  Coordinator,
  JsonValue,
  Limits,
  Role,
  WorkRequest,
} from "../packages/core/src/types.ts";

function latch() {
  return Promise.withResolvers<void>();
}

function dispatch(requests: WorkRequest[]): Coordinator {
  return {
    name: "xean.fixture",
    async run(signal, view) {
      return {
        state: view.state,
        ...(signal.kind === "start" ? { dispatch: requests } : {}),
      };
    },
  };
}

const request = (id: string, input: JsonValue = id): WorkRequest => ({
  id,
  role: "worker",
  input,
});

test("reactive Coordinator signals are serialized while workers run concurrently", async () => {
  const started = [latch(), latch()];
  const release = [latch(), latch()];
  const coordinatorEntered = latch();
  const coordinatorRelease = latch();
  let activeCoordinators = 0;
  let maximumCoordinators = 0;
  let completions = 0;
  const engine = await Xean.open(new MemoryStorage(), {
    task: "Exact task",
    limits: { concurrency: 2 },
    roles: [
      {
        name: "worker",
        async run(input) {
          const index = Number(input);
          started[index]!.resolve();
          await release[index]!.promise;
          return { note: `result ${index}` };
        },
      },
    ],
    coordinator: {
      name: "reactive",
      async run(signal) {
        activeCoordinators++;
        maximumCoordinators = Math.max(maximumCoordinators, activeCoordinators);
        try {
          if (signal.kind === "start")
            return { state: 0, dispatch: [request("a", 0), request("b", 1)] };
          completions++;
          if (completions === 1) {
            coordinatorEntered.resolve();
            await coordinatorRelease.promise;
          }
          return { state: completions };
        } finally {
          activeCoordinators--;
        }
      },
    },
  });
  try {
    const running = engine.run();
    await Promise.all(started.map((item) => item.promise));
    expect(
      (await engine.inspect()).work.every((work) => work.result === null),
    ).toBe(true);
    release[0]!.resolve();
    await coordinatorEntered.promise;
    release[1]!.resolve();
    await engine.input({ whileCoordinatorWasBusy: true });
    coordinatorRelease.resolve();
    const result = await running;
    expect(result.work.map((work) => work.result)).toEqual([
      { note: "result 0" },
      { note: "result 1" },
    ]);
    expect(result.pendingSignals).toBe(0);
    expect(maximumCoordinators).toBe(1);
    expect(completions).toBe(3);
    expect(result.status).toBe("running");
  } finally {
    release.forEach((item) => item.resolve());
    coordinatorRelease.resolve();
    await engine.close();
  }
});

test("a group-waiting Coordinator can return no work and reuse an identical completed request", async () => {
  const calls: JsonValue[] = [];
  const waiting = latch();
  const engine = await Xean.open(new MemoryStorage(), {
    task: "Exact task",
    limits: { concurrency: 2 },
    roles: [
      {
        name: "worker",
        async run(input) {
          calls.push(input);
          if (input === "b") await waiting.promise;
          return input;
        },
      },
    ],
    coordinator: {
      name: "group",
      async run(signal, view) {
        if (signal.kind === "start")
          return { state: null, dispatch: [request("a"), request("b")] };
        const initial = view.work.filter((work) =>
          ["a", "b"].includes(work.id),
        );
        if (!initial.every((work) => work.status === "completed")) {
          waiting.resolve();
          return { state: "waiting" };
        }
        if (!view.work.some((work) => work.id === "combined")) {
          return {
            state: "combining",
            dispatch: [
              request("a"),
              request(
                "combined",
                initial.map((work) => work.result),
              ),
            ],
          };
        }
        return { state: "done" };
      },
    },
  });
  try {
    const result = await engine.run();
    expect(calls).toEqual(["a", "b", ["a", "b"]]);
    expect(result.work).toHaveLength(3);
    expect(
      result.work.every(
        (work) => work.attempts === 1 && work.status === "completed",
      ),
    ).toBe(true);
    expect(result.status).toBe("running");
    expect(result.result).toBeNull();
  } finally {
    waiting.resolve();
    await engine.close();
  }
});

test("an invalid Coordinator decision leaves its signal pending and admits no partial batch", async () => {
  let workers = 0;
  const engine = await Xean.open(new MemoryStorage(), {
    task: "Exact task",
    limits: { attempts: 1 },
    roles: [
      {
        name: "worker",
        async run() {
          workers++;
          return null;
        },
      },
    ],
    coordinator: {
      name: "failed decision",
      async run() {
        return {
          state: "must not publish",
          dispatch: [
            request("must not run"),
            { id: "invalid", role: "unknown", input: null },
          ],
        };
      },
    },
  });
  try {
    const result = await engine.run();
    expect(result.status).toBe("blocked");
    expect(result.work).toEqual([]);
    expect(result.pendingSignals).toBe(1);
    expect(workers).toBe(0);
    expect(result.state).toBeNull();
  } finally {
    await engine.close();
  }
});

test("pause drains a running worker, preserves queued work, and resumes it once", async () => {
  const started = latch();
  const release = latch();
  const calls: JsonValue[] = [];
  const engine = await Xean.open(new MemoryStorage(), {
    task: "Exact task",
    limits: { concurrency: 1 },
    roles: [
      {
        name: "worker",
        async run(input) {
          calls.push(input);
          if (input === "a") {
            started.resolve();
            await release.promise;
          }
          return input;
        },
      },
    ],
    coordinator: dispatch([request("a"), request("b")]),
  });
  try {
    const running = engine.run();
    await started.promise;
    const pausing = engine.pause();
    expect((await engine.inspect()).status).toBe("pausing");
    release.resolve();
    const paused = await pausing;
    await running;
    expect(paused.status).toBe("paused");
    expect(paused.work.map((work) => work.status)).toEqual([
      "completed",
      "queued",
    ]);
    expect(calls).toEqual(["a"]);
    await engine.resume();
    const result = await engine.run();
    expect(result.work.every((work) => work.status === "completed")).toBe(true);
    expect(calls).toEqual(["a", "b"]);
  } finally {
    release.resolve();
    await engine.close();
  }
});

test("cancellation preserves committed work and rejects a late result", async () => {
  const started = latch();
  const aborted = latch();
  const release = latch();
  const engine = await Xean.open(new MemoryStorage(), {
    task: "Exact task",
    limits: {
      concurrency: 1,
    },
    roles: [
      {
        name: "worker",
        async run(input, execution, context) {
          if (input === "a") return "committed";
          const model = { provider: "fixture", api: "fixture", id: "fixture" };
          const call = await execution.recorder.begin(model);
          context.abortSignal!.addEventListener(
            "abort",
            () => aborted.resolve(),
            { once: true },
          );
          started.resolve();
          await release.promise;
          try {
            await expect(
              Promise.resolve(execution.recorder.begin(model)).then((late) =>
                late.settle(measured, measured.usage),
              ),
            ).rejects.toThrow();
            await expect(
              Promise.resolve(call.recordRequest({ input })),
            ).rejects.toThrow();
          } finally {
            await call.settle(measured, measured.usage);
          }
          return "must not publish";
        },
      },
    ],
    coordinator: dispatch([request("a"), request("b")]),
  });
  try {
    const running = engine.run();
    await started.promise;
    const stopping = engine.cancel();
    await aborted.promise;
    release.resolve();
    const cancelled = await stopping;
    await running;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.work[0]).toMatchObject({
      status: "completed",
      result: "committed",
    });
    expect(cancelled.work[1]).toMatchObject({
      status: "cancelled",
      result: null,
    });
    expect(cancelled.providerCalls).toBe(1);
    expect(
      (await engine.records()).filter((r) => r.kind === "xean.call.settled"),
    ).toHaveLength(1);
  } finally {
    release.resolve();
    await engine.close();
  }
});

const measured = { ...fauxAssistantMessage([]), usageReported: true };
measured.usage = { ...measured.usage, input: 2, output: 1, totalTokens: 3 };

test("provider accounting snapshots values, commits once, and survives a failed worker", async () => {
  const engine = await Xean.open(new MemoryStorage(), {
    task: "atomic accounting",
    limits: { attempts: 1 },
    coordinator: dispatch([request("accounted")]),
    roles: [
      {
        name: "worker",
        async run(_, execution) {
          const model = {
            provider: "fixture",
            api: "openai-responses",
            id: "fixture",
          };
          const admission = execution.recorder.begin(model);
          model.id = "changed after admission";
          const call = await admission;
          const payload = { input: 1 };
          const recording = Promise.allSettled([
            call.recordRequest(payload),
            call.recordRequest(payload),
          ]);
          payload.input = 2;
          const requests = await recording;
          expect(requests.filter((r) => r.status === "fulfilled")).toHaveLength(
            1,
          );
          const response = structuredClone(measured);
          const settling = Promise.allSettled([
            call.settle(response, response.usage),
            call.settle(response, response.usage),
          ]);
          response.usage.input = 99;
          const settlements = await settling;
          expect(
            settlements.filter((r) => r.status === "fulfilled"),
          ).toHaveLength(1);
          throw new Error("mathematical result discarded");
        },
      },
    ],
  });
  try {
    const result = await engine.run();
    expect(result.status).toBe("running");
    expect(result.work[0]?.status).toBe("failed");
    expect(result.work[0]?.result).toBeNull();
    const records = await engine.records();
    expect(
      records.find((r) => r.kind === "xean.call.started")?.data,
    ).toMatchObject({
      model: { id: "fixture" },
    });
    expect(records.filter((r) => r.kind === "xean.call.request")).toHaveLength(
      1,
    );
    expect(
      records.find((r) => r.kind === "xean.call.request")?.data,
    ).toMatchObject({
      payload: { input: 1 },
    });
    const settlements = records.filter((r) => r.kind === "xean.call.settled");
    expect(settlements).toHaveLength(1);
    expect(settlements[0]?.data).toMatchObject({ usage: measured.usage });
  } finally {
    await engine.close();
  }
});

test("invalid open options release ownership and committed work survives role removal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-options-"));
  const path = join(directory, "campaign.sqlite");
  const role: Role = {
    name: "worker",
    run: () => "verified",
  };
  const coordinator: Coordinator = {
    name: "reuse",
    run(signal) {
      return {
        state: null,
        ...(signal.kind !== "completed"
          ? { dispatch: [request("support")] }
          : {}),
      };
    },
  };
  try {
    await expect(
      Xean.open(await openXeanStorage(path), {
        task: "reuse",
        roles: [role, role],
        coordinator,
      }),
    ).rejects.toThrow("Duplicate");
    for (const limits of [
      { concurrency: null },
      { attempts: null },
      { unknown: undefined },
    ])
      await expect(
        Xean.open(await openXeanStorage(path), {
          task: "reuse",
          roles: [role],
          coordinator,
          limits: limits as Partial<Limits>,
        }),
      ).rejects.toThrow("Invalid campaign limits");
    const storage = await openXeanStorage(path);
    const first = await Xean.open(storage, {
      task: "reuse",
      roles: [role],
      coordinator,
      limits: {
        concurrency: undefined,
        attempts: undefined,
      },
    });
    expect((await first.inspect()).limits).toEqual({
      concurrency: 4,
      attempts: 3,
    });
    await expect(
      Xean.open(storage, { roles: [role], coordinator }),
    ).rejects.toThrow("already has a Xean owner");
    expect((await first.run()).work[0]?.result).toBe("verified");
    await first.close();
    const second = await Xean.open(await openXeanStorage(path), {
      roles: [],
      coordinator,
    });
    try {
      await second.input("reuse support");
      const result = await second.run();
      expect(result.status).toBe("running");
      expect(result.work).toHaveLength(1);
      expect(result.work[0]).toMatchObject({ result: "verified", attempts: 1 });
    } finally {
      await second.close();
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("an uncertain commit stops the runner and reopen discovers the committed result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-commit-"));
  const path = join(directory, "campaign.sqlite");
  let runs = 0;
  const options = {
    task: "uncertain commit",
    coordinator: dispatch([request("once")]),
    roles: [
      {
        name: "worker",
        run() {
          runs++;
          return "durable result";
        },
      },
    ],
  };
  const storage = await openXeanStorage(path);
  let injected = false;
  const commit = storage.commit.bind(storage);
  const unreliable = spyOn(storage, "commit").mockImplementation(
    async (writes, context) => {
      const seq = await commit(writes, context);
      if (
        !injected &&
        writes.some(
          (w) =>
            w.type === "task" &&
            w.value.kind === "xean.worker" &&
            w.value.state.status === "terminal",
        )
      ) {
        injected = true;
        throw new Error("commit succeeded but its reply was lost");
      }
      return seq;
    },
  );
  try {
    const first = await Xean.open(storage, options);
    try {
      await expect(first.run()).rejects.toThrow("reply was lost");
    } finally {
      await first.close();
    }
    const second = await Xean.open(await openXeanStorage(path), options);
    try {
      const result = await second.run();
      expect(runs).toBe(1);
      expect(result.work[0]?.result).toBe("durable result");
      expect(result.pendingSignals).toBe(0);
    } finally {
      await second.close();
    }
  } finally {
    unreliable.mockRestore();
    await rm(directory, { recursive: true });
  }
});

test.each(["missing", "rejected"] as const)(
  "a %s acceptance gate blocks completion",
  async (gate) => {
    const engine = await Xean.open(new MemoryStorage(), {
      task: { statement: "Exact P", criterion: "Complete proof" },
      roles: [],
      coordinator: {
        name: "candidate",
        async run() {
          return { state: null, completion: "candidate" };
        },
      },
      ...(gate === "missing"
        ? {}
        : {
            accept(candidate: JsonValue, view: { task: JsonValue }) {
              expect(candidate).toBe("candidate");
              expect(view.task).toEqual({
                statement: "Exact P",
                criterion: "Complete proof",
              });
              return false;
            },
          }),
    });
    try {
      const result = await engine.run();
      expect(result.status).toBe("blocked");
      expect(result.result).toBeNull();
    } finally {
      await engine.close();
    }
  },
);

async function ready(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done)
        throw new Error(`Crash fixture exited before readiness: ${output}`);
      output += decoder.decode(chunk.value, { stream: true });
      if (output.includes("\n")) {
        expect(output.trim()).toBe("ready");
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

test("live and crashed campaigns admit readers, exclude a second owner, and recover only interrupted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-kernel-"));
  const fixture = join(import.meta.dir, "fixtures/kernel-crash.ts");
  const seed = Bun.spawn([process.execPath, fixture, directory, "seed"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
    killSignal: "SIGKILL",
  });
  const seedErrors = new Response(seed.stderr).text();
  let recovery: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    await ready(seed.stdout).catch(async (error) => {
      throw new Error(`${error}: ${await seedErrors}`);
    });
    const path = join(directory, "campaign.sqlite");
    const before = await inspectCampaign(path);
    expect(before.campaign.work.map(({ status }) => status)).toEqual([
      "completed",
      "active",
    ]);
    const bytes = await readFile(path);
    const wal = await readFile(`${path}-wal`);
    const inspected = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "../packages/cli/src/index.ts"),
        "inspect",
        path,
        "--records",
      ],
      { timeout: 5000 },
    );
    expect(inspected.exitCode).toBe(0);
    expect(JSON.parse(inspected.stdout.toString())).toEqual(before);
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(`${path}-wal`)).toEqual(wal);
    await expect(
      openXeanStorage(join(directory, "campaign.sqlite")),
    ).rejects.toThrow("locked");
    seed.kill("SIGKILL");
    await seed.exited;
    expect(await inspectCampaign(path)).toEqual(before);
    recovery = Bun.spawn([process.execPath, fixture, directory, "recover"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(recovery.stdout).text(),
      new Response(recovery.stderr).text(),
      recovery.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout) as Campaign;
    expect(
      result.work.map((work) => [
        work.id,
        work.status,
        work.attempts,
        work.result,
      ]),
    ).toEqual([
      ["committed", "completed", 1, "committed"],
      ["interrupted", "completed", 2, "interrupted"],
    ]);
    expect(result.pendingSignals).toBe(0);
    expect(result.state).toEqual(["committed", "interrupted"]);
    expect((await inspectCampaign(path)).campaign).toEqual(result);
    expect(
      (await readFile(join(directory, "invocations.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(["committed", "interrupted", "interrupted"]);
  } finally {
    await Promise.all(
      [seed, recovery].map(async (child) => {
        if (!child) return;
        if (child.exitCode === null) child.kill("SIGKILL");
        await child.exited;
      }),
    );
    seed.stdin.end();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
