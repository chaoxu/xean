import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "xean";
import { observe } from "../packages/observe/src/publish.ts";

test("publisher skips unchanged ticks and recovers changes, replacement, and failed exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "xean-publisher-"));
  const first = join(root, "first");
  const directory = join(root, "current");
  await mkdir(first);
  await symlink(first, directory);
  const open = async (path: string, problem: string) =>
    core.Xean.open(await core.openXeanStorage(join(path, "campaign.sqlite")), {
      task: {
        kind: "xean.role",
        task: { problem, completionCriteria: "Proof" },
      },
      coordinator: { name: "fixture", run: () => ({ state: null }) },
      roles: [],
    });
  const read = () => Bun.file(join(directory, "observation.json")).json();
  const errors: unknown[] = [];
  const original = core.inspectCampaign;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const inspect = spyOn(core, "inspectCampaign").mockImplementation((async (
    ...args: Parameters<typeof original>
  ) => {
    const result = await original(...args);
    if (hold) {
      entered.resolve();
      await release.promise;
    }
    return result;
  }) as typeof original);
  const intervals = spyOn(globalThis, "setInterval");
  const stop = observe(directory, (error) => {
    errors.push(error);
  });
  const tick = intervals.mock.calls.at(-1)![0] as () => Promise<void>;
  intervals.mockRestore();
  let engine: core.Xean | undefined;
  try {
    // Start before initialization, then retry without restarting the watcher.
    await tick();
    expect(errors).toHaveLength(1);
    engine = await open(first, "Original task");
    await tick();
    const initial = await read();
    const initialStatus = await Bun.file(join(directory, "status.json")).text();
    for (let i = 0; i < 3; i++) await tick();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(await read()).toEqual(initial);
    expect(await Bun.file(join(directory, "status.json")).text()).toBe(
      initialStatus,
    );

    await engine.input("new work");
    await tick();
    expect((await read()).status.pendingSignals).toBe(
      initial.status.pendingSignals + 1,
    );
    // The change detector must not pin a WAL read transaction between polls.
    using checkpoint = new Database(join(first, "campaign.sqlite"));
    expect(checkpoint.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toEqual({
      busy: 0,
      log: 0,
      checkpointed: 0,
    });

    await engine.input("before publication");
    hold = true;
    const publishing = tick();
    await entered.promise;
    await engine.input("during publication");
    expect(tick()).toBe(publishing);
    // A second process using the canonical directory cannot overwrite this snapshot.
    const competing = Bun.spawn(
      [
        process.execPath,
        "--no-install",
        "--no-env-file",
        new URL("../packages/observe/src/publish.ts", import.meta.url).pathname,
        first,
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    );
    const [code, error] = await Promise.all([
      competing.exited,
      new Response(competing.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(error).toContain("database is locked");
    release.resolve();
    await publishing;
    const preceding = await read();
    hold = false;
    await tick();
    expect((await read()).status.pendingSignals).toBe(
      preceding.status.pendingSignals + 1,
    );

    // Fail after observation.json was replaced but before status.json can publish.
    const statusFile = join(directory, "status.json");
    await rm(statusFile);
    await mkdir(statusFile);
    await engine.input("failed export");
    await tick();
    expect(errors).toHaveLength(2);
    await rm(statusFile, { recursive: true });
    await tick();
    expect((await Bun.file(statusFile).json()).observedAt).toBe(
      (await read()).observedAt,
    );

    await engine.close();
    const replacement = join(root, "replacement");
    await mkdir(replacement);
    engine = await open(replacement, "Replacement task");
    await symlink(replacement, join(root, "next"));
    await rename(join(root, "next"), directory);
    await tick();
    expect((await read()).task.problem).toBe("Replacement task");

    const beforeStop = (await read()).status.pendingSignals;
    await engine.input("last change before shutdown");
    await stop();
    await stop();
    expect((await read()).status.pendingSignals).toBe(beforeStop + 1);
    expect(errors).toHaveLength(2);
  } finally {
    release.resolve();
    await stop();
    await engine?.close();
    inspect.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
