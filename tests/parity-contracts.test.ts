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
// The existing v1 prompt digest covers the instruction and prompt strings.
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

async function calls() {
  const { text, ...heading } = support;
  return {
    explorer: explorerCall({
      task,
      explorerGuidance,
      notes: [heading],
      support: [support],
    }),
    coordinator: coordinatorCall({ task, notes: [support, target] }),
    source: await verifierCall("source", verification, [target.id]),
    correctness: await verifierCall("correctness", verification, [target.id]),
    requirements: await verifierCall("requirements", verification, [target.id]),
    statement: await statementCall(verification, target),
    proof: await proofCall(verification, target, { statement: "P holds." }),
    reconstruction: await reconstructionCall(
      verification,
      target,
      { statement: "P holds." },
      "Independent proof of P.",
    ),
  };
}

test("every role retains the historical tool name, description and complete JSON Schema", async () => {
  const current = await calls();
  for (const name of Object.keys(current) as (keyof typeof current)[]) {
    const call = current[name],
      expected = historical.contracts[name];
    expect<unknown>(
      {
        name: call.tool,
        description: call.description,
        parameters: z.toJSONSchema(call.schema),
      },
      name,
    ).toEqual({
      name: expected.name,
      description: expected.description,
      parameters: expected.parameters,
    });
  }
  expect(current.explorer.submissionGate).toBeUndefined();
});

test("Codex source retains the historical request fields and output schema with search on or off", async () => {
  for (const [name, search] of [
    ["online", true],
    ["offline", false],
  ] as const) {
    const call = await sourceCall({ ...profile, search }, verification, [
      target.id,
    ]);
    const { developerInstructions, prompt, ...contract } = call.request;
    expect<unknown>(contract, name).toEqual(historical.codex[name]);
    expect<unknown>(z.toJSONSchema(call.schema), name).toEqual(
      historical.codex[name].outputSchema,
    );
  }
});

test("historical submissions retain required fields, nullable statements and rejection of extra fields", async () => {
  const current = {
    ...(await calls()),
    codex: await sourceCall({ ...profile, search: true }, verification, [
      target.id,
    ]),
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
