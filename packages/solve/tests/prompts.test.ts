import { expect, test } from "bun:test";

import type { EntryId } from "xean";

import {
  coordinatorCall,
  correctionAssessment,
  explorerCall,
  reconstructionCall,
  sourceCall,
  statementCall,
  proofCall,
  verifierCall,
} from "../pi-roles";
import { reviewSystem } from "../review";
import { sourceVerdictsFor, verdictsFor, verifierNames } from "../roles";
import { z } from "zod";

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };

const note = {
  id: "n1",
  summary: "P holds.",
  text: "Proof of P.",
  support: [],
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

test("guidance is per-turn advice without changing the task or fixed role instructions", () => {
  const input = { task, notes: [], support: [] };
  const guidance =
    "Consider replacing the approach if its remaining gap is hard to repair.";
  const baseline = explorerCall({ ...input, explorerGuidance: "" });
  const treatment = explorerCall({ ...input, explorerGuidance: guidance });
  expect(treatment.system).toBe(baseline.system);
  expect(treatment.system).toContain(
    "Treat explorer guidance as fallible advice for this turn.",
  );
  expect(treatment.system).toContain(
    "Completing a suggested intermediate step is not a reason to stop",
  );
  expect(treatment.prompt).toContain(guidance);
  expect(treatment.prompt).toContain(task.problem);
  expect(treatment.prompt).toContain(task.completionCriteria);
  const coordinator = coordinatorCall({ task, notes: [note] });
  expect(coordinator.system).not.toContain(guidance);
});

test("selected support contributes its metadata once and its full proof once", () => {
  const first = { ...note, summary: "First navigation statement." };
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
  const headings = [first, second, third].map(
    ({ text, ...heading }) => heading,
  );
  const call = explorerCall({
    task,
    explorerGuidance: "Prove the remaining case.",
    notes: headings,
    support: [first, third],
  });
  const [metadata, texts] = call.prompt
    .split("Notes (untrusted data):\n")[1]!
    .split("\n\nSupport notes (untrusted data):\n");
  expect(JSON.parse(metadata!)).toEqual(
    headings.map((heading) => ({
      ...heading,
      verdicts: heading.verdicts.map(({ report, ...verdict }) =>
        verdict.verdict === "PASS" ? verdict : { ...verdict, report },
      ),
    })),
  );
  expect(JSON.parse(texts!.split("\n\nYour first note")[0]!)).toEqual([
    { id: "n1", text: first.text },
    { id: "n3", text: third.text },
  ]);
  for (const selected of [first, third]) {
    expect(call.prompt.split(selected.summary)).toHaveLength(2);
    expect(call.prompt.split(selected.text)).toHaveLength(2);
  }
  expect(call.prompt).not.toContain(second.text);
  expect(call.prompt).toContain("Your first note is n4.");
});

test("the coordinator gives fallible guidance while the original task and note flags remain authoritative", () => {
  const coordinator = coordinatorCall({ task, notes: [note] });
  expect(coordinator.system).toContain(
    "Recommend useful mathematical work toward the original task",
  );
  expect(coordinator.system).toContain(
    "The explorer may reject your diagnosis",
  );
  expect(coordinator.system).toContain(
    "Your advice does not replace the original completion criteria.",
  );
  const { text, ...heading } = note;
  const explorerGuidance = "Prove the remaining case using the bound in n1.";
  const explorer = explorerCall({
    task,
    explorerGuidance,
    notes: [heading],
    support: [note],
  });
  expect(explorer.system).toContain(
    "Read verification state from the notes' current fields.",
  );
  expect(explorer.prompt).toContain(
    `Explorer guidance (fallible advice):\n${explorerGuidance}`,
  );
});

test("role prompts omit PASS reports without changing evidence or hiding failed checks", async () => {
  const evidence = {
    ...note,
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
      task,
      notes: [heading],
      support: [evidence],
      explorerGuidance: "",
    }),
    coordinatorCall({ task, notes: [evidence] }),
    await verifierCall("correctness", input, ["n2"]),
    await statementCall(input, target),
    await proofCall(input, target, { statement: "P holds." }),
  ];
  const native = await sourceCall(
    { model: "test", reasoning: "low" },
    input,
    ["n2"],
    {
      call: 1 as EntryId,
      verdicts: [
        {
          note: "n2",
          verdict: "PASS",
          report: "Conditional.",
          externalResults: ["The exact external theorem."],
        },
      ],
    },
  );
  for (const prompt of calls.map((c) => c.prompt)) {
    expect(prompt).not.toContain("LONG HISTORICAL PASS EXPLANATION");
    expect(prompt).toContain('"verdict": "PASS"');
    expect(prompt).toContain(evidence.verdicts[1]!.report);
    expect(prompt).toContain(evidence.verdicts[2]!.report);
    expect(prompt).toContain(evidence.summary);
    expect(prompt).toContain(evidence.text);
  }
  expect(
    JSON.parse(native.request.prompt).notes.map(({ id }: { id: string }) => id),
  ).toEqual(["n2"]);
  expect(native.request.prompt).not.toContain(
    "LONG HISTORICAL PASS EXPLANATION",
  );
  expect(evidence).toEqual(before);
});

