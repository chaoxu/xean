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
} from "@earendil-works/pi-durable";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import { readView } from "../packages/core/src/history.ts";
import type { Execution, XeanOptions } from "../packages/core/src/types.ts";
import type { Context } from "@earendil-works/chord";

const latch = () => Promise.withResolvers<void>();

async function privateWork<S extends { phase: string }>(
  execution: Execution,
  extension: Extension & { tasks: readonly Task<null, S, null, object>[] },
  context: Context,
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
    });
    return conversation.id;
  }, context);
  return (await api.conversation(id, context))!;
}

for (const [attempts, failed] of [
  [1, false],
  [2, false],
  [2, true],
] as const)
  test(`${failed ? "failed" : "interrupted"} native private recovery preserves checkpoints, frozen input, and ${attempts} attempt allowance`, async () => {
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
              await runtime.commit(
                () => ({
                  status: "terminal",
                  outcome: { status: "completed", result: null },
                }),
                context,
              );
            },
          },
          async abort(_task, runtime, context) {
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "aborted" } }),
              context,
            );
          },
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
            await conversation.waitForIdle(context);
          } finally {
            execution.durable!.registry.uninstall(extension);
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

for (const stop of ["pause", "cancel"] as const) {
  test(`${stop} joins native descendants before returning`, async () => {
    const entered = latch();
    const release = latch();
    let aborted = 0;
    let published = false;
    const storage = new MemoryStorage();
    const extension = {
      name: "join-fixture",
      tasks: [
        defineTask<null, { phase: "run" }, null>({
          name: "fixture.child",
          version: 1,
          initial: () => ({ phase: "run" }),
          phases: {
            async run(_task, runtime, context) {
              entered.resolve();
              await awaitWithContext(release.promise, context);
              await runtime.commit(
                () => ({
                  status: "terminal",
                  outcome: { status: "completed", result: null },
                }),
                context,
              );
            },
          },
          async abort(_task, runtime, context) {
            aborted++;
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "aborted" } }),
              context,
            );
          },
        }),
      ],
    } satisfies Extension;
    const engine = await Xean.open(storage, {
      task: "join",
      limits: { attempts: 1 },
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
            } else await privateWork(execution, extension, context);
            // The kernel joins private work even if the role has its answer already.
            return "private result";
          },
        },
      ],
      coordinator: {
        name: "join coordinator",
        run(signal) {
          if (signal.kind === "completed") published = true;
          return {
            state: null,
            ...(signal.kind === "start"
              ? { dispatch: [{ id: "work", role: "worker", input: null }] }
              : {}),
          };
        },
      },
    });
    try {
      const running = engine.run();
      await entered.promise;
      expect((await engine.inspect()).work[0]!.result).toBeNull();
      const stopping = engine[stop]();
      if (stop !== "cancel") release.resolve();
      const result = await stopping;
      await running;
      expect(result.work[0]!.status).toBe(
        stop === "cancel" ? "cancelled" : "completed",
      );
      expect(aborted).toBe(stop === "cancel" ? 1 : 0);
      expect(published).toBe(false);
      const tasks = (
        await storage.scanTasks({}, 100, undefined, BACKGROUND_CONTEXT)
      ).items;
      expect(
        tasks
          .filter((task) => task.kind === "fixture.child")
          .every((task) => task.state.status === "terminal"),
      ).toBe(true);
    } finally {
      release.resolve();
      await engine.close();
    }
  });
}
