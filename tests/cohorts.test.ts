import { expect, spyOn, test } from "bun:test";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import type { TaskDefinition } from "@earendil-works/pi-durable";
import type { Respond } from "./worker-fixture.ts";
import * as verification from "../src/verification.ts";
import { Notebook, project, readNotebook } from "../src/state.ts";
import {
  createWorkflow,
  type CampaignState,
  type CampaignResult,
} from "../src/workflow.ts";
import * as workflow from "../src/workflow.ts";
import { inspect, readStatus } from "../src/index.ts";
import { fixture, complete, context, abortable } from "./worker-fixture.ts";
import { verifierNames } from "../src/policy/contracts.ts";

const all = [...verifierNames];
type CampaignPhases = TaskDefinition<
  { resume?: CampaignState },
  CampaignState,
  CampaignResult,
  {}
>["phases"];
async function observed<T>(
  promise: Promise<T>,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("verification starts after one Explorer publishes while another is still running", async () => {
  const explorersStarted = Promise.withResolvers<void>();
  const firstSource = Promise.withResolvers<void>();
  const bothSources = Promise.withResolvers<void>();
  const releaseExplorers = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  const releaseSources = Promise.withResolvers<void>();
  let explorers = 0,
    sources = 0;
  const selected: string[] = [];
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        const slot = explorers++;
        if (explorers === 2) explorersStarted.resolve();
        expect(slot).toBeLessThan(2);
        await Promise.race([
          releaseExplorers[slot]!.promise,
          abortable(request.signal),
        ]);
      }
      if (descriptor.kind === "selection") {
        const root = descriptor.input.notes.find(
          (note) => !note.dead && !note.checked,
        )?.id;
        expect(root).toBeDefined();
        selected.push(root!);
        return { verify: [{ note: root!, verifiers: all }] };
      }
      if (descriptor.kind === "verifier" && descriptor.name === "source") {
        if (++sources === 1) firstSource.resolve();
        if (sources === 2) bothSources.resolve();
        await Promise.race([releaseSources.promise, abortable(request.signal)]);
      }
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 2 } },
  );
  const done = run.owner.root.waitForIdle(context);
  try {
    await observed(explorersStarted.promise, "initial Explorers");
    releaseExplorers[0]!.resolve();
    await observed(
      firstSource.promise,
      "verification while the second Explorer is blocked",
    );
    const records = await run.tasks();
    const campaign = records.find(
      (task: { kind: string }) => task.kind === "xean.campaign",
    );
    const logical = records.filter(
      (task: { kind: string; owner?: number; state: { status: string } }) =>
        task.kind === "xean.worker" &&
        task.owner === campaign.id &&
        task.state.status !== "terminal",
    );
    expect(
      logical
        .map((task: { input: { kind: string } }) => task.input.kind)
        .sort(),
    ).toEqual(["explorer", "verifier"]);
    expect(await run.notes()).toHaveLength(1);
    await expect(run.create({ kind: "explorer" })).rejects.toThrow(
      "settle or resume",
    );
    releaseExplorers[1]!.resolve();
    await observed(bothSources.promise, "both verification calls");
    const checking = (await run.tasks()).filter(
      (task: { kind: string; state: { status: string } }) =>
        task.kind === "xean.worker" && task.state.status !== "terminal",
    );
    expect(
      checking.filter((task: { owner?: number }) => task.owner === campaign.id),
    ).toHaveLength(2);
    expect(
      checking.filter(
        (task: { input: { kind: string } }) => task.input.kind === "verify",
      ),
    ).toHaveLength(2);
    expect(explorers).toBe(2);
    expect(new Set(selected).size).toBe(2);
    expect((await inspect(run.path, readStatus)).status).not.toBe("terminal");
  } finally {
    for (const release of releaseExplorers) release.resolve();
    releaseSources.resolve();
    await done;
  }
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "accepted",
    turns: 2,
  });
  expect((await run.book()).checks).toHaveLength(8);
});

