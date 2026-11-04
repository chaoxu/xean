import { expect, test } from "bun:test";
import {
  selectionResultFor,
  explorerResultFor,
  judgedBy,
  missingVerdicts,
  noteIdAfter,
  verifierNames,
  type Note,
  type Verdict,
  type Verification,
} from "../src/policy/contracts.ts";
import { explorerCall } from "../src/policy/prompts.ts";
import {
  directSupport,
  noteOrder,
  reconstructionInput,
  supportClosure,
} from "../src/policy/support.ts";
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
  checked: false,
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

test("Explorer submissions require notes and have no solution flag", () => {
  const input = { task, explorerGuidance: "", namespace: "w7", notes: [] };
  const ordinary = explorerCall(input);
  const submitted = {
    notes: [{ summary: "A claim.", text: "A partial result.", support: [] }],
  };
  expect(ordinary.schema.safeParse(submitted).success).toBe(true);
  expect(
    ordinary.schema.safeParse({ ...submitted, solution: false }).success,
  ).toBe(false);
  expect(ordinary.schema.safeParse({ notes: [] }).success).toBe(false);
});

test("Explorer can append notes using live prior support but cannot edit or choose their IDs", () => {
  const schema = explorerResultFor(
    [note("n1"), { ...note("n2"), dead: true }],
    "w7",
  );
  expect(noteIdAfter("w7", 0)).toBe("w7.1");
  expect(noteIdAfter("w7", 1)).toBe("w7.2");
  expect(
    schema.parse({
      notes: [
        { summary: "A claim.", text: "New lemma.", support: ["n1"] },
        {
          summary: "A claim.",
          text: "Use the newly appended lemma.",
          support: ["w7.1"],
        },
      ],
    }).notes,
  ).toHaveLength(2);
  for (const support of [["n2"], ["w7.1"], ["n99"], ["n1", "n1"]])
    expect(
      schema.safeParse({
        notes: [{ summary: "A claim.", text: "Invalid support.", support }],
      }).success,
    ).toBe(false);
  expect(
    schema.safeParse({
      notes: [{ id: "n1", text: "Replace proof.", support: [] }],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      notes: [{ summary: "A claim.", text: "New proof.", support: [] }],
      edits: [],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      notes: [
        { summary: "A claim.", text: "The bound is n4^{-L}.", support: [] },
      ],
    }).success,
  ).toBe(true);
});

test("Verifier selection requests valid local prefixes without dependency ordering", () => {
  const schema = selectionResultFor([note("n1"), note("n2", ["n1"])]);
  const base = {};
  for (const field of ["explorerGuidance", "support"]) {
    expect(
      schema.safeParse({
        ...base,
        verify: [],
        [field]: field === "support" ? ["n1"] : "Try a different method.",
      }).success,
    ).toBe(false);
  }
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
  ])
    expect(schema.safeParse({ ...base, verify }).success).toBe(false);
  expect(
    schema.safeParse({
      ...base,
      verify: [
        { note: "n2", verifiers: all },
        { note: "n1", verifiers: lemma },
      ],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      ...base,
      verify: [
        { note: "n1", verifiers: ["source"] },
        { note: "n2", verifiers: all },
      ],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      ...base,
      verify: [
        {
          note: "n1",
          verifiers: ["source", "correctness", "reconstruction"],
        },
      ],
    }).success,
  ).toBe(true);
  const imported = { ...note("n1"), summary: undefined };
  const unfiled = selectionResultFor([imported]);
  expect(unfiled.safeParse({ verify: [] }).success).toBe(true);
  expect(
    unfiled.safeParse({ verify: [{ note: "n1", verifiers: lemma }] }).success,
  ).toBe(true);
  expect(unfiled.safeParse({ filings: [], verify: [] }).success).toBe(false);
});

test("source then correctness then requirements then reconstruction gate reachable checks", () => {
  const input = {
    notes: [note("n1"), note("n2", ["n1"])],
    support: [],
    order: ["n1", "n2"],
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
  expect(judgedBy(input, correct, "reconstruction")).toEqual(["n2"]);
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
  ).toEqual(["n2"]);
  const failed = [verdict("source", "n1", "FAIL"), verdict("source", "n2")];
  expect(judgedBy(input, failed, "correctness")).toEqual(["n2"]);
  expect(judgedBy(input, failed, "requirements")).toEqual([]);
  expect(judgedBy(input, failed, "reconstruction")).toEqual([]);
});

