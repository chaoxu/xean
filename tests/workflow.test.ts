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
  type WorkerInput,
} from "../src/workflow.ts";
import { DefinitionDoc } from "../src/definition.ts";
import { readView } from "../src/math/state.ts";
import { readReport } from "../src/report.ts";
import { createRuntime } from "../src/config.ts";
import { createRoles } from "../src/roles/index.ts";
import { RoleFailure } from "../src/roles/types.ts";
import { stagePassed } from "../src/math/notes.ts";
import type { Note } from "../src/math/contracts.ts";

const task = {
  problem: "Prove 1 = 1.",
  completionCriteria: "A self-contained proof of the exact equality.",
};
const settings = {
  profiles: { default: { provider: "openai" as const, model: "gpt-6-astra" } },
  limits: { concurrency: 2 },
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
    coordinator: async () => ({ work: [] }),
    explorer: async () => empty(),
    verifier: async () => ({ kind: "verification", checks: [] }),
    literature: async () => empty(),
    codex: async () => empty(),
    reconstruct: async () => ({ kind: "verification", checks: [] }),
    review: async () => ({ verdict: "INCONCLUSIVE", report: "Fixture" }),
    ...replacements,
  };
  let harness!: Harness;
  const research = createResearch(roles, (id, context) =>
    harness.abortTask(id, context),
  );
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

test("Pi serializes decisions after queued cancellation, reports individual completions, and bounds workers", async () => {
  const held = Promise.withResolvers<void>();
  const slow = Promise.withResolvers<void>();
  const arrived = Promise.withResolvers<void>();
  const fastObserved = Promise.withResolvers<void>();
  let decisions = 0,
    running = 0,
    maximum = 0;
  const { research, harness, root } = await setup({
    coordinator: async (input) => {
      decisions++;
      if (input.guidance.at(-1) === "hold") {
        arrived.resolve();
        await held.promise;
      }
      if (
        input.notes.some((note: { summary: string }) => note.summary === "fast")
      )
        fastObserved.resolve();
      return { work: [] };
    },
    explorer: async (input) => {
      running++;
      maximum = Math.max(maximum, running);
      if (input.guidance === "slow") await slow.promise;
      running--;
      return {
        kind: "notes",
        notes: [{ ...draft(), summary: input.guidance }],
        candidate: false,
      };
    },
  });
  try {
    const at = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "start",
          text: "ready",
        }),
      context,
    );
    await harness.waitForIdle(context);
    const ids = await root.commit(async (tx) => {
      const slow = await research.worker(tx, root.id, {
        at,
        request: { kind: "explorer", guidance: "slow" },
      });
      const fast = await research.worker(tx, root.id, {
        at,
        request: { kind: "explorer", guidance: "fast" },
      });
      return { slow, fast };
    }, context);
    harness.resume();
    await fastObserved.promise;
    expect((await harness.getTask(ids.slow, context))!.state.status).not.toBe(
      "terminal",
    );
    const hold = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "hold",
          text: "hold",
        }),
      context,
    );
    await arrived.promise;
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "cancel",
          text: "cancel",
        }),
      context,
    );
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "last",
          text: "last",
        }),
      context,
    );
    const coordinators = await root.commit(
      (tx) => scanTasks(tx, root.id, research.Coordinator.definition.name),
      context,
    );
    const [active, cancelled, last] = coordinators.slice(-3);
    await harness.abortTask(cancelled!.id, context);
    await harness.waitForTask(cancelled!.id, context);
    const record = (await harness.getTask(last!.id, context))!;
    expect(record.state.status).not.toBe("terminal");
    held.resolve();
    slow.resolve();
    await harness.waitForIdle(context);
    expect(maximum).toBe(2);
    expect(
      (await harness.getTask(active!.id, context))!.state.outcome!.status,
    ).toBe("completed");
    expect(hold).toBeGreaterThan(at);
    expect(decisions).toBeGreaterThan(2);
  } finally {
    held.resolve();
    slow.resolve();
    await harness.close(context);
  }
});

