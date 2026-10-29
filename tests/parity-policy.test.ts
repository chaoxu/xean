import { expect, test } from "bun:test";
import {
  coordinatorResultFor,
  explorerResultFor,
  judgedBy,
  missingVerdicts,
  noteIdAfter,
  verifierInput,
  verifierNames,
  type Note,
  type Verdict,
  type Verification,
} from "../src/policy/contracts.ts";
import { explorerCall } from "../src/policy/prompts.ts";
import { solveSettings } from "../src/policy/settings.ts";
import { supportClosure } from "../src/policy/support.ts";
import { verificationPrefix } from "../src/policy/verification.ts";

// Cases taken from v1.0.0's workflow, continuation, support and recovery tests.
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const note = (
  id: string,
  support: string[] = [],
  text = `Proof ${id}.`,
): Note => ({
  id,
  text,
  summary: `Summary ${id}.`,
  support,
  verdicts: [],
  verified: false,
  dead: false,
});
const all = [...verifierNames];
const lemma: Verification["verifiers"] = ["source", "correctness"];
const verdict = (
  verifier: Verdict["verifier"],
  id: string,
  value: Verdict["verdict"] = "PASS",
): Verdict => ({
  verifier,
  note: id,
  verdict: value,
  report: `${verifier}: ${value}`,
});

test("Explorer continuation is rejected and ordinary submissions have no solution flag", () => {
  const input = { task, explorerGuidance: "", notes: [], support: [] };
  const ordinary = explorerCall(input);
  const submitted = { notes: [{ text: "A partial result.", support: [] }] };
  expect(ordinary.schema.safeParse(submitted).success).toBe(true);
  expect(
    ordinary.schema.safeParse({ ...submitted, solution: false }).success,
  ).toBe(false);
  expect(ordinary.schema.safeParse({ notes: [] }).success).toBe(false);
  const profile = { provider: "test", model: "test-model", reasoning: "high" };
  const settings = {
    maxExplorerTurns: 4,
    window: 100000,
    ...Object.fromEntries(
      ["explorer", "coordinator", ...verifierNames].map((role) => [
        role,
        profile,
      ]),
    ),
  };
  expect(solveSettings.parse(settings).verifyOnSolution).toBeUndefined();
  for (const verifyOnSolution of [false, true])
    expect(
      solveSettings.parse({ ...settings, verifyOnSolution }).verifyOnSolution,
    ).toBe(verifyOnSolution);
  expect(
    solveSettings.safeParse({ ...settings, verifyOnSolution: "true" }).success,
  ).toBe(false);
  for (const explorerContinuation of [false, true])
    expect(() =>
      solveSettings.parse({ ...settings, explorerContinuation }),
    ).toThrow("explorerContinuation");
  expect(
    solveSettings.safeParse({
      ...settings,
      explorerContextBudgetTokens: 400000,
    }).success,
  ).toBe(false);
});

test("Explorer can append notes using live prior support but cannot edit or choose their IDs", () => {
  const schema = explorerResultFor([note("n1"), { ...note("n2"), dead: true }]);
  expect(noteIdAfter(2, 0)).toBe("n3");
  expect(noteIdAfter(2, 1)).toBe("n4");
  expect(
    schema.parse({
      notes: [
        { text: "New lemma.", support: ["n1"] },
        { text: "Use the newly appended lemma.", support: ["n3"] },
      ],
    }).notes,
  ).toHaveLength(2);
  for (const support of [["n2"], ["n3"], ["n99"], ["n1", "n1"]])
    expect(
      schema.safeParse({ notes: [{ text: "Invalid support.", support }] })
        .success,
    ).toBe(false);
  expect(
    schema.safeParse({
      notes: [{ id: "n1", text: "Replace proof.", support: [] }],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      notes: [{ text: "New proof.", support: [] }],
      edits: [],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      notes: [{ text: "The bound is n4^{-L}.", support: [] }],
    }).success,
  ).toBe(true);
});

test("Coordinator requests verifier prefixes and orders support before its consumers", () => {
  const schema = coordinatorResultFor([note("n1"), note("n2", ["n1"])]);
  const base = { filings: [], explorerGuidance: "Continue.", support: [] };
  expect(
    schema.safeParse({
      ...base,
      verify: [
        { note: "n1", verifiers: lemma },
        { note: "n2", verifiers: all },
      ],
    }).success,
  ).toBe(true);
  for (const verify of [
    [{ note: "n1", verifiers: ["correctness"] }],
    [{ note: "n1", verifiers: ["source", "requirements"] }],
    [
      { note: "n2", verifiers: all },
      { note: "n1", verifiers: lemma },
    ],
    [
      { note: "n1", verifiers: ["source"] },
      { note: "n2", verifiers: all },
    ],
  ])
    expect(schema.safeParse({ ...base, verify }).success).toBe(false);
  const unfiled = coordinatorResultFor([{ ...note("n1"), summary: undefined }]);
  expect(unfiled.safeParse({ ...base, verify: [] }).success).toBe(false);
  expect(
    unfiled.safeParse({
      ...base,
      filings: [{ note: "n1", summary: "P." }],
      verify: [],
    }).success,
  ).toBe(true);
});

