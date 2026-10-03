import { expect, spyOn, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openXeanStorage } from "xean";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  createSession,
  defineDoc,
  defineTask,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  StorageRejected,
} from "@earendil-works/pi-durable";
import {
  Store,
  campaignAddress,
  initialAttempt,
} from "../packages/core/src/store.ts";
import {
  campaignVersion,
  UninitializedCampaignError,
  type CampaignState,
} from "../packages/core/src/types.ts";

const initial: CampaignState = {
  version: campaignVersion,
  task: "prepared changes",
  coordinator: "fixture",
  status: "running",
  state: { count: 1 },
  limits: { concurrency: 1, attempts: 1 },
  providerCalls: 0,
  result: null,
  error: null,
};

test("Store observes native completion during recovery refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-store-recovery-"));
  const path = join(directory, "campaign.sqlite");
  let storage = await openXeanStorage(path);
  const registry = createRegistry();
  registry.install({
    name: "fixture",
    tasks: ["xean.worker", "xean.coordinator"].map((name) =>
      defineTask({
        name,
        version: 1,
        initial: initialAttempt,
        phases: { run: async () => {} },
        abort: async () => {},
      }),
    ),
  });
  const runtime = { models: createModels(), registry };
  let store = await Store.open(storage, initial, runtime);
  store.harness.pause();
  try {
    const [workerId, signalId, laterWorkerId] = await store.mutate(
      async (tx) =>
        [
          await tx.newTask("xean.worker", {
            id: "work",
            role: "fixture",
            input: null,
          }),
          await tx.newTask("xean.coordinator", { kind: "input", value: null }),
          await tx.newTask("xean.worker", {
            id: "later-work",
            role: "fixture",
            input: null,
          }),
        ] as const,
    );
    await store.close();
    storage = await openXeanStorage(path);
    const worker = (await storage.task(workerId, context))!;
    const signal = (await storage.task(signalId, context))!;
    await storage.commit(
      [
        {
          type: "task",
          value: {
            ...worker,
            state: { status: "running", checkpoint: initialAttempt() },
          },
        },
        {
          type: "task",
          value: {
            ...signal,
            memos: undefined,
            state: {
              status: "completing",
              checkpoint: initialAttempt(),
              outcome: {
                status: "failed",
                error: { message: "Exhausted before crash" },
              },
            },
          },
        },
      ],
      context,
    );
    const read = storage.task.bind(storage);
    storage.task = async (id, ctx) => {
      const value = await read(id, ctx);
      if (id === workerId)
        for (let turn = 0; turn < 5; turn++) await setImmediate();
      return value;
    };
    store = await Store.open(storage, undefined, runtime);
    expect(await store.mutate((tx) => tx.tasks.map(({ id }) => id))).toEqual([
      workerId,
      signalId,
      laterWorkerId,
    ]);
    expect((await read(signalId, context))?.state.status).toBe("terminal");
    expect(
      await store.mutate(
        (tx) => tx.tasks.find((task) => task.id === signalId)?.state.status,
      ),
    ).toBe("terminal");
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Store rejects foreign conversations and session documents without a root", async () => {
  const foreign = defineDoc({
    kind: "foreign",
    scope: "session",
    version: 1,
    initial: () => ({ retained: true }),
  });
  for (const kind of ["conversation", "document"]) {
    const storage = new MemoryStorage();
    const session = createSession(storage);
    try {
      await expect(Store.open(storage)).rejects.toBeInstanceOf(
        UninitializedCampaignError,
      );
      await session.commit(async (tx) => {
        if (kind === "conversation")
          await tx.createConversation({ ownership: { kind: "ownerless" } });
        else await tx.doc(foreign);
      }, context);
      const commit = spyOn(storage, "commit");
      await expect(Store.open(storage)).rejects.toThrow("non-Xean session");
      expect(commit).not.toHaveBeenCalled();
      commit.mockRestore();
    } finally {
      await session.close(context);
    }
  }
});

