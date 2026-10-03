import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Xean, openXeanStorage } from "xean";
import {
  createSolver,
  project,
  submitCommand,
  type ExplorerInput,
  type VerifierInput,
} from "xean/solve";

const task = {
  problem: "Task text belongs in the campaign, not each worker request",
  completionCriteria: "Prove the exact statement",
};
const content = (text: string) => ({
  summary: text,
  detailedSummary: text,
  text,
});
const draft = (id: string, text: string, support: string[] = []) => ({
  id,
  ...content(text),
  support,
});
const solver = () =>
  createSolver(task, () => {
    throw new Error("This regression makes no model calls");
  });
const submit = (engine: Xean, id: string, notes: ReturnType<typeof draft>[]) =>
  submitCommand(engine, { kind: "submit", id, candidate: false, notes });
const correct = (engine: Xean, note: string, text: string) =>
  submitCommand(engine, {
    kind: "correct",
    id: "edit",
    note,
    revision: 0,
    ...content(text),
  });

test("queued Explorer resolves its original corpus after late inputs, verdict, and SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-frozen-corpus-"));
  const path = join(directory, "campaign.sqlite");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let expected: ExplorerInput | undefined;
  let received: ExplorerInput | undefined;
  const options = () => {
    const setup = solver();
    setup.functions.coordinator = async ({ notes }) => {
      if (expected) return { work: [] };
      expected = {
        task,
        notes: structuredClone(notes),
        guidance: "Use original corpus",
      };
      return {
        work: [
          { kind: "explorer", guidance: expected.guidance },
          {
            kind: "verifier",
            notes: ["input/seed/n1"],
            through: "correctness",
          },
        ],
      };
    };
    setup.functions.explorer = async (input) => {
      received = input;
      return { kind: "notes", candidate: false, notes: [] };
    };
    setup.functions.verifier = async () => {
      started.resolve();
      await release.promise;
      return {
        kind: "verification",
        checks: [
          {
            noteId: "input/seed/n1",
            correctness: {
              verdict: "FAIL",
              report: "Later rejection",
              premises: [],
            },
          },
        ],
      };
    };
    // Hold the first worker while Explorer remains queued with the same planning view.
    const coordinate = setup.coordinator.run;
    setup.coordinator.run = async (...args) => {
      const decision = await coordinate(...args);
      decision.dispatch?.reverse();
      return decision;
    };
    return { ...setup, limits: { concurrency: 1 } };
  };
  let engine = await Xean.open(await openXeanStorage(path), options());
  let running: ReturnType<Xean["run"]> | undefined;
  try {
    await submit(engine, "seed", [draft("n1", "ORIGINAL PROOF")]);
    running = engine.run();
    await Promise.race([
      started.promise,
      running.then((result) => {
        throw new Error(result.error ?? "Verifier never started");
      }),
    ]);
    const queued = (await engine.inspect()).work.find(
      (work) => work.role === "xean.explorer",
    )!;
    expect(queued.status).toBe("queued");
    expect(queued.input).toEqual({
      kind: "explorer",
      view: expect.any(Number),
      guidance: "Use original corpus",
    });
    await correct(engine, "input/seed/n1", "LATER PROOF");
    await submit(engine, "late", [draft("n1", "LATER IMPORT")]);
    const pausing = engine.pause();
    expect((await engine.inspect()).status).toBe("pausing");
    release.resolve();
    const paused = await pausing;
    await running;
    expect(received).toBeUndefined();
    expect(project(paused).map(({ text, dead }) => ({ text, dead }))).toEqual([
      { text: "LATER PROOF", dead: true },
      { text: "LATER IMPORT", dead: false },
    ]);
    await engine.close();
    engine = await Xean.open(await openXeanStorage(path), options());
    await engine.resume();
    const result = await engine.run();
    expect(received).toEqual(expected);
    expect(result.work.find((work) => work.id === queued.id)).toMatchObject({
      status: "completed",
      input: queued.input,
    });
    expect(result.providerCalls).toBe(0);
  } finally {
    release.resolve();
    await engine.close();
    await running;
    await rm(directory, { recursive: true });
  }
});

test("Verifier resolves a frozen dependency closure and source evidence outside that closure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-verifier-corpus-"));
  const planned = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const setup = solver();
  const evidence = {
    id: "fixture/0",
    statement: "External premise",
    quote: "Published theorem",
    url: "https://example.invalid/theorem",
  };
  let plans = 0;
  let verifiers = 0;
  let received: VerifierInput | undefined;
  let expected: VerifierInput["notes"] | undefined;
  setup.functions.coordinator = async ({ task: receivedTask, notes }) => {
    expect(receivedTask).toEqual(task);
    receivedTask.problem = "A custom planner must not alter the campaign task";
    if (++plans > 2) return { work: [] };
    if (plans === 2) {
      expected = structuredClone(
        notes.filter((note) => note.id !== "input/seed/n3"),
      );
      planned.resolve();
      await release.promise;
    }
    return {
      work: [
        {
          kind: "verifier",
          notes: [plans === 1 ? "input/seed/n3" : "input/seed/n2"],
          through: "source",
        },
      ],
    };
  };
  setup.functions.verifier = async (input) => {
    if (++verifiers === 1) {
      input.task.problem = "A custom role must not alter the campaign task";
      return {
        kind: "verification",
        checks: [
          {
            noteId: "input/seed/n3",
            source: {
              kind: "codex-report",
              operationId: "fixture",
              reportedAt: "2026-10-03T00:00:00Z",
              verdict: "PASS",
              report: "Checked source",
              premises: [evidence.statement],
              passages: [{ ...evidence, premise: 0 }],
            },
          },
        ],
      };
    }
    received = input;
    return { kind: "verification", checks: [] };
  };
  const engine = await Xean.open(
    await openXeanStorage(join(directory, "campaign.sqlite")),
    setup,
  );
  setup.task.task.problem = "A returned declaration must not alter role inputs";
  let running: ReturnType<Xean["run"]> | undefined;
  try {
    await submit(engine, "seed", [
      draft("n1", "SUPPORT PROOF"),
      draft("n2", "TARGET PROOF", ["n1"]),
      draft("n3", "UNRELATED PROOF"),
    ]);
    running = engine.run();
    await Promise.race([
      planned.promise,
      running.then((result) => {
        throw new Error(result.error ?? "Second plan never started");
      }),
    ]);
    await correct(engine, "input/seed/n2", "LATER TARGET");
    await submit(engine, "late", [draft("n1", "LATER IMPORT")]);
    release.resolve();
    const result = await running;
    expect(result.status).toBe("running");
    expect(received?.task).toEqual(task);
    expect(received?.notes).toEqual(expected);
    expect(received?.evidence).toEqual([evidence]);
    expect(
      project(result).find((note) => note.id === "input/seed/n2")?.text,
    ).toBe("LATER TARGET");
    expect(result.work.at(-1)?.input).toEqual({
      kind: "verifier",
      view: expect.any(Number),
      targets: [{ id: "input/seed/n2", through: "source" }],
    });
    expect(result.providerCalls).toBe(0);
  } finally {
    release.resolve();
    await engine.close();
    await running;
    await rm(directory, { recursive: true });
  }
});
