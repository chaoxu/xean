import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
} from "@earendil-works/chord/context";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
  Harness,
  ToolResultEntry,
  type EntryId,
  type Storage,
  type TaskId,
  type TaskState,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { inspect, open } from "../src/host.ts";
import {
  createResearch,
  scanTasks,
  Control,
  blockedDecision,
  pendingDecisions,
  type Roles,
} from "../src/workflow.ts";
import { DefinitionDoc } from "../src/definition.ts";
import { Bodies, Catalog, readSnapshot, readView } from "../src/math/state.ts";
import { readReport } from "../src/report.ts";
import { RoleFailure } from "../src/roles/types.ts";
import type { Note } from "../src/math/contracts.ts";
import { createRuntime } from "../src/config.ts";
import { createRoles } from "../src/roles/index.ts";
import { closedBookResearch } from "../src/roles/research.ts";

const task = {
  problem: "Prove 1 = 1.",
  completionCriteria: "A self-contained proof of the exact equality.",
};
const settings = {
  profiles: { default: { provider: "openai" as const, model: "gpt-6-astra" } },
};
const empty = () => ({ kind: "notes" as const, notes: [], candidate: false });
const draft = (id = "n1") => ({
  id,
  summary: "Reflexivity",
  detailedSummary: "Equality is reflexive.",
  text: "1 = 1\n\nBy reflexivity, 1 = 1.",
  support: [],
});

async function setup(
  replacements: Partial<Roles> = {},
  storage: Storage = new MemoryStorage(),
) {
  const roles: Roles = {
    capabilities: () => ({ explorer: true, literature: false, codex: false }),
    coordinator: async () => ({ work: null }),
    explorer: async () => empty(),
    verifier: async () => ({ kind: "verification", checks: [] }),
    literature: async () => empty(),
    codex: async () => empty(),
    reconstruct: async () => ({ kind: "verification", checks: [] }),
    review: async () => ({ verdict: "INCONCLUSIVE", report: "Fixture" }),
    ...replacements,
  };
  let harness!: Harness;
  const research = createResearch(roles);
  const registry = createRegistry();
  registry.install(research.extension);
  harness = await Harness.open(
    storage,
    { registry, models: createModels() },
    context,
  );
  const root = await harness.root(context, {
    init: async (tx, root) => {
      Object.assign(await tx.doc(DefinitionDoc, root), { task, settings });
      await tx.doc(Control, root);
    },
  });
  return {
    research,
    harness,
    registry,
    root,
    view: () => harness.commit((tx) => readView(tx, root.id), context),
  };
}

test.each([
  [1, null],
  [1, "legacy/n1"],
  [2, null],
  [2, { candidateId: "legacy/n1", snapshotEntry: 1 }],
  [3, null],
  [3, { candidateId: "legacy/n1", snapshotEntry: 1 }],
] as const)(
  "old notebook Control rejects opening and inspection without changes: %s",
  async (version, accepted) => {
    const directory = await temporaryDirectory("workflow-old-control-");
    const path = join(directory, "campaign.sqlite");
    const LegacyControl = defineDoc({
      kind: "research.control",
      version,
      scope: "conversation",
      history: "latest",
      fork: "current",
      initial: () => ({ paused: false, cancelled: false, accepted }),
    });
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "gpt-6-astra" }],
    });
    const models = createModels();
    models.setProvider(faux.provider);
    const legacy = await Harness.open(
      await openNodeSqliteStorage(path),
      { models, registry: createRegistry() },
      context,
    );
    try {
      await legacy.root(context, {
        init: async (tx, root) => {
          Object.assign(await tx.doc(DefinitionDoc, root), { task, settings });
          await tx.doc(LegacyControl, root);
          await tx.appendEntry(root, {
            kind: "research.legacy-evidence",
            data: { text: "Preserve the historical notebook." },
          });
        },
      });
    } finally {
      await legacy.close(context);
    }
    const before = await Bun.file(path).bytes();
    const incompatible = new RegExp(
      `research\\.control.*requires migration from version ${version}`,
    );
    let inspected = false;
    await expect(
      inspect(path, () => {
        inspected = true;
      }),
    ).rejects.toThrow(incompatible);
    expect(inspected).toBe(false);
    expect(await Bun.file(path).bytes()).toEqual(before);
    await expect(
      open(path, { models }).then((owner) => owner.close()),
    ).rejects.toThrow(incompatible);
    expect(await Bun.file(path).bytes()).toEqual(before);
    expect(faux.state.callCount).toBe(0);
  },
);

