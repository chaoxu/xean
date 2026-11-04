import { expect, spyOn, test } from "bun:test";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import type { Respond } from "./worker-fixture.ts";
import * as verification from "../src/verification.ts";
import { project } from "../src/state.ts";
import { createWorkflow } from "../src/workflow.ts";
import { inspect, readStatus } from "../src/index.ts";
import { fixture, complete, context, abortable } from "./worker-fixture.ts";
import { verifierNames } from "../src/policy/contracts.ts";

const all = [...verifierNames];

test("a sealed cohort runs two Explorers and two Verifiers concurrently and admits no outside worker", async () => {
  const firstWave = Promise.withResolvers<void>();
  const releaseWave = Promise.withResolvers<void>();
  const sources = Promise.withResolvers<void>();
  const releaseSources = Promise.withResolvers<void>();
  let firstRequests = 0,
    selection = 0,
    sourceCalls = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        if (++firstRequests === 2) firstWave.resolve();
        await releaseWave.promise;
      }
      if (
        descriptor.kind === "selection" &&
        descriptor.input.notes.length > 0
      ) {
        const selected = descriptor.input.notes[selection++ % 2]!;
        return { verify: [{ note: selected.id, verifiers: all }] };
      }
      if (descriptor.kind === "verifier" && descriptor.name === "source") {
        if (++sourceCalls === 2) sources.resolve();
        await releaseSources.promise;
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: { explorers: 2, verifiers: 2, maxExplorerTurns: 2 },
    },
  );
  const done = run.owner.root.waitForIdle(context);
  await firstWave.promise;
  expect(firstRequests).toBe(2);
  expect(await run.notes()).toEqual([]);
  await expect(run.create({ kind: "explorer" })).rejects.toThrow();
  await expect(run.create({ kind: "verifier" })).rejects.toThrow();
  releaseWave.resolve();
  await sources.promise;
  expect(await run.notes()).toHaveLength(2);
  expect((await inspect(run.path, readStatus)).status).not.toBe("terminal");
  releaseSources.resolve();
  await done;
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "accepted",
    turns: 2,
  });
  expect(sourceCalls).toBe(2);
  expect((await run.book()).checks).toHaveLength(8);
});

test("a hung cohort member keeps finalization pending and native reopen recovers it", async () => {
  const started = Promise.withResolvers<void>();
  let explorers = 0,
    hold = true;
  let hungNamespace = "";
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "explorer") {
        explorers++;
        if (
          explorers === 2 ||
          request.descriptor.input.namespace === hungNamespace
        ) {
          hungNamespace = request.descriptor.input.namespace;
          started.resolve();
          if (hold) await abortable(request.signal);
        }
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: { explorers: 2, verifiers: 1, maxExplorerTurns: 2 },
    },
  );
  const pending = run.owner.root.waitForIdle(context).catch(() => {});
  await started.promise;
  const status = await inspect(run.path, readStatus);
  expect(status.status).not.toBe("terminal");
  expect(status.accepted).toBeNull();
  await run.owner.close();
  await pending;
  const suspended = await inspect(run.path, readStatus);
  expect(suspended.status).not.toBe("terminal");
  hold = false;
  await run.reopen();
  await run.owner.root.waitForIdle(context);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "accepted",
  });
  expect(
    run.requests.filter(
      ({ descriptor }) =>
        descriptor.kind === "explorer" &&
        descriptor.input.namespace === hungNamespace,
    ),
  ).toHaveLength(2);
});

