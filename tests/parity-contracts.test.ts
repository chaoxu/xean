import { expect, test } from "bun:test";
import { z } from "zod";
import { note, verifierNames } from "../src/policy/contracts.ts";
import {
  selectionCall,
  explorerCall,
  proofCall,
  reconstructionCall,
  sourceCall,
  statementCall,
  verifierCall,
} from "../src/policy/prompts.ts";
import historical from "./fixtures/v100-contracts.json";

// These expected declarations were captured by the
// archived 949a385 runtime with its own frozen dependencies, never by the port.
// Namespaced IDs and selection intentionally change the old contracts;
// verification retains the remaining captured schema fields.
const { task, explorerGuidance } = historical.input;
const support = note.parse(historical.input.support);
const target = note.parse(historical.input.target);
const verification = {
  task,
  notes: [target],
  support: [support],
  order: [support.id, target.id],
  verify: [{ note: target.id, verifiers: [...verifierNames] }],
};
const profile = {
  provider: "codex" as const,
  model: "codex-model",
  reasoning: "low" as const,
};

function calls() {
  const { text, ...heading } = support;
  return {
    explorer: explorerCall({
      task,
      explorerGuidance,
      namespace: "w7",
      notes: [heading],
    }),
    selection: selectionCall({ task, notes: [support, target], claimed: [] }),
    source: verifierCall("source", verification, [target.id]),
    correctness: verifierCall("correctness", verification, [target.id]),
    requirements: verifierCall("requirements", verification, [target.id]),
  };
}

function opaqueIds(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, item: unknown) =>
    key === "pattern" && item === "^n[1-9][0-9]*$" ? undefined : item,
  );
}

test("verification schemas retain archived fields with opaque note IDs", () => {
  const current = calls();
  for (const name of ["source", "correctness", "requirements"] as const) {
    const call = current[name],
      expected = historical.contracts[name];
    expect(call.description).toBe(expected.description);
    expect(call.tool).toBe(expected.name);
    expect<unknown>(z.toJSONSchema(call.schema)).toEqual(
      opaqueIds(expected.parameters),
    );
  }
});

test("Explorer requires summaries and selection returns only ordered verification requests", () => {
  const { explorer, selection } = calls();
  const parameters = z.toJSONSchema(explorer.schema);
  const item = (parameters.properties!.notes as z.core.JSONSchema.JSONSchema)
    .items as z.core.JSONSchema.JSONSchema;
  expect(item.required).toEqual(["summary", "text", "support"]);
  expect(item.properties!.detailedSummary).toEqual({ type: "string" });
  expect(explorer.prompt).toContain("Your first note is w7.1.");
  expect(selection.tool).toBe("select_verification");
  expect(selection.schema.safeParse({ verify: [] }).success).toBe(true);
  expect(selection.schema.safeParse({ filings: [], verify: [] }).success).toBe(
    false,
  );
  expect(
    selection.schema.safeParse({
      verify: [{ note: support.id, verifiers: ["correctness"] }],
    }).success,
  ).toBe(false);
});

test("Codex source retains historical request fields apart from protocol and opaque IDs", () => {
  for (const [name, search] of [
    ["online", true],
    ["offline", false],
  ] as const) {
    const call = sourceCall({ ...profile, search }, verification, [target.id]);
    const { developerInstructions, prompt, ...contract } = call;
    const { protocol, ...expected } = historical.codex[name];
    expect<unknown>(contract, name).toEqual(opaqueIds(expected));
  }
});

test("batch reconstruction requires exact statement and verdict IDs and an atomic correction", () => {
  const input = {
    task,
    notes: [support, target],
    support: [],
    order: [support.id, target.id],
  };
  const value = {
    statements: [
      { note: support.id, statement: "The supporting claim holds." },
      { note: target.id, statement: "The target claim holds." },
    ],
  };
  const extract = statementCall(input);
  const prove = proofCall(input, value);
  const compare = reconstructionCall(input, value, "Independent joint proof.");
  expect([extract.tool, prove.tool, compare.tool]).toEqual([
    "submit_statement",
    "submit_proof",
    "submit_verdict",
  ]);
  expect<unknown>(z.toJSONSchema(prove.schema)).toEqual(
    historical.contracts.proof.parameters,
  );
  expect(extract.schema.safeParse(value).success).toBe(true);
  const verdict = (note: string) => ({
    note,
    verdict: "PASS",
    report: "Checked.",
  });
  const verdicts = [verdict(support.id), verdict(target.id)];
  expect(compare.schema.safeParse({ statements: [], verdicts }).success).toBe(
    true,
  );
  expect(compare.schema.safeParse({ statements: null, verdicts }).success).toBe(
    false,
  );
  expect(compare.schema.safeParse({ ...value, verdicts: [] }).success).toBe(
    true,
  );
  expect(compare.schema.safeParse({ ...value, verdicts }).success).toBe(false);
  expect(
    compare.schema.safeParse({ statements: [], verdicts: [] }).success,
  ).toBe(false);
  expect(
    extract.schema.safeParse({ statement: "Old singular contract." }).success,
  ).toBe(false);
  for (const ids of [
    [support.id, "n99"],
    [support.id, support.id],
    [support.id],
    [],
  ]) {
    const statements = ids.map((note) => ({ note, statement: "A claim." }));
    expect(extract.schema.safeParse({ statements }).success).toBe(false);
    expect(compare.schema.safeParse({ statements, verdicts: [] }).success).toBe(
      false,
    );
    expect(
      compare.schema.safeParse({ statements: [], verdicts: ids.map(verdict) })
        .success,
    ).toBe(false);
  }
  expect(extract.schema.safeParse({ ...value, extra: true }).success).toBe(
    false,
  );
  expect(
    compare.schema.safeParse({ statements: [], verdicts, extra: true }).success,
  ).toBe(false);
  const other = { ...input, notes: [{ ...target, id: "n3", support: [] }] };
  const otherStatements = {
    statements: [{ note: "n3", statement: "Q holds." }],
  };
  expect(z.toJSONSchema(statementCall(other).schema)).toEqual(
    z.toJSONSchema(extract.schema),
  );
  expect(
    z.toJSONSchema(
      reconstructionCall(other, otherStatements, "Q proof.").schema,
    ),
  ).toEqual(z.toJSONSchema(compare.schema));
});