test("a hung Explorer keeps finalization pending and native reopen recovers it", async () => {
  const started = Promise.withResolvers<void>();
  const reconstructed = Promise.withResolvers<void>();
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
      if (request.descriptor.kind === "reconstruction") reconstructed.resolve();
      return complete(request);
    },
    {
      automatic: true,
      settings: { maxWorkers: 2, maxExplorerTurns: 2 },
    },
  );
  const pending = run.owner.root.waitForIdle(context).catch(() => {});
  await observed(started.promise, "held Explorer");
  await observed(reconstructed.promise, "completed first reconstruction");
  const verifier = (await run.tasks()).find(
    (task: { input: { kind?: string } }) => task.input.kind === "verifier",
  );
  expect((await run.wait(verifier.id)).state.outcome.status).toBe("completed");
  expect(project(await run.book()).accepted).toHaveLength(1);
  const calls = run.provider.state.callCount;
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
  expect(run.provider.state.callCount).toBe(calls + 1);
});

test.each(["fault", "abort"])(
  "a provisional acceptance waits for an adverse receipt after %s",
  async (interruption) => {
    const accepted = Promise.withResolvers<void>();
    const receiptPaused = Promise.withResolvers<void>();
    const releaseReceipt = Promise.withResolvers<void>();
    let ancestor = "",
      finalRoot = "";
    let exploration = 0;
    const run = await fixture(
      async (request): Promise<Awaited<ReturnType<Respond>>> => {
        const { descriptor } = request;
        if (descriptor.kind === "explorer") {
          if (++exploration === 1) {
            ancestor = `${descriptor.input.namespace}.1`;
            return {
              notes: [
                { text: "Generated lemma.", summary: "Lemma.", support: [] },
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
        if (
          exploration > 1 &&
          descriptor.kind === "verifier" &&
          descriptor.name === "source" &&
          descriptor.judged.includes(ancestor)
        ) {
          await Promise.race([accepted.promise, abortable(request.signal)]);
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
        if (descriptor.kind === "selection") return { verify: [] };
        return complete(request);
      },
      { settings: { maxWorkers: 3, maxExplorerTurns: 1 } },
    );
    await run.run({ kind: "explorer" });
    await run.run({
      kind: "verifier",
      verify: [
        {
          note: ancestor,
          verifiers: ["source", "correctness", "reconstruction"],
        },
      ],
    });
    const initial = project(await run.book());
    expect(initial.accepted).toEqual([]);
    expect(
      initial.notes.find((note) => note.id === ancestor)!.verdicts,
    ).toContainEqual(
      expect.objectContaining({ verifier: "reconstruction", verdict: "PASS" }),
    );
    const campaign = await run.owner.root.commit(
      (tx) => createWorkflow().initialize(tx, run.owner.root.id),
      context,
    );
    // Admit two disjoint checks to expose the late-adverse-result boundary.
    // The Campaign still owns, waits for, and recovers these native workers.
    const createGroup = run.owner.workers.createGroup.bind(run.owner.workers);
    let assigned = false;
    const assignments = spyOn(
      run.owner.workers,
      "createGroup",
    ).mockImplementation(async (tx, root, requests, owner, eligible) => {
      if (
        !assigned &&
        owner !== undefined &&
        finalRoot &&
        requests.some((request) => request.kind === "verifier") &&
        readNotebook(await tx.doc(Notebook, root)).notes.some(
          (note) => note.id === finalRoot,
        )
      ) {
        assigned = true;
        return createGroup(
          tx,
          root,
          [
            { kind: "verifier", verify: [{ note: finalRoot, verifiers: all }] },
            { kind: "verifier", verify: [{ note: ancestor, verifiers: all }] },
          ],
          owner,
          eligible,
        );
      }
      return createGroup(tx, root, requests, owner, eligible);
    });
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
        await observed(
          receiptPaused.promise,
          "adverse receipt before check publication",
        );
        await run.owner.harness.abortTask(campaign, context);
        releaseReceipt.resolve();
      }
      await idle;
    } finally {
      releaseReceipt.resolve();
      accepted.resolve();
      verifier.mockRestore();
      assignments.mockRestore();
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
    const adverse = (await run.tasks()).find(
      (task: {
        input: { kind?: string; input?: { verify?: { note: string }[] } };
        state: { outcome?: { status: string } };
      }) =>
        task.input.kind === "verify" &&
        task.input.input?.verify?.some((entry) => entry.note === ancestor) &&
        task.state.outcome?.status !== "completed",
    );
    expect(adverse).toBeDefined();
    await run.reopen();
    await run.owner.root.waitForIdle(context);
    expect(await inspect(run.path, readStatus)).toMatchObject({
      outcome: "call-failure",
      accepted: null,
    });
    expect(run.provider.state.callCount).toBe(calls);
    await run.owner.resume();
    await run.owner.root.waitForIdle(context);
    expect(run.provider.state.callCount).toBe(calls);
    expect(
      (await run.book()).checks.find((check) =>
        check.values.some(
          (value) => value.note === ancestor && value.verdict === "FAIL",
        ),
      )?.candidate,
    ).toBe(adverse.id);
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
      settings: { maxWorkers: 3, maxExplorerTurns: 3 },
    },
  );
  try {
    const idle = run.owner.root.waitForIdle(context);
    await observed(hung.promise, "unfinished Explorer");
    const records = await run.tasks();
    const campaign = records.find(
      (task: { kind: string }) => task.kind === "xean.campaign",
    );
    const members = records.filter(
      (task: { owner?: number; input: { kind?: string } }) =>
        task.owner === campaign.id && task.input.kind === "explorer",
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
        resume: expect.any(Object),
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

test("solution-only selection allows supporting-lemma checks with a complete root nomination", async () => {
  let a = "",
    b = "";
  const run = await fixture(
    (request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        a = `${descriptor.input.namespace}.1`;
        b = `${descriptor.input.namespace}.2`;
        return {
          notes: [
            {
              text: "Supporting lemma.",
              summary: "Partial prerequisite.",
              support: [],
            },
            {
              text: "Complete conditional solution.",
              summary: "Meets the task if the lemma holds.",
              support: [a],
            },
          ],
        };
      }
      if (descriptor.kind === "selection")
        return {
          verify: [
            { note: a, verifiers: ["source", "correctness", "reconstruction"] },
            ...(descriptor.input.notes.some((note) => note.id === b)
              ? [{ note: b, verifiers: all }]
              : []),
          ],
        };
      return complete(request);
    },
    {
      automatic: true,
      settings: {
        maxWorkers: 2,
        maxExplorerTurns: 1,
        verifyOnSolution: true,
      },
    },
  );
  await run.owner.root.waitForIdle(context);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "accepted",
    accepted: b,
  });
  const selections = run.requests.filter(
    ({ descriptor }) => descriptor.kind === "selection",
  );
  expect(selections).toHaveLength(2);
  expect(
    selections.map(({ descriptor }) => descriptor.input.notes.length).sort(),
  ).toEqual([1, 2]);
  const book = await run.book();
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === a)
      .map((value) => value.verifier),
  ).toEqual(["source", "correctness", "reconstruction"]);
  expect(new Set(book.checks.map((check) => check.candidate)).size).toBe(1);
  expect(project(book).accepted).toEqual([b]);
});

test("a no-work selection does not repeat on an unchanged notebook", async () => {
  const run = await fixture(
    (request) =>
      request.descriptor.kind === "selection"
        ? { verify: [] }
        : complete(request),
    {
      automatic: true,
      settings: { maxWorkers: 1, maxExplorerTurns: 1 },
    },
  );
  await run.owner.root.waitForIdle(context);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "turn-limit",
    turns: 1,
  });
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(1);
  expect((await run.book()).checks).toEqual([]);
});

