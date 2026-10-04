import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
} from "@earendil-works/chord/context";
import {
  configure,
  defineTask,
  ROOT_CONVERSATION_ID,
  MemoryStorage,
  type EntryId,
  type Extension,
  type Task,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import { readView } from "../packages/core/src/history.ts";
import type { Execution, XeanOptions } from "../packages/core/src/types.ts";
import type { Context } from "@earendil-works/chord";

const latch = () => Promise.withResolvers<void>();
const completed = {
  status: "terminal",
  outcome: { status: "completed", result: null },
} as const;

async function abortTask<S extends { phase: string }>(
  _task: unknown,
  runtime: TaskRuntime<null, S, null, object>,
  context: Context,
) {
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  );
}

async function privateWork<S extends { phase: string }>(
  execution: Execution,
  extension: Extension & { tasks: readonly Task<null, S, null, object>[] },
  context: Context,
  background = false,
) {
  const api = execution.durable!;
  api.registry.install(extension);
  const id = await api.commit(async (tx) => {
    const prior = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1))
      .items[0];
    if (prior) return prior.id;
    const conversation = await tx.createConversation({
      ownership: { kind: "task", taskId: api.taskId },
    });
    await configure(tx, conversation.id, { extensions: [extension] });
    await tx.createTask(extension.tasks![0]!, null, {
      conversationId: conversation.id,
      ownership: { kind: "conversation" },
      background,
    });
    return conversation.id;
  }, context);
  return (await api.conversation(id, context))!;
}

