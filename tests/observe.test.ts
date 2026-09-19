import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCampaign,
  type Campaign,
  type EntryId,
  type Reader,
} from "../src";
import {
  inspectCoreCampaign,
  inspectCoreCampaignRecords,
  inspectCoreCampaignSummary,
  inspectCoreCampaignSummaryRecords,
  inspectCoreCallSummaries,
} from "../src/observe";
import {
  PI_TELEMETRY_SCHEMA_VERSIONS,
  piStoredResult,
  storePiResult,
} from "../src/pi";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function campaignPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xean-observe-v1-"));
  directories.push(directory);
  return join(directory, "campaign.db");
}

function piRequest() {
  return {
    protocol: "xean/pi-run/v1" as const,
    model: { provider: "provider", id: "model", api: "responses" },
    modelProfile: null,
    prompt: "test",
  };
}

function piResult(
  campaign: Campaign,
  call: EntryId,
  attributes: Record<string, string | number | boolean>,
  transcript: readonly unknown[] = [],
  additionalOperations: readonly Record<
    string,
    string | number | boolean
  >[] = [],
  errors: readonly (string | undefined)[] = [],
) {
  return storePiResult(campaign, {
    call,
    ...piStoredResult.parse({
      state: "succeeded" as const,
      text: "done",
      transcript,
      telemetry: {
        schemaVersions: PI_TELEMETRY_SCHEMA_VERSIONS,
        spans: [
          {
            id: 1,
            parentId: null,
            name: "xean.pi.run",
            attributes: {},
            events: [],
            status: { status: "ok" as const },
            settled: true,
          },
          ...[attributes, ...additionalOperations].map((operation, at) => ({
            id: at + 2,
            parentId: 1,
            name: "pi.ai.request",
            attributes: operation,
            events: [],
            status:
              errors[at] === undefined
                ? { status: "ok" as const }
                : {
                    status: "error" as const,
                    error: { name: "ProviderError", message: errors[at] },
                  },
            settled: true,
          })),
        ],
      },
    }),
  });
}

const firstUsage = {
  input: 8,
  output: 5,
  cacheRead: 2,
  cacheWrite: 1,
  reasoning: 3,
  totalTokens: 16,
  cost: { input: 1, output: 8, cacheRead: 0.5, cacheWrite: 0.5, total: 10 },
};

test("call summaries preserve full metadata at the captured boundary", async () => {
  const campaign = createCampaign(campaignPath(), "call-summary", null);
  try {
    campaign.submitCandidate(new TextEncoder().encode("proof"), ["check"]);
    await campaign.call(
      { label: "measured", role: "explorer", request: piRequest() },
      async ({ call }) =>
        piResult(campaign, call, attributes(firstUsage), [message(firstUsage)]),
    );
    await expect(
      campaign.call({ label: "failed-local", request: null }, async () => {
        throw new Error("local failure");
      }),
    ).rejects.toThrow("local failure");
    const records = campaign.records();
    const full = inspectCoreCampaignRecords(campaign, records);
    const metadata = full.calls.map(({ pi, ...call }) => {
      if (pi === undefined) return call;
      const { responseText: _, ...summary } = pi;
      return { ...call, pi: summary };
    });
    expect(inspectCoreCallSummaries(records)).toEqual(metadata);
    expect(full.calls[0]?.pi?.responseText).toBe("done");
    await campaign.call({ label: "later", request: null }, async () => null);
    expect(inspectCoreCallSummaries(records)).toEqual(metadata);
    expect(inspectCoreCallSummaries(campaign.records())).toHaveLength(3);
  } finally {
    campaign.close();
  }
});
const secondUsage = {
  input: 0,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 5,
  cost: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, total: 10 },
};
const attributes = (usage: typeof firstUsage) => ({
  "pi.ai.provider": "provider",
  "pi.ai.model": "model",
  "pi.ai.api": "responses",
  "pi.ai.usage.input_tokens": usage.input,
  "pi.ai.usage.output_tokens": usage.output,
  "pi.ai.usage.cache_read_tokens": usage.cacheRead,
  "pi.ai.usage.cache_write_tokens": usage.cacheWrite,
  "pi.ai.usage.reasoning_tokens": usage.reasoning,
  "pi.ai.usage.total_tokens": usage.totalTokens,
  "pi.ai.usage.cost": usage.cost.total,
});
const message = (usage: typeof firstUsage) => ({ role: "assistant", usage });

