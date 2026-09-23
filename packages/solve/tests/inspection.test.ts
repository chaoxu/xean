import { afterEach, expect, test } from "bun:test";
import { createCampaign, defineTool, openReader } from "xean";

import { createRoleHost, modelCallLabel } from "../role-host";
import { codexOutcome } from "../source";
import { inspectCampaign, inspectCampaignSnapshot } from "../role-cli";
import { applicationId, roleTools, verifierLabels, verdicts } from "../roles";
import { run } from "../runner";
import { runWorkflow, workflowConfiguration } from "../workflow";
import {
  createWorkflowCampaign,
  campaignPath,
  cleanupCampaigns,
  dependencies,
  dispatchExplorer,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);

test.each([
  { kind: "workflow", schemaVersion: 0 },
  { kind: "calls" },
  { kind: "calls", schemaVersion: 0 },
  { kind: "calls", unknown: true },
  { kind: "unknown" },
])(
  "inspection rejects unsupported declarations without changing the journal: %j",
  async (config) => {
    const path = campaignPath();
    createCampaign(path, applicationId, config).close();
    const before = await Bun.file(path).arrayBuffer();
    await expect(inspectCampaign(path)).rejects.toThrow();
    expect(await Bun.file(path).arrayBuffer()).toEqual(before);
  },
);

test("inspection does not interpret a Pi submission as source verification", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, applicationId, {
    kind: "calls",
    schemaVersion: 1,
  });
  const drive = dependencies([
    {
      submission: {
        verdicts: [
          {
            note: "n1",
            verdict: "PASS",
            report: "Unsupported source submission.",
          },
        ],
      },
    },
  ]);
  const profile = roleSettings().correctness;
  const model = drive.models.getModel(profile.provider, profile.model);
  if (model === undefined) throw new Error("missing fixture model");
  try {
    await drive.run(campaign, {
      models: drive.models,
      model,
      label: modelCallLabel(verifierLabels.source),
      prompt: "Unsupported Pi source request.",
      transport: "sse",
      tools: [
        defineTool({
          name: roleTools.verifier,
          description: "Submit a verifier result",
          input: verdicts,
          async run() {
            return null;
          },
        }),
      ],
    });
    const report: any = await inspectCampaign(path);
    expect(report.calls).toEqual([]);
    expect(report.spend.logicalProviderRequests).toBe(1);
  } finally {
    campaign.close();
  }
});

test("inspection derives every field from one captured journal prefix", async () => {
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
    settings: roleSettings(),
  });
  const path = campaignPath();
  const fixture = await createWorkflowCampaign(path, config, 4);
  try {
    const drive = dependencies([
      dispatchExplorer(),
      {
        submission: {
          solution: false,
          notes: [{ text: "A partial result.", support: [] }],
        },
      },
    ]);
    await runWorkflow(
      fixture,
      createRoleHost(fixture, config.settings, drive),
      {
        pauseRequested: () => drive.calls.length === 2,
      },
    );
  } finally {
    fixture.close();
  }
  const reader = openReader(path);
  const prototype = Object.getPrototypeOf(reader) as typeof reader;
  reader.close();
  const original = prototype.records;
  let reads = 0;
  // Return the prefix captured before Explorer completed. A second read would
  // observe the later entries already in the database and mix the two views.
  prototype.records = function () {
    const records = original.call(this);
    return ++reads === 1 ? records.filter(({ seq }) => seq <= 3) : records;
  };
  let report;
  try {
    report = await inspectCampaign(path, { includeGuidance: true });
  } finally {
    prototype.records = original;
  }
  expect(reads).toBe(1);
  expect(report).toMatchObject({
    phase: "coordinator",
    notes: [],
    calls: [],
    guidance: [],
    spend: { logicalProviderRequests: 0 },
    accounting: { complete: true, measuredCostUsd: 0 },
  });
  expect(report).not.toHaveProperty("result");
  expect(await inspectCampaign(path)).toMatchObject({
    phase: "coordinator",
    notes: [{ id: "n1" }],
    calls: [{ role: "coordinator" }, { role: "explorer" }],
    spend: { logicalProviderRequests: 2 },
  });
});

test("inspection distinguishes logical role failure from model settlement and leaves retries unresolved", async () => {
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
    settings: roleSettings(),
  });
  const path = campaignPath(),
    campaign = await createWorkflowCampaign(path, config, 4);
  const input = { task: config.task, notes: [] };
  try {
    await expect(
      createRoleHost(
        campaign,
        config.settings,
        dependencies([{ state: "failed", error: "incomplete.max_messages" }]),
      ).coordinator(
        input,
        campaign
          .records()
          .find(
            (entry) =>
              entry.kind === "call" && entry.label === "xean-solve/allowance",
          )!.seq,
      ),
    ).rejects.toThrow("incomplete.max_messages");
    const before = campaign.records();
    const failed = await inspectCampaign(path);
    expect(failed).toMatchObject({
      phase: "coordinator",
      calls: [
        {
          role: "coordinator",
          state: "threw",
          outcome: "failed",
          error: "coordinator failed: incomplete.max_messages",
        },
      ],
    });
    expect(failed).not.toHaveProperty("result");
    expect(
      inspectCampaignSnapshot(before).coreCalls.find((call) => call.pi)?.pi,
    ).toMatchObject({
      outcome: "failed",
      error: "incomplete.max_messages",
    });
    expect(campaign.records()).toEqual(before);
    await createRoleHost(
      campaign,
      config.settings,
      dependencies([
        {
          ...dispatchExplorer(),
          onStarted: async () => {
            const retry: any = await inspectCampaign(path);
            expect(retry.phase).toBe("coordinator");
            expect(retry).not.toHaveProperty("result");
            expect(retry.calls[0].outcome).toBe("failed");
            expect(retry.calls[1]).not.toHaveProperty("outcome");
            expect(retry.calls[1]).not.toHaveProperty("error");
          },
        },
      ]),
    ).coordinator(
      input,
      campaign
        .records()
        .find(
          (entry) =>
            entry.kind === "call" && entry.label === "xean-solve/allowance",
        )!.seq,
    );
    const succeeded: any = await inspectCampaign(path);
    expect(succeeded.phase).toBe("explorer");
    expect(succeeded.calls[1]).toMatchObject({
      state: "returned",
      outcome: "succeeded",
    });
    expect(succeeded.calls[1]).not.toHaveProperty("error");
    expect(succeeded).not.toHaveProperty("result");
  } finally {
    campaign.close();
  }
});

