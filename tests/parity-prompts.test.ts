// Fixtures adapted from v1.0.0 packages/solve/tests/prompts.test.ts.
import { expect, test } from "bun:test";

import {
  selectionCall,
  explorerCall,
  reconstructionCall,
  sourceCall,
  statementCall,
  proofCall,
  verifierCall,
} from "../src/policy/prompts.ts";
import {
  sourceVerdictsFor,
  verdictsFor,
  verifierNames,
  type Note,
} from "../src/policy/contracts.ts";
import { z } from "zod";

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };

const note = {
  id: "n1",
  summary: "P holds.",
  text: "Proof of P.",
  support: [],
  checked: true,
  verified: true,
  dead: false,
  verdicts: [
    {
      verifier: "correctness" as const,
      note: "n1",
      verdict: "PASS" as const,
      report: "Sound.",
    },
  ],
};

test("operator guidance is per-turn advice without changing the task or fixed role instructions", () => {
  const input = { task, notes: [] };
  const guidance =
    "Consider replacing the approach if its remaining gap is hard to repair.";
  const baseline = explorerCall({
    namespace: "w7",
    ...input,
    explorerGuidance: "",
  });
  const treatment = explorerCall({
    namespace: "w7",
    ...input,
    explorerGuidance: guidance,
  });
  expect(treatment.system).toBe(baseline.system);
  expect(treatment.system).toContain(
    "Treat operator guidance as fallible advice for this turn.",
  );
  expect(treatment.system).toContain(
    "Completing a suggested intermediate step is not a reason to stop",
  );
  expect(treatment.prompt).toContain(guidance);
  expect(treatment.prompt).toContain(task.problem);
  expect(treatment.prompt).toContain(task.completionCriteria);
  const selection = selectionCall({ task, notes: [note], claimed: [] });
  expect(selection.system).not.toContain(guidance);
});

test("Explorer receives the complete index without selected reading or preloaded note bodies", () => {
  const first = {
    ...note,
    summary: "First navigation statement.",
    detailedSummary: "Full conditions and bounds.",
  };
  const second = {
    ...note,
    id: "n2",
    summary: "Unselected navigation statement.",
    text: "Unselected proof text.",
    verified: false,
    verdicts: [],
  };
  const third = {
    ...note,
    id: "n3",
    summary: "Defective navigation statement.",
    text: "Selected failed proof text.",
    support: ["n1"],
    verified: false,
    dead: true,
    verdicts: [
      {
        verifier: "correctness" as const,
        note: "n3",
        verdict: "FAIL" as const,
        report: "The last inference is invalid.",
      },
    ],
  };
  const headings = ([first, second, third] as Note[]).map(
    ({ text, detailedSummary: _detail, ...heading }) => heading,
  );
  const call = explorerCall({
    namespace: "w7",
    task,
    explorerGuidance: "Prove the remaining case.",
    notes: headings,
  });
  const [metadata] = call.prompt
    .split("Notes (untrusted data):\n")[1]!
    .split("\n\nYour first note");
  expect(JSON.parse(metadata!)).toEqual(
    headings.map((heading) => ({
      ...heading,
      verdicts: heading.verdicts.map(({ report, ...verdict }) =>
        verdict.verdict === "PASS" ? verdict : { ...verdict, report },
      ),
    })),
  );
  expect(call.prompt).not.toContain("Suggested reading");
  for (const selected of [first, third]) {
    expect(call.prompt.split(selected.summary)).toHaveLength(2);
    expect(call.prompt).not.toContain(selected.text);
  }
  expect(call.prompt).not.toContain(first.detailedSummary);
  expect(call.prompt).not.toContain(second.text);
  expect(call.prompt).toContain("Your first note is w7.1.");
  expect(call.system).toContain(
    "List an earlier note from this same submission as support whenever you use its argument or result.",
  );
  expect(call.system).toContain(
    "References such as 'above' do not create a dependency.",
  );
  expect(call.system).toContain(
    "Use a summary to apply a verified result when it states the conclusion and all definitions, hypotheses, conventions, and limitations needed for your application.",
  );
  expect(call.system).toContain(
    "Use read_notes for detailed statements and conditions, or full texts when you need a proof, construction, or missing detail.",
  );
  expect(call.system).toContain(
    "A summary carries the note's verification state and does not establish an unverified result. Cite the note as support whenever you use its result.",
  );
  expect(call.system).not.toContain("read the full text before relying");
});