test("derives token buckets and prices reasoning per response", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", null);
  try {
    await campaign.call(
      { label: "workflow/measured", request: piRequest() },
      async ({ call }) =>
        piResult(
          campaign,
          call,
          attributes(firstUsage),
          [message(firstUsage), message(secondUsage)],
          [attributes(secondUsage)],
        ),
    );
  } finally {
    campaign.close();
  }

  const expected = {
    freshInputTokens: 9,
    cachedInputTokens: 2,
    reasoningOutputTokens: 3,
    nonReasoningOutputTokens: 7,
    estimatedReasoningCostUsd: 4.8,
    reasoningCostShareOfMeasuredCost: 0.24,
  };
  const observation = inspectCoreCampaign(path);
  expect(observation.spend.breakdown).toEqual(expected);
  expect(observation.calls[0]!.pi?.accounting).toMatchObject({
    state: "available",
    spend: { breakdown: expected },
  });
  expect(inspectCoreCampaignSummary(path).spend.breakdown).toEqual(expected);
});

test("omits reasoning cost when measured retry usage is absent from transcript", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", null);
  try {
    await campaign.call(
      { label: "workflow/measured", request: piRequest() },
      async ({ call }) =>
        piResult(
          campaign,
          call,
          attributes(firstUsage),
          [message(firstUsage)],
          [attributes(secondUsage)],
        ),
    );
  } finally {
    campaign.close();
  }

  expect(inspectCoreCampaign(path).spend.breakdown).toEqual({
    freshInputTokens: 9,
    cachedInputTokens: 2,
    reasoningOutputTokens: 3,
    nonReasoningOutputTokens: 7,
  });
});

test("projects opaque application data, calls, candidates, and verdicts", async () => {
  const path = campaignPath();
  const config = { protocol: "rapid-v37", future: { value: true } };
  const campaign = createCampaign(path, "changing-workflow", config);
  try {
    const candidate = campaign.submitCandidate(new TextEncoder().encode("x"), [
      "proof",
    ]);
    const { call } = await campaign.call(
      {
        label: "proof",
        role: "proof-auditor",
        candidate,
        request: { custom: true },
      },
      async () => ({ state: "succeeded" }),
    );
    campaign.recordVerdict(call, "PASS", { checked: "directly" });
  } finally {
    campaign.close();
  }

  expect(inspectCoreCampaign(path)).toMatchObject({
    schema: "xean.core-observation/v1",
    application: "changing-workflow",
    applicationConfig: config,
    calls: [
      {
        label: "proof",
        role: "proof-auditor",
        settlement: "returned",
        candidateId: 2,
        tools: [],
      },
    ],
    candidates: [
      {
        id: 2,
        requiredVerifiers: ["proof"],
        material: { bytes: 1, encoding: "utf8", text: "x" },
        status: { verified: true, missing: [], failed: [] },
        verdicts: [
          {
            call: 3,
            verifier: "proof",
            verdict: "PASS",
            evidence: { checked: "directly" },
          },
        ],
      },
    ],
  });
});