test("verification drains multiple windows after the exploration limit", async () => {
  const run = await fixture(
    (request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer")
        return {
          notes: ["First", "Second", "Third"].map((name) => ({
            text: `${name} useful intermediate lemma, with its complete proof.`,
            summary: `${name} intermediate lemma.`,
            support: [],
          })),
        };
      if (descriptor.kind === "selection")
        return {
          verify: descriptor.input.notes
            .filter((note) => !note.checked)
            .map((note) => ({
              note: note.id,
              verifiers: ["source", "correctness", "reconstruction"],
            })),
        };
      return complete(request);
    },
    {
      automatic: true,
      settings: { maxWorkers: 1, maxExplorerTurns: 1, window: 1 },
    },
  );
  await run.owner.root.waitForIdle(context);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "turn-limit",
    turns: 1,
  });
  const book = await run.book();
  const projected = project(book);
  expect(projected.notes).toHaveLength(3);
  expect(projected.notes.every((note) => note.checked && note.verified)).toBe(
    true,
  );
  expect(projected.accepted).toEqual([]);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "explorer"),
  ).toHaveLength(1);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(3);
  expect(book.checks).toHaveLength(9);
  expect(new Set(book.checks.map((check) => check.candidate)).size).toBe(3);
  for (const note of projected.notes)
    expect(
      book.checks
        .flatMap((check) => check.values)
        .filter((value) => value.note === note.id)
        .map((value) => value.verifier),
    ).toEqual(["source", "correctness", "reconstruction"]);
});