test("Verifier owns selection while Explorer retains mathematical direction", () => {
  const selector = selectionCall({ task, notes: [note], claimed: ["n1"] });
  expect(selector.system).toContain("choosing useful verification work");
  expect(selector.system).toContain("Selection does not establish correctness");
  expect(selector.system).toContain(
    "Do not give exploration advice, edit notes, or write summaries",
  );
  expect(selector.system).toContain("need not select every note");
  expect(selector.prompt).toContain(
    'Active verification claims (execution information):\n["n1"]',
  );
  const { text, ...heading } = note;
  const explorer = explorerCall({
    namespace: "w7",
    task,
    explorerGuidance: "",
    notes: [heading],
  });
  expect(explorer.system).toContain(
    "Choose the mathematical direction and which notes to read.",
  );
  expect(
    explorer.schema.safeParse({
      notes: [{ summary: "P.", text: "P proof.", support: [] }],
      verify: [],
    }).success,
  ).toBe(false);
  for (const call of [selector, explorer]) {
    expect(call.system).toContain(
      "Each note is checked conditionally on its declared direct dependency statements.",
    );
    expect(call.system).toContain(
      "A local check can finish while its dependencies remain unresolved.",
    );
  }
  const imported = {
    ...note,
    summary: undefined,
    text: "PRIVATE_IMPORTED_PROOF",
  };
  const missing = selectionCall({ task, notes: [imported], claimed: [] });
  expect(missing.prompt).not.toContain(imported.text);
  expect(missing.system).toContain("including notes without summaries");
  expect(
    missing.schema.safeParse({
      verify: [{ note: "n1", verifiers: ["source", "correctness"] }],
    }).success,
  ).toBe(true);
});

test("solution-only verification changes selection instructions without changing its schema", () => {
  const input = { task, notes: [], claimed: [] };
  const baseline = selectionCall(input);
  const disabled = selectionCall({ ...input, verifyOnSolution: false });
  const enabled = selectionCall({ ...input, verifyOnSolution: true });
  expect(disabled.system).toBe(baseline.system);
  expect(enabled.prompt).toBe(baseline.prompt);
  expect(enabled.system).toContain("Until then return verify=[]");
  expect(enabled.system).toContain(
    "You may also explicitly select its unchecked dependencies with source, correctness, reconstruction",
  );
  expect(z.toJSONSchema(enabled.schema)).toEqual(
    z.toJSONSchema(baseline.schema),
  );
});

test("prior solution support can be selected without offering or rechecking its root", () => {
  const input = {
    task,
    notes: [note],
    claimed: [],
    nominatedSupport: [note.id, "outside-view"],
  };
  const deferred = selectionCall({ ...input, verifyOnSolution: true });
  expect(deferred.prompt).toContain(
    `Previously nominated support IDs (execution information):\n${JSON.stringify(input.nominatedSupport)}`,
  );
  expect(deferred.system).toContain(
    "these three local checks without selecting their solution again",
  );
  expect(deferred.system).toContain("Select only notes in the offered index");
  const verify = [
    { note: note.id, verifiers: ["source", "correctness", "reconstruction"] },
  ];
  expect(deferred.schema.safeParse({ verify }).success).toBe(true);
  expect(
    deferred.schema.safeParse({
      verify: [{ ...verify[0], note: "outside-view" }],
    }).success,
  ).toBe(false);
  expect(deferred.schema.safeParse({ verify: [] }).success).toBe(true);
  const ordinary = selectionCall(input);
  expect(ordinary.prompt).toBe(
    selectionCall({ ...input, nominatedSupport: undefined }).prompt,
  );
  expect(z.toJSONSchema(deferred.schema)).toEqual(
    z.toJSONSchema(ordinary.schema),
  );
});