test("captured observation boundaries do not reread later calls or verdicts", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "captured-boundary", { opaque: true });
  let forbiddenReads = 0;
  const forbidden = (): never => {
    forbiddenReads += 1;
    throw new Error("captured projection must not reread journal or payload");
  };
  const materialReads: number[] = [];
  const reader: Reader = {
    records: forbidden,
    record: forbidden,
    lastSequence: forbidden,
    payload: forbidden,
    material(seq) {
      materialReads.push(seq);
      return campaign.material(seq);
    },
    close: forbidden,
  };
  try {
    const candidate = campaign.submitCandidate(
      new TextEncoder().encode("captured proof"),
      ["proof"],
    );
    const { call } = await campaign.call(
      { label: "proof", candidate, request: null },
      async () => ({ state: "succeeded" }),
    );
    const through = campaign.lastSequence();
    const records = campaign.records({ through });
    const before = inspectCoreCampaignRecords(reader, records);
    const summary = inspectCoreCampaignSummaryRecords(records);
    expect(before.lastSeq).toBe(through);
    expect(before.calls.map((value) => value.id)).toEqual([call]);
    expect(before.candidates[0]!.status.verified).toBe(false);
    expect(before.candidates[0]!.material).toMatchObject({
      text: "captured proof",
    });
    expect(summary).toMatchObject({
      lastSeq: through,
      callCount: 1,
      candidateCount: 1,
      verifiedCandidateCount: 0,
    });

    campaign.recordVerdict(call, "PASS", { checked: "after capture" });
    campaign.submitCandidate(new TextEncoder().encode("later proof"), [
      "later",
    ]);
    await campaign.call({ label: "later", request: null }, async () => null);

    expect(campaign.lastSequence()).toBeGreaterThan(through);
    expect(inspectCoreCampaignRecords(reader, records)).toEqual(before);
    expect(inspectCoreCampaignSummaryRecords(records)).toEqual(summary);
    expect(materialReads).toEqual([candidate, candidate]);
    expect(forbiddenReads).toBe(0);
    const current = inspectCoreCampaignSummary(path);
    expect(current).toMatchObject({
      callCount: 2,
      candidateCount: 2,
      verifiedCandidateCount: 1,
    });
    expect(current.lastSeq).toBeGreaterThan(summary.lastSeq);
  } finally {
    campaign.close();
  }
});

test("a captured pending call stays pending after its result is appended", async () => {
  const campaign = createCampaign(campaignPath(), "pending-boundary", null);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pending = campaign.call(
    { label: "pending", request: null },
    async () => {
      await gate;
      return { done: true };
    },
  );
  let forbiddenReads = 0;
  const forbidden = (): never => {
    forbiddenReads += 1;
    throw new Error("unexpected live read");
  };
  const reader: Reader = {
    records: forbidden,
    record: forbidden,
    lastSequence: forbidden,
    payload: forbidden,
    material: forbidden,
    close: forbidden,
  };
  try {
    const records = campaign.records({ through: campaign.lastSequence() });
    const summary = inspectCoreCampaignSummaryRecords(records);
    expect(summary.callsWithoutResult?.count).toBe(1);
    expect(
      inspectCoreCampaignRecords(reader, records).calls[0]!.settlement,
    ).toBe("unsettled");
    finish();
    await pending;
    expect(campaign.lastSequence()).toBeGreaterThan(summary.lastSeq);
    expect(inspectCoreCampaignSummaryRecords(records)).toEqual(summary);
    expect(
      inspectCoreCampaignRecords(reader, records).calls[0]!.settlement,
    ).toBe("unsettled");
    expect(forbiddenReads).toBe(0);
    const latest = inspectCoreCampaignSummaryRecords(campaign.records());
    expect(latest).not.toHaveProperty("callsWithoutResult");
    expect(latest.lastSeq).toBeGreaterThan(summary.lastSeq);
  } finally {
    finish();
    await pending;
    campaign.close();
  }
});

test("preserves non-UTF-8 candidate bytes without invented text", () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "binary-workflow", null);
  try {
    campaign.submitCandidate(new Uint8Array([0xff]), ["proof"]);
  } finally {
    campaign.close();
  }

  expect(inspectCoreCampaign(path).candidates[0]!.material).toEqual({
    bytes: 1,
    encoding: "base64",
    base64: "/w==",
  });
});

test("summarizes without response, evidence, operation, or material payloads", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", { opaque: true });
  try {
    campaign.submitCandidate(new TextEncoder().encode("large material"), [
      "proof",
    ]);
    await campaign.call(
      { label: "workflow/call", request: { opaque: true } },
      async () => ({ response: "large response" }),
    );
  } finally {
    campaign.close();
  }

  const summary = inspectCoreCampaignSummary(path);
  expect(summary).toMatchObject({
    schema: "xean.core-observation-summary/v1",
    application: "changing-workflow",
    callCount: 1,
    candidateCount: 1,
    verifiedCandidateCount: 0,
  });
  expect(JSON.stringify(summary)).not.toContain("large material");
  expect(JSON.stringify(summary)).not.toContain("large response");
  expect(summary).not.toHaveProperty("applicationConfig");
});

