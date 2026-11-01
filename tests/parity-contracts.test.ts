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
// Coordinator advice/reading fields are deliberately retired; reconstruction
// has an intentionally different batch contract below.
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
    }),
    coordinator: coordinatorCall({ task, notes: [support, target] }),
    source: verifierCall("source", verification, [target.id]),
    correctness: verifierCall("correctness", verification, [target.id]),
    requirements: verifierCall("requirements", verification, [target.id]),
  };
}

test("contracts retain historical verification schemas while retiring Coordinator advice and adding optional Explorer summaries", () => {
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
    const expectedParameters = structuredClone(
      expected.parameters,
    ) as z.core.JSONSchema.JSONSchema;
    if (name === "coordinator") {
      expect(call.description).toBe(
        "File missing summaries and list the notes to verify with their verifiers",
      );
      delete expectedParameters.properties!.explorerGuidance;
      delete expectedParameters.properties!.support;
      expectedParameters.required = ["filings", "verify"];
    } else {
      expect(call.description, name).toBe(expected.description);
    }
    expect(call.tool, name).toBe(expected.name);
    expect<unknown>(parameters, name).toEqual(expectedParameters);
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

test("historical submissions retain required fields apart from retired Coordinator advice and reading selections", () => {
  const current = {
    ...calls(),
    codex: sourceCall({ ...profile, search: true }, verification, [target.id]),
  };
  for (const name of Object.keys(current) as (keyof typeof current)[]) {
    const schema = current[name].schema,
      expected = historical.validation[name];
    const currentValue: Record<string, unknown> = { ...expected.value };
    const retired =
      name === "coordinator" ? ["explorerGuidance", "support"] : [];
    for (const field of retired) delete currentValue[field];
    expect(schema.safeParse(currentValue).success, name).toBe(
      expected.accepted,
    );
    if (retired.length)
      expect(schema.safeParse(expected.value).success).toBe(false);
    for (const [field, accepted] of Object.entries(expected.missingFields)) {
      if (retired.includes(field)) continue;
      const value: Record<string, unknown> = { ...currentValue };
      delete value[field];
      expect(schema.safeParse(value).success, `${name} without ${field}`).toBe(
        accepted,
      );
    }
    expect(
      schema.safeParse({ ...currentValue, extra: "not part of the contract" })
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