test.each(["empty", "independent", "retired-support"] as const)(
  "literature after retiring an existing dependency: %s",
  async (resultKind) => {
    let searched = false;
    const retiredId = "input/seed/n1";
    const builtins = createRoles(
      {
        profiles: createRuntime(settings, { models: createModels() }).profiles,
        literature: true,
      },
      {
        ...closedBookResearch,
        retrieval: true,
        async literature(input) {
          searched = true;
          expect(input.notes.map((note) => note.id)).toEqual(["input/seed/n2"]);
          return {
            notes:
              resultKind === "empty"
                ? []
                : [
                    {
                      ...draft("n1"),
                      support:
                        resultKind === "retired-support" ? [retiredId] : [],
                    },
                  ],
          };
        },
      },
    );
    const owner = await setup({
      capabilities: () => ({ explorer: true, literature: true, codex: false }),
      coordinator: async ({ notes }) => ({
        work: !notes.find((note: Note) => note.id === retiredId)?.retired
          ? { kind: "explorer", guidance: "Retire the old supporting note." }
          : searched
            ? null
            : { kind: "literature", query: "Find independent evidence." },
      }),
      explorer: async ({ notes }) => ({
        ...empty(),
        edits: [
          {
            id: retiredId,
            revision: notes.find((note: Note) => note.id === retiredId)!
              .revision,
            retired: true,
          },
        ],
      }),
      literature: builtins.literature,
    });
    try {
      await owner.root.commit(
        (tx) =>
          owner.research.input(tx, owner.root.id, {
            kind: "submit",
            id: "seed",
            candidate: false,
            notes: [draft("n1"), { ...draft("n2"), support: ["n1"] }],
          }),
        context,
      );
      await owner.root.waitForIdle(context);
      const report = await owner.root.commit(
        (tx) => readReport(tx, owner.root.id),
        context,
      );
      expect(searched).toBe(true);
      const work = report.work.find((worker) => worker.role === "literature")!;
      expect(work.status).toBe(
        resultKind === "retired-support" ? "failed" : "completed",
      );
      if (resultKind === "retired-support")
        expect(work.error).toContain("retired support");
      expect(report.notes.find((note) => note.id === retiredId)?.retired).toBe(
        true,
      );
      expect(
        report.notes.find((note) => note.id === "input/seed/n2")?.support,
      ).toEqual([retiredId]);
    } finally {
      await owner.harness.close(context);
    }
  },
);

