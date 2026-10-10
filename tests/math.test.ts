import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type EntryId,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  batchResults,
  decode,
  noteContentSchema,
  type Note,
  type Plan,
  type SourceEvidence,
  type SolverResult,
} from "../src/math/contracts.ts";
import { readCommand } from "../src/math/commands.ts";
import { bindCodex } from "../src/math/evidence.ts";
import {
  publishCommand,
  publishResult,
  readSnapshot,
  readView,
  type MathView,
  type SnapshotReader,
} from "../src/math/state.ts";
import {
  refresh,
  noteInfo,
  pendingChecks,
  stagePassed,
  sourceEvidence,
  stagePending,
  validateNotes,
  validatePlan,
  validateResult,
} from "../src/math/notes.ts";
import { acceptedArgument, closure } from "../src/math/argument.ts";
import { mergeExploration } from "../src/math/results.ts";
import type { NoteEdit } from "../src/math/contracts.ts";

test.each([
  [[{ text: "formatted", cosmetic: true }, { text: "new proof" }], false],
  [[{ text: "new proof" }, { text: "formatted", cosmetic: true }], false],
  [[{ text: "formatted", cosmetic: true }, { summary: "shorter" }], true],
  [
    [
      { text: "formatted", cosmetic: true },
      { text: "formatted again", cosmetic: true },
    ],
    true,
  ],
  [[{ text: "new proof" }, { cosmetic: true }], false],
  [[{ summary: "shorter" }, { text: "formatted", cosmetic: true }], true],
] as [Partial<NoteEdit>[], boolean][])(
  "private edit merging preserves mathematical changes: %j",
  (edits, cosmetic) => {
    const result = mergeExploration(
      edits.map((edit) => ({
        notes: [],
        candidate: false,
        edits: [{ id: "n1", revision: 1, ...edit }],
      })),
    );
    expect(result.edits).toEqual([
      {
        id: "n1",
        revision: 1,
        ...Object.assign({}, ...edits),
        cosmetic,
      },
    ]);
  },
);

const pass = { verdict: "PASS" as const, report: "Checked exact statement." };
const content = (claim: string) => ({
  summary: claim,
  detailedSummary: claim,
  text: `${claim}\n\nProof of ${claim}.`,
});
const note = (id: string, support: string[] = [], imported = false): Note => ({
  id,
  ...content(id),
  support,
  imported,
  revision: 0,
  retired: false,
  candidate: false,
  checks: {
    correctness: { ...pass, statement: id, premises: [] },
    ...(imported ? {} : { source: pass }),
  },
  verified: false,
  accepted: false,
  dead: false,
});
const capabilities = { explorer: true, literature: false, codex: false };

test("completed uncertain checks stay closed on unchanged inputs", () => {
  const candidate = refresh([note("candidate")])[0]!;
  const report = "The completion criterion is not established.";
  candidate.checks.requirements = { verdict: "INCONCLUSIVE", report };
  expect(stagePending(candidate, "requirements")).toBe(false);
  expect(noteInfo(candidate).feedback).toEqual([
    `requirements INCONCLUSIVE: ${report}`,
  ]);
  candidate.checks.requirements = { verdict: "FAIL", report };
  expect(stagePending(candidate, "requirements")).toBe(false);
  expect(noteInfo(candidate).feedback).toEqual([
    `requirements FAIL: ${report}`,
  ]);
});

test.each(["correctness", "source", "reconstruction"] as const)(
  "%s uncertainty blocks unchanged verification requests",
  (stage) => {
    const target = note("target");
    const uncertain = {
      verdict: "INCONCLUSIVE" as const,
      report: "Unresolved.",
    };
    if (stage === "correctness")
      target.checks = {
        correctness: { ...uncertain, statement: target.id, premises: [] },
      };
    else if (stage === "source") target.checks.source = uncertain;
    else
      Object.assign(target.checks, {
        requirements: pass,
        reconstruction: { ...uncertain, proof: "Partial proof." },
      });
    const notes = refresh([target]);
    const plan: Plan = {
      work: { kind: "verifier", notes: [target.id], through: stage },
    };
    expect(() => validatePlan(plan, notes, capabilities)).toThrow(
      "no pending checks",
    );
    expect(target.dead).toBe(false);
    expect(target.accepted).toBe(false);
  },
);

