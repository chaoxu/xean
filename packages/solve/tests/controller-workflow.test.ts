import { afterEach, expect, test } from "bun:test";

import {
  coordinatorCall,
  createPiRoles,
  defaultCoordinatorBehavior,
  literatureCall,
} from "../pi-roles";
import { inspectCampaign } from "../role-cli";
import { runWorkflow, workflowConfiguration } from "../workflow";
import { codexRequest } from "../source";
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
          note: "n2",
          verdict: "PASS",
          report: "Correct.",
          externalResults: [],
        },
      ],
    },
  },
  {
    submission: {
      verdicts: [{ note: "n2", verdict: "PASS", report: "Meets the task." }],
    },
  },
  { submission: { statement: "P." } },
  { submission: { proof: "A proof of P." } },
  {
    submission: {
      statement: null,
      verdicts: [{ note: "n2", verdict: "PASS", report: "Independent." }],
    },
  },
];

test("coordinator mode starts with the coordinator and returns after literature", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
    maxCoordinatorSteps: 12,
    coordinatorBehavior: {
      literature: "required-if-not-started" as const,
      verification: "decide" as const,
    },
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
        notes: [
          {
            text: "A cited result relevant to P. Source: Example et al., Theorem 1.",
            support: [],
          },
        ],
      },
    },
    {
      submission: coordination(
        { role: "explorer" },
        [],
        [{ note: "n1", summary: "A cited result relevant to P." }],
      ),
    },
    { submission: { solution: false, notes: [good] } },
    {
      submission: coordination(
        { role: "verifier" },
        [{ note: "n2", verifiers: all }],
        [{ note: "n2", summary: "P." }],
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
    expect(drive.allCalls[2]?.prompt).toContain(
      "A cited result relevant to P.",
    );
  } finally {
    campaign.close();
  }
  expect(accepted).toBe(true);
  const inspection = (await inspectCampaign(path)) as {
    readonly notes: readonly unknown[];
    readonly calls: readonly {
      readonly role: string;
      readonly submission?: unknown;
    }[];
  };
  expect(inspection.notes).toContainEqual(
    expect.objectContaining({
      id: "n1",
      text: "A cited result relevant to P. Source: Example et al., Theorem 1.",
    }),
  );
  expect(
    inspection.calls.find(({ role }) => role === "literature")?.submission,
  ).toMatchObject({
    notes: [
      {
        text: "A cited result relevant to P. Source: Example et al., Theorem 1.",
        support: [],
      },
    ],
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

test("new campaigns disable literature unless their policy opts in", () => {
  expect(defaultCoordinatorBehavior.literature).toBe("never");
  const call = coordinatorCall({ task, notes: [] }, "coordinator");
  expect(call.prompt).toContain('"literature": "never"');
  expect(
    call.schema.safeParse({
      filings: [],
      explorerGuidance: "Explore the task.",
      support: [],
      verify: [],
      action: { role: "literature", request: "Search." },
    }).success,
  ).toBe(false);
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

test("literature output is only note candidates", () => {
  const call = literatureCall(
    { task, request: "Search for prior work on P." },
    { model: "codex-model", reasoning: "low" },
  );
  expect(
    call.schema.safeParse({
      notes: [{ text: "A cited theorem and its source.", support: [] }],
    }).success,
  ).toBe(true);
  expect(
    call.schema.safeParse({
      notes: [{ text: "A cited theorem and its source.", support: [] }],
      report: "extra fields are rejected",
    }).success,
  ).toBe(false);
  expect(
    call.schema.safeParse({
      notes: [{ text: "A self-dependent claim.", support: [1] }],
    }).success,
  ).toBe(false);
  expect(
    call.schema.safeParse({
      notes: [
        { text: "First claim.", support: [] },
        { text: "Duplicate dependency claim.", support: [1, 1] },
      ],
    }).success,
  ).toBe(false);
  const request = codexRequest.parse(call.request);
  expect(request.developerInstructions).toContain(
    "Your only deliverable is a JSON object with a notes array",
  );
  expect(request.developerInstructions).toContain(
    "source verifier will independently open and check",
  );
  expect(request.prompt).toContain('"problemToSolve": "Prove P."');
  expect(request.prompt).toContain('"request": "Search for prior work on P."');
});