test("Store rejects invalid startup before recovery and closes failed native initialization", async () => {
  for (const failure of ["validation", "initialization"]) {
    const storage = new MemoryStorage();
    const commit = spyOn(storage, "commit");
    const close = spyOn(storage, "close");
    const fail = () => {
      throw new Error(failure);
    };
    try {
      await expect(
        Store.open(
          storage,
          initial,
          {
            models: createModels(),
            registry: createRegistry(),
            conversationCreated:
              failure === "initialization" ? fail : undefined,
          },
          failure === "validation" ? fail : undefined,
        ),
      ).rejects.toThrow(failure);
      expect(commit).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(failure === "initialization" ? 1 : 0);
    } finally {
      commit.mockRestore();
      close.mockRestore();
      await storage.close(context);
    }
  }
});

test("Store snapshots entries and keeps rejected commits separate from uncertain commits", async () => {
  const storage = new MemoryStorage();
  const registry = createRegistry();
  registry.install({
    name: "fixture",
    tasks: [
      defineTask({
        name: "xean.worker",
        version: 1,
        initial: initialAttempt,
        phases: { run: async () => {} },
        abort: async () => {},
      }),
    ],
  });
  const commit = spyOn(storage, "commit");
  const store = await Store.open(storage, initial, {
    models: createModels(),
    registry,
  });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(commit.mock.calls[0]![0]).toEqual(
    expect.arrayContaining([
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      expect.objectContaining({
        type: "document.create",
        record: expect.objectContaining({ kind: campaignAddress.kind }),
      }),
    ]),
  );
  commit.mockRestore();
  const address = await storage.findDocument(
    campaignAddress,
    "current",
    context,
  );
  const persisted = async () =>
    (await storage.document(address!.id, "current", context))!.value.state;
  try {
    const taskId = await store.mutate(async (tx) => {
      const taskId = await tx.newTask("xean.worker", {
        id: "committed",
        role: "fixture",
        input: null,
      });
      const data = { text: "original" };
      const entry = tx.entry("snapshot", data, taskId);
      data.text = "changed while minting ID";
      await entry;
      return taskId;
    });
    expect((await store.mutate((tx) => tx.entries()))[0]).toMatchObject({
      byTaskId: taskId,
      data: { text: "original" },
    });
    expect(await store.mutate((tx) => tx.tasks.map(({ id }) => id))).toEqual([
      taskId,
    ]);

    await expect(
      store.mutate((tx) => {
        tx.state.state = { count: 99 };
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    expect(store.failure).toBeUndefined();
    expect(await persisted()).toEqual({ count: 1 });
    for (const failure of [
      new StorageRejected("nothing committed"),
      new Error("commit outcome is unknown"),
    ]) {
      const rejected = spyOn(storage, "commit").mockImplementation(async () => {
        throw failure;
      });
      try {
        await expect(
          store.mutate(async (tx) => {
            tx.state.state = { count: 99 };
            await tx.newTask("xean.worker", {
              id: "rejected",
              role: "fixture",
              input: null,
            });
            await tx.entry("rejected", null);
          }),
        ).rejects.toThrow(failure.message);
      } finally {
        rejected.mockRestore();
      }
      expect(await persisted()).toEqual({ count: 1 });
      expect(
        (await storage.scanTasks({}, 10, undefined, context)).items.map(
          ({ id }) => id,
        ),
      ).toEqual([taskId]);
      if (failure instanceof StorageRejected) {
        expect(store.failure).toBeUndefined();
        expect(
          await store.mutate(
            (tx) => (tx.state.state as { count: number }).count,
          ),
        ).toBe(1);
        expect(await store.mutate((tx) => tx.entries())).toHaveLength(1);
      } else {
        expect(store.failure).toBe(failure);
        await expect(store.mutate(() => {})).rejects.toThrow();
      }
    }
  } finally {
    await store.close();
  }
});
