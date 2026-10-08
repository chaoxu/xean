import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  createRegistry,
  defineExtension,
  defineTask,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import { open } from "../src/host.ts";
import { scanTasks } from "../src/workflow.ts";
import { readView } from "../src/math/state.ts";
import {
  context,
  fixture,
  task,
  settings,
  noteResult,
  recoveryRoles,
} from "./fixture.ts";

test("Coordinator children settle before its worker starts, including after reopening", async () => {
  const directory = await temporaryDirectory("coordinator-settlement-");
  const path = join(directory, "campaign.sqlite");
  const release = Promise.withResolvers<void>();
  let entered = Promise.withResolvers<void>();
  const completing = Promise.withResolvers<void>();
  const trace: string[] = [];
  const Child = defineTask<null, { phase: "run" }, null>({
    name: "test.coordinator-child",
    version: 1,
    initial: () => ({ phase: "run" }),
    async abort(_task, runtime, ctx) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
    phases: {
      async run(_task, runtime, ctx) {
        entered.resolve();
        await awaitWithContext(release.promise, ctx);
        trace.push("child");
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          ctx,
        );
      },
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "test.coordinator-settlement", tasks: [Child] }),
  );
  const options: Parameters<typeof open>[1] = {
    registry,
    roles: () => ({
      coordinator: async (input, runtime, ctx) => {
        trace.push("coordinator");
        if (input.notes.length) return { work: null };
        await runtime.commit(async (tx) => {
          await tx.createTask(Child, null, {
            ownership: { kind: "task", taskId: runtime.taskId },
          });
        }, ctx);
        return { work: { kind: "explorer", guidance: "Prove the claim" } };
      },
      explorer: async () => {
        trace.push("explorer");
        return { kind: "notes", ...noteResult };
      },
    }),
  };
  let owner = await open(path, { ...options, create: { task, settings } });
  const detach = owner.harness.subscribeCommits(({ changes }) => {
    if (
      changes.some(
        (change) =>
          change.type === "task" &&
          change.value.kind === "research.coordinator" &&
          change.value.state.status === "completing",
      )
    )
      completing.resolve();
  });
  try {
    owner.harness.resume();
    await completing.promise;
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(trace).toEqual(["coordinator"]);
    await owner.close();
    detach();
    entered = Promise.withResolvers<void>();
    owner = await open(path, options);
    owner.harness.resume();
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(trace).toEqual(["coordinator"]);
    release.resolve();
    await owner.root.waitForIdle(context);
    expect(trace).toEqual(["coordinator", "child", "explorer", "coordinator"]);
  } finally {
    release.resolve();
    detach();
    await owner.close();
  }
});

test("closing at private submission and worker publication reuses each committed native result", async () => {
  const directory = await temporaryDirectory("research-recovery-");
  const path = join(directory, "campaign.sqlite");
  const provider = fixture((role, input) =>
    role === "explorer"
      ? noteResult
      : {
          work: input.notes.length
            ? null
            : { kind: "explorer", guidance: "prove" },
        },
  );
  let owner = await open(path, {
    create: { task, settings },
    models: provider.models,
    roles: recoveryRoles,
  });
  let closing: Promise<void> | undefined;
  const unsubscribe = owner.harness.subscribeCommits((publication) => {
    if (
      publication.changes.some(
        (change) => change.type === "entry" && ToolResultEntry.is(change.value),
      )
    )
      queueMicrotask(() => {
        closing ??= owner.close();
      });
  });
  try {
    await owner.root.waitForIdle(context).catch(() => {});
    expect(closing).toBeDefined();
    await closing;
    unsubscribe();
    owner = await open(path, {
      models: provider.models,
      roles: recoveryRoles,
    });
    let closingWorker: Promise<void> | undefined;
    const detach = owner.harness.subscribeCommits((publication) => {
      if (
        publication.changes.some(
          (change) =>
            change.type === "task" &&
            change.value.kind === "research.worker" &&
            change.value.state.outcome?.status === "completed",
        )
      )
        queueMicrotask(() => {
          closingWorker ??= owner.close();
        });
    });
    await owner.root.waitForIdle(context).catch(() => {});
    expect(closingWorker).toBeDefined();
    await closingWorker;
    detach();
    owner = await open(path, {
      models: provider.models,
      roles: recoveryRoles,
    });
    await owner.root.waitForIdle(context);
    expect(provider.calls.map(({ role }) => role)).toEqual([
      "coordinator",
      "explorer",
      "coordinator",
    ]);
    expect(
      new Set(
        provider.calls
          .filter(({ role }) => role === "coordinator")
          .map(({ session }) => session),
      ).size,
    ).toBe(2);
    expect(
      (await owner.root.commit((tx) => readView(tx, owner.root.id), context))
        .notes,
    ).toHaveLength(1);
    await owner.close();
    owner = await open(path, {
      models: provider.models,
      roles: recoveryRoles,
    });
    await owner.root.waitForIdle(context);
    expect(provider.calls).toHaveLength(3);
  } finally {
    unsubscribe();
    await owner.close();
  }
});

test("SIGKILL recovers the product's native SQLite work without repeating its original Coordinator", async () => {
  const directory = await temporaryDirectory("research-kill-");
  const path = join(directory, "campaign.sqlite");
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "crash.ts"), path],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("ready");
    child.kill("SIGKILL");
    await child.exited;
    const provider = fixture((role) =>
      role === "explorer" ? noteResult : { work: null },
    );
    const owner = await open(path, {
      models: provider.models,
      roles: recoveryRoles,
    });
    try {
      await owner.root.waitForIdle(context);
      expect(provider.calls.map(({ role }) => role)).toEqual([
        "explorer",
        "coordinator",
      ]);
      const tasks = await owner.root.commit(
        (tx) => scanTasks(tx, owner.root.id),
        context,
      );
      expect(
        tasks.filter((task) => task.kind === "research.worker"),
      ).toHaveLength(1);
      expect(
        tasks.filter((task) => task.kind === "research.coordinator"),
      ).toHaveLength(2);
      expect(
        tasks.every((task) => task.state.outcome?.status === "completed"),
      ).toBe(true);
    } finally {
      await owner.close();
    }
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
