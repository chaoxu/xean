import { temporaryDirectory } from "./directory.ts";
import { expect, spyOn, test } from "bun:test";
import { copyFile, link, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT as context,
} from "@earendil-works/chord/context";
import {
  createRegistry,
  defineDoc,
  defineEntry,
  defineExtension,
  defineTask,
  Harness,
  SessionFailed,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  createModels,
  envApiKeyAuth,
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { defaultSettings } from "../src/config.ts";
import {
  inspect,
  open,
  openReadDatabase,
  ResearchOwnedError,
} from "../src/host.ts";
import {
  DefinitionDoc,
  readDefinition,
  UninitializedResearchError,
} from "../src/definition.ts";
import { Control } from "../src/workflow.ts";

const definition = {
  task: {
    problem: "Prove 1 = 1.",
    completionCriteria: "An exact self-contained proof.",
  },
  settings: defaultSettings,
};
const Event = defineEntry<string>("fixture.event");

test("older standalone note formats require their matching runtime", async () => {
  const directory = await temporaryDirectory("host-old-definition-");
  const path = join(directory, "campaign.sqlite");
  const legacy = defineDoc({
    ...DefinitionDoc.definition,
    version: 1,
    history: "latest",
    fork: "current",
  });
  const harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { registry: createRegistry(), models: createModels() },
    context,
  );
  await harness.root(context, {
    init: async (tx, root) => {
      Object.assign(await tx.doc(legacy, root), {
        ...definition,
        mode: { role: "verifier", input: { notes: [{ checks: [] }] } },
      });
    },
  });
  await harness.close(context);
  await expect(open(path)).rejects.toThrow("requires migration from version 1");
  await expect(inspect(path, readDefinition)).rejects.toThrow(
    "requires migration from version 1",
  );
});

test("definition and initialization commit atomically once and freeze on reopen", async () => {
  const directory = await temporaryDirectory("host-atomic-");
  const path = join(directory, "campaign.sqlite");

  await expect(
    open(path, {
      create: definition,
      initialize: async (tx, root) => {
        await tx.appendEntry(Event, root, { data: "rollback" });
        throw new Error("fixture failure");
      },
    }),
  ).rejects.toThrow("fixture failure");
  await expect(inspect(path, readDefinition)).rejects.toBeInstanceOf(
    UninitializedResearchError,
  );
  const owner = await open(path, {
    create: definition,
    initialize: (tx, root) => tx.appendEntry(Event, root, { data: "once" }),
  });
  await owner.close();
  const reopened = await open(path, {
    create: definition,
    initialize: () => {
      throw new Error("must not initialize twice");
    },
  });
  try {
    expect(await inspect(path, readDefinition)).toEqual(definition);
    const events = await reopened.root.commit(
      (tx) => tx.scanEntries({ conversationId: reopened.root.id }, 10),
      context,
    );
    expect(
      events.items
        .filter((entry) => entry.kind === Event.kind)
        .map((entry) => entry.data),
    ).toEqual(["once"]);
  } finally {
    await reopened.close();
  }
  await expect(
    open(path, {
      create: {
        ...definition,
        task: { ...definition.task, problem: "another problem" },
      },
    }),
  ).rejects.toThrow("frozen");
});

test("dangling database symlinks cannot create storage under a different owner path", async () => {
  const directory = await temporaryDirectory("host-dangling-");
  const path = join(directory, "campaign.sqlite");
  const alias = join(directory, "alias.sqlite");

  await symlink(path, alias);
  await expect(
    open(alias, { create: definition }).then((owner) => owner.close()),
  ).rejects.toThrow("database symlink must have an existing target");
  expect(await Bun.file(path).exists()).toBe(false);
  expect(await Bun.file(`${alias}.owner.sqlite`).exists()).toBe(false);
});

