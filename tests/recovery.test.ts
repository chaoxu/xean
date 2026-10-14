import { temporaryDirectory } from "./directory.ts";
import { fixtureTask } from "./task.ts";
import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  createRegistry,
  defineExtension,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { inspect, open } from "../src/host.ts";
import { scanTasks } from "../src/core/workflow.ts";
import { Bodies, readView } from "../src/core/math/state.ts";
import { context, fixture, task, settings, noteResult } from "./fixture.ts";

test.each(["worker", "input"] as const)(
  "Coordinator children settle before %s starts, including after reopening",
  async (next) => {
    const directory = await temporaryDirectory("coordinator-settlement-");
    const path = join(directory, "campaign.sqlite");
    const release = Promise.withResolvers<void>();
    let entered = Promise.withResolvers<void>();
    const completing = Promise.withResolvers<void>();
    const trace: string[] = [];
    let seedRevision: number | undefined;
    let historicalBodies = 0;
    const findDocument = SqliteStorage.prototype.findDocument;
    const reads = spyOn(
      SqliteStorage.prototype,
      "findDocument",
    ).mockImplementation(function (this: SqliteStorage, address, point, ctx) {
      if (address.kind === Bodies.definition.kind && typeof point === "number")
        historicalBodies++;
      return findDocument.call(this, address, point, ctx);
    });
    const Child = fixtureTask("test.coordinator-child", async (ctx) => {
      entered.resolve();
      await awaitWithContext(release.promise, ctx);
      trace.push("child");
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
          if (input.recent.length || input.guidance.length)
            return { work: null };
          await runtime.commit(async (tx) => {
            await tx.createTask(Child, null, {
              ownership: { kind: "task", taskId: runtime.taskId },
            });
          }, ctx);
          return {
            work:
              next === "worker"
                ? { kind: "explorer", assignment: "Prove the claim" }
                : null,
          };
        },
        explorer: async (input, runtime) => {
          trace.push("explorer");
          expect(input.notes[0].text).toBe(noteResult.notes[0]!.text);
          return {
            kind: "notes",
            notes: [{ ...noteResult.notes[0]!, id: `${runtime.taskId}/n1` }],
          };
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
      if (next === "worker")
        seedRevision = await owner.root.commit(
          (tx) =>
            owner.workflow.input(tx, owner.root.id, {
              kind: "submit",
              id: "seed",
              notes: [
                {
                  ...noteResult.notes[0]!,
                  id: "input/seed/n1",
                  candidate: false,
                },
              ],
            }),
          context,
        );
      owner.harness.resume();
      await completing.promise;
      await entered.promise;
      if (next === "input")
        await owner.root.commit(
          (tx) =>
            owner.workflow.input(tx, owner.root.id, {
              kind: "guide",
              id: "after-null",
              text: "Read this after the previous decision's child drains",
            }),
          context,
        );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(trace).toEqual(["coordinator"]);
      expect(historicalBodies).toBe(0);
      if (next === "worker")
        await owner.root.commit(
          (tx) =>
            owner.workflow.input(tx, owner.root.id, {
              kind: "submit",
              id: "while-waiting",
              notes: [],
              edits: [
                {
                  id: "input/seed/n1",
                  revision: seedRevision!,
                  summary: "Caller correction",
                  detailedSummary:
                    "The caller changed the admitted note while the worker waits.",
                  text: "A caller correction after admission.",
                },
              ],
            }),
          context,
        );
      await owner.close();
      detach();
      entered = Promise.withResolvers<void>();
      owner = await open(path, options);
      owner.harness.resume();
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(trace).toEqual(["coordinator"]);
      expect(historicalBodies).toBe(0);
      release.resolve();
      await owner.root.waitForIdle(context);
      expect(trace).toEqual(
        next === "worker"
          ? ["coordinator", "child", "explorer", "coordinator"]
          : ["coordinator", "child", "coordinator"],
      );
      if (next === "worker") {
        expect(historicalBodies).toBeGreaterThan(0);
        expect(
          (
            await owner.root.commit(
              (tx) => readView(tx, owner.root.id),
              context,
            )
          ).notes[0]!.text,
        ).toBe("A caller correction after admission.");
      }
    } finally {
      release.resolve();
      detach();
      await owner.close();
      reads.mockRestore();
    }
  },
);

test("closing after immediate role publication reuses each committed native result", async () => {
  const directory = await temporaryDirectory("research-recovery-");
  const path = join(directory, "campaign.sqlite");
  const provider = fixture((role, input) =>
    role === "explorer"
      ? {
          notes: [{ ...noteResult.notes[0]!, id: `${input.noteIdPrefix}n1` }],
        }
      : {
          work: input.notes.length
            ? null
            : { kind: "explorer", assignment: "prove" },
        },
  );
  let owner = await open(path, {
    create: { task, settings },
    models: provider.models,
  });
  try {
    for (const boundary of [
      "coordinator",
      "explorer",
      "publication",
    ] as const) {
      let closing: Promise<void> | undefined;
      const detach = owner.harness.subscribeCommits(({ changes }) => {
        const reached = changes.some((change) =>
          boundary === "publication"
            ? change.type === "task" &&
              change.value.kind === "research.worker" &&
              change.value.state.outcome?.status === "completed"
            : change.type === "entry" &&
              ToolResultEntry.is(change.value) &&
              change.value.model?.some(
                (message) =>
                  message.role === "toolResult" &&
                  message.toolName === `submit_${boundary}`,
              ),
        );
        if (reached)
          queueMicrotask(() => {
            closing ??= owner.close();
          });
      });
      try {
        await owner.root.waitForIdle(context).catch(() => {});
        expect(closing, boundary).toBeDefined();
        await closing;
      } finally {
        detach();
      }
      expect((await inspect(path, readView)).notes).toHaveLength(
        boundary === "coordinator" ? 0 : 1,
      );
      owner = await open(path, {
        models: provider.models,
      });
    }
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
    });
    await owner.root.waitForIdle(context);
    expect(provider.calls).toHaveLength(3);
  } finally {
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
    const provider = fixture((role, input) =>
      role === "explorer"
        ? {
            notes: [{ ...noteResult.notes[0]!, id: `${input.noteIdPrefix}n1` }],
          }
        : { work: null },
    );
    const owner = await open(path, {
      models: provider.models,
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
