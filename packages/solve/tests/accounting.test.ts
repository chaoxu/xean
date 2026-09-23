import { afterEach, expect, test } from "bun:test";
import { createCampaign, type Campaign, type EntryId } from "xean";
import { derivePiSpend, storePiResult, type PiRunOptions } from "xean/pi";

import { campaignAccounting } from "../accounting";
import { inspectCampaign, inspectCampaignSnapshot } from "../role-cli";
import { storeCodexResult } from "../source";
import { fakePiRequest, fakePiRequestCheckpoint } from "./fake-pi";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);

const models = dependencies([]).models;
const profile = roleSettings().explorer;
const options: PiRunOptions = {
  models,
  model: models.getModel(profile.provider, profile.model)!,
  label: "xean-solve/model/explorer",
  prompt: "Test accounting",
};

const body = { state: "succeeded", text: "", transcript: [] } as const;

async function measuredCall(
  campaign: Campaign,
  measured: boolean,
  parent?: EntryId,
) {
  return campaign.call(
    {
      label: options.label,
      request: fakePiRequest(options),
      tools: [],
      ...(parent === undefined ? {} : { parent }),
    },
    async ({ call }) => {
      await fakePiRequestCheckpoint(
        campaign,
        call,
        options,
        "succeeded",
        measured
          ? {
              input: 10,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 12,
              estimatedCostUsd: 0,
            }
          : null,
      );
      return storePiResult(campaign, { call, ...body });
    },
  );
}

async function records(measured: boolean) {
  const campaign = createCampaign(campaignPath(), "xean-solve", {
    kind: "calls",
    schemaVersion: 1,
  });
  try {
    await measuredCall(campaign, measured);
    return campaign.records();
  } finally {
    campaign.close();
  }
}

test("known zero-priced usage is complete but absent usage is unknown", async () => {
  expect(campaignAccounting(await records(true))).toEqual({
    complete: true,
    measuredCostUsd: 0,
    unmeasuredRequests: 0,
    unaccountedCalls: [],
    potentialRequests: [],
    unpricedCalls: [],
  });
  expect(campaignAccounting(await records(false))).toMatchObject({
    complete: false,
    measuredCostUsd: null,
    unmeasuredRequests: 1,
  });
});

test("logical role accounting combines model children once and preserves unpriced work", async () => {
  const campaign = createCampaign(campaignPath(), "xean-solve", {
    kind: "calls",
    schemaVersion: 1,
  });
  const value = { solution: false, notes: [] };
  let active: any;
  try {
    await campaign.call(
      {
        label: "xean-solve/explorer",
        role: "explorer",
        request: { protocol: "xean-solve/role/v1", input: {} },
        tools: [],
      },
      async ({ call }) => {
        await measuredCall(campaign, true, call);
        await measuredCall(campaign, false, call);
        await campaign.call(
          {
            label: "xean-solve/model/explorer",
            parent: call,
            request: {
              protocol: "xean/codex-exec/v1",
              model: "test",
              reasoning: "low",
              search: true,
              developerInstructions: "Test",
              prompt: "Test",
              outputSchema: {},
            },
            tools: [],
          },
          async () =>
            storeCodexResult(campaign, {
              state: "succeeded",
              codexVersion: "fixture",
              stderr: "",
              stdout: [
                { type: "thread.started" },
                { type: "turn.started" },
                { type: "item.completed", item: { type: "web_search" } },
                {
                  type: "item.completed",
                  item: { type: "agent_message", text: "{}" },
                },
                {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 10,
                    cached_input_tokens: 2,
                    cache_write_input_tokens: 0,
                    output_tokens: 5,
                    reasoning_output_tokens: 3,
                  },
                },
              ]
                .map((event) => JSON.stringify(event))
                .join("\n"),
            }),
        );
        active = inspectCampaignSnapshot(campaign.records()).inspection;
        return { state: "succeeded", value };
      },
    );
    const snapshot: any = inspectCampaignSnapshot(campaign.records(), {
      includeRequests: true,
    }).inspection;
    expect(snapshot.calls).toHaveLength(1);
    const role = snapshot.calls[0];
    expect(role.modelCalls).toHaveLength(3);
    expect(role.submission).toEqual(value);
    expect(role.outcome).toBe("succeeded");
    expect(role.accounting).toMatchObject({
      complete: false,
      measuredCostUsd: 0,
      unmeasuredRequests: 1,
      unpricedCalls: [role.modelCalls[2]],
      codex: [
        {
          call: role.modelCalls[2],
          searches: 1,
          usage: { input: 10, cacheRead: 2, output: 5 },
        },
      ],
      spend: {
        logicalProviderRequests: 2,
        requests: {
          first: { logicalProviderRequests: 2 },
          continuation: { logicalProviderRequests: 0 },
        },
      },
    });
    expect(role.accounting.spend.logicalProviderRequests).toBe(
      snapshot.spend.logicalProviderRequests,
    );
    expect(role.modelRequests.map((entry: any) => entry.call)).toEqual(
      role.modelCalls,
    );
    expect(active.calls[0]).not.toHaveProperty("modelRequests");
    expect(active.calls[0].accounting.complete).toBe(false);
    expect(active.calls[0].outcome).toBeUndefined();
  } finally {
    campaign.close();
  }
});

test("an unsettled call prevents complete accounting even before a usage result", async () => {
  expect(campaignAccounting((await records(true)).slice(0, 2))).toMatchObject({
    complete: false,
    measuredCostUsd: null,
    unmeasuredRequests: 0,
    unaccountedCalls: [2],
  });
});

test("inspection exposes completeness without modifying the journal", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "xean-solve", {
    kind: "calls",
    schemaVersion: 1,
  });
  await measuredCall(campaign, false);
  const captured = campaign.records();
  const spend = derivePiSpend(captured).summary;
  const snapshot = inspectCampaignSnapshot(captured);
  expect(snapshot.coreCalls).toHaveLength(1);
  expect(snapshot.coreCalls[0]?.pi?.accounting).toMatchObject({
    state: "available",
    spend,
  });
  expect(snapshot.coreCalls[0]?.pi).not.toHaveProperty("responseText");
  expect(snapshot).not.toHaveProperty("solution");
  campaign.close();
  const before = await Bun.file(path).arrayBuffer();
  const inspection = await inspectCampaign(path);
  expect(snapshot.inspection).toEqual(inspection);
  expect(inspection).toMatchObject({
    spend,
    accounting: {
      complete: false,
      measuredCostUsd: null,
      unmeasuredRequests: 1,
    },
  });
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
});