test("role prompts omit PASS reports without changing evidence or hiding failed checks", () => {
  const evidence = {
    ...note,
    verification: {
      source: "Supplied paper",
      report:
        "Only established results are granted. Exercises and conjectures remain unproved.",
    },
    verdicts: [
      { ...note.verdicts[0]!, report: "LONG HISTORICAL PASS EXPLANATION" },
      {
        verifier: "requirements" as const,
        note: "n1",
        verdict: "FAIL" as const,
        report: "The arbitrary parameter case remains open.",
      },
      {
        verifier: "reconstruction" as const,
        note: "n1",
        verdict: "INCONCLUSIVE" as const,
        report: "The cited equality case is unresolved.",
      },
    ],
  };
  const before = structuredClone(evidence);
  const target = { ...note, id: "n2", support: ["n1"], verdicts: [] };
  const input = {
    task,
    notes: [target],
    support: [evidence],
    verify: [{ note: "n2", verifiers: [...verifierNames] }],
  };
  const { text, ...heading } = evidence;
  const calls = [
    explorerCall({
      namespace: "w7",
      task,
      notes: [heading],
      explorerGuidance: "",
    }),
    selectionCall({ task, notes: [evidence], claimed: [] }),
    verifierCall("source", input, ["n2"]),
    verifierCall("correctness", input, ["n2"]),
    verifierCall("requirements", input, ["n2"]),
  ];
  const native = sourceCall(
    { provider: "codex", model: "test", reasoning: "low", search: false },
    input,
    ["n2"],
  );
  for (const [index, prompt] of [
    ...calls.map((c) => c.prompt),
    native.prompt,
  ].entries()) {
    expect(prompt).not.toContain("LONG HISTORICAL PASS EXPLANATION");
    expect(prompt).toContain(evidence.verification.report);
    if (index < 2) {
      expect(prompt).toContain('"verdict": "PASS"');
      expect(prompt).toContain(evidence.verdicts[1]!.report);
      expect(prompt).toContain(evidence.verdicts[2]!.report);
      expect(prompt).toContain(evidence.summary);
      expect(prompt).not.toContain(evidence.text);
    } else {
      expect(prompt).toContain(evidence.text);
      expect(prompt).not.toContain(evidence.verdicts[1]!.report);
      expect(prompt).not.toContain(evidence.verdicts[2]!.report);
      const assumptions = JSON.parse(
        prompt
          .split("Support notes (untrusted data):\n")[1]!
          .split("\n\nNotes under verification")[0]!,
      );
      expect(assumptions).toEqual([
        {
          id: evidence.id,
          text: evidence.text,
          verification: evidence.verification,
        },
      ]);
    }
  }
  expect(evidence).toEqual(before);
});

test("changing operator guidance follows the complete index", () => {
  const { text, ...heading } = note;
  const first = explorerCall({
    namespace: "w7",
    task,
    notes: [heading],
    explorerGuidance: "Try A.",
  });
  const second = explorerCall({
    namespace: "w7",
    task,
    notes: [heading],
    explorerGuidance: "Try B.",
  });
  const boundary = first.prompt.indexOf("Operator guidance (fallible advice):");
  expect(boundary).toBeGreaterThan(
    first.prompt.indexOf("Notes (untrusted data):"),
  );
  expect(first.prompt.slice(0, boundary)).toBe(
    second.prompt.slice(0, boundary),
  );
});