test("one owner excludes aliases while inspection uses a consistent snapshot", async () => {
  const directory = await temporaryDirectory("host-reader-");
  const path = join(directory, "campaign.sqlite");
  const owner = await open(path, {
    create: definition,
    initialize: async (tx, root) => {
      (await tx.doc(Control, root)).paused = false;
      await tx.appendEntry(Event, root, { data: "first" });
    },
  });
  try {
    const alias = join(directory, "alias.sqlite");
    await symlink(path, alias);
    await expect(open(alias)).rejects.toBeInstanceOf(ResearchOwnedError);
    const started = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const snapshot = inspect(path, async (tx, root) => {
      const first = await tx.scanEntries({ conversationId: root }, 10);
      expect((await tx.doc(Control, root)).paused).toBe(false);
      started.resolve();
      await resume.promise;
      const second = await tx.scanEntries({ conversationId: root }, 10);
      expect((await tx.doc(Control, root)).paused).toBe(false);
      return [first.items, second.items];
    });
    await started.promise;
    await owner.root.commit(async (tx) => {
      (await tx.doc(Control, owner.root.id)).paused = true;
      await tx.appendEntry(Event, owner.root.id, { data: "later" });
    }, context);
    resume.resolve();
    const [before, after] = await snapshot;
    expect(after).toEqual(before);
    expect(
      await inspect(
        path,
        async (tx, root) => (await tx.doc(Control, root)).paused,
      ),
    ).toBe(true);
    await inspect(path, (tx, root) =>
      tx.appendEntry(Event, root, { data: "snapshot only" }),
    );
    expect(
      before!
        .filter((entry) => entry.kind === Event.kind)
        .map((entry) => entry.data),
    ).toEqual(["first"]);
    expect(
      (
        await inspect(path, (tx, root) =>
          tx.scanEntries({ conversationId: root }, 10),
        )
      ).items.filter((entry) => entry.kind === Event.kind),
    ).toHaveLength(2);
    const original = await readFile(path);
    await inspect(path, readDefinition);
    expect(await readFile(path)).toEqual(original);
  } finally {
    await owner.close();
  }
  const hardlink = join(directory, "hardlink.sqlite");
  await link(path, hardlink);
  try {
    for (const linked of [path, hardlink]) {
      await expect(open(linked)).rejects.toThrow(
        "Hard-linked research database paths are unsupported",
      );
      await expect(inspect(linked, readDefinition)).rejects.toThrow(
        "Hard-linked research database paths are unsupported",
      );
    }
  } finally {
    await unlink(hardlink);
  }
  const reopened = await open(path);
  await reopened.close();
});

test("reopening recorded cancellation aborts an interrupted decision and nested work before recovery", async () => {
  const directory = await temporaryDirectory("host-cancelled-");
  const path = join(directory, "campaign.sqlite");
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  let decisions = 0;
  let children = 0;
  const Child = defineTask<null, { phase: "run" }, null>({
    name: "fixture.cancelled-child",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(_task, runtime, invocation) {
        children++;
        started.resolve();
        await awaitWithContext(held.promise, invocation);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          invocation,
        );
      },
    },
    async abort(_task, runtime, invocation) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        invocation,
      );
    },
  });
  const host = () => {
    const registry = createRegistry();
    registry.install(
      defineExtension({ name: "fixture.cancelled-child", tasks: [Child] }),
    );
    return open(path, {
      create: definition,
      registry,
      roles: () => ({
        coordinator: async (_input, runtime, invocation) => {
          decisions++;
          let child!: TaskId<null>;
          await runtime.commit(async (tx) => {
            child = await tx.createTask(Child, null, {
              ownership: { kind: "task", taskId: runtime.taskId },
            });
          }, invocation);
          await runtime.waitForTask(child, invocation);
          return { work: null };
        },
      }),
    });
  };
  let owner = await host();
  try {
    owner.harness.resume();
    await started.promise;
    await owner.root.commit(async (tx) => {
      (await tx.doc(Control, owner.root.id)).cancelled = true;
    }, context);
    // Suspend in the crash window after recorded cancellation, before native abort.
    await owner.close();
    held.resolve();
    owner = await host();
    await owner.root.waitForIdle(context);
    expect(decisions).toBe(1);
    expect(children).toBe(1);
    const tasks = await owner.root.commit(
      (tx) => tx.scanTasks({}, 10),
      context,
    );
    expect(tasks.items).toHaveLength(2);
    expect(
      tasks.items.every((task) => task.state.outcome?.status === "aborted"),
    ).toBe(true);
  } finally {
    held.resolve();
    await owner.close();
  }
});

