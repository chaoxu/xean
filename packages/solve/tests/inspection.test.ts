import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createCampaign, defineTool, openReader } from "xean";

import { createPiRoles } from "../pi-roles";
import { inspectCampaign } from "../role-cli";
import { applicationId, roleTools, verifierLabels, verdicts } from "../roles";
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
  const campaign = createCampaign(path, applicationId, { kind: "calls" });
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
      label: verifierLabels.source,
      role: "verifier",
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
    expect(report.calls[0]).toMatchObject({
      verifier: "source",
      state: "returned",
    });
    expect(report.calls[0]).not.toHaveProperty("submission");
  } finally {
    campaign.close();
  }
});

test("inspection uses one journal prefix when Explorer finishes during the read", async () => {
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
    settings: roleSettings(),
  });
  const fixturePath = campaignPath();
  const fixture = await createWorkflowCampaign(fixturePath, config, 4);
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
    await runWorkflow(fixture, createPiRoles(fixture, config.settings, drive), {
      pauseRequested: () => drive.calls.length === 2,
    });
  } finally {
    fixture.close();
  }
  using source = new Database(fixturePath, { readonly: true });
  const appended = source
    .query<{ seq: number; at_ms: number; kind: string; body: string }, []>(
      "SELECT seq, at_ms, kind, body FROM entries WHERE seq > 3 ORDER BY seq",
    )
    .all();
  const path = campaignPath();
  (await createWorkflowCampaign(path, config, 4)).close();
  using writer = new Database(path);
  const reader = openReader(path);
  const prototype = Object.getPrototypeOf(reader) as typeof reader;
  reader.close();
  const original = prototype.records;
  let reads = 0;
  // A writer may append immediately after the reader's SELECT returns.
  // Copy a valid completed call to make that interleaving deterministic.
  prototype.records = function () {
    const records = original.call(this);
    reads += 1;
    if (reads === 1) {
      for (const row of appended) {
        writer.run(
          "INSERT INTO entries(seq, at_ms, kind, body) VALUES (?, ?, ?, ?)",
          [row.seq, row.at_ms, row.kind, row.body],
        );
      }
    }
    return records;
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

test("inspection distinguishes a returned Pi failure from success and leaves retries unresolved", async () => {
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
    settings: roleSettings(),
  });
  const path = campaignPath(),
    campaign = await createWorkflowCampaign(path, config, 4);
  const input = { task: config.task, notes: [] };
  try {
    await expect(
      createPiRoles(
        campaign,
        config.settings,
        dependencies([{ state: "failed", error: "incomplete.max_messages" }]),
      ).coordinator(input),
    ).rejects.toThrow("incomplete.max_messages");
    const before = campaign.records();
    const failed = await inspectCampaign(path);
    expect(failed).toMatchObject({
      phase: "coordinator",
      calls: [
        {
          role: "coordinator",
          state: "returned",
          outcome: "failed",
          error: "incomplete.max_messages",
        },
      ],
    });
    expect(failed).not.toHaveProperty("result");
    expect(campaign.records()).toEqual(before);
    await createPiRoles(
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
    ).coordinator(input);
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
  "inspection exposes a returned Codex %s outcome without its raw output",
  async (state) => {
    const path = campaignPath(),
      campaign = createCampaign(path, applicationId, { kind: "calls" });
    const error = `Codex ${state}`;
    try {
      const roles = createPiRoles(campaign, roleSettings(), {
        ...dependencies([
          {
            submission: {
              verdicts: [
                {
                  note: "n1",
                  verdict: "PASS",
                  report: "Conditional on the external theorem.",
                  externalResults: ["The external theorem asserts P."],
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
        roles.verifier({
          task: { problem: "Prove P.", completionCriteria: "A proof." },
          notes: [
            {
              id: "n1",
              text: "A claim.",
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
      const inspection = await inspectCampaign(path);
      expect(inspection).toMatchObject({
        calls: [
          { verifier: "correctness", state: "returned", outcome: "succeeded" },
          {
            role: "verifier",
            verifier: "source",
            state: "returned",
            outcome: state,
            error,
          },
        ],
      });
      expect(JSON.stringify(inspection)).not.toContain("PRIVATE_CODEX_");
      expect(inspection).not.toHaveProperty("result");
    } finally {
      campaign.close();
    }
  },
);

test("inspection exposes Pi cancellation and a thrown local call without inventing a provider outcome", async () => {
  const path = campaignPath(),
    campaign = createCampaign(path, applicationId, { kind: "calls" });
  try {
    await expect(
      createPiRoles(
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
      campaign.call(
        {
          label: "xean-solve/coordinator",
          role: "coordinator",
          request: null,
        },
        async () => {
          throw new Error("Local setup failed");
        },
      ),
    ).rejects.toThrow("Local setup failed");
    const report: any = await inspectCampaign(path);
    expect(report.calls[0]).toMatchObject({
      state: "returned",
      outcome: "cancelled",
      error: "Operator interruption",
    });
    expect(report.calls[1]).toMatchObject({
      state: "threw",
      error: "Local setup failed",
    });
    expect(report.calls[1]).not.toHaveProperty("outcome");
  } finally {
    campaign.close();
  }
});
