import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  Xean,
  openXeanStorage,
  type JsonValue,
  type XeanOptions,
} from "../packages/core/src/index.ts";

test("keyed input, JSON normalization, and exact historical visibility survive SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-inputs-"));
  const path = join(directory, "campaign.sqlite");
  const text = "immutable input ".repeat(512);
  const seen: JsonValue[] = [];
  const validated: number[][] = [];
  const options: XeanOptions = {
    task: { zero: -0, statement: text },
    limits: { concurrency: 1 },
    roles: [
      {
        name: "worker",
        run(input) {
          return { zero: -0, input, payload: text };
        },
      },
    ],
    validateInput(value, view) {
      validated.push(view.inputs.map(({ id }) => id));
      (view.task as { statement: string }).statement = "changed by validation";
      if (value && typeof value === "object")
        Object.assign(Object.setPrototypeOf(value, null), { zero: -0 });
      if (value === "reject") throw new Error("invalid application input");
    },
    coordinator: {
      name: "coordinate",
      run(signal, view) {
        seen.push({ signal, view });
        const decision = {
          state: view.inputs.length,
          ...(signal.kind === "start"
            ? {
                dispatch: [0, 1].map((input) => ({
                  id: String(input),
                  role: "worker",
                  input: { input, payload: text },
                })),
              }
            : {}),
        };
        return decision;
      },
    },
  };
  let storage = await openXeanStorage(path);
  let engine = await Xean.open(storage, options);
  try {
    const [first, duplicate] = await Promise.all([
      engine.input({ text, zero: -0 }, "initial"),
      engine.input({ text, zero: 0 }, "initial"),
    ]);
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({ key: "initial", value: { text, zero: 0 } });
    const unkeyed = await engine.input(first.value);
    expect(unkeyed.key).toBeNull();
    expect(validated).toEqual([[], [first.id]]);
    await expect(engine.input("reject", "rejected")).rejects.toThrow(
      "invalid application input",
    );
    expect((await engine.inspect()).inputs).toEqual([first, unkeyed]);
    const result = await engine.run();
    expect(result.task).toEqual({ zero: 0, statement: text });
    expect(Object.is((result.task as { zero: number }).zero, 0)).toBe(true);
    expect(
      Object.is((result.work[0]!.result as { zero: number }).zero, 0),
    ).toBe(true);
    expect(seen[0]).toMatchObject({
      signal: { kind: "start" },
      view: { inputs: [first, unkeyed] },
    });
    const late = await engine.input("later", "later");
    await engine.run();
    const starts = (await engine.records()).filter(
      (entry) => entry.kind === "xean.attempt.started",
    );
    const coordinatorStarts = starts.filter((entry) =>
      Boolean((entry.data as { snapshot?: unknown }).snapshot),
    );
    const storedDecisions = () =>
      Promise.all(
        coordinatorStarts.map(async (entry) => {
          const task = await storage.task(entry.byTaskId!, BACKGROUND_CONTEXT);
          return task?.state.outcome?.result;
        }),
      );
    const workerStart = starts.find(
      (entry) => !coordinatorStarts.includes(entry),
    )!;
    expect(JSON.stringify(starts)).not.toContain(text);
    expect(await engine.attemptInput(workerStart.id)).toEqual({
      input: 0,
      payload: text,
    });
    const cancelled = await engine.cancel();
    await engine.close();

    storage = await openXeanStorage(path);
    engine = await Xean.open(storage, options);
    expect(await storedDecisions()).toEqual(coordinatorStarts.map(() => null));
    expect(await engine.inspect()).toEqual(cancelled);
    const validationsBeforeReplay = validated.length;
    expect(await engine.input({ zero: -0, text }, "initial")).toEqual(first);
    await expect(engine.input("changed", "initial")).rejects.toThrow(
      "Input key reused",
    );
    await expect(engine.input("new", "new")).rejects.toThrow(
      "Campaign does not accept input",
    );
    expect(validated).toHaveLength(validationsBeforeReplay);
    expect((await engine.inspect()).inputs).toEqual([first, unkeyed, late]);
    expect(
      await Promise.all(
        coordinatorStarts.map((entry) => engine.attemptInput(entry.id)),
      ),
    ).toEqual(seen);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true });
  }
});