test("usage overrides preserve frozen settings and completed custom-provider work reopens lazily", async () => {
  const directory = await temporaryDirectory("host-attribution-");
  const path = join(directory, "campaign.sqlite");
  const faux = fauxProvider({
    provider: "custom",
    models: [{ id: "fixture", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  let request:
    { sessionId?: string; headers?: Record<string, string | null> } | undefined;
  faux.setResponses([
    (_input, options) => {
      request = options;
      return fauxAssistantMessage(
        fauxToolCall("submit_coordinator", {
          work: { kind: "explorer", guidance: "Prove the task." },
        }),
        { stopReason: "toolUse" },
      );
    },
  ]);
  const frozen = {
    ...definition,
    mode: {
      role: "coordinator",
      input: {
        notes: [],
        guidance: [],
        failures: [],
        literatureUsed: false,
        explorerUsed: false,
      },
    },
    settings: {
      profiles: { default: { provider: "custom", model: "fixture" } },
      research: false as const,
      usagePrefix: "frozen",
    },
  };
  const owner = await open(path, {
    create: frozen,
    models,
    usagePrefix: "current",
  });
  try {
    await owner.harness.waitForIdle(context);
    expect(faux.state.callCount).toBe(1);
    expect(request?.sessionId).toBeDefined();
    expect(request?.headers).toMatchObject({
      "X-Codex-LB-Usage-Tag": `current/${request!.sessionId}`,
      "X-Codex-LB-Required-Capability": "usage_tag_v1",
    });
    expect(await inspect(path, readDefinition)).toEqual(frozen);
    const tasks = await owner.harness.commit(
      (tx) => tx.scanTasks({ kind: "research.worker" }, 10),
      context,
    );
    expect(tasks.items.map((task) => task.state.outcome?.status)).toEqual([
      "completed",
    ]);
    await owner.close();
    const reopened = await open(path);
    try {
      await reopened.root.waitForIdle(context);
      expect(
        await reopened.root.commit(
          (tx) => tx.scanTasks({ kind: "research.worker" }, 10),
          context,
        ),
      ).toEqual(tasks);
      expect(faux.state.callCount).toBe(1);
    } finally {
      await reopened.close();
    }
  } finally {
    await owner.close();
  }
});

test("owner commits use FULL durability and close without waiting for a held reader", async () => {
  const directory = await temporaryDirectory("host-durability-");
  const path = join(directory, "campaign.sqlite");
  const nativeOpen = SqliteStorage.open;
  let synchronous: number | undefined;
  const opening = spyOn(SqliteStorage, "open").mockImplementation(
    async (db) => {
      synchronous = (
        await db.get<{ synchronous: number }>("PRAGMA synchronous")
      )?.synchronous;
      return nativeOpen(db);
    },
  );
  let owner: Awaited<ReturnType<typeof open>> | undefined;
  let reader: DatabaseSync | undefined;
  try {
    owner = await open(path, {
      create: definition,
      initialize: (tx, root) => tx.appendEntry(Event, root, { data: "before" }),
    });
    expect(synchronous).toBe(2);
    opening.mockRestore();
    reader = new DatabaseSync(path, { readOnly: true });
    reader.exec("BEGIN");
    reader.prepare("SELECT * FROM durable_metadata").all();
    await owner.root.commit(
      (tx) => tx.appendEntry(Event, owner!.root.id, { data: "after" }),
      context,
    );
    const started = performance.now();
    await owner.close();
    expect(performance.now() - started).toBeLessThan(1_000);
    reader.exec("ROLLBACK");
    reader.close();
    reader = undefined;
    const events = await inspect(path, (tx, root) =>
      tx.scanEntries({ conversationId: root }, 20),
    );
    expect(
      events.items
        .filter((entry) => entry.kind === Event.kind)
        .map((entry) => entry.data)
        .sort(),
    ).toEqual(["after", "before"]);
  } finally {
    opening.mockRestore();
    reader?.close();
    await owner?.close();
  }
});

test("custom role extensions compose with built-in mathematical conversations", async () => {
  const directory = await temporaryDirectory("host-extensions-");
  const path = join(directory, "campaign.sqlite");
  const faux = fauxProvider({
    provider: "custom",
    models: [{ id: "fixture" }],
  });
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("custom", async () => ({
    type: "api_key",
    key: "stored-fixture",
  }));
  const models = createModels({ credentials });
  models.setProvider({
    ...faux.provider,
    auth: { apiKey: envApiKeyAuth("Fixture", []) },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("submit_explorer", { notes: [], candidate: false }),
      { stopReason: "toolUse" },
    ),
    (_input, options) => {
      expect(options?.apiKey).toBe("stored-fixture");
      return fauxAssistantMessage("Native conversation authenticated.");
    },
  ]);
  let calls = 0;
  const Custom = defineTask<null, { phase: "run" }, null>({
    name: "fixture.custom",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(_task, runtime, invocation) {
        calls++;
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          invocation,
        );
      },
    },
    async abort(_task, runtime, invocation) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        invocation,
      );
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "fixture.custom", tasks: [Custom] }),
  );
  const owner = await open(path, {
    create: {
      ...definition,
      mode: {
        role: "explorer",
        input: { notes: [], guidance: "Use the custom task." },
      },
      settings: {
        profiles: { default: { provider: "custom", model: "fixture" } },
        research: false,
      },
    },
    models,
    registry,
    roles: (builtins) => ({
      explorer: async (input, runtime, invocation, source) => {
        expect(calls).toBe(0);
        let id!: TaskId<null>;
        await runtime.commit(async (tx) => {
          id = await tx.createTask(Custom, null, {
            ownership: { kind: "task", taskId: runtime.taskId },
          });
        }, invocation);
        await runtime.waitForTask(id, invocation);
        return builtins.explorer(input, runtime, invocation, source);
      },
    }),
  });
  try {
    await owner.root.waitForIdle(context);
    expect(calls).toBe(1);
    expect(faux.state.callCount).toBe(1);
    const native = await owner.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "custom", modelId: "fixture" } },
      },
      context,
    );
    await (
      await native.submit(
        { type: "input", content: "Authenticate outside the role profile." },
        context,
      )
    ).wait(context);
    await native.waitForIdle(context);
    expect(faux.state.callCount).toBe(2);
    const tasks = await owner.root.commit(
      (tx) => tx.scanTasks({}, 30),
      context,
    );
    expect(
      tasks.items.every((task) => task.state.outcome?.status === "completed"),
    ).toBe(true);
  } finally {
    await owner.close();
  }
});

