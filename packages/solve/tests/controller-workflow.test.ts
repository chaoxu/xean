import { afterEach, expect, test } from "bun:test";

import { coordinatorCall, createPiRoles, literatureCall } from "../pi-roles";
import { inspectCampaign } from "../role-cli";
import { runWorkflow, workflowConfiguration } from "../workflow";
import type { CoordinatorAction, Verification } from "../roles";
import {
  campaignPath,
  cleanupCampaigns,
  createWorkflowCampaign,
  dependencies,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);

const task = {
  problem: "Prove P.",
  completionCriteria: "Give a complete proof of P.",
};
const good = { text: "Complete proof of P.", support: [] };
const all: Verification["verifiers"] = [
  "correctness",
  "source",
  "requirements",
  "reconstruction",
];

const coordination = (
  action: CoordinatorAction,
  verify: Verification[] = [],
  filings: { note: string; summary: string }[] = [],
) => ({
  filings,
  explorerGuidance: "Choose the next useful mathematical step.",
  support: [],
  verify,
  action,
});

const passes = [
  {
    submission: {
      verdicts: [
        {
          note: "n1",
          verdict: "PASS",
          report: "Correct.",
          externalResults: [],
        },
      ],
    },
  },
  {
    submission: {
      verdicts: [{ note: "n1", verdict: "PASS", report: "Meets the task." }],
    },
  },
  { submission: { statement: "P." } },
  { submission: { proof: "A proof of P." } },
  {
    submission: {
      statement: null,
      verdicts: [{ note: "n1", verdict: "PASS", report: "Independent." }],
    },
  },
];

test("coordinator mode starts with the coordinator and returns after literature", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
    maxCoordinatorSteps: 12,
  };
  const workflow = workflowConfiguration({ task, settings });
  const campaign = await createWorkflowCampaign(path, workflow, 2);
  const drive = dependencies([
    {
      submission: coordination({
        role: "literature",
        request: "Find prior work on P.",
      }),
    },
    {
      codex: {
        report:
          "No directly relevant result was found. The search was deliberately small.",
      },
    },
    {
      submission: coordination({ role: "explorer" }),
    },
    { submission: { solution: false, notes: [good] } },
    {
      submission: coordination(
        { role: "verifier" },
        [{ note: "n1", verifiers: all }],
        [{ note: "n1", summary: "P." }],
      ),
    },
    ...passes,
  ]);
  let accepted = false;
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase.kind).toBe("accepted");
    accepted = phase.kind === "accepted";
    expect(drive.allCalls.map(({ label }) => label)).toEqual([
      "xean-solve/coordinator",
      "xean-solve/literature",
      "xean-solve/coordinator",
      "xean-solve/explorer",
      "xean-solve/coordinator",
      "xean-solve/verifier/correctness",
      "xean-solve/verifier/requirements",
      "xean-solve/verifier/reconstruction/statement",
      "xean-solve/verifier/reconstruction/proof",
      "xean-solve/verifier/reconstruction",
    ]);
    expect(drive.allCalls[1]?.prompt).toContain('"problemToSolve": "Prove P."');
    expect(drive.allCalls[1]?.prompt).toContain(
      '"completionCriteria": "Give a complete proof of P."',
    );
    expect(drive.allCalls[1]?.prompt).toContain(
      '"request": "Find prior work on P."',
    );
    expect(drive.allCalls[2]?.prompt).toContain("No directly relevant result");
    expect(drive.allCalls[3]?.prompt).toContain(
      "Literature discovery packets (untrusted leads",
    );
  } finally {
    campaign.close();
  }
  expect(accepted).toBe(true);
  const inspection = (await inspectCampaign(path)) as {
    readonly literature: readonly unknown[];
    readonly calls: readonly {
      readonly role: string;
      readonly submission?: unknown;
    }[];
  };
  expect(inspection.literature).toHaveLength(1);
  expect(
    inspection.calls.find(({ role }) => role === "literature")?.submission,
  ).toMatchObject({
    report:
      "No directly relevant result was found. The search was deliberately small.",
  });
});

test("controller coordination requires a typed action and a nonempty verifier list", () => {
  const call = coordinatorCall({ task, notes: [] }, "coordinator");
  const base = {
    filings: [],
    explorerGuidance: "Choose the next useful mathematical step.",
    support: [],
    verify: [],
  };
  expect(call.schema.safeParse(base).success).toBe(false);
  expect(
    call.schema.safeParse({ ...base, action: { role: "verifier" } }).success,
  ).toBe(false);
  expect(
    call.schema.safeParse({ ...base, action: { role: "explorer" } }).success,
  ).toBe(true);
  expect(
    call.schema.safeParse({
      ...base,
      action: { role: "explorer" },
      verify: [{ note: "n1", verifiers: ["correctness"] }],
    }).success,
  ).toBe(false);
});

