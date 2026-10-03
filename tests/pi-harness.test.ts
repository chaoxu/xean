import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  defineTask,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";

test("Harness pause rolls back an unfinished admission and resumes it once", async () => {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let admissions = 0;
  let passes = 0;
  let executions = 0;
  const reports: unknown[] = [];
  const task = defineTask<
    null,
    { phase: "run"; attempt: number },
    null,
    object
  >({
    name: "admission",
    version: 1,
    initial: () => ({ phase: "run", attempt: 0 }),
    phases: {
      run: async (record, runtime) => {
        executions++;
        expect(record.state.checkpoint.attempt).toBe(1);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        );
      },
    },
    abort: async () => {},
  });
  registry.install({ name: "fixture", tasks: [task] });
  const harness = await Harness.open(
    storage,
    {
      registry,
      models: createModels(),
      onReport: (error) => reports.push(error),
      admitTasks: async (tx, candidates) => {
        passes++;
        const candidate = candidates[0];
        if (!candidate) return [];
        await tx.appendEntry(ROOT_CONVERSATION_ID, {
          kind: "admitted",
          data: null,
        });
        if (++admissions === 1) {
          entered.resolve();
          await release.promise;
        }
        return [{ id: candidate.id, checkpoint: { phase: "run", attempt: 1 } }];
      },
    },
    context,
  );
  try {
    const root = await harness.root(context);
    const id = await root.commit(
      (tx) =>
        tx.createTask(task, null, { ownership: { kind: "conversation" } }),
      context,
    );
    harness.resume();
    await entered.promise;
    harness.pause({ interrupt: true });
    release.resolve();
    await harness.waitForQuiescence(context);
    expect(executions).toBe(0);
    expect((await storage.task(id, context))!.state).toEqual({
      status: "pending",
      checkpoint: { phase: "run", attempt: 0 },
    });
    expect(
      (
        await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          10,
          undefined,
          context,
        )
      ).items,
    ).toHaveLength(0);
    harness.resume();
    await harness.waitForQuiescence(context);
    expect(executions).toBe(1);
    expect(
      (
        await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          10,
          undefined,
          context,
        )
      ).items,
    ).toMatchObject([{ kind: "admitted" }]);
    expect((await storage.task(id, context))!.state).toEqual({
      status: "terminal",
      outcome: { status: "completed", result: null },
    });
    const settledPasses = passes;
    await harness.commit(
      (tx) =>
        tx.doc(
          defineDoc({
            kind: "private-progress",
            scope: "session",
            version: 1,
            initial: () => ({ partial: "streaming" }),
          }),
        ),
      context,
    );
    await harness.waitForQuiescence(context);
    expect(passes).toBe(settledPasses);
    expect(reports).toEqual([]);
  } finally {
    release.resolve();
    await harness.close(context);
  }
});

test("Harness interruption rejects late publication while keeping accounting writable", async () => {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let rejected = false;
  let harness: Harness;
  const task = defineTask({
    name: "interruption",
    version: 1,
    initial: () => ({ phase: "run" as const }),
    phases: {
      run: async (_record, runtime) => {
        try {
          await runtime.commit(async (tx) => {
            entered.resolve();
            await release.promise;
            await tx.appendEntry(ROOT_CONVERSATION_ID, {
              kind: "result",
              data: null,
            });
            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            };
          }, context);
        } catch {
          rejected = true;
        }
        await harness.commit(
          (tx) =>
            tx.appendEntry(ROOT_CONVERSATION_ID, {
              kind: "settled",
              data: null,
            }),
          context,
        );
      },
    },
    abort: async () => {},
  });
  registry.install({ name: "fixture", tasks: [task] });
  harness = await Harness.open(
    storage,
    { registry, models: createModels() },
    context,
  );
  try {
    const root = await harness.root(context);
    const id = await root.commit(
      (tx) =>
        tx.createTask(task, null, { ownership: { kind: "conversation" } }),
      context,
    );
    harness.resume();
    await entered.promise;
    harness.pause({ interrupt: true });
    release.resolve();
    await harness.waitForQuiescence(context);
    expect(rejected).toBe(true);
    expect((await storage.task(id, context))!.state.status).toBe("running");
    expect(
      (
        await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          10,
          undefined,
          context,
        )
      ).items.map((entry) => entry.kind),
    ).toEqual(["settled"]);
  } finally {
    release.resolve();
    await harness.close(context);
  }
});

test("Harness quiescence waits for atomic runtime failure publication", async () => {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const task = defineTask({
    name: "fault",
    version: 1,
    initial: () => ({ phase: "run" as const }),
    phases: {
      run: async () => {
        throw new Error("runtime failure");
      },
    },
    abort: async () => {},
  });
  registry.install({ name: "fixture", tasks: [task] });
  const publications: string[][] = [];
  const harness = await Harness.open(
    storage,
    {
      registry,
      models: createModels(),
      onTaskFailure: async (tx, record, outcome) => {
        entered.resolve();
        await release.promise;
        const { memos: _memos, ...rest } = record;
        tx.setTask({ ...rest, state: { status: "terminal", outcome } });
        await tx.appendEntry(ROOT_CONVERSATION_ID, {
          kind: "failed",
          data: null,
          byTaskId: record.id,
        });
        return true;
      },
    },
    context,
  );
  try {
    const root = await harness.root(context);
    const id = await root.commit(
      (tx) =>
        tx.createTask(task, null, { ownership: { kind: "conversation" } }),
      context,
    );
    harness.subscribeCommits(({ changes }) => {
      publications.push(changes.map((change) => change.type));
    });
    harness.resume();
    await entered.promise;
    harness.pause({ interrupt: true });
    let quiescent = false;
    const waiting = harness.waitForQuiescence(context).then(() => {
      quiescent = true;
    });
    // Cross an event-loop turn while the failure hook holds the transaction.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(quiescent).toBe(false);
    expect((await storage.task(id, context))!.state.status).toBe("running");
    expect(
      (
        await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          10,
          undefined,
          context,
        )
      ).items,
    ).toHaveLength(0);
    release.resolve();
    await waiting;
    expect((await storage.task(id, context))!.state).toEqual({
      status: "terminal",
      outcome: { status: "faulted", error: { message: "runtime failure" } },
    });
    expect(
      (
        await storage.scanEntries(
          { conversationId: ROOT_CONVERSATION_ID },
          10,
          undefined,
          context,
        )
      ).items,
    ).toMatchObject([{ kind: "failed", byTaskId: id }]);
    expect(publications.at(-1)?.sort()).toEqual(["entry", "task"]);
  } finally {
    release.resolve();
    await harness.close(context);
  }
});