test("campaign inspection and records exclude concurrent call admission together", async () => {
  const started = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  const scanning = Promise.withResolvers<void>();
  const releaseScan = Promise.withResolvers<void>();
  class HeldStorage extends MemoryStorage {
    override async scanEntries(
      ...args: Parameters<MemoryStorage["scanEntries"]>
    ) {
      scanning.resolve();
      await releaseScan.promise;
      return super.scanEntries(...args);
    }
  }
  const engine = await Xean.open(new HeldStorage(), {
    task: "consistent inspection",
    roles: [
      {
        name: "worker",
        async run(_input, execution) {
          started.resolve();
          await releaseWorker.promise;
          const call = await execution.recorder.begin({
            provider: "fixture",
            id: "fixture",
            api: "fixture",
          });
          await call.settle("response", null);
          return null;
        },
      },
    ],
    coordinator: {
      name: "coordinate",
      run(signal) {
        return {
          state: null,
          ...(signal.kind === "start"
            ? {
                dispatch: [{ id: "work", role: "worker", input: null }],
              }
            : {}),
        };
      },
    },
  });
  const running = engine.run();
  try {
    await started.promise;
    const inspecting = engine.inspectWithRecords();
    await scanning.promise;
    releaseWorker.resolve();
    await yieldToEvents();
    releaseScan.resolve();
    const before = await inspecting;
    expect(before.campaign.providerCalls).toBe(0);
    expect(
      before.records.filter((entry) => entry.kind === "xean.call.started"),
    ).toHaveLength(0);
    await running;
    const after = await engine.inspectWithRecords();
    expect(after.campaign.providerCalls).toBe(1);
    expect(
      after.records.filter((entry) => entry.kind === "xean.call.started"),
    ).toHaveLength(1);
  } finally {
    releaseWorker.resolve();
    releaseScan.resolve();
    await running;
    await engine.close();
  }
});

test("a concurrent worker publication refreshes completion before acceptance", async () => {
  const deciding = Promise.withResolvers<void>();
  const workerRelease = Promise.withResolvers<void>();
  const decisionRelease = Promise.withResolvers<void>();
  const accepted: JsonValue[] = [];
  const engine = await Xean.open(new MemoryStorage(), {
    task: { statement: "completion with concurrent publication" },
    roles: [
      {
        name: "worker",
        async run(input) {
          if (input === "late") await workerRelease.promise;
          return input;
        },
      },
    ],
    coordinator: {
      name: "coordinate",
      async run(signal, view) {
        if (signal.kind === "start")
          return {
            state: null,
            dispatch: ["early", "late"].map((id) => ({
              id,
              role: "worker",
              input: id,
            })),
          };
        const count = view.work.filter(
          (work) => work.status === "completed",
        ).length;
        if (count === 1) {
          deciding.resolve();
          await decisionRelease.promise;
        }
        return { state: null, completion: count };
      },
    },
    accept(candidate, view) {
      accepted.push(candidate);
      (view.task as { statement: string }).statement = "changed by acceptance";
      return (
        candidate ===
        view.work.filter((work) => work.status === "completed").length
      );
    },
  });
  try {
    const running = engine.run();
    await deciding.promise;
    workerRelease.resolve();
    while ((await engine.inspect()).work[1]!.status !== "completed")
      await yieldToEvents();
    decisionRelease.resolve();
    expect(await running).toMatchObject({
      task: { statement: "completion with concurrent publication" },
      status: "completed",
      result: 2,
      pendingSignals: 0,
    });
    expect(accepted).toEqual([2]);
    const starts = (await engine.records()).filter(
      (entry) => entry.kind === "xean.attempt.started",
    );
    const historical = await Promise.all(
      starts.map((entry) => engine.attemptInput(entry.id)),
    );
    expect(historical).toContainEqual(
      expect.objectContaining({
        view: expect.objectContaining({
          work: expect.arrayContaining([
            expect.objectContaining({
              id: "late",
              status: "active",
              publicationId: null,
            }),
          ]),
        }),
      }),
    );
  } finally {
    workerRelease.resolve();
    decisionRelease.resolve();
    await engine.close();
  }
});

test("input arriving during a completion decision is delivered before acceptance", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const accepted: JsonValue[] = [];
  const seen: JsonValue[] = [];
  const engine = await Xean.open(new MemoryStorage(), {
    task: "completion with concurrent input",
    roles: [],
    coordinator: {
      name: "coordinate",
      async run(signal, view) {
        seen.push({ signal, view });
        if (signal.kind === "start") {
          started.resolve();
          await release.promise;
          return { state: "earlier decision", completion: "old" };
        }
        expect(view.state).toBe("earlier decision");
        return { state: "input received", completion: signal.value };
      },
    },
    accept(candidate, view) {
      accepted.push(candidate);
      return candidate === view.inputs.at(-1)?.value;
    },
  });
  const running = engine.run();
  try {
    await started.promise;
    const receipt = await engine.input("new", "correction");
    release.resolve();
    const result = await running;
    expect(result).toMatchObject({
      status: "completed",
      result: "new",
      pendingSignals: 0,
      inputs: [receipt],
    });
    expect(accepted).toEqual(["new"]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ view: { inputs: [] } });
    expect(seen[1]).toMatchObject({
      signal: {
        id: receipt.id,
        kind: "input",
        key: "correction",
        value: "new",
      },
      view: { inputs: [receipt] },
    });
  } finally {
    release.resolve();
    await running;
    await engine.close();
  }
});