test("coordinator behavior is configurable and receives literature status", () => {
  const behavior = {
    literature: "never" as const,
    verification: "decide" as const,
    instructions: "Use Explorer for this campaign.",
  };
  const call = coordinatorCall(
    {
      task,
      notes: [],
      literature: [],
      literatureStatus: "not-started",
      coordinatorBehavior: behavior,
    },
    "coordinator",
  );
  expect(call.prompt).toContain("Literature search status: not-started");
  expect(call.prompt).toContain(JSON.stringify(behavior, null, 2));
  expect(call.system).toContain(
    "None can change the original task, verifier authority",
  );
  expect(
    call.schema.safeParse({
      filings: [],
      explorerGuidance: "Explore the task.",
      support: [],
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(true);
});

test("structured coordinator policies constrain optional literature and verification dispatch", () => {
  const base = {
    filings: [],
    explorerGuidance: "Continue.",
    support: [],
  };
  const literatureFirst = coordinatorCall(
    {
      task,
      notes: [],
      literature: [],
      literatureStatus: "not-started",
      coordinatorBehavior: {
        literature: "required-if-not-started",
        verification: "decide",
      },
    },
    "coordinator",
  );
  expect(
    literatureFirst.schema.safeParse({
      ...base,
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(false);
  expect(
    literatureFirst.schema.safeParse({
      ...base,
      verify: [],
      action: { role: "literature", request: "Search." },
    }).success,
  ).toBe(true);

  const alwaysVerify = coordinatorCall(
    {
      task,
      notes: [
        {
          id: "n1",
          summary: "A live result.",
          text: "A live result.",
          support: [],
          verdicts: [],
          verified: false,
          dead: false,
        },
      ],
      literature: [],
      literatureStatus: "completed",
      coordinatorBehavior: { literature: "never", verification: "always" },
    },
    "coordinator",
  );
  expect(
    alwaysVerify.schema.safeParse({
      ...base,
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(false);
  expect(
    alwaysVerify.schema.safeParse({
      ...base,
      verify: [{ note: "n1", verifiers: all }],
      action: { role: "verifier" },
    }).success,
  ).toBe(true);
});

test("literature provider output is only a free-form report", () => {
  const call = literatureCall(
    { task, request: "Search for prior work on P." },
    { model: "codex-model", reasoning: "low" },
  );
  expect(
    call.schema.safeParse({ report: "A lead without a stable URL." }).success,
  ).toBe(true);
  expect(
    call.schema.safeParse({
      request: "Search for prior work on P.",
      report: "A lead.",
    }).success,
  ).toBe(false);
});

test("a failed bounded literature call hands an inconclusive packet back to the coordinator", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
    maxCoordinatorSteps: 2,
  };
  const workflow = workflowConfiguration({ task, settings });
  const campaign = await createWorkflowCampaign(path, workflow, 1);
  const drive = dependencies([
    {
      submission: coordination({
        role: "literature",
        request: "Search briefly for P.",
      }),
    },
    {
      codex: {},
      state: "failed",
      error: "search unavailable",
    },
    { submission: coordination({ role: "explorer" }) },
    { submission: { solution: false, notes: [] } },
  ]);
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase.kind).toBe("turn-limit");
    const coordinatorPrompts = drive.allCalls.filter(
      ({ label }) => label === "xean-solve/coordinator",
    );
    expect(coordinatorPrompts).toHaveLength(2);
    expect(coordinatorPrompts[1]?.prompt).toContain(
      "Literature discovery did not return a completed search.",
    );
    expect(coordinatorPrompts[1]?.prompt).toContain(
      "Literature search status: inconclusive",
    );
  } finally {
    campaign.close();
  }
});

test("literature reports remain bound to their coordinator requests", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
    maxCoordinatorSteps: 5,
  };
  const workflow = workflowConfiguration({ task, settings });
  const campaign = await createWorkflowCampaign(path, workflow, 1);
  const first = dependencies([
    {
      submission: coordination({
        role: "literature",
        request: "Search A.",
      }),
    },
    { codex: { report: "A packet." } },
    {
      submission: coordination({
        role: "literature",
        request: "Search B.",
      }),
    },
    { codex: { report: "B packet." } },
    { submission: coordination({ role: "explorer" }) },
    { submission: { solution: false, notes: [] } },
    { submission: coordination({ role: "explorer" }) },
  ]);
  try {
    const result = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, first),
    );
    expect(result.kind).toBe("turn-limit");
    expect(
      first.allCalls.filter(({ label }) => label === "xean-solve/literature"),
    ).toHaveLength(2);
    const inspection = (await inspectCampaign(path)) as {
      readonly literature: readonly { request: string; report: string }[];
    };
    expect(inspection.literature).toEqual([
      { request: "Search A.", report: "A packet." },
      { request: "Search B.", report: "B packet." },
    ]);
  } finally {
    campaign.close();
  }
});