test.each(["schema", "checkpoint"] as const)(
  "keeps understood spend when another Pi %s is unsupported",
  async (unsupported) => {
    const path = campaignPath();
    const campaign = createCampaign(path, "changing-workflow", null);
    try {
      await campaign.call(
        { label: "workflow/measured", request: piRequest() },
        async ({ call }) =>
          piResult(campaign, call, {
            "pi.ai.provider": "provider",
            "pi.ai.model": "model",
            "pi.ai.api": "responses",
            "pi.ai.usage.input_tokens": 8,
            "pi.ai.usage.output_tokens": 5,
            "pi.ai.usage.cache_read_tokens": 2,
            "pi.ai.usage.cache_write_tokens": 0,
            "pi.ai.usage.total_tokens": 13,
            "pi.ai.usage.cost": 0.25,
          }),
      );
      await campaign.call(
        { label: "workflow/future", request: piRequest() },
        async ({ call }) =>
          unsupported === "schema"
            ? {
                state: "succeeded",
                text: "done",
                transcript: [],
                telemetry: { schemaVersions: { future: 1 }, spans: [] },
              }
            : piResult(campaign, call, {
                ...attributes(firstUsage),
                "xean.pi.request.checkpoint": 999,
              }),
      );
    } finally {
      campaign.close();
    }

    const observation = inspectCoreCampaign(path);
    expect(observation.calls.map((call) => call.pi?.accounting.state)).toEqual([
      "available",
      "unsupported",
    ]);
    if (unsupported === "checkpoint")
      expect(observation.calls[1]?.pi).toMatchObject({
        outcome: "succeeded",
        responseText: "done",
      });
    expect(observation.spend).toMatchObject({
      logicalProviderRequests: 1,
      requestErrors: 0,
      unmeasuredRequests: 0,
      measuredUsage: {
        input: 8,
        output: 5,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 13,
        estimatedCostUsd: 0.25,
      },
      unsupportedCalls: [4],
      unaccountedCalls: [],
    });
  },
);

test("reports missing usage as unmeasured instead of zero", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", null);
  try {
    await campaign.call(
      { label: "workflow/unmeasured", request: piRequest() },
      async ({ call }) =>
        piResult(campaign, call, {
          "pi.ai.provider": "provider",
          "pi.ai.model": "model",
          "pi.ai.api": "responses",
        }),
    );
  } finally {
    campaign.close();
  }

  expect(inspectCoreCampaign(path).spend).toMatchObject({
    logicalProviderRequests: 1,
    requestErrors: 0,
    unmeasuredRequests: 1,
    unsupportedCalls: [],
    unaccountedCalls: [],
  });
});

test("distinguishes an unsettled Pi call from unsupported telemetry", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", null);
  let finish!: () => void;
  const pending = campaign.call(
    { label: "workflow/running", request: piRequest() },
    () => new Promise<null>((resolve) => (finish = () => resolve(null))),
  );
  try {
    await Bun.sleep(0);
    expect(inspectCoreCampaign(path)).toMatchObject({
      calls: [
        {
          settlement: "unsettled",
          pi: { accounting: { state: "unaccounted" } },
        },
      ],
      spend: { unsupportedCalls: [], unaccountedCalls: [2] },
    });
  } finally {
    finish();
    await pending;
    campaign.close();
  }
});

