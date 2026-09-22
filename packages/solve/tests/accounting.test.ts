import { afterEach, expect, test } from "bun:test";
import { createCampaign, type Campaign } from "xean";
import { derivePiSpend, storePiResult, type PiRunOptions } from "xean/pi";

import { campaignAccounting } from "../accounting";
import { inspectCampaign } from "../role-cli";
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
  label: "xean-solve/explorer",
  prompt: "Test accounting",
};

const body = { state: "succeeded", text: "", transcript: [] } as const;

async function measuredCall(campaign: Campaign, measured: boolean) {
  return campaign.call(
    { label: options.label, request: fakePiRequest(options), tools: [] },
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
  const campaign = createCampaign(path, "xean-solve", { kind: "calls" });
  await measuredCall(campaign, false);
  const spend = derivePiSpend(campaign.records()).summary;
  campaign.close();
  const before = await Bun.file(path).arrayBuffer();
  expect(await inspectCampaign(path)).toMatchObject({
    spend,
    accounting: {
      complete: false,
      measuredCostUsd: null,
      unmeasuredRequests: 1,
    },
  });
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
});