test("Coordinator plans contain one worker or an intentional wait", () => {
  const plan: Plan = {
    work: { kind: "explorer", guidance: "Explore the combinatorial route" },
  };
  expect(validatePlan(plan, [], capabilities)).toEqual(plan);
  expect(() =>
    validatePlan({ work: [plan.work, plan.work] }, [], capabilities),
  ).toThrow("Invalid value");
  expect(validatePlan({ work: null }, [], capabilities)).toEqual({
    work: null,
  });
});

test("correctness targets still establish sources when they support another target", () => {
  const base = note("base");
  delete base.checks.source;
  const target = note("target", [base.id]);
  const notes = refresh([base, target]);
  expect(notes.map((note) => note.verified)).toEqual([false, false]);
  const request = {
    targets: [base.id, target.id],
    through: "correctness" as const,
  };
  const pending = pendingChecks(request.targets, request.through, notes);
  expect(pending("source").map((note) => note.id)).toEqual([base.id]);
  expect(pending("requirements")).toEqual([]);
  expect(pending("reconstruction")).toEqual([]);
  const plan = {
    work: {
      kind: "verifier",
      notes: request.targets,
      through: request.through,
    },
  };
  expect(validatePlan(plan, notes, capabilities).work).not.toBeNull();
  base.checks.source = pass;
  refresh(notes);
  expect(notes.map((note) => note.verified)).toEqual([true, true]);
  expect(() => validatePlan(plan, notes, capabilities)).toThrow(
    "no pending checks",
  );
});

test("acceptance reconstructs generated dependencies beneath trusted imports and preserves useful requirements failures", () => {
  const base = note("base");
  const imported = note("import", ["base"], true);
  const target = note("solution", ["import"]);
  base.checks.requirements = {
    verdict: "FAIL",
    report: "Supporting lemma only.",
  };
  Object.assign(target.checks, {
    requirements: pass,
    reconstruction: {
      ...pass,
      proof: "Independent proof",
    },
  });
  const notes = refresh([target, imported, base]);
  expect(notes.every((entry) => entry.verified)).toBe(true);
  expect(notes.some((note) => note.accepted)).toBe(false);
  expect(() => acceptedArgument(notes, target.id)).toThrow(
    "No accepted argument",
  );
  expect(
    validatePlan(
      {
        work: {
          kind: "verifier",
          notes: [target.id],
          through: "reconstruction",
        },
      },
      notes,
      capabilities,
    ).work,
  ).toMatchObject({ kind: "verifier", notes: [target.id] });
  base.checks.reconstruction = {
    ...pass,
    proof: "Independent lemma proof",
  };
  refresh(notes);
  expect(target.accepted).toBe(true);
  expect(acceptedArgument(notes, target.id)).toBe(
    "## base\n\nbase\n\nProof of base.\n\n## import\n\nimport\n\nProof of import.\n\n## solution\n\nsolution\n\nProof of solution.",
  );
  expect(base.dead).toBe(false);
  expect(base.accepted).toBe(false);
  expect(() =>
    validatePlan(
      {
        work: {
          kind: "verifier",
          notes: [target.id],
          through: "reconstruction",
        },
      },
      notes,
      capabilities,
    ),
  ).toThrow("no pending checks");
  base.checks.correctness = {
    verdict: "FAIL",
    report: "Concrete defect",
    statement: base.id,
    premises: [],
  };
  refresh(notes);
  expect(notes.every((entry) => entry.dead)).toBe(true);
  expect(notes.some((note) => note.accepted)).toBe(false);
});

test.each([false, true])(
  "unchanged-note PASS fixes its statement and premises without suppressing FAIL, source committed=%s",
  (sourceCommitted) => {
    const established = note("established");
    if (!sourceCommitted) delete established.checks.source;
    const dependent = note("dependent", [established.id]);
    const binding = established.checks.correctness!;
    const late: SolverResult = {
      kind: "verification",
      checks: [
        {
          noteId: established.id,
          correctness: {
            ...binding,
            premises: ["Previously unchecked premise"],
          },
        },
      ],
    };
    const check = late.checks[0]!.correctness!;
    expect(() => validateResult(late, [established])).toThrow(
      "Correctness premises are final",
    );
    check.premises = [];
    expect(validateResult(late, [established])).toEqual(late);
    check.statement = "A stronger unchecked claim";
    expect(() => validateResult(late, [established])).toThrow(
      "Correctness statement is final",
    );
    established.checks.correctness = {
      ...binding,
      verdict: "INCONCLUSIVE",
      statement: null,
    };
    expect(() => validateResult(late, [established])).toThrow(
      "Correctness statement is final",
    );
    check.verdict = "INCONCLUSIVE";
    expect(() => validateResult(late, [established])).toThrow(
      "Correctness statement is final",
    );
    established.checks.correctness = binding;
    check.statement = binding.statement;
    check.verdict = "FAIL";
    check.report = "The argument has an unsupported step.";
    check.premises = ["Different unresolved premise"];
    expect(validateResult(late, [established])).toEqual(late);
    established.checks.correctness = check;
    expect(refresh([established, dependent]).every((note) => note.dead)).toBe(
      true,
    );
  },
);