test("input admission reads only edited bodies and keeps command IDs in native entries", async () => {
  const owner = await setup();
  const bodies = new Set<string>();
  const input = (command: unknown) => {
    bodies.clear();
    return owner.root.commit(
      (tx) =>
        owner.research.input(
          new Proxy(tx, {
            get(target, key) {
              if (key === "doc")
                return (...args: any[]) => {
                  if (args[0] === Bodies) bodies.add(args[2]);
                  return Reflect.apply(target.doc, target, args);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
          owner.root.id,
          command,
        ),
      context,
    );
  };
  try {
    await input({
      kind: "submit",
      id: "seed",
      notes: [draft("n1"), draft("n2")],
      candidate: false,
    });
    const note = (await owner.view()).notes[0]!;
    const guide = { kind: "guide", id: "hint", text: "Check the proof." };
    const receipt = await input(guide);
    expect([...bodies]).toEqual([]);
    expect(await input(guide)).toBe(receipt);
    expect([...bodies]).toEqual([]);
    await expect(input({ ...guide, text: "Different hint." })).rejects.toThrow(
      "Input ID already has another value",
    );
    expect([...bodies]).toEqual([]);
    const correction = {
      kind: "correct",
      id: "same",
      note: note.id,
      revision: note.revision,
      summary: note.summary,
      detailedSummary: note.detailedSummary,
      text: note.text,
    };
    await input(correction);
    expect([...bodies]).toEqual([note.id]);
    expect((await owner.view()).notes[0]!.revision).toBe(note.revision);
    await input({
      ...correction,
      id: "changed",
      text: "A different proof of reflexivity.",
    });
    expect([...bodies]).toEqual([note.id]);
    const edited = (await owner.view()).notes[0]!;
    expect(edited.revision).toBeGreaterThan(note.revision);
    expect(edited.imported).toBe(true);
    await expect(input({ ...correction, id: "stale" })).rejects.toThrow(
      "Stale note revision",
    );
    expect([...bodies]).toEqual([]);
    const refs = await owner.root.commit(
      async (tx) =>
        (await tx.doc(Catalog, owner.root.id)).inputs.map((ref) =>
          Object.keys(ref),
        ),
      context,
    );
    expect(refs).toEqual(Array.from({ length: 4 }, () => ["entry"]));
  } finally {
    await owner.harness.close(context);
  }
});

test.each(["completed", "stale"])(
  "report attributes native Explorer edits only after publication: %s",
  async (mode) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let invoked = false;
    const owner = await setup({
      coordinator: async () => ({
        work: invoked
          ? null
          : { kind: "explorer", guidance: "Improve the proof." },
      }),
      explorer: async ({ notes }, runtime, invocation) => {
        invoked = true;
        const note = notes[0] as Note;
        const entries: EntryId[] = [];
        await runtime.commit(async (tx) => {
          const conversation = await tx.createConversation({
            ownership: { kind: "task", taskId: runtime.taskId },
          });
          for (const details of [
            {
              notes: [],
              candidate: false,
              edits: [
                {
                  id: note.id,
                  revision: note.revision,
                  text: "Updated proof.",
                },
              ],
            },
            {
              notes: [draft()],
              candidate: false,
              edits: [
                {
                  id: note.id,
                  revision: note.revision,
                  summary: "Updated summary.",
                },
              ],
            },
          ])
            entries.push(
              (
                await tx.appendEntry(ToolResultEntry, conversation.id, {
                  data: { diagnostics: [] },
                  model: [
                    {
                      role: "toolResult",
                      toolCallId: `fixture-${entries.length}`,
                      toolName: "submit_explorer",
                      content: [],
                      details,
                      isError: false,
                      timestamp: Date.now(),
                    },
                  ],
                })
              ).id,
            );
        }, invocation);
        started.resolve();
        await release.promise;
        return { kind: "submissions", entries };
      },
    });
    const report = () =>
      owner.root.commit((tx) => readReport(tx, owner.root.id), context);
    try {
      await owner.root.commit(
        (tx) =>
          owner.research.input(tx, owner.root.id, {
            kind: "submit",
            id: "seed",
            notes: [draft()],
            candidate: false,
          }),
        context,
      );
      owner.harness.resume();
      await started.promise;
      const privateReport = await report();
      expect(privateReport.work[0]!.noteIds).toEqual([]);
      expect(privateReport.notes).toHaveLength(1);
      const note = privateReport.notes[0]!;
      if (mode === "stale")
        await owner.root.commit(
          (tx) =>
            owner.research.input(tx, owner.root.id, {
              kind: "correct",
              id: "concurrent",
              note: note.id,
              revision: note.revision,
              summary: note.summary,
              detailedSummary: note.detailedSummary,
              text: "Caller changed the frozen proof.",
            }),
          context,
        );
      release.resolve();
      await owner.harness.waitForIdle(context);
      const published = await report();
      const worker = published.work[0]!;
      expect(worker.status).toBe(mode === "completed" ? "completed" : "failed");
      expect(worker.noteIds).toEqual(
        mode === "completed" ? [`${worker.id}/n1`, note.id] : [],
      );
      expect(published.notes.find(({ id }) => id === note.id)!.text).toBe(
        mode === "completed"
          ? "Updated proof."
          : "Caller changed the frozen proof.",
      );
    } finally {
      release.resolve();
      await owner.harness.close(context);
    }
  },
);

test.each(["cancelled", "accepted", "blocked"] as const)(
  "input retries and rollback preserve a %s campaign",
  async (state) => {
    const owner = await setup(
      state === "blocked"
        ? {
            coordinator: async () => {
              throw new Error("Blocked decision fixture");
            },
          }
        : {},
    );
    const input = (value: unknown) =>
      owner.root.commit(
        (tx) => owner.research.input(tx, owner.root.id, value),
        context,
      );
    const seed = {
      kind: "submit",
      id: "seed",
      notes: [draft()],
      candidate: false,
      edits: undefined,
    };
    try {
      const receipt = await input(seed);
      await owner.root.waitForIdle(context);
      if (state !== "blocked")
        await owner.root.commit(async (tx) => {
          const control = await tx.doc(Control, owner.root.id);
          if (state === "cancelled") control.cancelled = true;
          else
            control.accepted = {
              candidateId: "input/seed/n1",
              snapshotEntry: receipt,
            };
        }, context);
      const before = await owner.view();
      expect(await input(seed)).toBe(receipt);
      await expect(
        input({ ...seed, id: "invalid", edits: null }),
      ).rejects.toThrow("Invalid value");
      await expect(input({ ...seed, candidate: true })).rejects.toThrow(
        "Input ID already has another value",
      );
      const note = before.notes[0]!;
      await expect(
        input({
          kind: "correct",
          id: "late",
          note: note.id,
          revision: note.revision,
          summary: "Changed",
          detailedSummary: "Changed",
          text: "Changed mathematical content",
        }),
      ).rejects.toThrow(state === "blocked" ? "blocked" : "terminal");
      expect(await owner.view()).toEqual(before);
      expect(
        (
          await owner.root.commit((tx) => scanTasks(tx, owner.root.id), context)
        ).filter((task) => task.kind === "research.coordinator"),
      ).toHaveLength(1);
    } finally {
      await owner.harness.close(context);
    }
  },
);

test("standalone resume serializes and reuses completed work", async () => {
  let calls = 0;
  const { research, harness, root } = await setup({
    explorer: async () => {
      calls++;
      return { ...empty(), notes: [draft()] };
    },
  });
  try {
    await root.commit(async (tx) => {
      (await tx.doc(DefinitionDoc, root.id)).mode = {
        role: "explorer",
        input: { notes: [], guidance: "Prove the claim" },
      };
      return research.initialize(tx, root.id);
    }, context);
    for (const settled of [false, true]) {
      if (settled) await harness.waitForIdle(context);
      await root.commit((tx) => research.resume(tx, root.id), context);
    }
    await harness.waitForIdle(context);
    await root.commit((tx) => research.resume(tx, root.id), context);
    await harness.waitForIdle(context);
    expect(calls).toBe(1);
    const report = await root.commit((tx) => readReport(tx, root.id), context);
    expect(report.status.status).toBe("completed");
    expect(report.work).toHaveLength(1);
    expect(report.work[0]!.noteIds).toEqual([]);
    expect(report.notes).toEqual([]);
  } finally {
    await harness.close(context);
  }
});

test("Coordinator waits for the worker outcome before handling inputs and choosing again", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let working = false;
  const decisions: string[][] = [];
  const { research, harness, root } = await setup({
    coordinator: async (input) => {
      expect(working).toBe(false);
      decisions.push(input.notes.map((note: Note) => note.summary));
      return {
        work: input.notes.length
          ? null
          : { kind: "explorer", guidance: "Complete the claim" },
      };
    },
    explorer: async () => {
      expect(working).toBe(false);
      working = true;
      started.resolve();
      await release.promise;
      working = false;
      return { kind: "notes", notes: [draft()], candidate: false };
    },
  });
  try {
    await root.commit((tx) => research.initialize(tx, root.id), context);
    harness.resume();
    await started.promise;
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "during-worker",
          text: "Use this after the worker returns",
        }),
      context,
    );
    for (let i = 0; i < 3; i++)
      await root.commit((tx) => research.resume(tx, root.id), context);
    release.resolve();
    await harness.waitForIdle(context);
    expect(decisions[0]).toEqual([]);
    expect(decisions.length).toBe(2);
    expect(
      decisions.slice(1).every((notes) => notes[0] === "Reflexivity"),
    ).toBe(true);
    const tasks = await root.commit((tx) => scanTasks(tx, root.id), context);
    expect(
      tasks.filter((task) => task.kind === "research.worker"),
    ).toHaveLength(1);
    expect(blockedDecision(tasks)).toBeUndefined();
  } finally {
    release.resolve();
    await harness.close(context);
  }
});

