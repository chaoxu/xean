import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolResultEntry } from "@earendil-works/pi-durable";
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

test("closing at private submission and worker publication reuses each committed native result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-recovery-"));
  const path = join(directory, "campaign.sqlite");
  const provider = fixture((role, input) =>
    role === "explorer"
      ? noteResult
      : {
          work: input.notes.length
            ? []
            : [{ kind: "explorer", guidance: "prove" }],
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
    await rm(directory, { recursive: true, force: true });
  }
});

test("SIGKILL recovers the product's native SQLite work without repeating its original Coordinator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-kill-"));
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
      role === "explorer" ? noteResult : { work: [] },
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
    await rm(directory, { recursive: true, force: true });
  }
});
