import { afterEach, expect, test } from "bun:test";
import { createCampaign } from "xean";
import { derivePiSpend, storePiResult, type PiRunOptions } from "xean/pi";

import { campaignAccounting } from "../accounting";
import { inspectCampaign } from "../role-cli";
import { fakePiRequest, fakePiTelemetry } from "./fake-pi";
import { campaignPath, cleanupCampaigns } from "./harness";

afterEach(cleanupCampaigns);

const options: PiRunOptions = {
  models: {
    streamSimple() {
      throw new Error("no model call");
    },
  },
  model: {
    id: "test",
    name: "Test",
    provider: "test",
    api: "openai-responses",
    baseUrl: "https://invalid.test/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 1000,
    maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  label: "xean-solve/explorer",
  prompt: "Test accounting",
};

function resultBody(measured: boolean) {
  const telemetry = structuredClone(fakePiTelemetry(options, "succeeded"));
  if (measured)
    Object.assign(telemetry.spans[1]!.attributes, {
      "pi.ai.usage.input_tokens": 10,
      "pi.ai.usage.output_tokens": 2,
      "pi.ai.usage.cache_read_tokens": 0,
      "pi.ai.usage.cache_write_tokens": 0,
      "pi.ai.usage.total_tokens": 12,
      "pi.ai.usage.cost": 0,
    });
  return { state: "succeeded", text: "", transcript: [], telemetry } as const;
}

async function records(measured: boolean) {
  const campaign = createCampaign(campaignPath(), "xean-solve", {
    kind: "calls",
  });
  try {
    await campaign.call(
      { label: options.label, request: fakePiRequest(options), tools: [] },
      async ({ call }) =>
        storePiResult(campaign, { call, ...resultBody(measured) }),
    );
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
  await campaign.call(
    { label: options.label, request: fakePiRequest(options), tools: [] },
    async ({ call }) => storePiResult(campaign, { call, ...resultBody(false) }),
  );
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