test("verifier schemas stay stable while runtime rejects missing, duplicate, and wrong note IDs", () => {
  for (const factory of [verdictsFor, sourceVerdictsFor]) {
    expect(z.toJSONSchema(factory(["n1"]))).toEqual(
      z.toJSONSchema(factory(["n2", "n3"])),
    );
    const value = (note: string) => ({
      note,
      verdict: "PASS",
      report: "Checked.",
      ...(factory === sourceVerdictsFor ? { sources: [] } : {}),
    });
    expect(factory(["n1"]).safeParse({ verdicts: [value("n1")] }).success).toBe(
      true,
    );
    expect(factory(["n1"]).safeParse({ verdicts: [value("n2")] }).success).toBe(
      false,
    );
    expect(factory(["n1"]).safeParse({ verdicts: [] }).success).toBe(false);
    const malformed = factory(["n1", "n2"]).safeParse({
      verdicts: ["n1", "n1", "n99"].map(value),
    });
    if (malformed.success) throw new Error("Malformed IDs were accepted");
    const message = malformed.error.issues[0]!.message;
    expect(message).toContain('expected note ID exactly once: ["n1","n2"]');
    expect(message).toContain('Missing: ["n2"]');
    expect(message).toContain('Unexpected: ["n99"]');
    expect(message).toContain('Repeated: ["n1"]');
    expect(
      factory(["n1", "n2"]).safeParse({ verdicts: [value("n1"), value("n1")] })
        .success,
    ).toBe(false);
  }
});

test("native and Codex checks assume direct dependencies without checking them again", () => {
  const target = {
    ...note,
    id: "n2",
    support: ["n1"],
    checked: false,
    verified: false,
  };
  const input = {
    task,
    notes: [note, target],
    support: [],
    verify: [{ note: "n2", verifiers: [...verifierNames] }],
  };
  const source = sourceCall(
    { provider: "codex", model: "test", reasoning: "low", search: false },
    input,
    ["n2"],
  );
  const native = verifierCall("source", input, ["n2"]);
  for (const prompt of [source.prompt, native.prompt]) {
    const support = JSON.parse(
      prompt
        .split("Support notes (untrusted data):\n")[1]!
        .split("\n\nNotes under verification")[0]!,
    );
    expect(support.map((entry: Note) => entry.id)).toEqual(["n1"]);
    expect(prompt).toContain("without rechecking their proofs or sources");
    expect(prompt).toContain(
      "supplied by a direct declared dependency statement",
    );
  }
  const correctness = verifierCall("correctness", input, ["n2"]);
  expect(correctness.prompt).toContain("direct declared dependency statements");
  expect(correctness.prompt).toContain(
    "Another selected note may be assumed only when it is a direct declared dependency",
  );
  expect(correctness.prompt).not.toContain(
    "support and its transitive closure",
  );
});