test.each([false, true])(
  "native Session failure releases waiters and preserves the first cause (close also fails=%s)",
  async (closeFails) => {
    const directory = await temporaryDirectory("host-failure-");
    const path = join(directory, "campaign.sqlite");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const diagnostic = new Error("fixture diagnostic");
    const failure = new Error("fixture storage outcome unknown");
    const reports = spyOn(console, "error").mockImplementation(() => {});
    const commits = spyOn(SqliteStorage.prototype, "commit");
    const nativeClose = SqliteStorage.prototype.close;
    const closes = spyOn(SqliteStorage.prototype, "close");
    let owner: Awaited<ReturnType<typeof open>> | undefined;
    try {
      owner = await open(path, {
        create: definition,
        roles: () => ({
          coordinator: async (_input, runtime) => {
            runtime.report(diagnostic);
            started.resolve();
            await release.promise;
            return { work: null };
          },
        }),
      });
      const idle = owner.root.waitForIdle(context);
      await started.promise;
      await owner.root.commit(() => {}, context);
      expect(reports.mock.calls.some((call) => call.includes(diagnostic))).toBe(
        true,
      );
      commits.mockImplementationOnce(async () => {
        throw failure;
      });
      if (closeFails)
        closes.mockImplementationOnce(async function (
          this: SqliteStorage,
          context,
        ) {
          await nativeClose.call(this, context);
          throw new Error("fixture secondary close failure");
        });
      release.resolve();
      await expect(idle).rejects.toBeInstanceOf(SessionFailed);
      await expect(idle).rejects.toMatchObject({
        name: "SessionFailed",
        cause: failure,
      });
      await expect(owner.harness.closed).resolves.toEqual({
        reason: "failed",
        error: failure,
      });
      // Native closure releases ownership without an explicit owner.close().
      const recovered = await open(path, {
        roles: () => ({ coordinator: async () => ({ work: null }) }),
      });
      try {
        await recovered.root.waitForIdle(context);
      } finally {
        await recovered.close();
      }
      await expect(owner.close()).rejects.toBe(failure);
    } finally {
      release.resolve();
      commits.mockRestore();
      await owner?.close().catch(() => {});
      closes.mockRestore();
      reports.mockRestore();
    }
  },
);