test("INCONCLUSIVE checks do not create a new selection frontier", async () => {
  const run = await fixture(
    (request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "verifier" && descriptor.name === "source")
        return {
          verdicts: descriptor.judged.map((note) => ({
            note,
            verdict: "INCONCLUSIVE",
            report: "The same unresolved source obligation remains.",
          })),
        };
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 1, maxExplorerTurns: 1 } },
  );
  await run.owner.root.waitForIdle(context);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(1);
  expect((await run.book()).checks).toHaveLength(1);
});

test.each(["inconclusive", "local-only"])(
  "a new publication permits an earlier %s note to receive a fresh full attempt",
  async (earlier) => {
    let firstNote = "",
      explorerCalls = 0,
      selectionCalls = 0,
      sourceCalls = 0;
    const run = await fixture(
      (request): ReturnType<Respond> => {
        const { descriptor } = request;
        if (descriptor.kind === "explorer") {
          if (++explorerCalls === 1)
            firstNote = `${descriptor.input.namespace}.1`;
          return complete(request);
        }
        if (descriptor.kind === "selection") {
          expect(
            descriptor.input.notes.some((note) => note.id === firstNote),
          ).toBe(true);
          selectionCalls++;
          return {
            verify: [
              {
                note: firstNote,
                verifiers:
                  earlier === "local-only" && selectionCalls === 1
                    ? ["source", "correctness", "reconstruction"]
                    : all,
              },
            ],
          };
        }
        if (descriptor.kind === "verifier" && descriptor.name === "source") {
          sourceCalls++;
          if (earlier === "inconclusive" && sourceCalls === 1)
            return {
              verdicts: [
                {
                  note: firstNote,
                  verdict: "INCONCLUSIVE",
                  report: "Unresolved before the next exploration.",
                },
              ],
            };
        }
        return complete(request);
      },
      { automatic: true, settings: { maxWorkers: 1, maxExplorerTurns: 2 } },
    );
    await run.owner.root.waitForIdle(context);
    expect(await inspect(run.path, readStatus)).toMatchObject({
      outcome: "accepted",
      accepted: firstNote,
      turns: 2,
    });
    expect(explorerCalls).toBe(2);
    expect(selectionCalls).toBe(2);
    expect(sourceCalls).toBe(2);
    const checks = (await run.book()).checks;
    const attempts = [...new Set(checks.map((check) => check.candidate))];
    expect(attempts).toHaveLength(2);
    expect(
      checks
        .filter((check) => check.candidate === attempts[1])
        .flatMap((check) => check.values)
        .map((value) => value.verifier),
    ).toEqual(all);
  },
);