test.each([
  "stream_incomplete: Upstream closed stream without completion",
  "Response incomplete: max_messages",
])("separates fresh-call cache coverage from recovered %s", async (failure) => {
  const path = campaignPath();
  const campaign = createCampaign(path, "recovered-workflow", null);
  const unmeasured = {
    "pi.ai.provider": "provider",
    "pi.ai.model": "model",
    "pi.ai.api": "responses",
    "pi.ai.response.stop_reason": "error",
  };
  const cached = {
    input: 1,
    output: 5,
    cacheRead: 9,
    cacheWrite: 0,
    reasoning: 3,
    totalTokens: 15,
    cost: {
      input: 0.01,
      output: 0.25,
      cacheRead: 0.009,
      cacheWrite: 0,
      total: 0.269,
    },
  };
  const fresh = {
    input: 17,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 17,
    cost: { input: 0.17, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.17 },
  };
  try {
    await campaign.call(
      { label: "workflow/recovered", request: piRequest() },
      async ({ call }) =>
        piResult(
          campaign,
          call,
          unmeasured,
          [],
          [attributes(cached)],
          [failure],
        ),
    );
    await campaign.call(
      { label: "workflow/fresh", request: piRequest() },
      async ({ call }) => piResult(campaign, call, attributes(fresh)),
    );
  } finally {
    campaign.close();
  }

  const observation = inspectCoreCampaign(path);
  const recovered = observation.calls[0]!.pi;
  expect(recovered?.outcome).toBe("succeeded");
  expect(recovered?.accounting).toMatchObject({
    state: "available",
    recoveredErrors: [{ request: 1, name: "ProviderError", message: failure }],
    spend: {
      recoveredRequestErrors: 1,
      requests: {
        first: {
          logicalProviderRequests: 1,
          requestErrors: 1,
          unmeasuredRequests: 1,
        },
        continuation: {
          logicalProviderRequests: 1,
          unmeasuredRequests: 0,
          cachedInputShare: 0.9,
        },
      },
    },
  });
  if (recovered?.accounting.state !== "available")
    throw new Error("missing accounting");
  expect(recovered.accounting.spend.requests?.first).not.toHaveProperty(
    "measuredUsage",
  );
  expect(recovered.accounting.spend.requests?.first).not.toHaveProperty(
    "cachedInputShare",
  );
  expect(observation.spend).toMatchObject({
    logicalProviderRequests: 3,
    requestErrors: 1,
    unmeasuredRequests: 1,
    recoveredRequestErrors: 1,
    requests: {
      first: {
        logicalProviderRequests: 2,
        requestErrors: 1,
        unmeasuredRequests: 1,
        cachedInputShare: 0,
        measuredUsage: { input: 17, cacheRead: 0 },
      },
      continuation: { logicalProviderRequests: 1, cachedInputShare: 0.9 },
    },
  });
  const summary = inspectCoreCampaignSummary(path);
  expect(summary.spend.requests).toEqual(observation.spend.requests);
  expect(summary.spend.recoveredRequestErrors).toBe(1);
  expect(JSON.stringify(summary)).not.toContain(failure);
});

test("keeps terminal provider failures separate from recovered errors", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "failed-workflow", null);
  const unmeasured = {
    "pi.ai.provider": "provider",
    "pi.ai.model": "model",
    "pi.ai.api": "responses",
    "pi.ai.response.stop_reason": "error",
  };
  try {
    await campaign.call(
      { label: "workflow/failed", request: piRequest() },
      async ({ call }) => ({
        ...piResult(
          campaign,
          call,
          unmeasured,
          [],
          [unmeasured],
          [
            "Response incomplete: max_messages",
            "Response incomplete: max_messages",
          ],
        ),
        state: "failed" as const,
        error: "Response incomplete: max_messages",
        providerRetryable: true,
        truncated: false,
      }),
    );
  } finally {
    campaign.close();
  }

  const observation = inspectCoreCampaign(path);
  expect(observation.calls[0]!.pi).toMatchObject({
    outcome: "failed",
    accounting: { state: "available", spend: { recoveredRequestErrors: 0 } },
  });
  expect(observation.calls[0]!.pi?.accounting).not.toHaveProperty(
    "recoveredErrors",
  );
  expect(observation.spend).toMatchObject({
    requestErrors: 2,
    unmeasuredRequests: 2,
    recoveredRequestErrors: 0,
  });
  expect(observation.spend).not.toHaveProperty("measuredUsage");
  expect(observation.spend.requests?.first).not.toHaveProperty(
    "cachedInputShare",
  );
  expect(observation.spend.requests?.continuation).not.toHaveProperty(
    "cachedInputShare",
  );
});

test("keeps measured zero usage distinct from missing usage in each request phase", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "zero-workflow", null);
  const zero = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  try {
    await campaign.call(
      { label: "workflow/zero", request: piRequest() },
      async ({ call }) => piResult(campaign, call, attributes(zero)),
    );
  } finally {
    campaign.close();
  }

  const requests = inspectCoreCampaign(path).spend.requests;
  expect(requests?.first).toMatchObject({
    logicalProviderRequests: 1,
    unmeasuredRequests: 0,
    measuredUsage: { input: 0, cacheRead: 0, estimatedCostUsd: 0 },
  });
  expect(requests?.first).not.toHaveProperty("cachedInputShare");
  expect(requests?.continuation).toEqual({
    logicalProviderRequests: 0,
    requestErrors: 0,
    unmeasuredRequests: 0,
  });
});