test("a null checked statement cannot establish support or acceptance even with PASS records", () => {
  const question = note("question", [], true);
  question.text = "Could an exchange argument settle the conjecture?";
  question.checks.correctness!.statement = null;
  const candidate = note("candidate", [question.id]);
  for (const entry of [question, candidate])
    Object.assign(entry.checks, {
      requirements: pass,
      reconstruction: { ...pass, proof: "Depends on the unresolved question." },
    });
  for (const entry of refresh([candidate, question]))
    expect(entry).toMatchObject({
      verified: false,
      accepted: false,
      dead: false,
    });
  expect(stagePassed(question, "source")).toBe(false);
  expect(stagePending(question, "correctness")).toBe(false);
});

test("source retries follow policy and reused evidence retains its exact original bindings", () => {
  for (const verdict of ["PASS", "FAIL", "INCONCLUSIVE"] as const) {
    const frozen = note("frozen");
    frozen.checks = {
      correctness: {
        ...pass,
        statement: frozen.id,
        premises: ["Exact frozen premise"],
      },
      source: { verdict, report: "Judged the frozen external claim" },
      reconstruction: { ...pass, proof: "Independent supporting proof" },
    };
    const dependent = note("dependent", [frozen.id]);
    Object.assign(dependent.checks, {
      requirements: pass,
      reconstruction: { ...pass, proof: "Independent proof" },
    });
    refresh([frozen, dependent]);
    expect(frozen.dead).toBe(false);
    expect(dependent.dead).toBe(false);
    expect(frozen.verified).toBe(verdict === "PASS");
    expect(dependent.verified).toBe(verdict === "PASS");
    expect(dependent.accepted).toBe(verdict === "PASS");
    expect(stagePending(frozen, "source")).toBe(false);
    expect(() =>
      validatePlan(
        { work: { kind: "verifier", notes: [frozen.id], through: "source" } },
        [frozen],
        capabilities,
      ),
    ).toThrow("no pending checks");
    expect(() =>
      validateResult(
        {
          kind: "verification",
          checks: [
            {
              noteId: frozen.id,
              correctness: {
                ...pass,
                statement: frozen.id,
                premises: ["Repaired premise"],
              },
            },
          ],
        },
        [frozen],
      ),
    ).toThrow("Correctness premises are final");
  }

  const evidence: SourceEvidence = {
    id: "source/0",
    statement: "Original exact premise",
    url: "https://example.org/theorem",
    quote: "Original quotation",
  };
  const claimed = {
    operationId: "source",
    reportedAt: "2026-10-05T00:00:00Z",
    searches: 0,
    value: {
      ...pass,
      passages: [{ premise: 0, url: evidence.url, quote: evidence.quote }],
    },
  };
  expect(bindCodex(claimed, [evidence.statement]).verdict).toBe("INCONCLUSIVE");
  const task = {
    problem: "Prove the half-weight cut guarantee.",
    completionCriteria:
      "Elementary arithmetic and basic finite graph definitions may be used.",
  };
  const selfContained = bindCodex(
    {
      ...claimed,
      value: {
        ...claimed.value,
        passages: [
          { premise: 0, url: "urn:xean:task", quote: task.completionCriteria },
        ],
      },
    },
    [],
    [],
    "review",
    task,
  );
  expect(selfContained.verdict).toBe("PASS");
  expect(selfContained.passages).toEqual([]);
  expect(
    bindCodex(
      {
        ...claimed,
        value: {
          ...claimed.value,
          passages: [{ premise: 0, passageId: evidence.id }],
        },
      },
      [evidence.statement],
      [evidence],
    ).verdict,
  ).toBe("PASS");
  const established = note("established");
  established.checks = {
    correctness: {
      ...pass,
      statement: established.id,
      premises: [evidence.statement],
    },
    source: {
      ...pass,
      kind: "codex-report",
      operationId: "source",
      reportedAt: "2026-10-04T00:00:00Z",
      premises: [evidence.statement],
      passages: [{ ...evidence, premise: 0 }],
    },
  };
  refresh([established]);
  expect(sourceEvidence([established], [evidence])).toEqual([evidence]);
  const priorApplications = [
    { ...evidence, premise: 0 },
    { ...evidence, premise: 1 },
  ];
  expect(sourceEvidence([established], priorApplications)).toEqual([evidence]);
  expect(() =>
    sourceEvidence(
      [established],
      [{ ...evidence, statement: "Substituted premise" }],
    ),
  ).toThrow("Conflicting source evidence");
  const unchecked = note("unchecked");
  unchecked.checks = {
    correctness: {
      ...pass,
      statement: unchecked.id,
      premises: ["Different exact premise"],
    },
  };
  expect(() =>
    validateResult(
      {
        kind: "verification",
        checks: [{ noteId: unchecked.id, source: established.checks.source }],
      },
      [unchecked],
    ),
  ).toThrow("Source-checked premises do not match");
});