test("a busy result does not spin while its only target remains claimed", async () => {
  const checking = Promise.withResolvers<void>();
  const busySettled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let target = "";
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer")
        target = `${descriptor.input.namespace}.1`;
      if (descriptor.kind === "verifier" && descriptor.name === "source") {
        checking.resolve();
        await Promise.race([release.promise, abortable(request.signal)]);
      }
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 1 } },
  );
  // Explicit callers can race on one target; the controller must drain that
  // real busy outcome without repeatedly dispatching the same claimed note.
  const createGroup = run.owner.workers.createGroup.bind(run.owner.workers);
  let assigned = false;
  const assignments = spyOn(
    run.owner.workers,
    "createGroup",
  ).mockImplementation((tx, root, requests, owner, eligible) => {
    if (
      !assigned &&
      owner !== undefined &&
      requests.some((request) => request.kind === "verifier")
    ) {
      assigned = true;
      return createGroup(
        tx,
        root,
        [
          { kind: "verifier", verify: [{ note: target, verifiers: all }] },
          { kind: "verifier", verify: [{ note: target, verifiers: all }] },
        ],
        owner,
        eligible,
      );
    }
    return createGroup(tx, root, requests, owner, eligible);
  });
  const observation = run.owner.harness.observeCommits({
    advance: ({ changes }) => {
      for (const change of changes) {
        if (change.type !== "task") continue;
        const task = change.value;
        if (
          task.kind === "xean.worker" &&
          task.state.status === "terminal" &&
          task.state.outcome.status === "completed" &&
          (task.state.outcome.result as { status?: string } | undefined)
            ?.status === "busy"
        )
          busySettled.resolve();
      }
    },
    end: (end) => {
      if (end.kind === "listener_error") busySettled.reject(end.error);
    },
  });
  const done = run.owner.root.waitForIdle(context);
  try {
    await observed(checking.promise, "checking call");
    await observed(busySettled.promise, "busy result");
    const calls = run.provider.state.callCount;
    await Bun.sleep(30);
    expect(run.provider.state.callCount).toBe(calls);
    const records = await run.tasks();
    expect(
      records.filter(
        (task: { input: { kind?: string } }) => task.input.kind === "verifier",
      ),
    ).toHaveLength(2);
    expect(
      records.find((task: { kind: string }) => task.kind === "xean.campaign")
        .state,
    ).toMatchObject({ status: "running", checkpoint: { phase: "wait" } });
  } finally {
    release.resolve();
    observation.detach();
    assignments.mockRestore();
    await done;
  }
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "accepted",
    turns: 1,
  });
});

test("an in-flight Explorer consumes the remaining exploration allowance after no-work", async () => {
  const secondStarted = Promise.withResolvers<void>();
  const noWork = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let explorers = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "explorer") {
        expect(++explorers).toBeLessThanOrEqual(2);
        if (explorers === 2) {
          secondStarted.resolve();
          await Promise.race([release.promise, abortable(request.signal)]);
        }
      }
      return request.descriptor.kind === "selection"
        ? { verify: [] }
        : complete(request);
    },
    { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 2 } },
  );
  const observer = run.owner.harness.observeCommits({
    advance: ({ changes }) => {
      for (const change of changes)
        if (change.type === "task") {
          const task = change.value;
          if (
            task.kind === "xean.worker" &&
            task.state.status === "terminal" &&
            task.state.outcome.status === "completed" &&
            (task.state.outcome.result as { status?: string } | undefined)
              ?.status === "no-work"
          )
            noWork.resolve();
        }
    },
    end: (end) => {
      if (end.kind === "listener_error") noWork.reject(end.error);
    },
  });
  const done = run.owner.root.waitForIdle(context);
  try {
    await observed(secondStarted.promise, "second Explorer");
    await observed(noWork.promise, "no-work result");
    await Bun.sleep(30);
    expect(explorers).toBe(2);
    const campaign = (await run.tasks()).find(
      (task: { kind: string }) => task.kind === "xean.campaign",
    );
    expect(campaign.state).toMatchObject({
      status: "running",
      checkpoint: { phase: "wait" },
    });
  } finally {
    release.resolve();
    observer.detach();
    await done;
  }
  expect(explorers).toBe(2);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "turn-limit",
    turns: 2,
  });
});