test("cache-read share counts fresh tokens and cache writes in the prompt denominator", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "cache-write-workflow", null);
  const usage = {
    input: 10,
    output: 5,
    cacheRead: 30,
    cacheWrite: 20,
    reasoning: 0,
    totalTokens: 65,
    cost: {
      input: 0.01,
      output: 0.01,
      cacheRead: 0.003,
      cacheWrite: 0.025,
      total: 0.048,
    },
  };
  try {
    await campaign.call(
      { label: "workflow/cache-write", request: piRequest() },
      async ({ call }) => piResult(campaign, call, attributes(usage)),
    );
  } finally {
    campaign.close();
  }
  expect(inspectCoreCampaign(path).spend.requests?.first.cachedInputShare).toBe(
    0.5,
  );
});

test.each([
  ["textRef", "damaged"],
  ["textRef", "missing"],
  ["transcriptRef", "damaged"],
  ["transcriptRef", "missing"],
] as const)(
  "summary and accounting avoid %s %s attachments; full inspection checks integrity",
  async (attachment, corruption) => {
    const { Database } = await import("bun:sqlite");
    const { derivePiSpend, piResultRecord, readPiResult } =
      await import("../src/pi");
    const path = campaignPath();
    const campaign = createCampaign(path, "attachments", null);
    try {
      const receipt = await campaign.call(
        { label: "measured", request: piRequest() },
        async ({ call }) =>
          piResult(campaign, call, attributes(firstUsage), [
            message(firstUsage),
          ]),
      );
      const records = campaign.records();
      const summary = inspectCoreCampaignSummaryRecords(records);
      const full = inspectCoreCampaignRecords(campaign, records);
      const callSummaries = inspectCoreCallSummaries(records);
      expect(summary.spend).toEqual({
        ...full.spend,
        unsupportedCalls: 0,
        unaccountedCalls: 0,
      });
      const record = piResultRecord.parse(receipt.output);
      const database = new Database(path);
      try {
        database.run(
          `DROP TRIGGER payload_items_no_${corruption === "missing" ? "delete" : "update"}`,
        );
        database.run(
          corruption === "missing"
            ? "DELETE FROM payload_items WHERE digest=(SELECT body_digest FROM payloads WHERE digest=?)"
            : "UPDATE payload_items SET body='null' WHERE digest=(SELECT body_digest FROM payloads WHERE digest=?)",
          [record[attachment]],
        );
      } finally {
        database.close();
      }
      expect(inspectCoreCampaignSummaryRecords(records)).toEqual(summary);
      expect(inspectCoreCallSummaries(records)).toEqual(callSummaries);
      expect(derivePiSpend(records).summary).toMatchObject({
        logicalProviderRequests: 1,
      });
      expect(() => readPiResult(receipt.output, campaign)).toThrow();
      expect(() => inspectCoreCampaignRecords(campaign, records)).toThrow();
    } finally {
      campaign.close();
    }
  },
);

test.each([
  { role: "assistant", usage: null },
  { role: "assistant", usage: { ...firstUsage, reasoning: -1 } },
  {
    role: "assistant",
    usage: { ...firstUsage, cost: { ...firstUsage.cost, output: -1 } },
  },
  { role: "assistant", usage: { ...firstUsage, reasoning: 6 } },
])(
  "invalid assistant usage preserves unavailable reasoning cost: %j",
  async (invalid) => {
    const campaign = createCampaign(campaignPath(), "invalid-usage", null);
    try {
      await campaign.call(
        { label: "measured", request: piRequest() },
        async ({ call }) =>
          piResult(campaign, call, attributes(firstUsage), [
            message(firstUsage),
            invalid,
          ]),
      );
      const records = campaign.records();
      const full = inspectCoreCampaignRecords(campaign, records);
      const summary = inspectCoreCampaignSummaryRecords(records);
      expect(full.calls[0]?.pi?.accounting.state).toBe("available");
      expect(full.spend.breakdown?.estimatedReasoningCostUsd).toBeUndefined();
      expect(summary.spend).toEqual({
        ...full.spend,
        unsupportedCalls: 0,
        unaccountedCalls: 0,
      });
    } finally {
      campaign.close();
    }
  },
);