test("inputs during a decision share one fresh successor and discard its stale plan", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const decisions: { id: TaskId; guidance: string[] }[] = [];
  let workers = 0;
  const { research, harness, root } = await setup({
    coordinator: async (input, runtime) => {
      decisions.push({ id: runtime.taskId, guidance: input.guidance });
      if (decisions.length === 1) {
        started.resolve();
        await release.promise;
        return { work: { kind: "explorer", guidance: "This plan is stale" } };
      }
      return { work: null };
    },
    explorer: async () => {
      workers++;
      return empty();
    },
  });
  try {
    await root.commit((tx) => research.initialize(tx, root.id), context);
    harness.resume();
    await started.promise;
    for (const id of ["first", "second"]) {
      await root.commit(
        (tx) => research.input(tx, root.id, { kind: "guide", id, text: id }),
        context,
      );
      expect(
        (await root.commit((tx) => research.resume(tx, root.id), context)).map(
          String,
        ),
      ).toEqual([String(decisions[0]!.id)]);
    }
    expect(
      pendingDecisions(
        await root.commit((tx) => scanTasks(tx, root.id), context),
      ),
    ).toHaveLength(1);
    release.resolve();
    await harness.waitForIdle(context);
    expect(decisions.map(({ guidance }) => guidance)).toEqual([
      [],
      ["first", "second"],
    ]);
    expect(decisions[0]!.id).not.toBe(decisions[1]!.id);
    expect(workers).toBe(0);
    expect(
      (await root.commit((tx) => readReport(tx, root.id), context)).status,
    ).toMatchObject({ status: "idle", pendingDecisions: 0 });
  } finally {
    release.resolve();
    await harness.close(context);
  }
});

