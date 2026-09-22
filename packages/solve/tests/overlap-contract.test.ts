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
  action: {
    role: "verifier",
    verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
  },
};
const concurrent = {
  ...serial,
  action: {
    ...serial.action,
    explorerGuidance: "Explore an independent route toward P.",
    support: [],
  },
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
  for (const verification of ["decide", "always"] as const) {
    for (const request of [
      call(undefined, verification),
      call(false, verification),
    ]) {
      expect(request.schema.safeParse(serial).success).toBe(true);
      expect(request.schema.safeParse(concurrent).success).toBe(false);
    }
  }
  expect(call().system).toBe(call(false).system);
  expect(call().prompt).toBe(call(false).prompt);
});

test.each(["decide", "always"] as const)(
  "enabled overlap requires paired Explorer fields under %s verification",
  (verification) => {
    const request = call(true, verification);
    expect(request.schema.parse(concurrent)).toEqual(concurrent);
    expect(request.schema.safeParse(serial).success).toBe(false);
    for (const incomplete of [
      {
        ...serial,
        action: {
          ...serial.action,
          explorerGuidance: concurrent.action.explorerGuidance,
        },
      },
      { ...serial, action: { ...serial.action, support: [] } },
    ]) {
      expect(coordinatorResult.safeParse(incomplete).success).toBe(false);
      expect(request.schema.safeParse(incomplete).success).toBe(false);
    }
    expect(
      request.schema.safeParse({
        ...concurrent,
        action: { ...concurrent.action, support: ["n99"] },
      }).success,
    ).toBe(false);
  },
);

test("literature stays serial and can run before mandatory overlap", () => {
  const literature = {
    filings: [],
    action: { role: "literature", request: "Find background for P." },
  };
  expect(call(true).schema.safeParse(literature).success).toBe(true);
  expect(
    call(true).schema.safeParse({
      ...literature,
      action: {
        ...literature.action,
        explorerGuidance: concurrent.action.explorerGuidance,
        support: [],
      },
    }).success,
  ).toBe(false);
  const forced = coordinatorCall({
    task,
    notes: [note],
    coordinatorBehavior: {
      literature: "required-if-not-started",
      verification: "always",
      overlap: true,
    },
  });
  expect(forced.schema.safeParse(literature).success).toBe(true);
  expect(forced.schema.safeParse(concurrent).success).toBe(false);
});