test("batch responses and note graphs reject missing, duplicate, extra, retired and cyclic identities", () => {
  expect(
    batchResults(
      ["a", "b"],
      [
        { noteId: "b", value: 2 },
        { noteId: "a", value: 1 },
      ],
    ),
  ).toEqual([{ value: 1 }, { value: 2 }]);
  for (const results of [
    [{ noteId: "a", value: 1 }],
    [
      { noteId: "a", value: 1 },
      { noteId: "a", value: 2 },
    ],
    [
      { noteId: "a", value: 1 },
      { noteId: "b", value: 2 },
      { noteId: "c", value: 3 },
    ],
  ])
    expect(() => batchResults(["a", "b"], results)).toThrow(
      "exactly one result per requested note",
    );
  expect(() =>
    batchResults(
      ["a", "a"],
      [
        { noteId: "a", value: 1 },
        { noteId: "b", value: 2 },
      ],
    ),
  ).toThrow("exactly one result per requested note");
  for (const text of [" ", "claim\u0000", "claim\u001b"])
    expect(() =>
      decode(noteContentSchema, { ...content("claim"), text }),
    ).toThrow();
  expect(decode(noteContentSchema, content("$x \\to 0$\n")).text).toBe(
    content("$x \\to 0$\n").text,
  );
  const draft = (id: string, support: string[]) => ({
    id,
    ...content(id),
    support,
  });
  expect(() =>
    validateNotes([draft("n1", ["n2"]), draft("n2", [])], []),
  ).not.toThrow();
  expect(() =>
    validateNotes(
      [draft("n1", ["retired"])],
      [{ id: "retired", support: [], dead: false, retired: true }],
    ),
  ).toThrow("retired");
  expect(() =>
    closure(
      ["a"],
      [
        { id: "a", support: ["b"] },
        { id: "b", support: ["a"] },
      ],
    ),
  ).toThrow("Cyclic support");
});