test("Coordinator waits for a completing worker until its child drains", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completing = Promise.withResolvers<TaskId>();
  const decision = Promise.withResolvers<{
    id: TaskId;
    state: TaskState<unknown, unknown>;
  }>();
  const Child = defineTask<null, { phase: "run" }, null>({
    name: "fixture.worker-child",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(_task, runtime, invocation) {
        started.resolve();
        await awaitWithContext(release.promise, invocation);
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
  let calls = 0;
  let workerId: TaskId | undefined;
  const { research, harness, registry, root } = await setup({
    explorer: async (_input, runtime, invocation) => {
      calls++;
      await runtime.commit(async (tx) => {
        await tx.createTask(Child, null, {
          ownership: { kind: "task", taskId: runtime.taskId },
        });
      }, invocation);
      await started.promise;
      return empty();
    },
  });
  registry.install(defineExtension({ name: "fixture.child", tasks: [Child] }));
  const unsubscribe = harness.subscribeCommits(({ changes }) => {
    for (const change of changes) {
      if (change.type !== "task") continue;
      const { id, kind, state } = change.value;
      if (kind === "research.worker" && state.status === "completing") {
        workerId = id;
        completing.resolve(id);
      }
      if (
        kind === "research.coordinator" &&
        workerId !== undefined &&
        id > workerId &&
        (state.status === "waiting" || state.status === "terminal")
      )
        decision.resolve({ id, state });
    }
  });
  try {
    await root.commit(async (tx) => {
      (await tx.doc(DefinitionDoc, root.id)).mode = {
        role: "explorer",
        input: { notes: [], guidance: "Prove the claim" },
      };
      await research.initialize(tx, root.id);
    }, context);
    harness.resume();
    const worker = await completing.promise;
    const [resumed] = await root.commit(
      (tx) => research.resume(tx, root.id),
      context,
    );
    expect(await decision.promise).toMatchObject({
      id: resumed,
      state: { status: "waiting", on: [worker], policy: "allSettled" },
    });
    expect((await harness.getTask(worker, context))!.state.status).toBe(
      "completing",
    );
    release.resolve();
    await harness.waitForIdle(context);
    expect((await harness.getTask(worker, context))!.state.status).toBe(
      "terminal",
    );
    expect(calls).toBe(1);
  } finally {
    release.resolve();
    unsubscribe();
    await harness.close(context);
  }
});

test("a worker fault wakes Coordinator after reopening without repeating the failed worker", async () => {
  const directory = await temporaryDirectory("worker-fault-recovery-");
  let attempt = 0;
  const roles: Partial<Roles> = {
    coordinator: async (input) => {
      if (input.notes.length) return { work: null };
      if (input.failures.length)
        expect(input.failures[0].error).toContain("fixture failure");
      return {
        work: {
          kind: "explorer",
          guidance: input.failures.length ? "revised approach" : "prove",
        },
      };
    },
    explorer: async (input) => {
      if (++attempt === 1) throw new Error("fixture failure");
      expect(input.guidance).toBe("revised approach");
      return { kind: "notes", notes: [draft()], candidate: true };
    },
  };
  let owner = await setup(
    roles,
    await openNodeJsonlStorage(directory, context),
  );
  const closed = Promise.withResolvers<void>();
  let closing = false;
  owner.harness.subscribeCommits(({ changes }) => {
    if (
      !closing &&
      changes.some(
        (change) =>
          change.type === "task" &&
          change.value.kind === "research.worker" &&
          change.value.state.outcome?.status === "faulted",
      )
    ) {
      closing = true;
      queueMicrotask(() => {
        void owner.harness.close(context).then(closed.resolve, closed.reject);
      });
    }
  });
  try {
    await owner.root.commit(
      (tx) => owner.research.initialize(tx, owner.root.id),
      context,
    );
    owner.harness.resume();
    await closed.promise;
    expect(attempt).toBe(1);
    owner = await setup(roles, await openNodeJsonlStorage(directory, context));
    await owner.harness.waitForIdle(context);
    expect(attempt).toBe(2);
    expect((await owner.view()).notes).toHaveLength(1);
  } finally {
    await owner.harness.close(context);
  }
});

test.each(["invalid batch", "invalid kind", "cancelled"])(
  "failed verification publishes no carried checks or corrections when %s",
  async (mode) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { research, harness, root, view } = await setup({
      coordinator: async (input) => ({
        work: input.failures.length
          ? null
          : {
              kind: "verifier",
              notes: [input.notes[0].id],
              through: "requirements",
            },
      }),
      verifier: async (input) => {
        const failure = new RoleFailure("failure after a completed check");
        failure.result = {
          kind: "verification",
          checks: [
            {
              noteId: input.notes[0].id,
              requirements: { verdict: "PASS", report: "Checked." },
              correction: {
                revision: input.notes[0].revision,
                summary: "Reflexive equality",
              },
            },
          ],
        };
        if (mode === "invalid batch")
          failure.result.checks.push({
            noteId: "unknown/n1",
            requirements: { verdict: "PASS", report: "Checked." },
          });
        if (mode === "invalid kind")
          Object.assign(failure, {
            result: { kind: "notes", notes: [draft()], candidate: false },
          });
        started.resolve();
        await release.promise;
        throw failure;
      },
    });
    try {
      await root.commit(
        (tx) =>
          research.input(tx, root.id, {
            kind: "submit",
            id: "import",
            notes: [draft()],
            candidate: false,
          }),
        context,
      );
      const original = (await view()).notes[0]!;
      harness.resume();
      await started.promise;
      const [worker] = await root.commit(
        (tx) => scanTasks(tx, root.id, "research.worker"),
        context,
      );
      if (mode === "cancelled")
        await root.commit(async (tx) => {
          (await tx.doc(Control, root.id)).cancelled = true;
        }, context);
      release.resolve();
      await harness.waitForIdle(context);
      const outcome = (await harness.getTask(worker!.id, context))!.state
        .outcome!;
      expect(outcome.status).toBe(mode === "cancelled" ? "aborted" : "faulted");
      expect(outcome.result).toBeUndefined();
      const current = await view();
      expect(current.notes).toHaveLength(1);
      expect(current.notes[0]).toMatchObject({
        ...draft(),
        id: "input/import/n1",
        revision: original.revision,
        checks: {},
      });
    } finally {
      release.resolve();
      await harness.close(context);
    }
  },
);

test("Verifier recovery keeps its frozen input while only a fresh verdict applies to edited content", async () => {
  const directory = await temporaryDirectory("research-verifier-");
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  let carriedOnClose = false;
  const seen: {
    revision: number;
    text: string;
    cutoff: number;
  }[] = [];
  const roles: Partial<Roles> = {
    coordinator: async (input) => ({
      work: Object.keys(input.notes[0].checks).length
        ? null
        : {
            kind: "verifier",
            notes: [input.notes[0].id],
            through: "requirements",
          },
    }),
    verifier: async (input, _runtime, invocation, source) => {
      const note = input.notes[0];
      seen.push({
        revision: note.revision,
        text: note.text,
        cutoff: source!.cutoff,
      });
      const result = {
        kind: "verification" as const,
        checks: [
          {
            noteId: note.id,
            requirements: {
              verdict: "PASS" as const,
              report: `Checked revision ${note.revision}.`,
            },
          },
        ],
      };
      if (seen.length === 1) {
        started.resolve();
        try {
          await awaitWithContext(held.promise, invocation);
        } catch {
          carriedOnClose = true;
          const failure = new RoleFailure("failure while closing");
          failure.result = result;
          throw failure;
        }
      }
      return result;
    },
  };
  let owner = await setup(
    roles,
    await openNodeJsonlStorage(directory, context),
  );
  try {
    const { research, root, harness } = owner;
    const command = {
      kind: "submit",
      id: "import",
      notes: [draft()],
      candidate: false,
    };
    const admitted = await root.commit(
      (tx) => research.input(tx, root.id, command),
      context,
    );
    const initialRevision = (await owner.view()).notes[0]!.revision;
    harness.resume();
    await started.promise;
    expect(
      await root.commit((tx) => research.input(tx, root.id, command), context),
    ).toBe(admitted);
    await expect(
      root.commit(
        (tx) => research.input(tx, root.id, { ...command, candidate: true }),
        context,
      ),
    ).rejects.toThrow("another value");
    const [worker] = await root.commit(
      (tx) => scanTasks(tx, root.id, "research.worker"),
      context,
    );
    const at = seen[0]!.cutoff;
    expect(
      (await harness.getTask(worker!.id, context))!.state.checkpoint,
    ).toEqual({
      phase: "run",
    });
    expect(worker!.input).toMatchObject({
      at,
    });
    const correction = {
      kind: "correct",
      id: "fix",
      note: "input/import/n1",
      revision: initialRevision,
      summary: "Equality",
      detailedSummary: "Reflexivity proves equality.",
      text: "1=1\n\nBy reflexivity, 1=1.",
    };
    const revised = await root.commit(
      (tx) => research.input(tx, root.id, correction),
      context,
    );
    expect(
      await root.commit(
        (tx) => research.input(tx, root.id, correction),
        context,
      ),
    ).toBe(revised);
    const editedRevision = (await owner.view()).notes[0]!.revision;
    expect(editedRevision).toBeGreaterThan(initialRevision);
    await harness.close(context);
    expect(carriedOnClose).toBe(true);
    owner = await setup(roles, await openNodeJsonlStorage(directory, context));
    expect((await owner.view()).notes[0]!.checks).toEqual({});
    expect(
      (await owner.harness.getTask(worker!.id, context))!.state.outcome,
    ).toBeUndefined();
    await owner.harness.waitForIdle(context);
    expect(seen.slice(0, 2)).toEqual([
      {
        revision: initialRevision,
        text: draft().text,
        cutoff: at,
      },
      {
        revision: initialRevision,
        text: draft().text,
        cutoff: at,
      },
    ]);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({
      revision: editedRevision,
      text: correction.text,
    });
    expect(seen[2]!.cutoff).toBeGreaterThan(at);
    expect((await owner.view()).notes[0]!.revision).toBe(editedRevision);
    expect((await owner.view()).notes[0]!.checks).toEqual({
      requirements: {
        verdict: "PASS",
        report: `Checked revision ${editedRevision}.`,
      },
    });
    expect(
      (await owner.harness.getTask(worker!.id, context))!.state.outcome,
    ).toMatchObject({
      status: "faulted",
      error: { message: expect.stringContaining("Stale mathematical input") },
    });
  } finally {
    held.resolve();
    await owner.harness.close(context);
  }
});

test("an edit after Coordinator freezes a checked candidate prevents stale acceptance", async () => {
  const changed = Promise.withResolvers<void>();
  let target: { id: string; revision: number } | undefined;
  let verified = false;
  let cutoff: EntryId | undefined;
  const owner = await setup({
    coordinator: async (input) => ({
      work: !input.notes.length
        ? { kind: "explorer", guidance: "Prove the exact equality." }
        : input.notes[0].summary.includes("unresolved extension")
          ? null
          : {
              kind: "verifier",
              notes: [input.notes[0].id],
              through: "reconstruction",
            },
    }),
    explorer: async () => ({
      kind: "notes",
      notes: [draft()],
      candidate: true,
    }),
    verifier: async (input) => {
      const note = input.notes[0];
      target = { id: note.id, revision: note.revision };
      const pass = { verdict: "PASS" as const, report: "Checked." };
      return {
        kind: "verification",
        checks: [
          {
            noteId: note.id,
            correctness: { ...pass, statement: "1 = 1", premises: [] },
            source: pass,
            requirements: pass,
            reconstruction: { ...pass, proof: "By reflexivity." },
          },
        ],
      };
    },
  });
  const { harness, root, research } = owner;
  const unsubscribe = harness.subscribeCommits(({ changes }) => {
    for (const change of changes) {
      if (change.type !== "task") continue;
      const task = change.value;
      if (
        task.kind === "research.worker" &&
        task.state.outcome?.status === "completed" &&
        (task.state.outcome.result as { kind?: string } | undefined)?.kind ===
          "verification"
      )
        verified = true;
      const checkpoint = task.state.checkpoint as
        { phase?: string; at?: EntryId } | undefined;
      if (
        !verified ||
        cutoff !== undefined ||
        task.kind !== "research.coordinator" ||
        checkpoint?.phase !== "decide"
      )
        continue;
      cutoff = checkpoint.at!;
      queueMicrotask(() => {
        void root
          .commit(
            (tx) =>
              research.input(tx, root.id, {
                kind: "correct",
                id: "edit-before-acceptance",
                note: target!.id,
                revision: target!.revision,
                summary: "Equality with an unresolved extension",
                detailedSummary: "The extension has not been checked.",
                text: `${draft().text}\n\nUnproved addition: 1 = 2.`,
              }),
            context,
          )
          .then(() => changed.resolve(), changed.reject);
      });
    }
  });
  try {
    await root.commit((tx) => research.initialize(tx, root.id), context);
    await harness.waitForIdle(context);
    await changed.promise;
    await harness.waitForIdle(context);
    const frozen = await readSnapshot(
      {
        snapshotAsOf: harness.snapshotAsOf.bind(harness),
        getTask: harness.getTask.bind(harness),
        entry: (id) => root.commit((tx) => tx.entry(id), context),
      },
      root.id,
      cutoff!,
      context,
    );
    expect(frozen.notes[0]!.accepted).toBe(true);
    expect((await owner.view()).notes[0]).toMatchObject({
      accepted: false,
      checks: {},
    });
    expect(
      await root.commit(
        async (tx) => (await tx.doc(Control, root.id)).accepted,
        context,
      ),
    ).toBeNull();
    expect(
      (await root.commit((tx) => readReport(tx, root.id), context)).status
        .acceptedNoteId,
    ).toBeNull();
  } finally {
    unsubscribe();
    await harness.close(context);
  }
});

test("failed decisions block queued work and inputs until explicit native-task resume", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { research, harness, root } = await setup({
    coordinator: async (input) => {
      if (++calls === 1) {
        started.resolve();
        await release.promise;
        throw new Error("decision failed");
      }
      expect(input.guidance).toEqual(["first", "second"]);
      return { work: null };
    },
  });
  const command = { kind: "guide", id: "first", text: "first" };
  try {
    const first = await root.commit(
      (tx) => research.input(tx, root.id, command),
      context,
    );
    harness.resume();
    await started.promise;
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "second",
          text: "second",
        }),
      context,
    );
    release.resolve();
    await harness.waitForIdle(context);
    expect(calls).toBe(1);
    const before = await root.commit((tx) => scanTasks(tx, root.id), context);
    expect(blockedDecision(before)?.state.outcome?.status).toBe("faulted");
    expect(pendingDecisions(before)).toHaveLength(1);
    const report = await root.commit((tx) => readReport(tx, root.id), context);
    expect(report.status.status).toBe("blocked");
    expect(report.status.pendingDecisions).toBe(1);
    expect(
      await root.commit((tx) => research.input(tx, root.id, command), context),
    ).toBe(first);
    await expect(
      root.commit(
        (tx) =>
          research.input(tx, root.id, {
            kind: "guide",
            id: "blocked",
            text: "blocked",
          }),
        context,
      ),
    ).rejects.toThrow("blocked");
    const resumed = await root.commit(
      (tx) => research.resume(tx, root.id),
      context,
    );
    await harness.waitForIdle(context);
    expect(calls).toBe(2);
    const after = await root.commit((tx) => scanTasks(tx, root.id), context);
    expect(blockedDecision(after)).toBeUndefined();
    expect(pendingDecisions(after)).toHaveLength(0);
    expect(
      after
        .filter(({ id }) => resumed.includes(id))
        .map(({ input }) => (input as { after: number }).after),
    ).toEqual(pendingDecisions(before).map(({ id }) => id));
  } finally {
    release.resolve();
    await harness.close(context);
  }
});

