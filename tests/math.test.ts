import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  type EntryId,
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
import { readCommand, validateCommand } from "../src/math/commands.ts";
import { bindCodex } from "../src/math/evidence.ts";
import { Events, readView } from "../src/math/state.ts";
import {
  refresh,
  stagePassed,
  sourceEvidence,
  stagePending,
  validateNotes,
  validatePlan,
  validateResult,
} from "../src/math/notes.ts";
import { acceptedArgument, closure } from "../src/math/argument.ts";

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
  candidate: false,
  checks: [
    {
      correctness: { ...pass, statement: id, premises: [] },
      ...(imported ? {} : { source: pass }),
    },
  ],
  verified: false,
  accepted: false,
  dead: false,
});
const capabilities = { explorer: true, literature: false, codex: false };

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
  expect(() => validatePlan({ work: null }, [], capabilities, false)).toThrow(
    "Return useful work",
  );
});

test("acceptance reconstructs generated dependencies beneath trusted imports and preserves useful requirements failures", () => {
  const base = note("base");
  const imported = note("import", ["base"], true);
  const target = note("solution", ["import"]);
  base.checks.push({
    requirements: { verdict: "FAIL", report: "Supporting lemma only." },
  });
  target.checks.push({
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
  base.checks.push({
    reconstruction: {
      ...pass,
      proof: "Independent lemma proof",
    },
  });
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
  base.checks.push({
    correctness: {
      verdict: "FAIL",
      report: "Concrete defect",
      statement: base.id,
      premises: [],
    },
  });
  refresh(notes);
  expect(notes.every((entry) => entry.dead)).toBe(true);
  expect(notes.some((note) => note.accepted)).toBe(false);
  expect(() =>
    validateResult(
      {
        kind: "notes",
        candidate: false,
        notes: [
          { id: "n1", ...content("Frozen worker finding"), support: [base.id] },
        ],
      },
      notes,
    ),
  ).toThrow("Unknown, dead, or forward support: base");
});

test.each([false, true])(
  "correctness PASS fixes statement and premises without suppressing FAIL, source committed=%s",
  (sourceCommitted) => {
    const established = note("established");
    if (!sourceCommitted) delete established.checks[0]!.source;
    const dependent = note("dependent", [established.id]);
    const binding = established.checks[0]!.correctness!;
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
    established.checks[0]!.correctness = {
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
    established.checks[0]!.correctness = binding;
    check.statement = binding.statement;
    check.verdict = "FAIL";
    check.report = "The argument has an unsupported step.";
    check.premises = ["Different unresolved premise"];
    expect(validateResult(late, [established])).toEqual(late);
    established.checks.push(...late.checks);
    expect(refresh([established, dependent]).every((note) => note.dead)).toBe(
      true,
    );
  },
);

test("a null checked statement cannot establish support or acceptance even with PASS records", () => {
  const question = note("question", [], true);
  question.text = "Could an exchange argument settle the conjecture?";
  question.checks[0]!.correctness!.statement = null;
  const candidate = note("candidate", [question.id]);
  for (const entry of [question, candidate])
    entry.checks.push({
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

test("committed source verdicts are final and reused evidence retains immutable original bindings", () => {
  for (const verdict of ["PASS", "FAIL", "INCONCLUSIVE"] as const) {
    const frozen = note("frozen");
    frozen.checks = [
      {
        correctness: {
          ...pass,
          statement: frozen.id,
          premises: ["Exact frozen premise"],
        },
        source: { verdict, report: "Judged the frozen external claim" },
        reconstruction: { ...pass, proof: "Independent supporting proof" },
      },
    ];
    const dependent = note("dependent", [frozen.id]);
    dependent.checks.push({
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
        { kind: "verification", checks: [{ noteId: frozen.id, source: pass }] },
        [frozen],
      ),
    ).toThrow("Source verdict already committed");
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
  established.checks = [
    {
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
    },
  ];
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
  unchecked.checks = [
    {
      correctness: {
        ...pass,
        statement: unchecked.id,
        premises: ["Different exact premise"],
      },
    },
  ];
  expect(() =>
    validateResult(
      {
        kind: "verification",
        checks: [
          { noteId: unchecked.id, source: established.checks[0]!.source },
        ],
      },
      [unchecked],
    ),
  ).toThrow("Source-checked premises do not match");
});

test("batch responses and note support reject missing, duplicate, extra, dead and cyclic identities", () => {
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
  ).toThrow("forward support");
  expect(() =>
    validateNotes([draft("n1", ["dead"])], [{ id: "dead", dead: true }]),
  ).toThrow("dead");
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

test("native result references preserve frozen views and late corrections across reopen", async () => {
  const context = BACKGROUND_CONTEXT;
  const directory = await mkdtemp(join(tmpdir(), "pi-math-"));
  const Worker = defineTask<
    { standalone?: true },
    { phase: "result" },
    SolverResult
  >({
    name: "math.fixture",
    version: 1,
    initial: () => ({ phase: "result" }),
    phases: {
      async result(task, runtime, context) {
        const result: SolverResult = {
          kind: "verification",
          checks: [
            {
              noteId: task.input.standalone
                ? "standalone-only"
                : "input/seed/n2",
              correction: { revision: 0, summary: "STALE VERIFIER SUMMARY" },
              requirements: pass,
            },
          ],
        };
        await runtime.commit(async (tx) => {
          if (!task.input.standalone)
            validateResult(
              result,
              (await readView(tx, task.conversationId)).notes,
            );
          await tx.appendEntry(Events, task.conversationId, {
            data: { type: "result", task: task.id },
          });
          return {
            status: "terminal",
            outcome: { status: "completed", result },
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
  const open = async () =>
    Harness.open(
      await openNodeJsonlStorage(directory, context, { fsync: true }),
      { registry, models: createModels() },
      context,
    );
  let harness = await open();
  try {
    const root = await harness.root(context);
    const append = async (value: unknown) =>
      root.commit(async (tx) => {
        const command = validateCommand(
          readCommand(value),
          await readView(tx, root.id),
        );
        return (
          await tx.appendEntry(Events, root.id, {
            data: { type: "input", command },
          })
        ).id;
      }, context);
    const frozenAt = await append({
      kind: "submit",
      id: "seed",
      candidate: true,
      notes: [
        { id: "n1", ...content("IMPORTED SUPPORT"), support: [] },
        { id: "n2", ...content("ORIGINAL TEXT"), support: ["n1"] },
      ],
    });
    const worker = await root.commit(
      (tx) =>
        tx.createTask(
          Worker,
          {},
          { conversationId: root.id, ownership: { kind: "conversation" } },
        ),
      context,
    );
    await append({
      kind: "correct",
      id: "edit",
      note: "input/seed/n2",
      revision: 0,
      ...content("NEWER TEXT"),
    });
    await expect(
      append({
        kind: "correct",
        id: "stale",
        note: "input/seed/n2",
        revision: 0,
        ...content("STALE INPUT"),
      }),
    ).rejects.toThrow("Stale note revision");
    // A page boundary must not lose the original imports or later result references.
    await root.commit(async (tx) => {
      for (let index = 0; index < 129; index++)
        await tx.appendEntry(Events, root.id, {
          data: {
            type: "input",
            command: {
              kind: "guide",
              id: `guide-${index}`,
              text: `Guidance ${index}`,
            },
          },
        });
    }, context);
    harness.resume();
    expect(
      (await harness.waitForTask(worker, context)).state.outcome.status,
    ).toBe("completed");
    const standalone = await root.commit(
      (tx) =>
        tx.createTask(
          Worker,
          { standalone: true },
          { conversationId: root.id, ownership: { kind: "conversation" } },
        ),
      context,
    );
    await harness.waitForTask(standalone, context);
    const read = (at?: EntryId) =>
      harness.commit((tx) => readView(tx, root.id, at), context);
    const frozen = await read(frozenAt);
    expect(
      frozen.notes.map(({ text, revision, candidate, support }) => ({
        text,
        revision,
        candidate,
        support,
      })),
    ).toEqual([
      {
        text: content("IMPORTED SUPPORT").text,
        revision: 0,
        candidate: false,
        support: [],
      },
      {
        text: content("ORIGINAL TEXT").text,
        revision: 0,
        candidate: true,
        support: ["input/seed/n1"],
      },
    ]);
    const latest = await read();
    expect(latest.notes[1]).toMatchObject({
      text: content("NEWER TEXT").text,
      summary: "NEWER TEXT",
      revision: 1,
      imported: true,
      verified: false,
      accepted: false,
    });
    expect(stagePending(latest.notes[1]!, "correctness")).toBe(true);
    expect(latest.notes[1]!.checks).toEqual([{ requirements: pass }]);
    expect(latest.guidance).toHaveLength(129);
    const stored = await harness.commit((tx) => tx.task(worker), context);
    expect(stored!.state.outcome).toMatchObject({
      result: {
        checks: [
          { correction: { revision: 0, summary: "STALE VERIFIER SUMMARY" } },
        ],
      },
    });
    await harness.close(context);
    harness = await open();
    expect(await read(frozenAt)).toEqual(frozen);
    expect(await read()).toEqual(latest);
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true });
  }
});
