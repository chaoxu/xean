import { expect, test } from "bun:test";
import { z } from "zod";
import { note, verifierNames } from "../src/policy/contracts.ts";
import {
  coordinatorCall,
  explorerCall,
  proofCall,
  reconstructionCall,
  sourceCall,
  statementCall,
  verifierCall,
} from "../src/policy/prompts.ts";
import historical from "./fixtures/v100-contracts.json";

// These expected declarations and validation outcomes were captured by the
// archived 949a385 runtime with its own frozen dependencies, never by the port.
// Reconstruction has an intentionally different batch contract below.
const { task, explorerGuidance } = historical.input;
const support = note.parse(historical.input.support);
const target = note.parse(historical.input.target);
const verification = {
  task,
  notes: [target],
  support: [support],
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
      notes: [heading],
      support: [support],
    }),
    coordinator: coordinatorCall({ task, notes: [support, target] }),
    source: verifierCall("source", verification, [target.id]),
    correctness: verifierCall("correctness", verification, [target.id]),
    requirements: verifierCall("requirements", verification, [target.id]),
  };
}

test("ordinary contracts retain the historical schema apart from optional Explorer navigation", () => {
  const current = calls();
  for (const name of Object.keys(current) as (keyof typeof current)[]) {
    const call = current[name],
      expected = historical.contracts[name];
    const parameters = z.toJSONSchema(call.schema);
    if (name === "explorer") {
      const item = (
        parameters.properties!.notes as z.core.JSONSchema.JSONSchema
      ).items as z.core.JSONSchema.JSONSchema;
      expect(item.required).toEqual(["text", "support"]);
      for (const field of ["summary", "detailedSummary"]) {
        expect(item.properties![field]).toEqual({ type: "string" });
        delete item.properties![field];
      }
    }
    expect<unknown>(
      {
        name: call.tool,
        description: call.description,
        parameters,
      },
      name,
    ).toEqual({
      name: expected.name,
      description: expected.description,
      parameters: expected.parameters,
    });
  }
});

test("Codex source retains the historical request fields and output schema with search on or off", () => {
  for (const [name, search] of [
    ["online", true],
    ["offline", false],
  ] as const) {
    const call = sourceCall({ ...profile, search }, verification, [target.id]);
    const { developerInstructions, prompt, ...contract } = call.request;
    expect<unknown>(contract, name).toEqual(historical.codex[name]);
    expect<unknown>(z.toJSONSchema(call.schema), name).toEqual(
      historical.codex[name].outputSchema,
    );
  }
});

test("ordinary historical submissions retain required fields and rejection of extra fields", () => {
  const current = {
    ...calls(),
    codex: sourceCall({ ...profile, search: true }, verification, [target.id]),
  };
  for (const name of Object.keys(current) as (keyof typeof current)[]) {
    const schema = current[name].schema,
      expected = historical.validation[name];
    expect(schema.safeParse(expected.value).success, name).toBe(
      expected.accepted,
    );
    for (const [field, accepted] of Object.entries(expected.missingFields)) {
      const value: Record<string, unknown> = { ...expected.value };
      delete value[field];
      expect(schema.safeParse(value).success, `${name} without ${field}`).toBe(
        accepted,
      );
    }
    expect(
      schema.safeParse({ ...expected.value, extra: "not part of the contract" })
        .success,
      `${name} with extra field`,
    ).toBe(expected.extraField);
  }
});

test("batch reconstruction requires exact statement and verdict IDs and an atomic correction", () => {
  const input = { task, notes: [support, target], support: [] };
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