test.each(["source", "correctness"] as const)(
  "%s failure does not gate a dependent root's in-flight local check",
  (stage) => {
    const input = {
      notes: [note("n1"), note("n3", ["n2"]), note("n4")],
      support: [{ ...note("n2", ["n1"]), verified: true }],
      order: ["n1", "n2", "n3", "n4"],
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
    ).toEqual(["n3", "n4"]);
  },
);

test("verification windows count direct support text once without transitive expansion", () => {
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
  expect(() => supportClosure(notes.slice(2), [...notes].reverse())).toThrow(
    "must precede",
  );
  expect(() => supportClosure(notes.slice(2), [...notes, notes[0]!])).toThrow(
    "duplicate note",
  );
  for (const [window, selected] of [
    [125, ["n3", "n4"]],
    [30, ["n3", "n4"]],
    [29, ["n3"]],
  ] as const)
    expect(
      verificationPrefix(verify, notes, window).map((entry) => entry.note),
    ).toEqual([...selected]);
  expect(() => supportClosure([notes[2]!], [notes[2]!])).toThrow(
    "missing support",
  );
  expect(() =>
    supportClosure(notes.slice(2), [
      { ...notes[0]!, support: ["n3"] },
      ...notes.slice(1),
    ]),
  ).toThrow("must precede");
});

test("narrowed local checks retain only direct assumptions from the original assignment", () => {
  const notes = [note("a"), note("b", ["a"]), note("c", ["b"])];
  expect(directSupport([notes[2]!], notes).map(({ id }) => id)).toEqual(["b"]);
  const input = {
    task,
    notes,
    support: [],
    order: notes.map(({ id }) => id),
  };
  expect(reconstructionInput(input, ["c"]).notes.map(({ id }) => id)).toEqual([
    "c",
  ]);
  expect(reconstructionInput(input, ["c"]).support.map(({ id }) => id)).toEqual(
    ["b"],
  );
  expect(
    reconstructionInput(input, ["a", "b"]).support.map(({ id }) => id),
  ).toEqual([]);
  // If A's own check drops out of the roots, B still gets A's statement as a
  // conditional assumption from the original assignment.
  expect(reconstructionInput(input, ["b"]).support.map(({ id }) => id)).toEqual(
    ["a"],
  );
});

test("opaque identities follow notebook order and namespace positions, not spelling", () => {
  const notes = [
    note("w900.8"),
    note("i30.1", ["w900.8"]),
    note("w2.1", ["i30.1"]),
  ];
  expect(supportClosure([notes[2]!], notes)).toEqual(["w900.8", "i30.1"]);
  expect(["w2.1", "i30.1", "w900.8"].sort(noteOrder(notes))).toEqual(
    notes.map(({ id }) => id),
  );
  const namespace = "w17";
  const schema = explorerResultFor(notes, namespace);
  const many = Array.from({ length: 40 }, (_, index) => ({
    summary: "Claim.",
    text: `Proof for ${noteIdAfter(namespace, index)}.`,
    support: index ? [noteIdAfter(namespace, index - 1)] : ["w2.1"],
  }));
  expect(schema.safeParse({ notes: many }).success).toBe(true);
  expect(
    schema.safeParse({ notes: [{ text: "Missing summary.", support: [] }] })
      .success,
  ).toBe(false);
});

test("new adverse evidence gates directly dead roots without propagating during local checks", () => {
  const notes = [
    note("ancestor"),
    note("middle", ["ancestor"]),
    note("target", ["middle"]),
    note("independent"),
  ];
  const input = {
    notes: [notes[0]!, notes[2]!, notes[3]!],
    support: [{ ...notes[1]!, verified: true }],
    order: notes.map(({ id }) => id),
    verify: ["ancestor", "target", "independent"].map((note) => ({
      note,
      verifiers: all,
    })),
  };
  const passes = input.verify.flatMap(({ note }) => [
    verdict("source", note),
    verdict("correctness", note),
    verdict("requirements", note),
  ]);
  input.notes[0]!.dead = true;
  expect(judgedBy(input, passes, "source")).toEqual(["target", "independent"]);
  expect(judgedBy(input, passes, "reconstruction")).toEqual([
    "target",
    "independent",
  ]);
  input.notes[0]!.dead = false;
  input.support[0]!.dead = true;
  expect(judgedBy(input, passes, "reconstruction")).toEqual([
    "ancestor",
    "target",
    "independent",
  ]);
});
