import { expect, test } from "bun:test";

import {
  coordinatorCall,
  explorerCall,
  statementCall,
  proofCall,
  verifierCall,
} from "../pi-roles";
import { verdictsFor, verifierNames } from "../roles";
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

test("changing guidance preserves the task, fixed instructions and mathematical prefix", () => {
  const { text, ...heading } = note;
  const input = { task, notes: [heading], support: [note] };
  const first = explorerCall({ ...input, explorerGuidance: "Try A." });
  const second = explorerCall({ ...input, explorerGuidance: "Try B." });
  expect(first.system).toBe(second.system);
  expect(first.system).not.toContain("Try A.");
  for (const value of [task.problem, task.completionCriteria])
    expect(first.prompt).toContain(value);
  const boundary = first.prompt.indexOf("Try A.");
  expect(boundary).toBeGreaterThan(first.prompt.indexOf(text));
  expect(first.prompt.slice(0, boundary)).toBe(
    second.prompt.slice(0, boundary),
  );
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
  for (const selected of [first, third]) {
    expect(call.prompt.split(selected.summary)).toHaveLength(2);
    expect(call.prompt.split(selected.text)).toHaveLength(2);
  }
  expect(call.prompt).not.toContain(second.text);
});

test("role prompts omit PASS reports without changing evidence or hiding failed checks", () => {
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
    verifierCall("correctness", input, ["n2"]),
    statementCall(input, target),
    proofCall(input, target, { statement: "P holds." }),
  ];
  for (const prompt of calls.map((c) => c.prompt)) {
    expect(prompt).not.toContain("LONG HISTORICAL PASS EXPLANATION");
    expect(prompt).toContain('"verdict": "PASS"');
    expect(prompt).toContain(evidence.verdicts[1]!.report);
    expect(prompt).toContain(evidence.verdicts[2]!.report);
    expect(prompt).toContain(evidence.summary);
    expect(prompt).toContain(evidence.text);
  }
  expect(evidence).toEqual(before);
});

test("verdict schemas stay stable while runtime rejects missing, duplicate, and wrong note IDs", () => {
  expect(z.toJSONSchema(verdictsFor(["n1"]))).toEqual(
    z.toJSONSchema(verdictsFor(["n2", "n3"])),
  );
  const value = (note: string) => ({
    note,
    verdict: "PASS",
    report: "Checked.",
  });
  expect(
    verdictsFor(["n1"]).safeParse({ verdicts: [value("n1")] }).success,
  ).toBe(true);
  expect(
    verdictsFor(["n1"]).safeParse({ verdicts: [value("n2")] }).success,
  ).toBe(false);
  expect(verdictsFor(["n1"]).safeParse({ verdicts: [] }).success).toBe(false);
  expect(
    verdictsFor(["n1", "n2"]).safeParse({
      verdicts: [value("n1"), value("n1")],
    }).success,
  ).toBe(false);
});
