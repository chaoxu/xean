import { expect, test } from "bun:test";

import { executionContract, executionReport } from "../execution-contract";

const note = {
  id: "n1",
  summary: "proof",
  text: "Proof.",
  support: [],
  verdicts: [],
  verified: true,
  dead: false,
};

test("publishes one workflow execution contract", () => {
  expect(executionContract).toEqual({
    schemaVersion: 3,
    application: "xean-solve",
    protocol: "workflow",
    run: {
      command: "run",
      arguments: ["task", "campaign", "settings"],
      allowance: { turnsOption: "--turns", idOption: "--id", defaultTurns: 20 },
      report: {
        schemaVersion: 2,
        outcomes: [
          "accepted",
          "turn-limit",
          "paused",
          "call-failure",
          "interrupted",
        ],
        terminalOutcomes: ["accepted", "turn-limit"],
      },
    },
  });
  expect(
    executionReport({
      outcome: "accepted",
      turns: 1,
      note,
      notes: [note],
      verification: 7,
    }),
  ).toMatchObject({
    schemaVersion: 2,
    application: "xean-solve",
    protocol: "workflow",
    outcome: "accepted",
    verification: 7,
  });
});