test("a child completed before wait snapshots is reconciled without waiting for its hung peer", async () => {
  const waitEntered = Promise.withResolvers<void>();
  const resumeWait = Promise.withResolvers<void>();
  const bothExplorers = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const releaseSecond = Promise.withResolvers<void>();
  const verificationStarted = Promise.withResolvers<void>();
  let explorerCalls = 0,
    firstNamespace = "",
    intercepted = false;
  let restorePhase = () => {};
  const originalFactory = workflow.createWorkflow;
  const factory = spyOn(workflow, "createWorkflow").mockImplementation(
    (options) => {
      const value = originalFactory(options);
      const phases = value.extension.tasks!.find(
        (task) => task.definition.name === "xean.campaign",
      )!.definition.phases as CampaignPhases;
      const original = phases.wait;
      const wait = spyOn(phases, "wait").mockImplementation(
        async (task, runtime, ctx) => {
          if (!intercepted) {
            intercepted = true;
            waitEntered.resolve();
            await Promise.race([resumeWait.promise, abortable(runtime.signal)]);
            runtime.signal.throwIfAborted();
          }
          return original(task, runtime, ctx);
        },
      );
      restorePhase = () => wait.mockRestore();
      return value;
    },
  );
  try {
    const run = await fixture(
      async (request): Promise<Awaited<ReturnType<Respond>>> => {
        if (request.descriptor.kind === "explorer") {
          const first = ++explorerCalls === 1;
          if (first) firstNamespace = request.descriptor.input.namespace;
          if (explorerCalls === 2) bothExplorers.resolve();
          await Promise.race([
            (first ? releaseFirst : releaseSecond).promise,
            abortable(request.signal),
          ]);
        }
        if (
          request.descriptor.kind === "verifier" &&
          request.descriptor.name === "source"
        )
          verificationStarted.resolve();
        return complete(request);
      },
      { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 2 } },
    );
    factory.mockRestore();
    const done = run.owner.root.waitForIdle(context);
    try {
      await observed(
        waitEntered.promise,
        "Campaign wait phase before its child snapshots",
      );
      await observed(bothExplorers.promise, "both blocked Explorers");
      releaseFirst.resolve();
      const first = (await run.tasks()).find(
        (task: { id: number }) => `w${task.id}` === firstNamespace,
      );
      expect((await run.wait(first.id)).state.outcome.status).toBe("completed");
      resumeWait.resolve();
      await observed(
        verificationStarted.promise,
        "verification before the second Explorer finishes",
      );
      expect((await inspect(run.path, readStatus)).status).not.toBe("terminal");
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      resumeWait.resolve();
      await done;
    }
    expect(await inspect(run.path, readStatus)).toMatchObject({
      outcome: "accepted",
      turns: 2,
    });
  } finally {
    factory.mockRestore();
    restorePhase();
  }
});