async function notebook(storage: Storage = new MemoryStorage()) {
  const Worker = defineTask<
    { result: SolverResult; frozen: MathView },
    { phase: "publish" },
    SolverResult
  >({
    name: "math.fixture",
    version: 1,
    initial: () => ({ phase: "publish" }),
    phases: {
      async publish(task, runtime, context) {
        await runtime.commit(async (tx) => {
          await publishResult(
            tx,
            task.conversationId,
            task.input.result,
            task.id,
            task.input.frozen,
          );
          return {
            status: "terminal",
            outcome: { status: "completed", result: task.input.result },
          };
        }, context);
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      );
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "math.fixture", tasks: [Worker] }));
  const harness = await Harness.open(
    storage,
    { registry, models: createModels() },
    BACKGROUND_CONTEXT,
  );
  const root = await harness.root(BACKGROUND_CONTEXT);
  const view = () =>
    root.commit((tx) => readView(tx, root.id), BACKGROUND_CONTEXT);
  const run = async (result: SolverResult, prior?: MathView) => {
    const frozen = prior ?? (await view());
    const id = await root.commit(
      (tx) =>
        tx.createTask(
          Worker,
          { result, frozen },
          { ownership: { kind: "conversation" } },
        ),
      BACKGROUND_CONTEXT,
    );
    const record = await harness.waitForTask(id, BACKGROUND_CONTEXT);
    return { id, outcome: record.state.outcome };
  };
  const publish = async (result: SolverResult, frozen?: MathView) => {
    const completed = await run(result, frozen);
    if (completed.outcome.status !== "completed")
      throw new Error(JSON.stringify(completed.outcome));
    return completed.id;
  };
  const checkpoint = async () =>
    (
      await root.commit(
        (tx) =>
          tx.appendEntry(root.id, { kind: "math.checkpoint", data: null }),
        BACKGROUND_CONTEXT,
      )
    ).id;
  return {
    harness,
    root,
    view,
    run,
    publish,
    checkpoint,
    snapshot: (at: EntryId) =>
      readSnapshot(
        {
          snapshotAsOf: harness.snapshotAsOf.bind(harness),
          getTask: harness.getTask.bind(harness),
          entry: (id: EntryId) =>
            harness.commit((tx) => tx.entry(id), BACKGROUND_CONTEXT),
        } satisfies SnapshotReader,
        root.id,
        at,
        BACKGROUND_CONTEXT,
      ),
    command: (value: unknown) =>
      root.commit(
        (tx) => publishCommand(tx, root.id, readCommand(value)),
        BACKGROUND_CONTEXT,
      ),
  };
}

test("stable edits preserve summaries and independent evidence while repairing a dependency chain", async () => {
  const owner = await notebook();
  try {
    const initial = await owner.publish({
      kind: "notes",
      candidate: true,
      notes: [
        { id: "n1", ...content("Original lemma"), support: [] },
        { id: "n2", ...content("Independent lemma"), support: [] },
        { id: "n3", ...content("Candidate"), support: ["n1"] },
      ],
    });
    const ids = [1, 2, 3].map((index) => `${initial}/n${index}`);
    await owner.publish({
      kind: "verification",
      checks: ids.map((noteId) => ({
        noteId,
        correctness: { ...pass, statement: noteId, premises: [] },
        source: pass,
        requirements: pass,
        reconstruction: { ...pass, proof: "Independent proof." },
      })),
    });
    const checkedAt = await owner.checkpoint();
    const checked = await owner.snapshot(checkedAt);
    expect(checked.notes.at(-1)!.accepted).toBe(true);
    await owner.publish({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        {
          id: ids[0]!,
          revision: checked.notes[0]!.revision,
          summary: "A clearer index description",
        },
      ],
    });
    const summarized = await owner.view();
    expect(summarized.notes[0]!.revision).toBeGreaterThan(
      checked.notes[0]!.revision,
    );
    expect(summarized.notes[0]!.checks).toEqual(checked.notes[0]!.checks);
    expect(summarized.notes[2]!.accepted).toBe(true);

    await owner.publish({
      kind: "notes",
      candidate: false,
      notes: [],
      edits: [
        {
          id: ids[0]!,
          revision: summarized.notes[0]!.revision,
          ...content("Changed lemma"),
        },
      ],
    });
    const edited = await owner.view();
    expect(edited.notes.map((note) => note.id)).toEqual(ids);
    expect(edited.notes[0]!.checks).toEqual({});
    expect(edited.notes[1]!.checks).toEqual(checked.notes[1]!.checks);
    expect(edited.notes[2]!.text).toBe(checked.notes[2]!.text);
    expect(edited.notes[2]!.accepted).toBe(false);
    expect(edited.notes[2]!.support).toEqual([ids[0]!]);
    await owner.publish({
      kind: "verification",
      checks: [
        {
          noteId: ids[0]!,
          correctness: {
            ...pass,
            statement: "Changed exported claim",
            premises: [],
          },
          source: pass,
        },
      ],
    });
    expect((await owner.view()).notes[2]!.checks).toEqual({});

    await owner.publish({
      kind: "notes",
      candidate: false,
      notes: [
        { id: "n1", ...content("Missing replacement lemma"), support: [] },
      ],
      edits: [
        { id: ids[2]!, revision: checked.notes[2]!.revision, support: ["n1"] },
      ],
    });
    const repaired = await owner.view();
    expect(repaired.notes[2]!.id).toBe(ids[2]!);
    expect(repaired.notes[2]!.support).toEqual([repaired.notes[3]!.id]);
    expect(repaired.notes[2]!.checks).toEqual({});
    expect(await owner.snapshot(checkedAt)).toEqual(checked);
  } finally {
    await owner.harness.close(BACKGROUND_CONTEXT);
  }
});