test.each(["fault", "abort"])(
  "a provisional acceptance waits for an adverse receipt after %s",
  async (interruption) => {
    const accepted = Promise.withResolvers<void>();
    const receiptPaused = Promise.withResolvers<void>();
    const releaseReceipt = Promise.withResolvers<void>();
    let ancestor = "",
      initialRoot = "",
      finalRoot = "";
    let exploration = 0,
      selection = 0;
    const run = await fixture(
      async (request): Promise<Awaited<ReturnType<Respond>>> => {
        const { descriptor } = request;
        if (descriptor.kind === "explorer") {
          if (++exploration === 1) {
            ancestor = `${descriptor.input.namespace}.1`;
            initialRoot = `${descriptor.input.namespace}.2`;
            return {
              notes: [
                { text: "Generated lemma.", summary: "Lemma.", support: [] },
                {
                  text: "Initial candidate.",
                  summary: "Initial claim.",
                  support: [ancestor],
                },
              ],
            };
          }
          finalRoot = `${descriptor.input.namespace}.1`;
          return {
            notes: [
              {
                text: "Final candidate.",
                summary: "Final claim.",
                support: [ancestor],
              },
            ],
          };
        }
        if (descriptor.kind === "selection")
          return {
            verify: [
              {
                note: ++selection === 1 ? finalRoot : ancestor,
                verifiers: all,
              },
            ],
          };
        if (
          descriptor.kind === "reconstruction" &&
          descriptor.input.notes.some((note) => note.id === initialRoot)
        )
          return {
            statements: [],
            verdicts: descriptor.input.notes.map((note) => ({
              note: note.id,
              verdict: note.id === initialRoot ? "INCONCLUSIVE" : "PASS",
              report: "Checked initial attempt.",
            })),
          };
        if (
          selection &&
          descriptor.kind === "verifier" &&
          descriptor.name === "source" &&
          descriptor.judged.includes(ancestor)
        ) {
          await accepted.promise;
          return {
            verdicts: [
              {
                note: ancestor,
                verdict: "FAIL",
                report: "The lemma's cited source is false.",
              },
            ],
          };
        }
        return complete(request);
      },
      { settings: { explorers: 1, verifiers: 2, maxExplorerTurns: 1 } },
    );
    await run.run({ kind: "explorer" });
    await run.run({
      kind: "verifier",
      verify: [
        { note: ancestor, verifiers: ["source", "correctness"] },
        { note: initialRoot, verifiers: all },
      ],
    });
    const initial = project(await run.book());
    expect(initial.accepted).toEqual([]);
    expect(initial.reconstructed[ancestor]).toBeDefined();
    const campaign = await run.owner.root.commit(
      (tx) => createWorkflow().initialize(tx, run.owner.root.id),
      context,
    );
    const original = verification.verify;
    let interrupted = false;
    const verifier = spyOn(verification, "verify").mockImplementation(
      async (input, settings, dependencies) =>
        original(input, settings, {
          ...dependencies,
          async record(id, values) {
            if (
              !interrupted &&
              values.some(
                (value) => value.note === ancestor && value.verdict === "FAIL",
              )
            ) {
              interrupted = true;
              if (interruption === "abort") {
                receiptPaused.resolve();
                await releaseReceipt.promise;
              } else
                throw new Error(
                  "Adverse source receipt committed before check publication",
                );
            }
            await dependencies.record(id, values);
            if (
              values.some(
                (value) =>
                  value.note === finalRoot &&
                  value.verifier === "reconstruction",
              )
            )
              accepted.resolve();
          },
        }),
    );
    try {
      const idle = run.owner.root.waitForIdle(context);
      if (interruption === "abort") {
        await receiptPaused.promise;
        await run.owner.harness.abortTask(campaign, context);
        releaseReceipt.resolve();
      }
      await idle;
    } finally {
      verifier.mockRestore();
    }
    expect(interrupted).toBe(true);
    expect(
      (await run.tasks()).find((task: { id: number }) => task.id === campaign)
        .state.outcome.status,
    ).toBe(interruption === "abort" ? "aborted" : "completed");
    expect(project(await run.book()).accepted).toEqual([finalRoot]);
    expect(await inspect(run.path, readStatus)).toMatchObject({
      status: "terminal",
      outcome: "call-failure",
      accepted: null,
    });
    await expect(run.create({ kind: "explorer" })).rejects.toThrow(
      "settle or resume",
    );
    const calls = run.provider.state.callCount;
    await run.owner.resume();
    await run.owner.root.waitForIdle(context);
    expect(run.provider.state.callCount).toBe(calls);
    expect(project(await run.book()).accepted).toEqual([]);
    expect(
      (await run.notes()).find((note) => note.id === finalRoot)!.dead,
    ).toBe(true);
    expect(await inspect(run.path, readStatus)).toMatchObject({
      status: "terminal",
      outcome: "turn-limit",
      accepted: null,
    });
  },
);

test("native abort retains completed, unpublished, and unfinished Explorer members", async () => {
  const hung = Promise.withResolvers<void>();
  let explorerCalls = 0;
  let interrupted = false;
  const original = NoteStore.prototype.append;
  const append = spyOn(NoteStore.prototype, "append").mockImplementation(
    function (this: NoteStore, requestId, notes) {
      const version = original.call(this, requestId, notes);
      if (
        !interrupted &&
        Object.values(notes).some((note) => note.text === "Unpublished proof.")
      ) {
        interrupted = true;
        throw new Error("Append committed before Pi publication");
      }
      return version;
    },
  );
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "explorer") {
        explorerCalls++;
        if (explorerCalls === 2)
          return {
            notes: [
              {
                text: "Unpublished proof.",
                summary: "Unpublished proof.",
                support: [],
              },
            ],
          };
        if (explorerCalls === 3) {
          hung.resolve();
          await abortable(request.signal);
        }
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: { explorers: 3, verifiers: 1, maxExplorerTurns: 3 },
    },
  );
  try {
    const idle = run.owner.root.waitForIdle(context);
    await hung.promise;
    const records = await run.tasks();
    const campaign = records.find(
      (task: { kind: string }) => task.kind === "xean.campaign",
    );
    const members = records.filter(
      (task: { owner?: number }) => task.owner === campaign.id,
    );
    expect((await run.wait(members[0].id)).state.outcome.status).toBe(
      "completed",
    );
    expect((await run.wait(members[1].id)).state.outcome.status).toBe(
      "faulted",
    );
    await run.owner.harness.abortTask(campaign.id, context);
    await idle;
    const settled = (await run.tasks()).find(
      (task: { id: number }) => task.id === campaign.id,
    );
    expect(settled.state.outcome).toMatchObject({
      status: "aborted",
      result: {
        outcome: "call-failure",
        turns: 1,
        resume: {
          phase: "next",
          step: "explorer",
          turns: 1,
          children: [members[1].id, members[2].id],
        },
      },
    });
    expect(await run.notes()).toHaveLength(1);
    using store = new NoteStore(`${run.path}.notes.sqlite`, { readonly: true });
    expect(store.snapshot()).toBe(2);
    await expect(run.create({ kind: "explorer" })).rejects.toThrow(
      "settle or resume",
    );
    await run.owner.resume();
    await run.owner.root.waitForIdle(context);
    expect(explorerCalls).toBe(4);
    const notes = await run.notes();
    expect(notes).toHaveLength(3);
    expect(notes.find((note) => note.id === `w${members[1].id}.1`)?.text).toBe(
      "Unpublished proof.",
    );
    expect(store.snapshot()).toBe(3);
    expect(await inspect(run.path, readStatus)).toMatchObject({
      status: "terminal",
      outcome: "accepted",
      turns: 3,
    });
  } finally {
    append.mockRestore();
  }
});