test("worker failures reach Coordinator, which chooses whether and how to retry", async () => {
  let attempt = 0;
  const { research, harness, root, view } = await setup({
    coordinator: async (input) => {
      if (!input.failures.length || input.notes.length) return { work: [] };
      expect(input.failures[0].error).toContain("fixture failure");
      return { work: [{ kind: "explorer", guidance: "revised approach" }] };
    },
    explorer: async (input) => {
      if (++attempt === 1) throw new Error("fixture failure");
      expect(input.guidance).toBe("revised approach");
      return { kind: "notes", notes: [draft()], candidate: true };
    },
  });
  try {
    const at = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "start",
          text: "ready",
        }),
      context,
    );
    await harness.waitForIdle(context);
    await root.commit(
      (tx) =>
        research.worker(tx, root.id, {
          at,
          request: { kind: "explorer", guidance: "prove" },
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
      const at = await root.commit(
        (tx) =>
          research.input(tx, root.id, {
            kind: "submit",
            id: "import",
            notes: [draft()],
            candidate: false,
          }),
        context,
      );
      await harness.waitForIdle(context);
      const worker = await root.commit(
        (tx) =>
          research.worker(tx, root.id, {
            at,
            request: {
              kind: "verifier",
              targets: [{ id: "input/import/n1", through: "requirements" }],
            },
          }),
        context,
      );
      await started.promise;
      if (mode === "cancelled")
        await root.commit(async (tx) => {
          (await tx.doc(Control, root.id)).cancelled = true;
        }, context);
      release.resolve();
      await harness.waitForIdle(context);
      const outcome = (await harness.getTask(worker, context))!.state.outcome!;
      expect(outcome.status).toBe(mode === "cancelled" ? "aborted" : "faulted");
      expect(outcome.result).toBeUndefined();
      const current = await view();
      expect(
        current.results.filter((result) => result.task === worker),
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

test("a queued worker uses the next free slot without waiting for a slower worker", async () => {
  const fastStarted = Promise.withResolvers<void>();
  const slowStarted = Promise.withResolvers<void>();
  const queuedStarted = Promise.withResolvers<void>();
  const fast = Promise.withResolvers<void>();
  const slow = Promise.withResolvers<void>();
  const { research, harness, root } = await setup({
    explorer: async (input, _runtime, invocation) => {
      if (input.guidance === "fast") {
        fastStarted.resolve();
        await awaitWithContext(fast.promise, invocation);
      } else if (input.guidance === "slow") {
        slowStarted.resolve();
        await awaitWithContext(slow.promise, invocation);
      } else queuedStarted.resolve();
      return empty();
    },
  });
  try {
    const at = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "start",
          text: "ready",
        }),
      context,
    );
    await harness.waitForIdle(context);
    const ids = await root.commit(async (tx) => {
      const ids = [];
      for (const guidance of ["slow", "fast", "queued"])
        ids.push(
          await research.worker(tx, root.id, {
            at,
            request: { kind: "explorer", guidance },
          }),
        );
      return ids;
    }, context);
    await Promise.all([fastStarted.promise, slowStarted.promise]);
    fast.resolve();
    await queuedStarted.promise;
    expect((await harness.getTask(ids[0]!, context))!.state.status).not.toBe(
      "terminal",
    );
    slow.resolve();
    await harness.waitForIdle(context);
    expect(
      (await harness.getTask(ids[2]!, context))!.state.outcome!.status,
    ).toBe("completed");
  } finally {
    fast.resolve();
    slow.resolve();
    await harness.close(context);
  }
});

test("Verifier admission merges requests, reuses PASS, and preserves Explorer concurrency", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const explored = Promise.withResolvers<void>();
  const stale = Promise.withResolvers<void>();
  const releaseDecision = Promise.withResolvers<void>();
  const calls: Note[][] = [];
  let first = "",
    second = "",
    running = 0,
    maximum = 0;
  let queued = false,
    staleRequested = false,
    parallel = false;
  const pass = { verdict: "PASS" as const, report: "Checked." };
  const { research, harness, root, view } = await setup({
    coordinator: async (input, _runtime, invocation) => {
      if (input.guidance.at(-1) === "queue" && !queued) {
        queued = true;
        return {
          work: [
            { kind: "verifier", notes: [first], through: "source" },
            { kind: "verifier", notes: [second], through: "source" },
            { kind: "explorer", guidance: "parallel" },
          ],
        };
      }
      if (input.guidance.at(-1) === "stale" && !staleRequested) {
        staleRequested = true;
        expect(
          input.notes.find((note: { id: string }) => note.id === first).checks,
        ).toEqual([]);
        stale.resolve();
        await awaitWithContext(releaseDecision.promise, invocation);
        return {
          work: [{ kind: "verifier", notes: [first], through: "source" }],
        };
      }
      return { work: [] };
    },
    explorer: async (input) => {
      if (input.guidance === "seed")
        return {
          kind: "notes",
          notes: [draft(), { ...draft("n2"), support: ["n1"] }],
          candidate: false,
        };
      parallel = running === 1;
      explored.resolve();
      return empty();
    },
    verifier: async (input, _runtime, invocation) => {
      running++;
      maximum = Math.max(maximum, running);
      calls.push(input.notes);
      try {
        if (calls.length === 1) {
          started.resolve();
          await awaitWithContext(release.promise, invocation);
        }
        return {
          kind: "verification",
          checks: (input.notes as Note[])
            .filter((note) => !stagePassed(note, "source"))
            .map((note) => ({
              noteId: note.id,
              correctness: { ...pass, statement: "1 = 1", premises: [] },
              source: pass,
            })),
        };
      } finally {
        running--;
      }
    },
  });
  const workers = () =>
    root.commit((tx) => scanTasks(tx, root.id, "research.worker"), context);
  const verifiers = async () =>
    (await workers()).filter((record) => {
      const input = record.input as WorkerInput;
      return "request" in input && input.request.kind === "verifier";
    });
  try {
    const start = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "start",
          text: "ready",
        }),
      context,
    );
    await root.commit(
      (tx) =>
        research.worker(tx, root.id, {
          at: start,
          request: { kind: "explorer", guidance: "seed" },
        }),
      context,
    );
    await harness.waitForIdle(context);
    const before = await view();
    [first, second] = before.notes.map(({ id }) => id) as [string, string];
    const request = {
      at: before.cutoff!,
      request: {
        kind: "verifier" as const,
        targets: [{ id: first, through: "source" as const }],
      },
    };
    const active = await root.commit(
      (tx) => research.worker(tx, root.id, request),
      context,
    );
    await started.promise;
    const duplicate = await root.commit(
      (tx) => research.worker(tx, root.id, request),
      context,
    );
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "queue",
          text: "queue",
        }),
      context,
    );
    await explored.promise;
    expect(parallel).toBe(true);
    const queuedWorkers = await verifiers();
    expect(queuedWorkers).toHaveLength(3);
    expect(
      queuedWorkers.filter(
        ({ state }) => (state.checkpoint as { phase: string }).phase === "wait",
      ),
    ).toHaveLength(2);
    const merged = queuedWorkers.find(
      ({ id }) => id !== active && id !== duplicate,
    )!;
    expect(
      (merged.input as { request: { targets: unknown[] } }).request.targets,
    ).toHaveLength(2);
    await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "stale",
          text: "stale",
        }),
      context,
    );
    await stale.promise;
    release.resolve();
    await harness.waitForTask(active, context);
    releaseDecision.resolve();
    await harness.waitForIdle(context);
    const finished = await verifiers();
    expect(finished).toHaveLength(3);
    expect(
      finished.every(({ state }) => state.outcome?.status === "completed"),
    ).toBe(true);
    expect((await harness.getTask(duplicate, context))!.state.outcome).toEqual({
      status: "completed",
      result: { kind: "verification", checks: [] },
    });
    expect(maximum).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.find(({ id }) => id === first)!.checks).toHaveLength(1);
    expect((await view()).notes.map(({ checks }) => checks.length)).toEqual([
      1, 1,
    ]);
  } finally {
    release.resolve();
    releaseDecision.resolve();
    await harness.close(context);
  }
});

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
    const at = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "submit",
          id: "import",
          notes: [draft()],
          candidate: false,
        }),
      context,
    );
    const worker = await root.commit(
      (tx) =>
        research.worker(tx, root.id, {
          at,
          request: {
            kind: "verifier",
            targets: [{ id: "input/import/n1", through: "requirements" }],
          },
        }),
      context,
    );
    harness.resume();
    await started.promise;
    expect((await harness.getTask(worker, context))!.state.checkpoint).toEqual({
      phase: "run",
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
      (await owner.harness.getTask(worker, context))!.state.outcome,
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
      (await owner.harness.getTask(worker, context))!.state.outcome?.status,
    ).toBe("completed");
  } finally {
    held.resolve();
    await owner.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("acceptance waits for newer input and aborts late worker results", async () => {
  const late = Promise.withResolvers<void>();
  let unsubscribe = () => {};
  let newerInput: Promise<number> | undefined;
  let acceptedEvent: number | undefined;
  const pass = { verdict: "PASS" as const, report: "Checked." };
  const { research, harness, root, view } = await setup({
    explorer: async (input, _runtime, invocation) => {
      if (input.guidance === "late")
        await awaitWithContext(late.promise, invocation);
      return { kind: "notes", notes: [draft()], candidate: true };
    },
    verifier: async (input) => ({
      kind: "verification",
      checks: [
        {
          noteId: input.targets[0].id,
          correctness: { ...pass, statement: "1 = 1", premises: [] },
          source: pass,
          requirements: pass,
          reconstruction: {
            ...pass,
            proof: "Reflexivity.",
          },
        },
      ],
    }),
  });
  try {
    const start = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "start",
          text: "ready",
        }),
      context,
    );
    await root.commit(
      (tx) =>
        research.worker(tx, root.id, {
          at: start,
          request: { kind: "explorer", guidance: "candidate" },
        }),
      context,
    );
    await harness.waitForIdle(context);
    const id = (await view()).notes[0]!.id;
    const at = (await view()).cutoff!;
    const unfinished = await root.commit(
      (tx) =>
        research.worker(tx, root.id, {
          at,
          request: { kind: "explorer", guidance: "late" },
        }),
      context,
    );
    unsubscribe = harness.subscribeCommits((publication) => {
      if (
        !newerInput &&
        publication.changes.some(
          (change) =>
            change.type === "entry" &&
            change.value.kind === "research.decision-view",
        )
      ) {
        newerInput = Promise.resolve().then(() =>
          root.commit(
            (tx) =>
              research.input(tx, root.id, {
                kind: "guide",
                id: "before-seal",
                text: "Check the exact task before sealing.",
              }),
            context,
          ),
        );
      }
      for (const change of publication.changes) {
        if (
          change.type === "task" &&
          (change.value.state.checkpoint as { phase?: string } | undefined)
            ?.phase === "finish"
        )
          acceptedEvent = (change.value.input as { event: number }).event;
      }
    });
    await root.commit(
      (tx) =>
        research.worker(tx, root.id, {
          at,
          request: {
            kind: "verifier",
            targets: [{ id, through: "reconstruction" }],
          },
        }),
      context,
    );
    const accepted = Promise.withResolvers<void>();
    const watch = (await harness.watchDoc(Control, root.id, context))!;
    const check = (value: typeof watch.value) => {
      if (value?.accepted) accepted.resolve();
    };
    check(watch.value);
    watch.start(async (value) => check(value));
    await accepted.promise;
    await watch.stop();
    await harness.waitForIdle(context);
    expect(newerInput).toBeDefined();
    expect(acceptedEvent).toBe(await newerInput);
    expect(
      (await harness.getTask(unfinished, context))!.state.outcome!.status,
    ).toBe("aborted");
    expect((await view()).notes).toHaveLength(1);
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
    late.resolve();
    unsubscribe();
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
      return { work: [] };
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
    const second = await root.commit(
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
        .map(({ input }) => (input as { event: number }).event),
    ).toEqual([first, second]);
    expect(
      after
        .filter(({ id }) => resumed.includes(id))
        .every(
          ({ input }) => (input as { retryOf?: number }).retryOf !== undefined,
        ),
    ).toBe(true);
  } finally {
    release.resolve();
    await harness.close(context);
  }
});