test("conflicting and cyclic edit batches publish nothing, while retirement keeps historical mathematics", async () => {
  const owner = await notebook();
  try {
    await owner.command({
      kind: "submit",
      id: "seed",
      candidate: true,
      notes: [
        { id: "n1", ...content("Lemma"), support: [] },
        { id: "n2", ...content("Candidate"), support: ["n1"] },
      ],
    });
    const before = await owner.view();
    for (const edits of [
      [{ id: "input/seed/n1", revision: 99, summary: "Stale" }],
      [
        {
          id: "input/seed/n1",
          revision: before.notes[0]!.revision,
          support: ["input/seed/n2"],
        },
      ],
    ]) {
      const failed = await owner.run({
        kind: "notes",
        candidate: false,
        notes: [{ id: "n1", ...content("Must not leak"), support: [] }],
        edits,
      });
      expect(failed.outcome.status).toBe("faulted");
      expect(await owner.view()).toEqual(before);
    }
    await owner.publish({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        {
          id: "input/seed/n2",
          revision: before.notes[1]!.revision,
          retired: true,
        },
      ],
    });
    const retired = (await owner.view()).notes[1]!;
    expect(retired).toMatchObject({
      id: "input/seed/n2",
      retired: true,
      dead: false,
      text: before.notes[1]!.text,
    });
    expect(() =>
      validatePlan(
        {
          work: {
            kind: "verifier",
            notes: [retired.id],
            through: "correctness",
          },
        },
        [retired],
        capabilities,
      ),
    ).toThrow("Retired note");
    expect(stagePending(retired, "correctness")).toBe(true);
  } finally {
    await owner.harness.close(BACKGROUND_CONTEXT);
  }
});

test("Pi snapshots survive reopen and stale verification cannot restore current checks or summaries", async () => {
  const directory = await temporaryDirectory("pi-notebook-");
  const start = async () =>
    notebook(
      await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, {
        fsync: true,
      }),
    );
  let owner = await start();
  try {
    await owner.command({
      kind: "submit",
      id: "seed",
      candidate: true,
      notes: [{ id: "n1", ...content("Original"), support: [] }],
    });
    const frozenAt = await owner.checkpoint();
    const frozen = await owner.snapshot(frozenAt);
    await owner.command({
      kind: "correct",
      id: "edit",
      note: "input/seed/n1",
      revision: frozen.notes[0]!.revision,
      ...content("Revised"),
    });
    const worker = await owner.run(
      {
        kind: "verification",
        checks: [
          {
            noteId: "input/seed/n1",
            correction: {
              revision: frozen.notes[0]!.revision,
              summary: "Stale summary",
            },
            correctness: { ...pass, statement: "Original", premises: [] },
            requirements: pass,
          },
        ],
      },
      frozen,
    );
    expect(worker.outcome).toMatchObject({
      status: "faulted",
      error: { message: expect.stringContaining("Stale mathematical input") },
    });
    for (let index = 0; index < 129; index++)
      await owner.command({
        kind: "guide",
        id: `g-${index}`,
        text: `Guidance ${index}`,
      });
    const current = await owner.view();
    expect(current.notes[0]).toMatchObject({
      ...content("Revised"),
      checks: {},
      verified: false,
      accepted: false,
    });
    expect(current.notes[0]!.revision).toBeGreaterThan(
      frozen.notes[0]!.revision,
    );
    expect(current.guidance).toHaveLength(129);
    const record = await owner.harness.getTask(worker.id, BACKGROUND_CONTEXT);
    expect(record!.state.outcome).toMatchObject({
      status: "faulted",
      error: { message: expect.stringContaining("Stale mathematical input") },
    });
    await owner.harness.close(BACKGROUND_CONTEXT);
    owner = await start();
    expect(await owner.snapshot(frozenAt)).toEqual(frozen);
    expect(await owner.view()).toEqual(current);
  } finally {
    await owner.harness.close(BACKGROUND_CONTEXT);
  }
});