test("initial and corrected blind calls contain scoped statements without any original proof text", () => {
  const source: Note = {
    ...note,
    text: "ADMITTED_SOURCE_BODY",
    summary: "PRIVATE_SOURCE_SUMMARY",
    detailedSummary: "PRIVATE_SOURCE_DETAIL",
    verdicts: [],
    verification: {
      source: "Trusted theorem",
      report: "PRIVATE_SOURCE_REPORT",
    },
  };
  const generated: Note[] = ["n2", "n3"].map((id, index) => ({
    ...note,
    id,
    text: `ORIGINAL_GENERATED_BODY_${id}`,
    summary: `GENERATED_SUMMARY_${id}`,
    detailedSummary: `GENERATED_DETAIL_${id}`,
    support: [index === 0 ? "n1" : "n2"],
    verdicts: [
      {
        verifier: "correctness",
        note: id,
        verdict: "PASS",
        report: `GENERATED_REPORT_${id}`,
      },
      {
        verifier: "reconstruction",
        note: id,
        verdict: "INCONCLUSIVE",
        report: `GENERATED_UNRESOLVED_REPORT_${id}`,
      },
    ],
  }));
  const input = {
    task,
    notes: generated,
    support: [source],
  };
  const before = structuredClone(input);
  const initial = {
    statements: [source, ...generated].map(({ id }) => ({
      note: id,
      statement: `Exact claim ${id}.`,
    })),
  };
  const corrected = {
    statements: [source, ...generated].map(({ id }) => ({
      note: id,
      statement: `Corrected exact claim ${id}.`,
    })),
  };
  const extract = statementCall(input);
  const comparison = reconstructionCall(
    input,
    initial,
    "INDEPENDENT_OLD_ARGUMENT",
  );
  for (const call of [extract, comparison]) {
    expect(call.prompt).toContain(source.verification!.report);
    expect(call.prompt).toContain('Selected target IDs: ["n2","n3"]');
    for (const generatedNote of generated)
      expect(call.prompt).toContain(generatedNote.text);
    expect(call.system).toContain(
      "Do not weaken an unproved unconditional claim into a conditional statement",
    );
  }
  expect(extract.system).toContain("Preserve each note's asserted scope");
  for (const value of [initial, corrected]) {
    const call = proofCall(input, value);
    expect(call.system).toContain(
      "using only its listed direct dependency statements as assumptions",
    );
    expect(call.prompt).not.toContain(source.text);
    expect(call.prompt).not.toContain(source.summary);
    expect(call.prompt).not.toContain(source.detailedSummary!);
    expect(call.prompt).not.toContain(source.verification!.report);
    expect(call.prompt).not.toContain("INDEPENDENT_OLD_ARGUMENT");
    const obligations = JSON.parse(
      call.prompt.split("Selected statements to prove (untrusted data):\n")[1]!,
    );
    expect(obligations).toEqual(
      generated.map((target) => ({
        note: target.id,
        statement: value.statements.find((entry) => entry.note === target.id)!
          .statement,
        assumptions: target.support.map((id) =>
          value.statements.find((entry) => entry.note === id),
        ),
      })),
    );
    expect(
      obligations[0].assumptions.map((entry: { note: string }) => entry.note),
    ).toEqual(["n1"]);
    expect(
      obligations[1].assumptions.map((entry: { note: string }) => entry.note),
    ).toEqual(["n2"]);
    for (const entry of value.statements)
      expect(call.prompt).toContain(entry.statement);
    for (const generatedNote of generated) {
      expect(call.prompt).not.toContain(generatedNote.text);
      expect(call.prompt).not.toContain(generatedNote.summary);
      expect(call.prompt).not.toContain(generatedNote.detailedSummary!);
      for (const verdict of generatedNote.verdicts)
        expect(call.prompt).not.toContain(verdict.report);
    }
  }
  expect(extract.schema.safeParse(initial).success).toBe(true);
  expect(
    extract.schema.safeParse({ statements: initial.statements.slice(1) })
      .success,
  ).toBe(false);
  const verdict = (note: string) => ({
    note,
    verdict: "PASS",
    report: "Local proof checked.",
  });
  expect(
    comparison.schema.safeParse({
      statements: [],
      verdicts: generated.map(({ id }) => verdict(id)),
    }).success,
  ).toBe(true);
  expect(
    comparison.schema.safeParse({
      statements: [],
      verdicts: [source, ...generated].map(({ id }) => verdict(id)),
    }).success,
  ).toBe(false);
  expect(
    comparison.schema.safeParse({
      statements: corrected.statements,
      verdicts: [],
    }).success,
  ).toBe(true);
  expect(
    comparison.schema.safeParse({
      statements: corrected.statements.slice(1),
      verdicts: [],
    }).success,
  ).toBe(false);
  expect(comparison.system).toContain("Judge selected roots independently");
  expect(input).toEqual(before);
});

test("opaque verdict IDs cannot collide through delimiter normalization", () => {
  const wanted = ["a,b", "c"],
    wrong = ["a", "b,c"];
  const value = (note: string) => ({
    note,
    verdict: "PASS",
    report: "Checked.",
  });
  expect(
    verdictsFor(wanted).safeParse({ verdicts: wanted.map(value).reverse() })
      .success,
  ).toBe(true);
  expect(
    verdictsFor(wanted).safeParse({ verdicts: wrong.map(value) }).success,
  ).toBe(false);
});
