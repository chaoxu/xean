import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, type StorageWrite } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import {
  Xean,
  openXeanStorage,
  TransientError,
  type XeanOptions,
} from "../packages/core/src/index.ts";
import { resumeExperiment } from "../scripts/bounded-solve.ts";

test("explicit resume retries a blocked signal and preserves completed work and history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-blocked-"));
  const path = join(directory, "campaign.sqlite");
  let fail = true;
  let workers = 0;
  const options: XeanOptions = {
    task: "resume provider failure",
    limits: { attempts: 1 },
    roles: [
      {
        name: "worker",
        run() {
          workers++;
          return "saved";
        },
      },
    ],
    coordinator: {
      name: "coordinator",
      run(signal) {
        if (signal.kind === "start")
          return {
            state: null,
            dispatch: [{ id: "work", role: "worker", input: null }],
          };
        if (fail) throw new Error("Provider temporarily unavailable");
        return { state: signal.id };
      },
    },
  };
  let engine = await Xean.open(await openXeanStorage(path), options);
  try {
    const blocked = await engine.run();
    expect(blocked.status).toBe("blocked");
    expect(await engine.run()).toEqual(blocked);
    const before = await engine.records();
    const failedInput = await engine.attemptInput(
      before.filter((r) => r.kind === "xean.attempt.started").at(-1)!.id,
    );
    await engine.close();
    engine = await Xean.open(await openXeanStorage(path), options);
    expect(await engine.run()).toEqual(blocked);
    fail = false;
    const resumed = await resumeExperiment(engine, 20);
    expect(resumed).toMatchObject({
      status: "running",
      error: null,
      pendingSignals: 0,
      providerCalls: 0,
      inputs: [],
    });
    expect(resumed.work).toEqual(blocked.work);
    expect(resumed.limits).toEqual(blocked.limits);
    expect(workers).toBe(1);
    const after = await engine.records();
    expect(after.slice(0, before.length)).toEqual(before);
    const started = after
      .filter((r) => r.kind === "xean.attempt.started")
      .at(-1)!;
    expect(
      ((await engine.attemptInput(started.id)) as { signal: unknown }).signal,
    ).toEqual((failedInput as { signal: unknown }).signal);
    expect(
      after.filter((r) => r.kind === "xean.coordinator.resumed"),
    ).toHaveLength(1);
    expect(await engine.resume()).toEqual(resumed);
    expect(await engine.records()).toEqual(after);
    await engine.cancel();
    await expect(engine.resume()).rejects.toThrow(
      "Cannot resume a cancelled campaign",
    );
  } finally {
    await engine.close();
    await rm(directory, { recursive: true });
  }
});

test("recovery settles an exhausted worker before delivering its failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-admission-"));
  const path = join(directory, "campaign.sqlite");
  const workerStarted = Promise.withResolvers<void>();
  const coordinatorStarted = Promise.withResolvers<void>();
  let workers = 0;
  let coordinators = 0;
  let recovering = false;
  const untilAborted = (signal: AbortSignal) =>
    new Promise<void>((done) => {
      if (signal.aborted) done();
      else signal.addEventListener("abort", () => done(), { once: true });
    });
  const options: XeanOptions = {
    task: "admission after interruption",
    limits: { concurrency: 1, attempts: 2 },
    roles: [
      {
        name: "worker",
        async run(_input, _execution, context) {
          if (++workers === 1) throw new TransientError("first attempt fails");
          workerStarted.resolve();
          await untilAborted(context.abortSignal!);
          return "uncommitted";
        },
      },
    ],
    coordinator: {
      name: "coordinator",
      async run(signal, view, _execution, context) {
        if (signal.kind === "start")
          return {
            state: null,
            dispatch: [{ id: "work", role: "worker", input: null }],
          };
        coordinators++;
        if (!recovering) {
          coordinatorStarted.resolve();
          await untilAborted(context.abortSignal!);
        }
        if (recovering) expect(view.work[0]?.status).toBe("failed");
        return { state: signal.kind };
      },
    },
  };
  let engine = await Xean.open(await openXeanStorage(path), options);
  try {
    const running = engine.run();
    await workerStarted.promise;
    await engine.input("coordinate");
    await coordinatorStarted.promise;
    await engine.close();
    await running;
    recovering = true;
    engine = await Xean.open(await openXeanStorage(path), options);
    const before = await engine.records();
    const result = await engine.run();
    expect(result.status).toBe("running");
    expect(workers).toBe(2);
    expect(coordinators).toBe(3);
    expect(result.state).toBe("failed");
    expect(result.work[0]?.status).toBe("failed");
    expect(result.work[0]?.result).toBeNull();
    expect(
      (await engine.records()).filter(
        (record) => record.kind === "xean.attempt.started",
      ),
    ).toHaveLength(
      before.filter((record) => record.kind === "xean.attempt.started").length +
        2,
    );
  } finally {
    await engine.close();
    await rm(directory, { recursive: true });
  }
});

test("resume during the final pause commit runs newly queued input", async () => {
  const started = Promise.withResolvers<void>();
  const releaseCoordinator = Promise.withResolvers<void>();
  const paused = Promise.withResolvers<void>();
  const releaseCommit = Promise.withResolvers<void>();
  let calls = 0;
  let held = false;
  const delayed = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], context: Context) {
      const result = await super.commit(writes, context);
      if (
        !held &&
        writes.some(
          (write) =>
            write.type === "document.change" &&
            write.content.kind === "base" &&
            write.content.value.status === "paused",
        )
      ) {
        held = true;
        paused.resolve();
        await releaseCommit.promise;
      }
      return result;
    }
  })();
  const engine = await Xean.open(delayed, {
    task: "resume while idle is being observed",
    roles: [],
    coordinator: {
      name: "coordinate",
      async run(signal) {
        calls++;
        if (signal.kind === "start") {
          started.resolve();
          await releaseCoordinator.promise;
        }
        return { state: signal.value };
      },
    },
  });
  try {
    const running = engine.run();
    await started.promise;
    const pausing = engine.pause();
    releaseCoordinator.resolve();
    await paused.promise;
    const resuming = engine.resume();
    const input = engine.input("next");
    releaseCommit.resolve();
    await input;
    await pausing;
    await running;
    const result = await resuming;
    expect(calls).toBe(2);
    expect(result.pendingSignals).toBe(0);
    expect(result.state).toBe("next");
    await engine.input("queued");
    // Give the Harness scheduler a turn; input alone must not restart dispatch.
    await Bun.sleep(10);
    expect(calls).toBe(2);
    expect((await engine.inspect()).pendingSignals).toBe(1);
    expect((await engine.run()).state).toBe("queued");
    expect(calls).toBe(3);
  } finally {
    releaseCoordinator.resolve();
    releaseCommit.resolve();
    await engine.close();
  }
});