test("native publication rechecks late siblings and retains the owning execution", async () => {
  const entered = latch();
  const spawn = latch();
  const siblingReady = latch();
  const firstDone = latch();
  const release = latch();
  let owner!: Execution;
  let publications = 0;
  const seen: unknown[] = [];
  const storage = new MemoryStorage();
  const commit = storage.commit.bind(storage);
  storage.commit = async (writes, context) => {
    if (
      writes.some(
        (write) =>
          write.type === "task" &&
          write.value.kind === "xean.worker" &&
          write.value.state.status === "terminal",
      )
    ) {
      expect(
        writes.some(
          (write) =>
            write.type === "task" &&
            write.value.kind === "xean.coordinator" &&
            (write.value.input as { kind: string }).kind === "completed",
        ),
      ).toBe(true);
      expect(
        writes.some(
          (write) =>
            write.type === "entry" &&
            write.value.kind === "xean.attempt.completed",
        ),
      ).toBe(true);
      publications++;
    }
    return commit(writes, context);
  };
  const sibling = defineTask<null, { phase: "run" }, null>({
    name: "fixture.late-sibling",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(_task, runtime, context) {
        // The role already returned, but its native-owned work can still account.
        const call = await owner.recorder.begin({
          provider: "fixture",
          api: "fixture",
          id: "child",
        });
        await call.recordRequest(null);
        siblingReady.resolve();
        await awaitWithContext(release.promise, context);
        await call.settle({ done: true }, null);
        await runtime.commit(() => completed, context);
      },
    },
    abort: abortTask,
  });
  const first = defineTask<null, { phase: "run" }, null>({
    name: "fixture.first-child",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(_task, runtime, context) {
        entered.resolve();
        await awaitWithContext(spawn.promise, context);
        await runtime.commit(async (tx) => {
          await tx.createTask(sibling, null, {
            ownership: { kind: "task", taskId: owner.durable!.taskId },
          });
        }, context);
        await awaitWithContext(siblingReady.promise, context);
        await runtime.commit(() => completed, context);
        firstDone.resolve();
      },
    },
    abort: abortTask,
  });
  const engine = await Xean.open(storage, {
    task: "late ownership",
    roles: [
      {
        name: "worker",
        async run(_input, execution, context) {
          owner = execution;
          execution.durable!.registry.install({
            name: "late-ownership",
            tasks: [first, sibling],
          });
          await execution.durable!.commit(async (tx) => {
            await tx.createTask(first, null, {
              ownership: { kind: "task", taskId: execution.durable!.taskId },
            });
          }, context);
          return "joined result";
        },
      },
    ],
    coordinator: {
      name: "coordinator",
      run(signal, view) {
        if (signal.kind === "completed") seen.push(view.work[0]);
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
  try {
    const running = engine.run();
    await entered.promise;
    await yieldToEvents();
    spawn.resolve();
    await firstDone.promise;
    const before = await engine.inspect();
    expect(before.work[0]).toMatchObject({
      status: "active",
      result: null,
      publicationId: null,
    });
    expect(before.pendingSignals).toBe(0);
    expect(seen).toEqual([]);
    release.resolve();
    expect((await running).work[0]).toMatchObject({
      status: "completed",
      result: "joined result",
    });
    expect(seen).toEqual([
      expect.objectContaining({ status: "completed", result: "joined result" }),
    ]);
    expect(publications).toBe(1);
  } finally {
    spawn.resolve();
    release.resolve();
    await engine.close();
  }
});

for (const [attempts, failed, returned] of [
  [1, false, false],
  [2, false, false],
  [2, true, false],
  [2, false, true],
] as const)
  test(`${failed ? "failed" : "interrupted"} ${returned ? "returned" : "waiting"} native private recovery preserves checkpoints, frozen input, and ${attempts} attempt allowance`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "xean-durable-"));
    const path = join(directory, "campaign.sqlite");
    const entered = latch();
    const register = latch();
    const cancelled = latch();
    const cleanup = latch();
    let recovering = false;
    let preparations = 0;
    let finishes = 0;
    const views: unknown[] = [];
    const signals: string[] = [];
    const extension = {
      name: "private-fixture",
      tasks: [
        defineTask<null, { phase: "prepare" | "finish" }, null>({
          name: "fixture.private",
          version: 1,
          initial: () => ({ phase: "prepare" }),
          phases: {
            async prepare(_task, runtime, context) {
              preparations++;
              await runtime.commit(
                () => ({ status: "running", checkpoint: { phase: "finish" } }),
                context,
              );
            },
            async finish(_task, runtime, context) {
              if (!recovering) {
                entered.resolve();
                try {
                  await awaitWithContext(latch().promise, context);
                } finally {
                  if (failed) {
                    cancelled.resolve();
                    await cleanup.promise;
                  }
                }
              }
              finishes++;
              await runtime.commit(() => completed, context);
            },
          },
          abort: abortTask,
        }),
      ],
    } satisfies Extension;
    const options: XeanOptions = {
      task: "frozen",
      limits: { attempts },
      roles: [
        {
          name: "resolve input",
          async run(input, execution, context) {
            const view = await execution.durable!.commit(
              (tx) => readView(tx, input as EntryId),
              context,
            );
            return view.inputs;
          },
        },
      ],
      coordinator: {
        name: "private coordinator",
        async run(signal, view, execution, context) {
          signals.push(signal.kind);
          const state = Array.isArray(view.state) ? view.state : [];
          if (signal.kind !== "start")
            return { state: [...state, signal.kind] };
          views.push(view.inputs);
          if (recovering) await register.promise;
          const conversation = await privateWork(execution, extension, context);
          try {
            if (failed && !recovering) {
              await awaitWithContext(entered.promise, context);
              throw new Error("Role failed with busy private work");
            }
            if (!returned) await conversation.waitForIdle(context);
          } finally {
            if (!returned) execution.durable!.registry.uninstall(extension);
          }
          return {
            state: [...state, "start"],
            dispatch: [
              {
                id: "original input",
                role: "resolve input",
                input: execution.inputId!,
              },
            ],
          };
        },
      },
    };
    let engine = await Xean.open(await openXeanStorage(path), options);
    try {
      const first = engine.run();
      await (failed ? cancelled : entered).promise;
      const late = await engine.input("arrived after the frozen prompt");
      expect((await engine.inspect()).state).toBeNull();
      expect(
        (await engine.records()).filter(
          (entry) => entry.kind === "xean.attempt.failed",
        ),
      ).toHaveLength(0);
      let closed = false;
      const closing = engine.close().then(() => {
        closed = true;
      });
      if (failed) {
        await yieldToEvents();
        expect(closed).toBe(false);
        cleanup.resolve();
      }
      await closing;
      await first;
      recovering = true;
      engine = await Xean.open(await openXeanStorage(path), options);
      expect(
        (await engine.records()).filter(
          (entry) => entry.kind === "xean.attempt.failed",
        ),
      ).toHaveLength(0);
      const second = engine.run();
      if (attempts === 1) {
        expect(await second).toMatchObject({
          status: "blocked",
          state: null,
          pendingSignals: 2,
        });
        expect(views).toEqual([[]]);
        expect(signals).toEqual(["start"]);
        expect(finishes).toBe(0);
        return;
      }
      while (views.length < 2)
        await new Promise((resolve) => setTimeout(resolve, 1));
      expect(finishes).toBe(0);
      expect(signals).toEqual(["start", "start"]);
      register.resolve();
      const result = await second;
      expect(result.state).toEqual(["start", "input", "completed"]);
      expect(signals).toEqual(["start", "start", "input", "completed"]);
      expect(result.work).toMatchObject([{ status: "completed", result: [] }]);
      expect(result.work[0]!.input as number).toBeGreaterThan(late.id);
      expect(result.pendingSignals).toBe(0);
      expect(views).toEqual([[], []]);
      expect(preparations).toBe(1);
      expect(finishes).toBe(failed ? 0 : 1);
      expect(
        (await engine.records()).filter(
          (entry) => entry.kind === "xean.attempt.interrupted",
        ),
      ).toHaveLength(1);
    } finally {
      register.resolve();
      cleanup.resolve();
      await engine.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

for (const [stop, background] of [
  ["pause", false],
  ["cancel", false],
  ["cancel", true],
  ["complete", true],
  ["complete-close", true],
] as const)
  test(`campaign ${stop} settles native ${background ? "background work" : "descendants"}`, async () => {
    const entered = latch();
    const release = latch();
    const unwinding = latch();
    const finishCleanup = latch();
    let aborted = 0;
    let published = false;
    const storage = new MemoryStorage();
    const extension = {
      name: "lifecycle-fixture",
      tasks: [
        defineTask<null, { phase: "run" }, null>({
          name: "fixture.child",
          version: 1,
          initial: () => ({ phase: "run" }),
          phases: {
            async run(_task, runtime, context) {
              entered.resolve();
              try {
                await awaitWithContext(release.promise, context);
              } finally {
                if (stop === "complete-close") {
                  unwinding.resolve();
                  await finishCleanup.promise;
                }
              }
              await runtime.commit(() => completed, context);
            },
          },
          async abort(task, runtime, context) {
            aborted++;
            await abortTask(task, runtime, context);
          },
        }),
      ],
    } satisfies Extension;
    const engine = await Xean.open(storage, {
      task: "native lifecycle",
      roles: [
        {
          name: "worker",
          async run(_input, execution, context) {
            if (stop === "pause") {
              const api = execution.durable!;
              api.registry.install(extension);
              await api.commit(
                (tx) =>
                  tx.createTask(extension.tasks[0]!, null, {
                    conversationId: ROOT_CONVERSATION_ID,
                    ownership: { kind: "task", taskId: api.taskId },
                  }),
                context,
              );
            } else await privateWork(execution, extension, context, background);
            if (background) {
              await entered.promise;
              if (stop === "cancel")
                await awaitWithContext(release.promise, context);
            }
            // Ordinary descendants must finish even after their role returns.
            return "private result";
          },
        },
      ],
      coordinator: {
        name: "coordinator",
        run(signal) {
          if (signal.kind === "completed") published = true;
          return signal.kind === "start"
            ? {
                state: null,
                dispatch: [{ id: "work", role: "worker", input: null }],
              }
            : {
                state: null,
                ...(stop === "complete" || stop === "complete-close"
                  ? { completion: "accepted" }
                  : {}),
              };
        },
      },
      accept: (value) => value === "accepted",
    });
    try {
      const running = engine.run();
      await entered.promise;
      if (!background)
        expect((await engine.inspect()).work[0]!.result).toBeNull();
      if (stop === "complete-close") {
        await unwinding.promise;
        expect(await engine.inspect()).toMatchObject({
          status: "completed",
          result: "accepted",
        });
        const closing = engine.close();
        finishCleanup.resolve();
        await closing;
      }
      const stopping =
        stop === "pause" || stop === "cancel" ? engine[stop]() : running;
      if (stop === "pause") release.resolve();
      const result = await stopping;
      await running;
      expect(result.status).toBe(
        stop === "pause"
          ? "paused"
          : stop === "cancel"
            ? "cancelled"
            : "completed",
      );
      expect(result.work[0]!.status).toBe(
        stop === "cancel" ? "cancelled" : "completed",
      );
      expect(result.result).toBe(
        stop.startsWith("complete") ? "accepted" : null,
      );
      expect(published).toBe(stop.startsWith("complete"));
      expect(aborted).toBe(
        stop === "pause" || stop === "complete-close" ? 0 : 1,
      );
      if (stop !== "complete-close") {
        const tasks = (
          await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)
        ).items;
        expect(
          tasks.find((task) => task.kind === "fixture.child")?.state.status,
        ).toBe("terminal");
      }
    } finally {
      release.resolve();
      finishCleanup.resolve();
      await engine.close();
    }
  });