test.each(["failed", "cancelled"] as const)(
  "inspection preserves a Codex %s child under its failed source role without raw output",
  async (state) => {
    const path = campaignPath(),
      campaign = createCampaign(path, applicationId, {
        kind: "calls",
        schemaVersion: 1,
      });
    const error = `Codex ${state}`;
    try {
      const host = createRoleHost(campaign, roleSettings(), {
        ...dependencies([
          {
            submission: {
              verdicts: [
                {
                  note: "n1",
                  verdict: "PASS",
                  report: "Valid conditional on the source.",
                  externalResults: ["The cited theorem establishes P."],
                },
              ],
            },
          },
        ]),
        codex: async () => ({
          state,
          error,
          stdout: "PRIVATE_CODEX_STDOUT",
          stderr: "PRIVATE_CODEX_STDERR",
        }),
      });
      await expect(
        host.verifier({
          task: { problem: "P", completionCriteria: "Prove P" },
          notes: [
            {
              id: "n1",
              text: "P follows from the cited theorem.",
              support: [],
              verdicts: [],
              verified: false,
              dead: false,
            },
          ],
          support: [],
          verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
        }),
      ).rejects.toThrow(error);
      const inspection: any = await inspectCampaign(path);
      const source = inspection.calls.find(
        (call: any) => call.verifier === "source",
      );
      expect(source).toMatchObject({
        role: "verifier",
        verifier: "source",
        state: "threw",
        outcome: "failed",
        error: `verifier failed: ${error}`,
      });
      expect(source.modelCalls).toHaveLength(1);
      expect(
        codexOutcome(campaign.records(), source.modelCalls[0]),
      ).toMatchObject({ state, error });
      expect(
        inspectCampaignSnapshot(campaign.records()).coreCalls.find(
          (call) => call.call === source.modelCalls[0],
        ),
      ).toMatchObject({
        state: "returned",
        parent: source.call,
      });
      expect(JSON.stringify(inspection)).not.toContain("PRIVATE_CODEX_");
      expect(inspection).not.toHaveProperty("result");
    } finally {
      campaign.close();
    }
  },
);

test("inspection retains cancelled Pi children and separates local failures with no model call", async () => {
  const path = campaignPath(),
    campaign = createCampaign(path, applicationId, {
      kind: "calls",
      schemaVersion: 1,
    });
  try {
    await expect(
      createRoleHost(
        campaign,
        roleSettings(),
        dependencies([{ state: "cancelled", error: "Operator interruption" }]),
      ).explorer({
        task: { problem: "P", completionCriteria: "Prove P" },
        explorerGuidance: "",
        notes: [],
        support: [],
      }),
    ).rejects.toThrow("Operator interruption");
    await expect(
      createRoleHost(campaign, roleSettings(), dependencies([]), {
        coordinator: async () => {
          throw new Error("Local setup failed");
        },
      }).coordinator({
        task: { problem: "P", completionCriteria: "Prove P" },
        notes: [],
      }),
    ).rejects.toThrow("Local setup failed");
    const report: any = await inspectCampaign(path);
    expect(report.calls[0]).toMatchObject({
      state: "threw",
      outcome: "failed",
      error: "explorer failed: Operator interruption",
    });
    expect(report.calls[1]).toMatchObject({
      state: "threw",
      outcome: "failed",
      error: "Local setup failed",
      modelCalls: [],
    });
    expect(
      inspectCampaignSnapshot(campaign.records()).coreCalls.find(
        (call) => call.pi,
      )?.pi,
    ).toMatchObject({
      outcome: "cancelled",
      error: "Operator interruption",
    });
  } finally {
    campaign.close();
  }
});

test("operator cancellation reaches model execution and reports an interrupted resumable run", async () => {
  const path = campaignPath();
  const controller = new AbortController();
  const drive = dependencies([
    {
      state: "cancelled",
      error: "Operator interruption",
      onStarted: async () => {
        controller.abort();
      },
    },
  ]);
  expect(
    await run(
      {
        task: { problem: "P", completionCriteria: "Prove P" },
        campaignPath: path,
        settings: roleSettings(),
      },
      { ...drive, signal: controller.signal },
    ),
  ).toMatchObject({
    outcome: "interrupted",
    at: "coordinator",
    reason: "operator interruption",
  });
  expect(drive.calls[0]?.signal?.aborted).toBe(true);
  const reader = openReader(path);
  try {
    const snapshot = inspectCampaignSnapshot(reader.records());
    expect(snapshot.inspection).toMatchObject({
      phase: "coordinator",
      calls: [{ state: "threw", outcome: "failed" }],
    });
    expect(snapshot.coreCalls.find((call) => call.pi)?.pi?.outcome).toBe(
      "cancelled",
    );
    expect(snapshot.inspection).not.toHaveProperty("result");
  } finally {
    reader.close();
  }
});