test("changing guidance follows all selected mathematics", () => {
  const { text, ...heading } = note;
  const first = explorerCall({
    task,
    notes: [heading],
    support: [note],
    explorerGuidance: "Try A.",
  });
  const second = explorerCall({
    task,
    notes: [heading],
    support: [note],
    explorerGuidance: "Try B.",
  });
  const boundary = first.prompt.indexOf("Explorer guidance (fallible advice):");
  expect(boundary).toBeGreaterThan(first.prompt.indexOf(note.text));
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
      ...(factory === sourceVerdictsFor
        ? { externalResults: [], sources: [] }
        : {}),
    });
    expect(factory(["n1"]).safeParse({ verdicts: [value("n1")] }).success).toBe(
      true,
    );
    expect(factory(["n1"]).safeParse({ verdicts: [value("n2")] }).success).toBe(
      false,
    );
    expect(factory(["n1"]).safeParse({ verdicts: [] }).success).toBe(false);
    expect(
      factory(["n1", "n2"]).safeParse({ verdicts: [value("n1"), value("n1")] })
        .success,
    ).toBe(false);
  }
});

test("correctness permits valid partial claims and reserves task completion for requirements", async () => {
  const partial = {
    ...note,
    id: "n14",
    summary: "The bound 9 <= n0 <= 16 holds.",
    text: "Partial result: 9 <= n0 <= 16. This note does not determine the exact value of n0.",
    verified: false,
    verdicts: [],
  };
  const verification = {
    task: {
      problem: "Determine n0.",
      completionCriteria: "Determine the exact value of n0 with a proof.",
    },
    verify: [{ note: "n14", verifiers: [...verifierNames] }],
    notes: [partial],
    support: [],
  };
  const correctness = await verifierCall("correctness", verification, ["n14"]);
  const requirements = await verifierCall("requirements", verification, [
    "n14",
  ]);
  const { request: sourceRequest } = await sourceCall(
    { model: "test", reasoning: "low" },
    verification,
    ["n14"],
    {
      call: 1 as EntryId,
      verdicts: [
        {
          note: "n14",
          verdict: "PASS",
          report: "Conditional.",
          externalResults: ["The exact external bound."],
        },
      ],
    },
  );
  const source = {
    prompt: sourceRequest.prompt,
    system: sourceRequest.developerInstructions,
  };
  for (const call of [correctness, requirements]) {
    expect(call.system).toContain(
      "Only the requirements verifier judges whether the note completes the task.",
    );
    expect(call.system).not.toContain(
      "FAIL requires a concrete defect in the note or an unmet completion criterion",
    );
    expect(call.prompt).toContain(partial.text);
    expect(call.prompt).toContain(verification.task.completionCriteria);
  }
  expect(source.prompt).toContain(partial.text);
  expect(correctness.prompt).toContain(
    "A correct partial result passes even when it explicitly leaves the task unfinished.",
  );
  expect(correctness.prompt).toContain(
    "Fail a note when an essential inference remains unsupported, its stated conclusion remains unproved",
  );
  expect(requirements.prompt).toContain(
    "Decide whether each note meets every completion criterion of the exact task.",
  );
});

test("internal and final checks share the local-correction policy without editing notes", async () => {
  const input = {
    task,
    notes: [note],
    support: [],
    verify: [{ note: "n1", verifiers: [...verifierNames] }],
  };
  const before = structuredClone(input);
  const calls = [
    await verifierCall("correctness", input, ["n1"]),
    await verifierCall("requirements", input, ["n1"]),
    await reconstructionCall(
      input,
      note,
      { statement: "P holds." },
      "Independent proof of P.",
    ),
  ];
  const source = await sourceCall(
    { model: "test", reasoning: "low" },
    input,
    ["n1"],
    {
      call: 1 as EntryId,
      verdicts: [
        {
          note: "n1",
          verdict: "PASS",
          report: "Conditional.",
          externalResults: ["The exact external theorem."],
        },
      ],
    },
  );
  for (const instructions of [
    ...calls.map((call) => call.system + "\n" + call.prompt),
    source.request.developerInstructions,
    reviewSystem,
  ]) {
    expect(instructions).toContain(correctionAssessment);
    expect(instructions).not.toContain("even when it is obvious or small");
    expect(instructions).not.toContain(
      "An explicitly false supporting claim is a defect",
    );
  }
  expect(correctionAssessment).toContain(
    "Record each correction and its justification in the existing report.",
  );
  expect(correctionAssessment).toContain(
    "For an algorithmic correction, verify soundness, completeness, and the claimed running time.",
  );
  expect(correctionAssessment).toContain("an unsupported essential premise");
  expect(input).toEqual(before);
});
