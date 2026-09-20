import { afterEach, expect, test } from "bun:test";

import { coordinatorCall, createPiRoles } from "../pi-roles";
import { inspectCampaign } from "../role-cli";
import {
  deriveWorkflow,
  runWorkflow,
  workflowConfiguration,
} from "../workflow";
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
        request: "Find prior work on P.",
        findings: [],
        synthesis: "No directly relevant result was found.",
        limitations: "The search was deliberately small.",
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
  ).toMatchObject({ synthesis: "No directly relevant result was found." });
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
  } finally {
    campaign.close();
  }
});

test("replay rejects a literature packet bound to a different request", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
    maxCoordinatorSteps: 3,
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
    {
      codex: {
        request: "Search B.",
        findings: [],
        synthesis: "B packet must not be reused.",
        limitations: "Wrong request.",
      },
    },
  ]);
  try {
    await expect(
      runWorkflow(campaign, createPiRoles(campaign, workflow.settings, first)),
    ).rejects.toThrow("literature returned no valid discovery packet");
    const pending = await deriveWorkflow(campaign.records());
    expect(pending.phase.kind).toBe("literature");
    const second = dependencies([
      {
        codex: {
          request: "Search A.",
          findings: [],
          synthesis: "A packet.",
          limitations: "Small search.",
        },
      },
      { submission: coordination({ role: "explorer" }) },
      { submission: { solution: false, notes: [] } },
      { submission: coordination({ role: "explorer" }) },
    ]);
    const resumed = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, second),
    );
    expect(resumed.kind).toBe("turn-limit");
    expect(
      second.allCalls.find(({ label }) => label === "xean-solve/coordinator")
        ?.prompt,
    ).toContain("A packet.");
    expect(
      second.allCalls.find(({ label }) => label === "xean-solve/coordinator")
        ?.prompt,
    ).not.toContain("B packet must not be reused.");
  } finally {
    campaign.close();
  }
});
