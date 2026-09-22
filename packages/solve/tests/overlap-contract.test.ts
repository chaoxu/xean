import { expect, test } from "bun:test";

import { coordinatorCall } from "../pi-roles";
import {
  coordinatorBehavior,
  coordinatorResult,
  defaultCoordinatorBehavior,
  type CoordinatorResult,
} from "../roles";

const task = {
  problem: "Prove P.",
  completionCriteria: "Give a complete proof of P.",
};
const note = {
  id: "n1",
  summary: "A lemma toward P.",
  text: "Proof of a lemma toward P.",
  support: [],
  verdicts: [],
  verified: false,
  dead: false,
};
const serial: CoordinatorResult = {
  filings: [],
  verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
  action: { role: "verifier" },
};
const concurrent = {
  ...serial,
  explorerGuidance: "Explore an independent route toward P.",
  support: [],
};

function call(overlap?: boolean, verification: "decide" | "always" = "decide") {
  return coordinatorCall({
    task,
    notes: [note],
    coordinatorBehavior: {
      literature: "optional",
      verification,
      ...(overlap === undefined ? {} : { overlap }),
    },
  });
}

test("overlap defaults off and explicit false preserves the serial contract", () => {
  expect(defaultCoordinatorBehavior.overlap).toBe(false);
  expect(
    coordinatorBehavior.parse({
      literature: "never",
      verification: "decide",
    }).overlap,
  ).toBe(false);
  for (const request of [call(), call(false)]) {
    expect(request.schema.safeParse(serial).success).toBe(true);
    expect(request.schema.safeParse(concurrent).success).toBe(false);
  }
  expect(call().system).toBe(call(false).system);
  expect(call().prompt).toBe(call(false).prompt);
});

test("enabled overlap accepts an optional pair of Explorer fields on a verifier action", () => {
  const request = call(true);
  expect(request.schema.parse(concurrent)).toEqual(concurrent);
  expect(request.schema.parse(serial)).toEqual(serial);
  for (const incomplete of [
    { ...serial, explorerGuidance: concurrent.explorerGuidance },
    { ...serial, support: [] },
  ]) {
    expect(coordinatorResult.safeParse(incomplete).success).toBe(false);
    expect(request.schema.safeParse(incomplete).success).toBe(false);
  }
  expect(
    request.schema.safeParse({ ...concurrent, support: ["n99"] }).success,
  ).toBe(false);
});

test("strict verification and literature dispatches remain serial with overlap enabled", () => {
  expect(call(true, "always").schema.safeParse(serial).success).toBe(true);
  expect(call(true, "always").schema.safeParse(concurrent).success).toBe(false);
  const literature = {
    filings: [],
    verify: [],
    action: { role: "literature", request: "Find background for P." },
  };
  expect(call(true).schema.safeParse(literature).success).toBe(true);
  expect(
    call(true).schema.safeParse({
      ...literature,
      explorerGuidance: concurrent.explorerGuidance,
      support: [],
    }).success,
  ).toBe(false);
});

test("overlap prompts describe optional concurrent work without pending verdicts", () => {
  const enabled = call(true);
  expect(enabled.prompt).toContain('"overlap": true');
  expect(enabled.system).toContain("supply both explorerGuidance and support");
  expect(enabled.system).toContain("Omit both for serial verification");
  expect(enabled.system).toContain(
    "Explorer does not receive verdicts that are still pending",
  );
  expect(enabled.system).toContain(
    "Choose useful work that does not need those pending results",
  );
  expect(enabled.system).not.toContain("before another explorer turn");
  for (const request of [call(false), call(true, "always")]) {
    expect(request.system).toContain(
      "When action is verifier or literature, omit explorerGuidance and support",
    );
    expect(request.system).not.toContain("run Explorer concurrently");
  }
});
