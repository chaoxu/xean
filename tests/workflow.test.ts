import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
} from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai";
import {
  createResearch,
  scanTasks,
  Control,
  blockedDecision,
  pendingDecisions,
  type Roles,
} from "../src/workflow.ts";
import { DefinitionDoc } from "../src/definition.ts";
import { readView } from "../src/math/state.ts";
import { readReport } from "../src/report.ts";
import { RoleFailure } from "../src/roles/types.ts";
import type { Note } from "../src/math/contracts.ts";

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

test("standalone initialization serializes and reuses completed work", async () => {
  let calls = 0;
  const { research, harness, root } = await setup({
    explorer: async () => {
      calls++;
      return empty();
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
      await root.commit((tx) => research.initialize(tx, root.id), context);
    }
    await harness.waitForIdle(context);
    await root.commit((tx) => research.resume(tx, root.id), context);
    await harness.waitForIdle(context);
    expect(calls).toBe(1);
    const report = await root.commit((tx) => readReport(tx, root.id), context);
    expect(report.status.status).toBe("completed");
    expect(report.work).toHaveLength(1);
  } finally {
    await harness.close(context);
  }
});

test("input replay is idempotent after projection and frozen workers retain old note revisions", async () => {
  const { research, harness, root, view } = await setup();
  try {
    const command = {
      kind: "submit",
      id: "import",
      notes: [draft()],
      candidate: true,
    };
    const at = await root.commit(
      (tx) => research.input(tx, root.id, command),
      context,
    );
    expect(
      await root.commit((tx) => research.input(tx, root.id, command), context),
    ).toBe(at);
    const correction = {
      kind: "correct",
      id: "fix",
      note: "input/import/n1",
      revision: 0,
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
    expect((await view()).notes[0]!.revision).toBe(1);
    const original = await root.commit(
      (tx) => readView(tx, root.id, at),
      context,
    );
    expect(original.notes[0]!.revision).toBe(0);
    await expect(
      root.commit(
        (tx) => research.input(tx, root.id, { ...command, candidate: false }),
        context,
      ),
    ).rejects.toThrow("another value");
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
    release.resolve();
    await harness.waitForIdle(context);
    expect(decisions[0]).toEqual([]);
    expect(decisions.length).toBeGreaterThan(1);
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

test("worker failures reach Coordinator, which chooses whether and how to retry", async () => {
  let attempt = 0;
  const { research, harness, root, view } = await setup({
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
    await harness.waitForIdle(context);
    expect(attempt).toBe(2);
    const current = await view();
    expect(current.notes).toHaveLength(1);
    expect(
      current.results.filter((result) => result.outcome.status === "faulted"),
    ).toHaveLength(1);
  } finally {
    await harness.close(context);
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
                revision: 0,
                summary: "Reflexive equality",
                text: "1=1\n\nReflexivity proves 1=1.",
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
      expect(
        current.results.filter((result) => result.task === worker!.id),
      ).toHaveLength(1);
      expect(current.notes).toHaveLength(1);
      expect(current.notes[0]).toMatchObject({
        ...draft(),
        id: "input/import/n1",
        revision: 0,
        checks: [],
      });
    } finally {
      release.resolve();
      await harness.close(context);
    }
  },
);

test("Verifier recovery retains its admission cutoff after a harmless correction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-verifier-"));
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
      work: input.notes[0].checks.length
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
              report: "Checked.",
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
    harness.resume();
    await started.promise;
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
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "correct",
          id: "fix",
          note: "input/import/n1",
          revision: 0,
          summary: "Equality",
          detailedSummary: "Reflexivity proves equality.",
          text: "1=1\n\nBy reflexivity, 1=1.",
        }),
      context,
    );
    expect((await owner.view()).notes[0]!.revision).toBe(1);
    await harness.close(context);
    expect(carriedOnClose).toBe(true);
    owner = await setup(roles, await openNodeJsonlStorage(directory, context));
    expect((await owner.view()).notes[0]!.checks).toEqual([]);
    expect((await owner.view()).results).toEqual([]);
    expect(
      (await owner.harness.getTask(worker!.id, context))!.state.outcome,
    ).toBeUndefined();
    await owner.harness.waitForIdle(context);
    expect(seen).toEqual([
      {
        revision: 0,
        text: draft().text,
        cutoff: at,
      },
      {
        revision: 0,
        text: draft().text,
        cutoff: at,
      },
    ]);
    expect((await owner.view()).notes[0]!.revision).toBe(1);
    expect((await owner.view()).notes[0]!.checks).toHaveLength(1);
    expect(
      (await owner.harness.getTask(worker!.id, context))!.state.outcome?.status,
    ).toBe("completed");
  } finally {
    held.resolve();
    await owner.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("acceptance follows a complete worker result and rejects later input", async () => {
  const trace: string[] = [];
  const pass = { verdict: "PASS" as const, report: "Checked." };
  const { research, harness, root, view } = await setup({
    coordinator: async (input) => {
      trace.push("coordinator");
      return {
        work: input.notes.length
          ? {
              kind: "verifier",
              notes: [input.notes[0].id],
              through: "reconstruction",
            }
          : { kind: "explorer", guidance: "Prove the claim" },
      };
    },
    explorer: async () => {
      trace.push("explorer");
      return { kind: "notes", notes: [draft()], candidate: true };
    },
    verifier: async (input) => {
      trace.push("verifier");
      return {
        kind: "verification",
        checks: [
          {
            noteId: input.targets[0].id,
            correctness: { ...pass, statement: "1 = 1", premises: [] },
            source: pass,
            requirements: pass,
            reconstruction: { ...pass, proof: "Reflexivity." },
          },
        ],
      };
    },
  });
  try {
    await root.commit((tx) => research.initialize(tx, root.id), context);
    await harness.waitForIdle(context);
    expect(trace).toEqual([
      "coordinator",
      "explorer",
      "coordinator",
      "verifier",
    ]);
    const notes = (await view()).notes;
    expect(notes).toHaveLength(1);
    expect(notes[0]!.accepted).toBe(true);
    expect(
      await root.commit(
        async (tx) => (await tx.doc(Control, root.id)).accepted,
        context,
      ),
    ).toBe(notes[0]!.id);
    const tasks = await root.commit((tx) => scanTasks(tx, root.id), context);
    const workers = tasks.filter((task) => task.kind === "research.worker");
    expect(workers).toHaveLength(2);
    expect(
      workers.every((worker) => worker.state.outcome?.status === "completed"),
    ).toBe(true);
    expect(pendingDecisions(tasks)).toHaveLength(0);
    await expect(
      root.commit(
        (tx) =>
          research.input(tx, root.id, {
            kind: "guide",
            id: "late",
            text: "reopen",
          }),
        context,
      ),
    ).rejects.toThrow("terminal");
  } finally {
    await harness.close(context);
  }
});

test("failed decisions block queued work and inputs until explicit native-task resume", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const { research, harness, root } = await setup({
    coordinator: async () => {
      if (++calls === 1) {
        started.resolve();
        await release.promise;
        throw new Error("decision failed");
      }
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
    expect(pendingDecisions(before)).toHaveLength(2);
    const report = await root.commit((tx) => readReport(tx, root.id), context);
    expect(report.status.status).toBe("blocked");
    expect(report.status.pendingDecisions).toBe(2);
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
    expect(calls).toBe(3);
    const after = await root.commit((tx) => scanTasks(tx, root.id), context);
    expect(blockedDecision(after)).toBeUndefined();
    expect(pendingDecisions(after)).toHaveLength(0);
    expect(
      after
        .filter(({ id }) => resumed.includes(id))
        .map(({ input }) => (input as { retryOf: number }).retryOf),
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
    expect(paused.status.pendingDecisions).toBe(2);
    await root.commit((tx) => research.resume(tx, root.id), context);
    await harness.waitForIdle(context);
    expect(decisions).toBe(3);
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