test("a single-shot Explorer plan is rejected atomically before any worker is created", async () => {
  let calls = 0;
  const builtins = createRoles({
    profiles: createRuntime(settings).profiles,
    chatgpt: {
      baseUrl: "http://127.0.0.1:17841/v1",
      model: "chatgpt-web/gpt-6-pro",
    },
    research: false,
  });
  const explorer = builtins.explorer;
  builtins.explorer = (...args) => explorer(...args);
  const { research, harness, root } = await setup({
    capabilities: builtins.capabilities,
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
      "one-shot allowance",
    );
    expect(
      tasks.filter((task) => task.kind === research.Worker.definition.name),
    ).toHaveLength(0);
    expect(calls).toBe(0);
  } finally {
    await harness.close(context);
  }
});

test("replacement planners may admit parallel Explorers", async () => {
  const both = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  const { research, harness, root } = await setup({
    coordinator: async (input) => ({
      work: input.explorerUsed
        ? []
        : [
            { kind: "explorer", guidance: "first" },
            { kind: "explorer", guidance: "second" },
          ],
    }),
    explorer: async (_input, _runtime, invocation) => {
      if (++active === 2) both.resolve();
      await awaitWithContext(release.promise, invocation);
      return empty();
    },
  });
  try {
    await root.commit((tx) => research.initialize(tx, root.id), context);
    harness.resume();
    await both.promise;
    expect(active).toBe(2);
    release.resolve();
    await harness.waitForIdle(context);
    expect(
      blockedDecision(
        await root.commit((tx) => scanTasks(tx, root.id), context),
      ),
    ).toBeUndefined();
  } finally {
    release.resolve();
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
      return { work: [] };
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

test("pause retains running decisions and worker failures for Coordinator on resume", async () => {
  const workerStarted = Promise.withResolvers<void>();
  const decisionStarted = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  const releaseDecision = Promise.withResolvers<void>();
  let attempts = 0,
    decisions = 0;
  const { research, harness, root, view } = await setup({
    coordinator: async (input) => {
      decisions++;
      if (decisions === 2) {
        expect(input.guidance.at(-1)).toBe("held");
        decisionStarted.resolve();
        await releaseDecision.promise;
      }
      if (decisions > 2)
        expect(input.failures[0].error).toContain("failure while paused");
      return { work: [] };
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
    const at = await root.commit(
      (tx) =>
        research.input(tx, root.id, {
          kind: "guide",
          id: "start",
          text: "ready",
        }),
      context,
    );
    await harness.waitForIdle(context);
    await root.commit(
      (tx) =>
        research.worker(tx, root.id, {
          at,
          request: { kind: "explorer", guidance: "prove" },
        }),
      context,
    );
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
    await decisionStarted.promise;
    await root.commit(async (tx) => {
      (await tx.doc(Control, root.id)).paused = true;
    }, context);
    releaseWorker.resolve();
    releaseDecision.resolve();
    await harness.waitForIdle(context);
    expect(attempts).toBe(1);
    expect(decisions).toBe(2);
    const paused = await root.commit((tx) => readReport(tx, root.id), context);
    expect(paused.status.status).toBe("paused");
    expect(paused.status.pendingDecisions).toBe(2);
    await root.commit((tx) => research.resume(tx, root.id), context);
    await harness.waitForIdle(context);
    expect(decisions).toBe(4);
    expect(attempts).toBe(1);
    expect((await view()).notes).toHaveLength(0);
    expect(
      pendingDecisions(
        await root.commit((tx) => scanTasks(tx, root.id), context),
      ),
    ).toHaveLength(0);
  } finally {
    releaseWorker.resolve();
    releaseDecision.resolve();
    await harness.close(context);
  }
});
