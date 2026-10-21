// Fixtures adapted from v1.0.0 packages/solve/tests/prompts.test.ts.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  coordinatorCall,
  coordinatorUpdate,
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
  type CoordinatorInput,
  type Note,
} from "../src/policy/contracts.ts";
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
  for (const call of [coordinator, explorer]) {
    expect(call.system).toContain(
      "Reconstruction then checks eligible candidates and their generated dependencies, without requiring supporting lemmas to pass requirements.",
    );
    expect(call.system).toContain(
      "Unresolved reconstruction blocks acceptance even when source and correctness leave the note verified.",
    );
  }
  expect(coordinator.system).toContain(
    "Reuse verified notes unless reconstruction identifies an unresolved obligation that needs a new corrected note.",
  );
});

test("solution-only verification changes Coordinator instructions without changing the default prompt or crossing cache modes", () => {
  const input = { task, notes: [] };
  const baseline = coordinatorCall(input);
  expect(
    createHash("sha256")
      .update(
        JSON.stringify({ system: baseline.system, prompt: baseline.prompt }),
      )
      .digest("hex"),
  ).toBe("fd882eb1c658f3ffbf93408e08cc5849dce6cf80813df20c79241c643cf91d2a");
  const disabled = coordinatorCall({ ...input, verifyOnSolution: false });
  const enabled = coordinatorCall({ ...input, verifyOnSolution: true });
  expect(disabled.system).toBe(baseline.system);
  expect(enabled.prompt).toBe(baseline.prompt);
  expect(enabled.system).toContain("Until then return verify=[]");
  expect(enabled.system).toContain(
    "List its unverified support earlier with source and correctness",
  );
  expect(z.toJSONSchema(enabled.schema)).toEqual(
    z.toJSONSchema(baseline.schema),
  );
  const mode = { ...input, verifyOnSolution: true };
  expect(coordinatorUpdate(input, mode)).toBeUndefined();
  expect(coordinatorUpdate(mode, input)).toBeUndefined();
  expect(coordinatorUpdate(mode, mode)).toBeDefined();
  expect(
    coordinatorUpdate(input, { ...input, verifyOnSolution: false }),
  ).toBeDefined();
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
    verifierCall("source", input, ["n2"]),
    verifierCall("correctness", input, ["n2"]),
  ];
  const native = sourceCall(
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

test("Coordinator deltas preserve the projected notebook and reset unsafe changes", () => {
  const { summary: _summary, ...seed } = note;
  const initial: CoordinatorInput = {
    task,
    notes: [
      { ...seed, verified: false, verdicts: [] },
      {
        ...seed,
        id: "n2",
        text: "Source: α ≤ β.\n[quoted] \u0004",
        verdicts: [],
        verification: {
          source: "Supplied paper",
          report: "PRIVATE ATTESTATION",
        },
      },
    ],
  };
  const current: CoordinatorInput = {
    task,
    notes: [
      {
        ...initial.notes[0]!,
        summary: "P holds.",
        verified: true,
        verdicts: [
          ...note.verdicts,
          {
            note: "n1",
            verifier: "requirements",
            verdict: "INCONCLUSIVE",
            report: "Missing case.",
          },
        ],
      },
      { ...initial.notes[1]!, summary: "The source theorem." },
      {
        ...seed,
        id: "n3",
        text: "New partial argument.",
        support: ["n1"],
        verified: false,
        verdicts: [],
      },
    ],
  };
  const before = structuredClone([initial, current]);
  const first = coordinatorCall(initial),
    next = coordinatorCall(current);
  const update = coordinatorUpdate(initial, current)!;
  const records = (prompt: string) =>
    JSON.parse(prompt.split("Notes (untrusted data):\n")[1]!) as Note[];
  const merged = new Map(
    records(first.prompt).map((record) => [record.id, record]),
  );
  for (const patch of JSON.parse(
    update.split("\n\nNote updates (untrusted data):\n")[1]!,
  ) as Note[])
    merged.set(patch.id, { ...merged.get(patch.id), ...patch });
  expect([...merged.values()]).toEqual(records(next.prompt));
  expect(next.system).toBe(first.system);
  expect(z.toJSONSchema(next.schema)).toEqual(z.toJSONSchema(first.schema));
  for (const old of initial.notes)
    expect(update).not.toContain(JSON.stringify(old.text));
  expect(update).toContain("New partial argument.");
  expect(update).toContain("Missing case.");
  expect(first.prompt + update).not.toContain("PRIVATE ATTESTATION");
  expect(first.prompt + update).not.toContain('"report": "Sound."');
  expect([initial, current]).toEqual(before);
  const failed: CoordinatorInput = {
    ...current,
    notes: current.notes.map((record) =>
      record.id === "n2"
        ? record
        : {
            ...record,
            dead: true,
            verified: false,
            verdicts:
              record.id === "n1"
                ? [
                    ...record.verdicts,
                    {
                      note: "n1",
                      verifier: "correctness" as const,
                      verdict: "FAIL" as const,
                      report:
                        "The final inference fails when the parameter is zero.",
                    },
                  ]
                : record.verdicts,
          },
    ),
  };
  const failureUpdate = coordinatorUpdate(current, failed)!;
  expect(failureUpdate).toContain(
    "The final inference fails when the parameter is zero.",
  );
  for (const patch of JSON.parse(
    failureUpdate.split("\n\nNote updates (untrusted data):\n")[1]!,
  ) as Note[])
    merged.set(patch.id, { ...merged.get(patch.id), ...patch });
  expect([...merged.values()]).toEqual(records(coordinatorCall(failed).prompt));
  expect(coordinatorUpdate(failed, current)).toBeUndefined();
  const changed = (patch: Partial<Note>): CoordinatorInput => ({
    ...current,
    notes: [{ ...current.notes[0]!, ...patch }, ...current.notes.slice(1)],
  });
  for (const reset of [
    { ...current, task: { ...task, problem: "A different target." } },
    { ...current, notes: current.notes.slice(1) },
    { ...current, notes: [...current.notes].reverse() },
    changed({ text: "Changed proof." }),
    changed({ support: ["n2"] }),
    changed({
      verification: { source: "Different attestation", report: "Changed." },
    }),
    changed({ summary: "Corrected claim." }),
    changed({ summary: undefined }),
    changed({ dead: true }),
    changed({ verified: false }),
    changed({ verdicts: [] }),
  ])
    expect(coordinatorUpdate(current, reset)).toBeUndefined();
  expect(coordinatorUpdate(changed({ dead: true }), current)).toBeUndefined();
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

test("correctness permits valid partial claims and reserves task completion for requirements", () => {
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
  const correctness = verifierCall("correctness", verification, ["n14"]);
  const requirements = verifierCall("requirements", verification, ["n14"]);
  const source = verifierCall("source", verification, ["n14"]);
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

test("verifier and Codex prompts retain their baseline apart from the declared-support clarification", () => {
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
  // Retain the archived call labels only as part of its captured fingerprint.
  const historicalLabels = [
    "xean-solve/verifier/source",
    "xean-solve/verifier/correctness",
    "xean-solve/verifier/requirements",
  ];
  const calls = [
    verifierCall("source", verification, ["n2"]),
    verifierCall("correctness", verification, ["n2"]),
    verifierCall("requirements", verification, ["n2"]),
  ];
  const source = sourceCall(
    { provider: "codex", model: "codex-model", reasoning: "low", search: true },
    verification,
    ["n2"],
  );
  const digest = createHash("sha256");
  const clarified =
    "Other notes in the verification batch are premises only when they belong to that note's declared support closure.";
  expect(calls[1]!.prompt).toContain(clarified);
  for (const [index, call] of calls.entries()) {
    const prompt = call.prompt.replace(
      clarified,
      "Other notes in the verification batch are not additional premises.",
    );
    digest.update(`${historicalLabels[index]}\n${call.system}\n${prompt}\n`);
  }
  const offline = sourceCall(
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
      `${historicalLabels[0]}\n${call.request.developerInstructions}\n${call.request.prompt}\n`,
    );
  }
  // Captured from pre-batch port ae15a025, normalizing only the clarification above. The old
  // aggregate archived fingerprint also included reconstruction, Explorer, and
  // Coordinator, whose instructions intentionally change with batch acceptance.
  expect(digest.digest("hex")).toBe(
    "d0cb6f75ce5e247ded7c4961206e4b8a7308f81bc717e137d3b5d3a6a6555b70",
  );
});

test("initial and corrected blind calls contain only statements, dependency edges, and admitted source text", () => {
  const source: Note = {
    ...note,
    text: "ADMITTED_SOURCE_BODY",
    summary: "PRIVATE_SOURCE_SUMMARY",
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
  const input = { task, notes: generated, support: [source] };
  const before = structuredClone(input);
  const initial = {
    statements: generated.map(({ id }) => ({
      note: id,
      statement: `Exact claim ${id}.`,
    })),
  };
  const corrected = {
    statements: generated.map(({ id }) => ({
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
      "Every listed statement is a proof obligation, not an axiom.",
    );
    expect(call.prompt).toContain(source.text);
    expect(call.prompt).not.toContain(source.summary);
    expect(call.prompt).not.toContain(source.verification!.report);
    expect(call.prompt).not.toContain("INDEPENDENT_OLD_ARGUMENT");
    expect(call.prompt).toContain('"support"');
    for (const entry of value.statements)
      expect(call.prompt).toContain(entry.statement);
    for (const generatedNote of generated) {
      expect(call.prompt).not.toContain(generatedNote.text);
      expect(call.prompt).not.toContain(generatedNote.summary);
      for (const verdict of generatedNote.verdicts)
        expect(call.prompt).not.toContain(verdict.report);
    }
  }
  expect(input).toEqual(before);
});
