import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type { EntryId } from "xean";
import type { PiSubmissionGate } from "xean/pi";

import {
  coordinatorCall,
  explorerCall,
  reconstructionCall,
  sourceCall,
  statementCall,
  proofCall,
  verifierCall,
} from "../pi-roles";
import { sourceVerdictsFor, verdictsFor, verifierNames } from "../roles";
import { z } from "zod";
import { workflowSchemaVersion } from "../workflow";

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
    await verifierCall("source", input, ["n2"]),
    await verifierCall("correctness", input, ["n2"]),
    await statementCall(input, target),
    await proofCall(input, target, { statement: "P holds." }),
  ];
  const native = await sourceCall(
    { provider: "codex", model: "test", reasoning: "low", search: false },
    input,
    ["n2"],
  );
  for (const prompt of [...calls.map((c) => c.prompt), native.request.prompt]) {
    expect(prompt).not.toContain("LONG HISTORICAL PASS EXPLANATION");
    expect(prompt).toContain('"verdict": "PASS"');
    expect(prompt).toContain(evidence.verdicts[1]!.report);
    expect(prompt).toContain(evidence.verdicts[2]!.report);
    expect(prompt).toContain(evidence.summary);
    expect(prompt).toContain(evidence.text);
  }
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
      ...(factory === sourceVerdictsFor ? { sources: [] } : {}),
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
  const source = await verifierCall("source", verification, ["n14"]);
  for (const call of [correctness, requirements, source]) {
    expect(call.system).toContain(
      "Only the requirements verifier judges whether the note completes the task.",
    );
    expect(call.system).not.toContain(
      "FAIL requires a concrete defect in the note or an unmet completion criterion",
    );
    expect(call.prompt).toContain(partial.text);
    expect(call.prompt).toContain(verification.task.completionCriteria);
  }
  expect(correctness.prompt).toContain(
    "A correct partial result passes even when it explicitly leaves the task unfinished.",
  );
  expect(correctness.prompt).toContain(
    "Fail a note when an inference is unsupported, a stated conclusion is unproved",
  );
  expect(requirements.prompt).toContain(
    "Decide whether each note meets every completion criterion of the exact task.",
  );
});

test("prompt bytes are frozen with the workflow schema version", async () => {
  const { text, ...heading } = note;
  const second = {
    ...note,
    id: "n2",
    support: ["n1"],
    verified: false,
    verdicts: [],
  };
  const verification = {
    task,
    verify: [{ note: "n2", verifiers: [...verifierNames] }],
    notes: [second],
    support: [note],
  };
  const calls: {
    label: string;
    system: string;
    prompt: string;
    submissionGate?: PiSubmissionGate | undefined;
  }[] = [
    explorerCall({
      task,
      explorerGuidance: "Extend P. Test the degenerate instances first.",
      notes: [heading],
      support: [note],
    }),
    explorerCall(
      {
        task,
        explorerGuidance: "Extend P. Test the degenerate instances first.",
        notes: [heading],
        support: [note],
      },
      true,
    ),
    coordinatorCall({ task, notes: [note, second] }),
    coordinatorCall({ task, notes: [note, second], emptySubmission: true }),
    await verifierCall("source", verification, ["n2"]),
    await verifierCall("correctness", verification, ["n2"]),
    await verifierCall("requirements", verification, ["n2"]),
  ];
  const stated = { statement: "P holds." };
  calls.push(
    await statementCall(verification, second),
    await proofCall(verification, second, stated),
    await reconstructionCall(
      verification,
      second,
      stated,
      "Independent proof of P.",
    ),
    await proofCall(verification, second, stated, 42 as EntryId),
    await reconstructionCall(
      verification,
      second,
      stated,
      "Independent proof of P.",
      42 as EntryId,
    ),
  );
  const source = await sourceCall(
    { provider: "codex", model: "codex-model", reasoning: "low", search: true },
    verification,
    ["n2"],
  );
  const digest = createHash("sha256");
  for (const call of calls) {
    digest.update(`${call.label}\n${call.system}\n${call.prompt}\n`);
    if (call.submissionGate?.continuationPrompt !== undefined)
      digest.update(`${call.submissionGate.continuationPrompt}\n`);
  }
  const offline = await sourceCall(
    {
      provider: "codex",
      model: "codex-model",
      reasoning: "low",
      search: false,
    },
    verification,
    ["n2"],
  );
  for (const call of [source, offline]) {
    digest.update(
      `${call.label}\n${call.request.developerInstructions}\n${call.request.prompt}\n`,
    );
  }
  // Changing any role prompt changes the bytes the workflow fold matches
  // against journals, so bump workflowSchemaVersion and update this digest
  // in the same change.
  expect(workflowSchemaVersion).toBe(1);
  expect(digest.digest("hex")).toBe(
    "89c8d9dacd8170ad48f6670f6868049a01c6bf0e3ed2720da1c61ace9a4c3129",
  );
});
