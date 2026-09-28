import { expect, test } from "bun:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import {
  createSolver,
  project,
  submitCommand,
  type CoordinationInput,
} from "../packages/core/src/solve/index.ts";
import { verdict } from "../packages/core/src/solve/notes.ts";

const task = {
  problem: "Research problem",
  completionCriteria: "Complete proof",
};
const pass = { verdict: "PASS" as const, report: "Checked." };
const draft = (id: string, text: string) => ({
  id,
  text,
  summary: text,
  detailedSummary: text,
  support: [],
});
const solverFixture = (editingThresholdTokens: number | null = 200_000) =>
  createSolver(
    task,
    () => {
      throw new Error("Replaced roles need no model runtime");
    },
    { editingThresholdTokens },
  );

test("solver edits below the advisory threshold and publishes only the reviewed corpus", async () => {
  const solver = solverFixture();
  const plans: CoordinationInput[] = [];
  const reviewing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let edits = 0;
  solver.functions.coordinator = async (input) => {
    plans.push(input);
    return { work: input.editingAvailable ? [{ kind: "editor" }] : [] };
  };
  solver.functions.editor = async ({ notes, previous }) => {
    edits++;
    expect(previous).toBeUndefined();
    expect(notes).toEqual(plans[0]!.notes);
    return {
      retained: [],
      notes: [draft("n1", "Short proof")],
      report: "Combine.",
    };
  };
  solver.functions.verifier = async ({ notes }, execution) => {
    const call = await execution.recorder.begin({
      provider: "fixture",
      id: "verifier",
      api: "fixture",
    });
    await call.settle(null, null);
    return {
      kind: "verification",
      checks: notes.map(({ id }) => ({
        noteId: id,
        correctness: { ...pass, premises: [] },
        source: pass,
      })),
    };
  };
  solver.functions.editionReview = async ({ notes, previous }, execution) => {
    const call = await execution.recorder.begin({
      provider: "fixture",
      id: "review",
      api: "fixture",
    });
    await call.settle(null, null);
    expect(notes.every((note) => note.verified)).toBe(true);
    expect(previous).toEqual(plans[0]!.notes);
    reviewing.resolve();
    await release.promise;
    return pass;
  };
  const directory = await mkdtemp(join(tmpdir(), "xean-edition-"));
  const path = join(directory, "campaign.sqlite");
  const options = { ...solver, limits: { providerCalls: 1 } };
  let engine = await Xean.open(await openXeanStorage(path), options);
  try {
    await submitCommand(engine, {
      kind: "submit",
      id: "original",
      candidate: false,
      notes: [
        draft("n1", "Long argument. ".repeat(100)),
        draft("n2", "Old lemma"),
      ],
    });
    const original = project(await engine.inspect());
    const limited = await engine.run();
    expect(limited.status).toBe("limited");
    expect(typeof limited.state).toBe("string");
    expect(project(limited)).toEqual(original);
    await engine.close();
    engine = await Xean.open(await openXeanStorage(path), options);
    await engine.extendCalls(1, "finish-review");
    const running = engine.run();
    await reviewing.promise;
    expect(plans[0]!.corpus.noteCount).toBe(2);
    expect(plans[0]!.corpus.estimatedTokens).toBeLessThan(200_000);
    expect(project(await engine.inspect())).toEqual(original);
    await expect(
      submitCommand(engine, {
        kind: "submit",
        id: "late",
        candidate: false,
        notes: [draft("n1", "Late note")],
      }),
    ).rejects.toThrow("Notes are frozen while editing");
    await expect(
      submitCommand(engine, {
        kind: "correct",
        id: "typo",
        note: original[0]!.id,
        revision: 0,
        summary: "Correction",
        detailedSummary: "Correction",
        text: "Correction",
      }),
    ).rejects.toThrow("Notes are frozen while editing");
    await submitCommand(engine, {
      kind: "guide",
      id: "guide",
      text: "Continue research.",
    });
    release.resolve();
    const edited = await running;
    const replacement = project(edited);
    expect(replacement.map((note) => note.text)).toEqual(["Short proof"]);
    expect(replacement[0]).toMatchObject({
      verified: true,
      accepted: false,
      candidate: false,
    });
    expect(edited.result).toBeNull();
    expect(edited.status).not.toBe("completed");
    expect(edited.state).toBeNull();
    expect(plans.at(-1)).toMatchObject({
      notes: replacement,
      corpus: { noteCount: 1 },
      editingAvailable: false,
      guidance: ["Continue research."],
    });
    expect(plans.at(-1)!.corpus.estimatedTokens).toBeLessThan(
      plans[0]!.corpus.estimatedTokens,
    );
    expect(edits).toBe(1);
    await expect(
      engine.input({
        kind: "submit",
        id: "original",
        candidate: false,
        notes: [draft("n1", "New content with old identity")],
      }),
    ).rejects.toThrow("Submission already exists");
  } finally {
    release.resolve();
    await engine.close();
    await rm(directory, { recursive: true });
  }
});

