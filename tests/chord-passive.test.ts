import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenerationTask } from "@earendil-works/pi-durable";
import { inspect, open } from "../src/host.ts";
import { guide, submitNotes } from "../src/inputs.ts";
import {
  abortable,
  complete,
  context,
  defaultSettings,
  fixture,
  note,
  problem,
} from "./worker-fixture.ts";

test("passive open leaves a pending native generation untouched while queuing notes and guidance", async () => {
  const entered = Promise.withResolvers<void>();
  let explorers = 0;
  const run = await fixture(async (request) => {
    if (request.descriptor.kind === "explorer" && explorers++ === 0) {
      entered.resolve();
      await abortable(request.signal);
    }
    return complete(request);
  });
  const job = await run.start({ kind: "explorer" });
  await entered.promise;
  await run.owner.close();
  const before = await run.tasks();
  const pending = before.filter(
    (task: { state: { status: string } }) => task.state.status !== "terminal",
  );
  expect(pending.length).toBeGreaterThan(0);
  expect(
    pending.some(
      (task: { kind: string }) => task.kind === GenerationTask.definition.name,
    ),
  ).toBe(true);
  expect(run.requests).toHaveLength(1);
  expect((await run.data()).history).toEqual([]);

  await run.reopen(false);
  expect(() => run.start({ kind: "explorer" })).toThrow("execute:true");
  await run.owner.change((draft) => {
    submitNotes(draft, "queued-reference", {
      notes: [note("Prepared premise.")],
    });
    guide(draft, "queued-advice", "Consider the prepared premise next turn.");
  });
  expect(run.owner.state.notebook.inputs).toMatchObject([
    { id: "queued-reference", consumed: false },
  ]);
  expect(run.owner.state.notebook.guidance).toHaveLength(1);
  expect(run.owner.state.notebook.publications).toEqual([]);
  await run.owner.close();
  expect(await run.tasks()).toEqual(before);
  expect(run.requests).toHaveLength(1);

  await run.reopen(true);
  const finished = await run.finished(job.id);
  expect(finished.status).toBe("completed");
  expect(finished.origin).toBe(job.id);
  expect(run.requests).toHaveLength(2);
  expect(run.requests[1]!.descriptor).toEqual(run.requests[0]!.descriptor);
  expect(run.owner.history).toHaveLength(1);
  expect(run.owner.state.notebook.inputs[0]!.consumed).toBe(false);
  const after = await run.tasks();
  for (const task of pending)
    expect(
      after.find((entry: { id: number }) => entry.id === task.id)?.state.status,
    ).toBe("terminal");
  expect(
    after
      .filter(
        (task: { kind: string }) =>
          task.kind === GenerationTask.definition.name,
      )
      .map((task: { id: number }) => task.id),
  ).toEqual(
    before
      .filter(
        (task: { kind: string }) =>
          task.kind === GenerationTask.definition.name,
      )
      .map((task: { id: number }) => task.id),
  );
  expect(
    after.every(
      (task: { state: { status: string } }) => task.state.status === "terminal",
    ),
  ).toBe(true);
  expect(run.reports).toEqual([]);
});

test("passive open after process death does not rewrite native generation recovery state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-passive-crash-"));
  const path = join(directory, "research.sqlite");
  const script = `
    import { createModels } from "@earendil-works/pi-ai";
    import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
    import { open } from ${JSON.stringify(new URL("../src/host.ts", import.meta.url).pathname)};
    const provider = fauxProvider({ provider: "test", models: [{ id: "math", reasoning: true }] });
    const models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses([async () => {
      process.stdout.write("model-request\\n");
      await new Promise(() => {});
      return fauxAssistantMessage("unreachable");
    }]);
    const owner = await open(${JSON.stringify(path)}, {
      create: ${JSON.stringify({ task: problem, settings: defaultSettings() })},
      startCampaign: false, execute: true, models,
    });
    await owner.start({ kind: "explorer" });
    await new Promise(() => {});
  `;
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--eval", script],
    {
      cwd: new URL("..", import.meta.url).pathname,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let passive: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("model-request");
    child.kill("SIGKILL");
    await child.exited;
    const tasks = () =>
      inspect(path, (_data, session) =>
        session.commit(
          async (tx) => (await tx.scanTasks({}, 256)).items,
          context,
        ),
      );
    const before = await tasks();
    expect(
      before.some(
        (task) =>
          task.kind === GenerationTask.definition.name &&
          task.state.status === "running",
      ),
    ).toBe(true);
    passive = await open(path);
    await passive.change((draft) =>
      guide(draft, "after-crash", "Prepared for a later run."),
    );
    await passive.close();
    expect(await tasks()).toEqual(before);
  } finally {
    child.kill();
    await child.exited;
    await passive?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