test("multiple-worker plans are rejected before any worker is created", async () => {
  let calls = 0;
  const { research, harness, root } = await setup({
    coordinator: async () => ({
      work: [
        { kind: "explorer", guidance: "first" },
        { kind: "explorer", guidance: "second" },
      ],
    }),
    explorer: async () => {
      calls++;
      return empty();
    },
  });
  try {
    await root.commit((tx) => research.initialize(tx, root.id), context);
    await harness.waitForIdle(context);
    const tasks = await root.commit((tx) => scanTasks(tx, root.id), context);
    expect(blockedDecision(tasks)?.state.outcome?.error?.message).toContain(
      "Invalid value",
    );
    expect(
      tasks.filter((task) => task.kind === "research.worker"),
    ).toHaveLength(0);
    expect(calls).toBe(0);
  } finally {
    await harness.close(context);
  }
});

test("one resume replaces a chosen Coordinator failure while native child cleanup drains", async () => {
  const childStarted = Promise.withResolvers<void>();
  const cleanupStarted = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  const Child = defineTask<null, { phase: "run" }, null>({
    name: "fixture.cleanup",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(_task, _runtime, invocation) {
        childStarted.resolve();
        await awaitWithContext(new Promise<never>(() => {}), invocation);
      },
    },
    async abort(_task, runtime, invocation) {
      cleanupStarted.resolve();
      await cleaned.promise;
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        invocation,
      );
    },
  });
  let calls = 0;
  const { research, harness, registry, root } = await setup({
    coordinator: async (_input, runtime, invocation) => {
      if (++calls === 1) {
        await runtime.commit(async (tx) => {
          await tx.createTask(Child, null, {
            ownership: { kind: "task", taskId: runtime.taskId },
          });
        }, invocation);
        await childStarted.promise;
        throw new Error("chosen failure");
      }
      return { work: null };
    },
  });
  registry.install(
    defineExtension({ name: "fixture.cleanup", tasks: [Child] }),
  );
  try {
    await root.commit((tx) => research.initialize(tx, root.id), context);
    harness.resume();
    await cleanupStarted.promise;
    const before = await root.commit((tx) => scanTasks(tx, root.id), context);
    expect(blockedDecision(before)?.state.status).toBe("completing");
    await root.commit((tx) => research.resume(tx, root.id), context);
    expect(
      blockedDecision(
        await root.commit((tx) => scanTasks(tx, root.id), context),
      ),
    ).toBeUndefined();
    expect(calls).toBe(1);
    cleaned.resolve();
    await harness.waitForIdle(context);
    expect(calls).toBe(2);
    expect(
      pendingDecisions(
        await root.commit((tx) => scanTasks(tx, root.id), context),
      ),
    ).toHaveLength(0);
  } finally {
    cleaned.resolve();
    await harness.close(context);
  }
});

