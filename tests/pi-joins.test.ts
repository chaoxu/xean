import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type Task,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function observed<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native join did not wake")),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function untilReleased(promise: Promise<void>, signal: AbortSignal) {
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
  signal.throwIfAborted();
}

async function fixture(
  options: {
    failed?: boolean;
    delayJoin?: boolean;
    grandchild?: boolean;
    durable?: boolean;
    empty?: boolean;
  } = {},
) {
  const released = Array.from({ length: 3 }, () =>
    Promise.withResolvers<void>(),
  );
  const started = Array.from({ length: 3 }, () =>
    Promise.withResolvers<void>(),
  );
  const allowJoin = Promise.withResolvers<void>(),
    awoke = Promise.withResolvers<void>(),
    completing = Promise.withResolvers<void>();
  const aborted: number[] = [];
  let wakeCount = 0,
    admissions = 0,
    children: TaskId<string>[] = [];
  let grandchild: TaskId<string> | undefined;
  const Gate: Task<
    { slot: number; grandchild?: boolean },
    { phase: "run" } | { phase: "finish" },
    string,
    {}
  > = defineTask<
    { slot: number; grandchild?: boolean },
    { phase: "run" } | { phase: "finish" },
    string,
    {}
  >({
    name: "join.gate",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, ctx) {
        started[task.input.slot]!.resolve();
        await untilReleased(released[task.input.slot]!.promise, runtime.signal);
        await runtime.commit(async (tx) => {
          if (task.input.grandchild) {
            grandchild = await tx.createTask(
              Gate,
              { slot: 2 },
              {
                conversationId: task.conversationId,
                ownership: { kind: "task", taskId: task.id },
              },
            );
            return { status: "running", checkpoint: { phase: "finish" } };
          }
          return options.failed && task.input.slot === 0
            ? {
                status: "terminal",
                outcome: {
                  status: "failed",
                  error: { message: "Expected child failure" },
                },
              }
            : {
                status: "terminal",
                outcome: {
                  status: "completed",
                  result: String(task.input.slot),
                },
              };
        }, ctx);
      },
      async finish(task, runtime, ctx) {
        await untilReleased(started[2]!.promise, runtime.signal);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: String(task.input.slot) },
          }),
          ctx,
        );
        completing.resolve();
      },
    },
    async abort(task, runtime, ctx) {
      aborted.push(task.input.slot);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  type State = (
    | { phase: "start" }
    | { phase: "join" }
    | { phase: "seen" }
    | { phase: "done" }
  ) & { children: number[] };
  const Parent = defineTask<{}, State, string>({
    name: "join.parent",
    version: 1,
    initial: () => ({ phase: "start", children: [] }),
    phases: {
      async start(task, runtime, ctx) {
        admissions++;
        await runtime.commit(async (tx) => {
          children = [];
          for (let slot = 0; slot < (options.empty ? 0 : 2); slot++)
            children.push(
              await tx.createTask(
                Gate,
                { slot, grandchild: !!options.grandchild && slot === 0 },
                {
                  conversationId: task.conversationId,
                  ownership: { kind: "task", taskId: task.id },
                },
              ),
            );
          return { status: "running", checkpoint: { phase: "join", children } };
        }, ctx);
      },
      async join(task, runtime, ctx) {
        if (options.delayJoin)
          await untilReleased(allowJoin.promise, runtime.signal);
        await runtime.commit(
          () => ({
            status: "waiting",
            on: task.state.checkpoint.children as TaskId[],
            policy: "anySettled",
            checkpoint: {
              phase: "seen",
              children: task.state.checkpoint.children,
            },
          }),
          ctx,
        );
      },
      async seen(task, runtime, ctx) {
        wakeCount++;
        awoke.resolve();
        await runtime.commit(
          () => ({
            status: "waiting",
            on: task.state.checkpoint.children as TaskId[],
            policy: "allSettled",
            checkpoint: {
              phase: "done",
              children: task.state.checkpoint.children,
            },
          }),
          ctx,
        );
      },
      async done(_task, runtime, ctx) {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: "joined" },
          }),
          ctx,
        );
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  const directory = options.durable
    ? await mkdtemp(join(tmpdir(), "xean-native-join-"))
    : undefined;
  const open = async () => {
    const registry = createRegistry();
    registry.install(defineExtension({ name: "join", tasks: [Gate, Parent] }));
    return Harness.open(
      directory
        ? await openNodeJsonlStorage(directory, context)
        : new MemoryStorage(),
      { registry, models: createModels() },
      context,
    );
  };
  let harness = await open();
  cleanup.push(async () => {
    await harness.close(context);
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const root = await harness.root(context);
  const parent = await root.commit(
    (tx) =>
      tx.createTask(
        Parent,
        {},
        { conversationId: root.id, ownership: { kind: "conversation" } },
      ),
    context,
  );
  harness.resume();
  return {
    parent,
    started,
    released,
    allowJoin,
    awoke,
    completing,
    aborted,
    get harness() {
      return harness;
    },
    get children() {
      return children;
    },
    get grandchild() {
      return grandchild;
    },
    get wakeCount() {
      return wakeCount;
    },
    get admissions() {
      return admissions;
    },
    releaseAll() {
      allowJoin.resolve();
      for (const release of released) release.resolve();
    },
    async reopen() {
      await harness.close(context);
      harness = await open();
    },
  };
}

test.each(["completed", "failed", "aborted"] as const)(
  "anySettled wakes on %s without cancelling a sibling",
  async (outcome) => {
    const run = await fixture({ failed: outcome === "failed" });
    try {
      await observed(
        Promise.all(run.started.slice(0, 2).map((gate) => gate.promise)),
      );
      if (outcome === "aborted")
        await run.harness.abortTask(run.children[0]!, context);
      else run.released[0]!.resolve();
      await observed(run.awoke.promise);
      expect(
        (await run.harness.getTask(run.children[0]!, context))!.state.outcome
          ?.status,
      ).toBe(outcome);
      expect(
        (await run.harness.getTask(run.children[1]!, context))!.state.status,
      ).not.toBe("terminal");
      expect(run.aborted).not.toContain(1);
      expect(run.wakeCount).toBe(1);
    } finally {
      run.releaseAll();
    }
    expect(
      (await observed(run.harness.waitForTask(run.parent, context))).state
        .outcome.status,
    ).toBe("completed");
  },
);

test("anySettled sees a target already terminal when the wait is committed", async () => {
  const run = await fixture({ delayJoin: true });
  try {
    await observed(
      Promise.all(run.started.slice(0, 2).map((gate) => gate.promise)),
    );
    run.released[0]!.resolve();
    await observed(run.harness.waitForTask(run.children[0]!, context));
    expect(run.wakeCount).toBe(0);
    run.allowJoin.resolve();
    await observed(run.awoke.promise);
    expect(
      (await run.harness.getTask(run.children[1]!, context))!.state.status,
    ).not.toBe("terminal");
  } finally {
    run.releaseAll();
  }
  await observed(run.harness.waitForTask(run.parent, context));
});

test("anySettled does not treat completing as terminal while an owned grandchild is held", async () => {
  const run = await fixture({ grandchild: true });
  try {
    await observed(
      Promise.all(run.started.slice(0, 2).map((gate) => gate.promise)),
    );
    run.released[0]!.resolve();
    await observed(run.started[2]!.promise);
    await observed(run.completing.promise);
    expect(
      (await run.harness.getTask(run.children[0]!, context))!.state,
    ).toMatchObject({ status: "completing", outcome: { status: "completed" } });
    expect(
      (await run.harness.getTask(run.grandchild!, context))!.state.status,
    ).toBe("running");
    await Bun.sleep(10);
    expect(run.wakeCount).toBe(0);
    run.released[2]!.resolve();
    await observed(run.awoke.promise);
    expect(
      (await run.harness.getTask(run.children[1]!, context))!.state.status,
    ).not.toBe("terminal");
  } finally {
    run.releaseAll();
  }
  await observed(run.harness.waitForTask(run.parent, context));
});

test("anySettled wait survives close and JSONL reopen with the same children", async () => {
  const run = await fixture({ durable: true });
  try {
    await observed(
      Promise.all(run.started.slice(0, 2).map((gate) => gate.promise)),
    );
    const before = await run.harness.getTask(run.parent, context);
    expect(before!.state).toMatchObject({
      status: "waiting",
      policy: "anySettled",
    });
    const ids = [...run.children];
    await run.reopen();
    expect((await run.harness.getTask(run.parent, context))!.state).toEqual(
      before!.state,
    );
    expect(run.admissions).toBe(1);
    run.harness.resume();
    run.released[0]!.resolve();
    await observed(run.awoke.promise);
    expect(run.children).toEqual(ids);
    expect(run.admissions).toBe(1);
    expect(
      (await run.harness.getTask(ids[1]!, context))!.state.status,
    ).not.toBe("terminal");
    expect(run.aborted).toEqual([]);
  } finally {
    run.releaseAll();
  }
  await observed(run.harness.waitForTask(run.parent, context));
});

test("anySettled with an empty target set continues immediately", async () => {
  const run = await fixture({ empty: true });
  await observed(run.harness.waitForTask(run.parent, context));
  expect(run.wakeCount).toBe(1);
  expect(run.children).toEqual([]);
});