test("an abort before worker admission resumes from an empty child list", async () => {
  const entered = Promise.withResolvers<void>();
  let restorePhase = () => {};
  const originalFactory = workflow.createWorkflow;
  const factory = spyOn(workflow, "createWorkflow").mockImplementation(
    (options) => {
      const value = originalFactory(options);
      const phases = value.extension.tasks!.find(
        (task) => task.definition.name === "xean.campaign",
      )!.definition.phases as CampaignPhases;
      const run = spyOn(phases, "run").mockImplementation(
        async (_task, runtime) => {
          entered.resolve();
          await abortable(runtime.signal);
          runtime.signal.throwIfAborted();
        },
      );
      restorePhase = () => run.mockRestore();
      return value;
    },
  );
  try {
    const run = await fixture(complete, {
      automatic: true,
      settings: { maxWorkers: 1, maxExplorerTurns: 1 },
    });
    factory.mockRestore();
    const idle = run.owner.root.waitForIdle(context);
    await observed(
      entered.promise,
      "initial Campaign invocation before admission",
    );
    const campaign = (await run.tasks()).find(
      (task: { kind: string }) => task.kind === "xean.campaign",
    );
    expect(run.provider.state.callCount).toBe(0);
    await run.owner.harness.abortTask(campaign.id, context);
    await idle;
    expect(
      (await run.tasks()).find(
        (task: { id: number }) => task.id === campaign.id,
      ).state.outcome,
    ).toMatchObject({
      status: "aborted",
      result: { outcome: "call-failure", resume: { children: [] } },
    });
    restorePhase();
    await run.owner.resume();
    await run.owner.root.waitForIdle(context);
    expect(await inspect(run.path, readStatus)).toMatchObject({
      outcome: "accepted",
      turns: 1,
    });
    expect(
      run.requests.filter(({ descriptor }) => descriptor.kind === "explorer"),
    ).toHaveLength(1);
  } finally {
    factory.mockRestore();
    restorePhase();
  }
});

test("deferred verification drains windowed support through its full ancestry without rechecking the root", async () => {
  let x = "",
    a = "",
    b = "",
    selections = 0;
  const local = ["source", "correctness", "reconstruction"] as const;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        x = `${descriptor.input.namespace}.1`;
        a = `${descriptor.input.namespace}.2`;
        b = `${descriptor.input.namespace}.3`;
        return {
          notes: [
            {
              text: "Long foundational argument. ".repeat(20),
              summary: "Foundational lemma X.",
              support: [],
            },
            {
              text: "Proof of A assuming X.",
              summary: "Supporting lemma A.",
              support: [x],
            },
            {
              text: "Complete proof B assuming A.",
              summary: "Completes the task.",
              support: [a],
            },
          ],
        };
      }
      if (descriptor.kind === "selection") {
        if (++selections === 1)
          return {
            verify: [
              { note: b, verifiers: all },
              { note: a, verifiers: [...local] },
              { note: x, verifiers: [...local] },
            ],
          };
        expect(selections).toBeLessThanOrEqual(3);
        expect(descriptor.input.notes.map((note) => note.id)).toEqual(
          selections === 2 ? [x, a] : [x],
        );
        expect(new Set(descriptor.input.nominatedSupport)).toEqual(
          new Set([x, a]),
        );
        const interim = project(await run.book());
        expect(interim.accepted).toEqual([]);
        expect(interim.notes.find((note) => note.id === b)).toMatchObject({
          checked: true,
          verified: false,
        });
        return {
          verify:
            selections === 2
              ? [
                  { note: a, verifiers: [...local] },
                  { note: x, verifiers: [...local] },
                ]
              : [{ note: x, verifiers: [...local] }],
        };
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: {
        maxWorkers: 1,
        maxExplorerTurns: 1,
        verifyOnSolution: true,
        window: 80,
      },
    },
  );
  await run.owner.root.waitForIdle(context);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "accepted",
    accepted: b,
    turns: 1,
  });
  const claims = (await run.tasks()).filter(
    (task: { input: { kind?: string } }) => task.input.kind === "verify",
  );
  expect(
    claims.map((task: { input: { input: { verify: { note: string }[] } } }) =>
      task.input.input.verify.map((entry) => entry.note),
    ),
  ).toEqual([[b], [a], [x]]);
  expect(selections).toBe(3);
  const book = await run.book();
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === b)
      .map((value) => value.verifier),
  ).toEqual(all);
  expect(project(book).notes.every((note) => note.verified)).toBe(true);
});