test("pause retains worker failures and input for the next Coordinator on resume", async () => {
  const workerStarted = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  let attempts = 0,
    decisions = 0;
  const { research, harness, root, view } = await setup({
    coordinator: async (input) => {
      decisions++;
      if (decisions === 1)
        return { work: { kind: "explorer", guidance: "prove" } };
      expect(input.guidance.at(-1)).toBe("held");
      expect(input.failures[0].error).toContain("failure while paused");
      return { work: null };
    },
    explorer: async () => {
      if (++attempts === 1) {
        workerStarted.resolve();
        await releaseWorker.promise;
        throw new Error("failure while paused");
      }
      return { kind: "notes", notes: [draft()], candidate: false };
    },
  });
  try {
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "start",
          text: "ready",
        }),
      context,
    );
    harness.resume();
    await workerStarted.promise;
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "held",
          text: "held",
        }),
      context,
    );
    await root.commit(async (tx) => {
      (await tx.doc(Control, root.id)).paused = true;
    }, context);
    releaseWorker.resolve();
    await harness.waitForIdle(context);
    expect(attempts).toBe(1);
    expect(decisions).toBe(1);
    const paused = await root.commit((tx) => readReport(tx, root.id), context);
    expect(paused.status.status).toBe("paused");
    expect(paused.status.pendingDecisions).toBe(0);
    await root.commit((tx) => research.resume(tx, root.id), context);
    await harness.waitForIdle(context);
    expect(decisions).toBe(2);
    expect(attempts).toBe(1);
    expect((await view()).notes).toHaveLength(0);
    expect(
      pendingDecisions(
        await root.commit((tx) => scanTasks(tx, root.id), context),
      ),
    ).toHaveLength(0);
  } finally {
    releaseWorker.resolve();
    await harness.close(context);
  }
});