test("stale or unverified editing cannot activate even with a passing corpus review", async () => {
  const solver = solverFixture();
  const planning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let plans = 0;
  let edits = 0;
  let checks = 0;
  let reviews = 0;
  solver.functions.coordinator = async ({
    notes,
    failures,
    editingAvailable,
  }) => {
    if (failures.length) {
      expect(failures.at(-1)?.error).toBe(
        "Repair cannot establish the premise",
      );
      expect(editingAvailable).toBe(true);
      return { work: [] };
    }
    if (!notes.length)
      return { work: [{ kind: "explorer", guidance: "Explore." }] };
    if (++plans === 1) {
      planning.resolve();
      await release.promise;
    }
    return { work: [{ kind: "editor" }] };
  };
  solver.functions.explorer = async () => ({
    kind: "notes",
    candidate: false,
    notes: [draft("n1", "Original claim")],
  });
  solver.functions.editor = async ({ notes, previous, review }) => {
    edits++;
    if (edits === 1)
      return {
        retained: [],
        notes: [draft("n1", "Stale replacement")],
        report: "Stale.",
      };
    expect(notes.map((note) => note.text)).toEqual([
      "Original claim",
      "External discovery",
    ]);
    if (edits === 2)
      return {
        retained: notes.map((note) => note.id),
        notes: [],
        report: "Keep both original notes.",
      };
    expect(verdict(notes[0]!, "source")?.verdict).toBe("INCONCLUSIVE");
    expect(previous?.[0]!.verified).toBe(false);
    expect(review).toEqual(pass);
    throw new Error("Repair cannot establish the premise");
  };
  solver.functions.verifier = async ({ notes }) => {
    checks++;
    expect(notes.map((note) => note.text)).toEqual([
      "Original claim",
      "External discovery",
    ]);
    return {
      kind: "verification",
      checks: [
        {
          noteId: notes[0]!.id,
          correctness: { ...pass, premises: ["Unsettled premise"] },
          source: { verdict: "INCONCLUSIVE", report: "Source unavailable." },
        },
        {
          noteId: notes[1]!.id,
          correctness: { ...pass, premises: [] },
          source: pass,
        },
      ],
    };
  };
  solver.functions.editionReview = async ({ notes }) => {
    reviews++;
    expect(notes[0]!.verified).toBe(false);
    expect(verdict(notes[0]!, "source")).toEqual({
      verdict: "INCONCLUSIVE",
      report: "Source unavailable.",
    });
    return pass;
  };
  const engine = await Xean.open(new MemoryStorage(), solver);
  try {
    const running = engine.run();
    await planning.promise;
    await submitCommand(engine, {
      kind: "submit",
      id: "concurrent",
      candidate: false,
      notes: [draft("n1", "External discovery")],
    });
    release.resolve();
    const failed = await running;
    expect(failed.status).toBe("running");
    expect(failed.state).toBeNull();
    expect(failed.result).toBeNull();
    expect(edits).toBe(3);
    expect(checks).toBe(1);
    expect(reviews).toBe(1);
    const notes = project(failed);
    expect(notes.map((note) => note.text)).toEqual([
      "Original claim",
      "External discovery",
    ]);
    expect(verdict(notes[0]!, "source")).toEqual({
      verdict: "INCONCLUSIVE",
      report: "Source unavailable.",
    });
    expect(notes[0]!.verified).toBe(false);
  } finally {
    release.resolve();
    await engine.close();
  }
});

test.each([null, 200_000])(
  "editing rejects disabled or mixed plans (%s)",
  async (threshold) => {
    const solver = solverFixture(threshold);
    solver.functions.coordinator = async ({ editingAvailable }) => {
      expect(editingAvailable).toBe(threshold !== null);
      return {
        work:
          threshold === null
            ? [{ kind: "editor" }]
            : [
                { kind: "editor" },
                { kind: "explorer", guidance: "Mixed work." },
              ],
      };
    };
    const engine = await Xean.open(new MemoryStorage(), solver);
    try {
      await submitCommand(engine, {
        kind: "submit",
        id: "original",
        candidate: false,
        notes: [draft("n1", "Existing result")],
      });
      const rejected = await engine.run();
      expect(rejected.status).toBe("blocked");
      expect(rejected.error).toContain(
        "Editing must be enabled, useful, and run alone",
      );
      expect(rejected.work).toHaveLength(0);
    } finally {
      await engine.close();
    }
  },
);
