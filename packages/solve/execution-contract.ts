import type { RunResult } from "./runner";
import { applicationId, workflowProtocol } from "./roles";

export const workflowOutcomes = [
  "accepted",
  "turn-limit",
  "paused",
  "call-failure",
  "interrupted",
] as const;

export const executionContract = {
  schemaVersion: 2,
  application: applicationId,
  protocol: workflowProtocol,
  run: {
    command: "run",
    arguments: ["task", "campaign", "settings"],
    allowance: { turnsOption: "--turns", idOption: "--id", defaultTurns: 10 },
    report: {
      schemaVersion: 1,
      outcomes: workflowOutcomes,
      terminalOutcomes: ["accepted", "turn-limit"],
    },
  },
} as const;

export type ExecutionContract = typeof executionContract;
export type ExecutionReport = RunResult & {
  readonly schemaVersion: typeof executionContract.run.report.schemaVersion;
  readonly application: typeof applicationId;
  readonly protocol: typeof workflowProtocol;
};

export function executionReport(report: RunResult): ExecutionReport {
  return {
    schemaVersion: executionContract.run.report.schemaVersion,
    application: applicationId,
    protocol: workflowProtocol,
    ...report,
  };
}