test("a later solution nomination reoffers support declined earlier in the same publication", async () => {
  const declined = Promise.withResolvers<void>();
  let a = "",
    b = "",
    declines = 0,
    supportSelections = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        a = `${descriptor.input.namespace}.1`;
        b = `${descriptor.input.namespace}.2`;
        return {
          notes: [
            {
              text: "Long prerequisite argument. ".repeat(20),
              summary: "Supporting lemma A.",
              support: [],
            },
            {
              text: "Complete proof of B assuming A.",
              summary: "Completes the task.",
              support: [a],
            },
          ],
        };
      }
      if (descriptor.kind === "selection") {
        if (descriptor.input.notes.some((note) => note.id === b)) {
          await observed(
            declined.promise,
            "A-only no-work before solution nomination",
          );
          return {
            verify: [
              { note: b, verifiers: all },
              {
                note: a,
                verifiers: ["source", "correctness", "reconstruction"],
              },
            ],
          };
        }
        expect(descriptor.input.notes.map((note) => note.id)).toEqual([a]);
        if (!descriptor.input.nominatedSupport?.includes(a)) {
          expect(++declines).toBe(1);
          return { verify: [] };
        }
        expect(++supportSelections).toBe(1);
        return {
          verify: [
            { note: a, verifiers: ["source", "correctness", "reconstruction"] },
          ],
        };
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: {
        maxWorkers: 2,
        maxExplorerTurns: 1,
        verifyOnSolution: true,
        window: 80,
      },
    },
  );
  const observation = run.owner.harness.observeCommits({
    advance: ({ changes }) => {
      for (const change of changes) {
        if (change.type !== "task") continue;
        const task = change.value;
        if (
          task.kind === "xean.worker" &&
          task.state.status === "terminal" &&
          task.state.outcome.status === "completed" &&
          (task.state.outcome.result as { status?: string } | undefined)
            ?.status === "no-work"
        )
          declined.resolve();
      }
    },
    end: (end) => {
      if (end.kind === "listener_error") declined.reject(end.error);
    },
  });
  try {
    await run.owner.root.waitForIdle(context);
  } finally {
    observation.detach();
  }
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "accepted",
    accepted: b,
    turns: 1,
  });
  expect(declines).toBe(1);
  expect(supportSelections).toBe(1);
  const book = await run.book();
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === b)
      .map((value) => value.verifier),
  ).toEqual(all);
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === a)
      .map((value) => value.verifier),
  ).toEqual(["source", "correctness", "reconstruction"]);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "explorer"),
  ).toHaveLength(1);
});

test("a completing child with an outcome still waits for its owned work to settle", async () => {
  const phases = createWorkflow().extension.tasks!.find(
    (task) => task.definition.name === "xean.campaign",
  )!.definition.phases as CampaignPhases;
  const finished = Promise.withResolvers<void>();
  const waits: number[] = [];
  let commits = 0;
  const current = {
    state: {
      checkpoint: {
        phase: "wait",
        children: [11, 12],
        turns: 0,
        guidanceThrough: 0,
        publicationCount: 0,
        afterWorkerId: 0,
      },
    },
  } as Parameters<typeof phases.wait>[0];
  const runtime = {
    async getTask(id: number) {
      return id === 11
        ? {
            id,
            state: {
              status: "completing",
              outcome: { status: "completed", result: null },
            },
          }
        : { id, state: { status: "running", checkpoint: {} } };
    },
    async waitForTask(id: number) {
      waits.push(id);
      await finished.promise;
    },
    async commit(advance: (tx: unknown, task: typeof current) => unknown) {
      commits++;
      expect(advance(undefined, current)).toMatchObject({
        status: "running",
        checkpoint: { phase: "run" },
      });
    },
  } as unknown as Parameters<typeof phases.wait>[1];
  const pending = phases.wait(current, runtime, context);
  try {
    await Bun.sleep(0);
    expect(waits).toEqual([11, 12]);
    expect(commits).toBe(0);
  } finally {
    finished.resolve();
    await pending;
  }
  expect(commits).toBe(1);
});