test("replacement roles preserve the browser quota and expose custom Codex", async () => {
  const directory = await temporaryDirectory("host-replacements-");
  const path = join(directory, "campaign.sqlite");
  let explorers = 0,
    codex = 0,
    decisions = 0;
  const observations: {
    explorerUsed: boolean;
    capabilities: { explorer: boolean; codex: boolean };
  }[] = [];
  const empty = () => ({ kind: "notes" as const, notes: [], candidate: false });
  const owner = await open(path, {
    create: {
      ...definition,
      settings: {
        ...defaultSettings,
        research: false,
        chatgpt: {
          baseUrl: "http://127.0.0.1:17841/v1",
          model: "chatgpt-web/gpt-6-pro",
        },
      },
    },
    roles: () => ({
      coordinator: async (input) => {
        observations.push({
          explorerUsed: input.explorerUsed,
          capabilities: input.capabilities,
        });
        decisions++;
        return {
          work:
            decisions === 1
              ? { kind: "explorer", guidance: "first" }
              : decisions === 2
                ? {
                    kind: "codex",
                    notes: [],
                    assignment: "fixture implementation",
                  }
                : null,
        };
      },
      explorer: async () => {
        explorers++;
        return empty();
      },
      codex: async () => {
        codex++;
        return empty();
      },
    }),
  });
  try {
    await owner.harness.waitForIdle(context);
    expect(observations[0]?.capabilities.codex).toBe(true);
    expect(
      observations.find((input) => input.explorerUsed)?.capabilities.explorer,
    ).toBe(false);
    expect(explorers).toBe(1);
    expect(codex).toBe(1);
    const tasks = await owner.harness.commit(
      (tx) => tx.scanTasks({}, 30),
      context,
    );
    expect(
      tasks.items.every((task) => task.state.outcome?.status === "completed"),
    ).toBe(true);
  } finally {
    await owner.close();
  }
});

test("inspection does not recover work or alter unsupported databases", async () => {
  const directory = await temporaryDirectory("host-inspection-");
  const path = join(directory, "campaign.sqlite");

  const started = Promise.withResolvers<void>();
  const owner = await open(path, {
    create: definition,
    roles: () => ({
      coordinator: async (_input, _runtime, invocation) => {
        started.resolve();
        await awaitWithContext(new Promise(() => {}), invocation);
        return { work: null };
      },
    }),
  });
  owner.harness.resume();
  await started.promise;
  const tasks = () =>
    inspect(path, async (tx) => (await tx.scanTasks({}, 20)).items);
  const pending = await tasks();
  expect(pending.some((task) => task.state.status === "running")).toBe(true);
  expect(await tasks()).toEqual(pending);
  await owner.close();
  expect(await tasks()).toEqual(pending);
  // A checkpointed copy has no WAL sidecars, regardless of statement GC timing.
  const stopped = join(directory, "stopped.sqlite");
  await copyFile(path, stopped);
  expect(
    await inspect(stopped, async (tx) => (await tx.scanTasks({}, 20)).items),
  ).toEqual(pending);
  const reader = openReadDatabase(stopped);
  try {
    expect(() => reader.exec("DELETE FROM tasks")).toThrow("readonly");
  } finally {
    reader.close();
  }
  const missing = join(directory, "missing.sqlite");
  expect(() => openReadDatabase(missing)).toThrow();
  await expect(inspect(missing, readDefinition)).rejects.toThrow();
  expect(await Bun.file(missing).exists()).toBe(false);
  const uninitialized = join(directory, "empty.sqlite");
  await (await openNodeSqliteStorage(uninitialized)).close(context);
  await expect(inspect(uninitialized, readDefinition)).rejects.toBeInstanceOf(
    UninitializedResearchError,
  );
  const future = new DatabaseSync(uninitialized);
  future.exec("UPDATE durable_schema SET version = 999");
  future.close();
  await expect(inspect(uninitialized, readDefinition)).rejects.toThrow(
    "newer than supported",
  );
  const corrupt = join(directory, "corrupt.sqlite");
  await Bun.write(corrupt, "not a database");
  await expect(inspect(corrupt, readDefinition)).rejects.not.toBeInstanceOf(
    UninitializedResearchError,
  );
  const unrelated = join(directory, "unrelated.sqlite");
  const other = new DatabaseSync(unrelated);
  other.exec("CREATE TABLE unrelated (value TEXT)");
  other.close();
  const original = await readFile(unrelated);
  await expect(inspect(unrelated, readDefinition)).rejects.toThrow(
    "Not a Pi Durable",
  );
  await expect(open(unrelated, { create: definition })).rejects.toThrow(
    "Not a Pi Durable",
  );
  expect(await readFile(unrelated)).toEqual(original);
});