test("source then correctness then requirements then reconstruction gate reachable checks", () => {
  const input = {
    notes: [note("n1"), note("n2", ["n1"])],
    support: [],
    verify: [
      { note: "n1", verifiers: lemma },
      { note: "n2", verifiers: all },
    ],
  };
  expect(judgedBy(input, [], "source")).toEqual(["n1", "n2"]);
  expect(judgedBy(input, [], "correctness")).toEqual([]);
  const source = [verdict("source", "n1"), verdict("source", "n2")];
  expect(judgedBy(input, source, "correctness")).toEqual(["n1", "n2"]);
  const correct = [
    ...source,
    verdict("correctness", "n1"),
    verdict("correctness", "n2"),
  ];
  expect(judgedBy(input, correct, "requirements")).toEqual(["n2"]);
  expect(judgedBy(input, correct, "reconstruction")).toEqual([]);
  const required = [...correct, verdict("requirements", "n2")];
  const reachable = judgedBy(input, required, "reconstruction");
  expect(reachable).toEqual(["n2"]);
  expect(missingVerdicts(required, "reconstruction", reachable)).toEqual([
    "n2",
  ]);
  const inconclusive = [
    ...required,
    verdict("reconstruction", "n2", "INCONCLUSIVE"),
  ];
  expect(missingVerdicts(inconclusive, "reconstruction", reachable)).toEqual(
    [],
  );
  expect(
    judgedBy(
      input,
      [...correct, verdict("requirements", "n2", "FAIL")],
      "reconstruction",
    ),
  ).toEqual([]);
  const failed = [verdict("source", "n1", "FAIL"), verdict("source", "n2")];
  expect(judgedBy(input, failed, "correctness")).toEqual([]);
  expect(judgedBy(input, failed, "requirements")).toEqual([]);
  expect(judgedBy(input, failed, "reconstruction")).toEqual([]);
});

test.each(["source", "correctness"] as const)(
  "%s failure blocks descendants through verified support but leaves unrelated roots eligible",
  (stage) => {
    const input = {
      notes: [note("n1"), note("n3", ["n2"]), note("n4")],
      support: [{ ...note("n2", ["n1"]), verified: true }],
      verify: [
        { note: "n1", verifiers: all },
        { note: "n3", verifiers: all },
        { note: "n4", verifiers: all },
      ],
    };
    const passed = ["n1", "n3", "n4"].flatMap((id) => [
      verdict("source", id),
      verdict("correctness", id),
      verdict("requirements", id),
    ]);
    expect(judgedBy(input, passed, "reconstruction")).toEqual([
      "n1",
      "n3",
      "n4",
    ]);
    expect(
      judgedBy(
        input,
        [...passed, verdict(stage, "n1", "FAIL")],
        "reconstruction",
      ),
    ).toEqual(["n4"]);
  },
);

test("verification receives the complete ordered support closure and counts shared texts once", () => {
  const notes = [
    note("n1", [], "a".repeat(100)),
    note("n2", ["n1"], "b".repeat(10)),
    note("n3", ["n2"], "c".repeat(10)),
    note("n4", ["n2"], "d".repeat(10)),
  ];
  const verify: Verification[] = [
    { note: "n3", verifiers: lemma },
    { note: "n4", verifiers: lemma },
  ];
  expect(supportClosure([notes[2]!, notes[3]!], notes)).toEqual(["n1", "n2"]);
  const input = {
    task,
    verify,
    notes: notes.slice(2),
    support: notes.slice(0, 2),
  };
  expect(verifierInput.safeParse(input).success).toBe(true);
  for (const support of [
    [notes[1]],
    [notes[1], notes[0]],
    [notes[0], notes[0], notes[1]],
  ])
    expect(verifierInput.safeParse({ ...input, support }).success).toBe(false);
  for (const [window, selected] of [
    [125, ["n3"]],
    [130, ["n3", "n4"]],
    [1, ["n3"]],
  ] as const)
    expect(
      verificationPrefix(verify, notes, window).map((entry) => entry.note),
    ).toEqual([...selected]);
  expect(() => supportClosure([notes[2]!], [notes[2]!])).toThrow(
    "missing support",
  );
  expect(
    verifierInput.safeParse({
      ...input,
      support: [{ ...notes[0], support: ["n3"] }, notes[1]],
    }).success,
  ).toBe(false);
});
