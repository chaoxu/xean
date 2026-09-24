import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  createCampaign,
  defineTool,
  openReader,
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
import { piStoredResult, storePiResult } from "../src/pi";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function campaignPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xean-observe-v2-"));
  directories.push(directory);
  return join(directory, "campaign.db");
}

function piRequest() {
  return {
    protocol: "xean/pi-run/v5" as const,
    model: { provider: "provider", id: "model", api: "responses" },
    modelProfile: null,
    prompt: "test",
  };
}

interface Operation {
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly reasoning?: number;
    readonly totalTokens: number;
    readonly estimatedCostUsd: number;
  };
  readonly error?: string;
}

/** Append one completed request checkpoint per operation, then the compact result. */
async function piResult(
  campaign: Campaign,
  call: EntryId,
  operations: readonly Operation[],
  transcript: readonly unknown[] = [],
) {
  const model = piRequest().model;
  for (const operation of operations) {
    await campaign.call(
      {
        label: "xean/pi-request",
        request: {
          protocol: "xean/pi-request/v1",
          parent: call,
          model,
          payloadRef: campaign.storePayload({ input: [] }),
        },
      },
      async () => ({
        protocol: "xean/pi-request-completion/v2",
        parent: call,
        operation: {
          provider: model.provider,
          requestedModel: model.id,
          api: model.api,
          stopReason: operation.error === undefined ? "stop" : "error",
          error: operation.error !== undefined,
          usage: operation.usage ?? null,
        },
        ...(operation.error === undefined
          ? {}
          : { errorMessage: operation.error }),
      }),
    );
  }
  return storePiResult(campaign, {
    call,
    ...piStoredResult.parse({ state: "succeeded", text: "done", transcript }),
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
    await campaign.call(
      { label: "measured", role: "explorer", request: piRequest() },
      async ({ call }) =>
        piResult(campaign, call, [measured(firstUsage)], [message(firstUsage)]),
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
    const summary = inspectCoreCampaignSummaryRecords(records);
    expect(summary.schema).toBe("xean.core-observation-summary/v2");
    expect(summary).not.toHaveProperty("applicationConfig");
    expect(JSON.stringify(summary)).not.toContain('"done"');
    await campaign.call({ label: "later", request: null }, async () => null);
    expect(inspectCoreCallSummaries(records)).toEqual(metadata);
    expect(inspectCoreCallSummaries(campaign.records())).toHaveLength(3);
  } finally {
    campaign.close();
  }
});

test("file observations preserve captured results without materializing historical requests", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "streamed-observation", {
    revision: 1,
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let pending: Promise<unknown> | undefined;
  try {
    const local = await campaign.call(
      {
        label: "local",
        request: { text: "large unrelated request".repeat(8192) },
        tools: [
          defineTool({
            name: "lookup",
            description: "Return local data",
            input: z.string(),
            async run() {
              return "large tool result".repeat(8192);
            },
          }),
        ],
      },
      async ({ tools }) => {
        await tools[0]!.execute("large tool input".repeat(8192));
        return { text: "large unrelated result".repeat(8192) };
      },
    );
    campaign.recordEvidence(local.call, { source: "application" });
    await campaign.call(
      {
        label: "measured",
        role: "explorer",
        parent: local.call,
        request: piRequest(),
      },
      async ({ call }) =>
        piResult(campaign, call, [
          measured(firstUsage),
          { error: "recovered" },
          measured(secondUsage),
        ]),
    );
    await campaign.call(
      { label: "unsupported", request: piRequest() },
      async () => null,
    );
    // A coincidental checkpoint label remains an ordinary application call.
    await campaign.call(
      { label: "xean/pi-request", request: null },
      async () => null,
    );
    pending = campaign.call(
      { label: "pending", request: piRequest() },
      async () => {
        await gate;
        return null;
      },
    );
    const records = campaign.records();
    const expectedFull = inspectCoreCampaignRecords(campaign, records);
    const expectedSummary = inspectCoreCampaignSummaryRecords(records);
    const reader = openReader(path);
    const prototype = Object.getPrototypeOf(reader) as Reader;
    reader.close();
    const read = prototype.records;
    const bounded = spyOn(prototype, "records").mockImplementation(function (
      this: Reader,
      query,
    ) {
      if (query?.call === undefined && query?.parent === undefined)
        throw new Error("unbounded array read");
      return read.call(this, query);
    });
    try {
      expect(inspectCoreCampaign(path)).toEqual(expectedFull);
      expect(inspectCoreCampaignSummary(path)).toEqual(expectedSummary);
    } finally {
      bounded.mockRestore();
    }
  } finally {
    finish();
    await pending;
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
const measured = (usage: typeof firstUsage) => ({
  usage: {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.cost.total,
  },
});
const message = (usage: typeof firstUsage) => ({ role: "assistant", usage });

test("derives token buckets only from request completions, ignoring transcript usage", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", null);
  try {
    await campaign.call(
      { label: "workflow/measured", request: piRequest() },
      async ({ call }) =>
        piResult(
          campaign,
          call,
          [measured(firstUsage), measured(secondUsage)],
          [{ role: "assistant", usage: { invalid: true } }],
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
  };
  const observation = inspectCoreCampaign(path);
  expect(observation.spend.breakdown).toEqual(expected);
  expect(observation.calls[0]!.pi?.accounting).toMatchObject({
    state: "available",
    spend: { breakdown: expected },
  });
  expect(inspectCoreCampaignSummary(path).spend.breakdown).toEqual(expected);
});

test("projects call ownership without interpreting application evidence", async () => {
  const path = campaignPath();
  const config = { protocol: "rapid-v37", future: { value: true } };
  const campaign = createCampaign(path, "changing-workflow", config);
  try {
    const parent = await campaign.call(
      { label: "verification", request: { exact: "claim" } },
      async () => null,
    );
    const { call } = await campaign.call(
      {
        label: "proof",
        role: "proof-auditor",
        parent: parent.call,
        request: { custom: true },
      },
      async () => ({ state: "succeeded" }),
    );
    campaign.recordEvidence(call, { verdict: "PASS", checked: "directly" });
    const records = campaign.records();
    const before = inspectCoreCampaignRecords(campaign, records);
    expect(before).toMatchObject({
      schema: "xean.core-observation/v2",
      application: "changing-workflow",
      applicationConfig: config,
      calls: [
        {
          call: parent.call,
          label: "verification",
          state: "returned",
          tools: [],
        },
        {
          call,
          label: "proof",
          role: "proof-auditor",
          state: "returned",
          parent: parent.call,
          tools: [],
        },
      ],
    });
    expect(before.calls[1]?.evidence).toEqual({
      verdict: "PASS",
      checked: "directly",
    });
    expect(inspectCoreCallSummaries(records)[1]).not.toHaveProperty("evidence");
    await campaign.call({ label: "later", request: null }, async () => null);
    expect(inspectCoreCampaignRecords(campaign, records)).toEqual(before);
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
    scan: forbidden,
    record: forbidden,
    lastSequence: forbidden,
    payload: forbidden,
    close: forbidden,
  };
  try {
    const records = campaign.records({ through: campaign.lastSequence() });
    const summary = inspectCoreCampaignSummaryRecords(records);
    expect(summary.callsWithoutResult?.count).toBe(1);
    expect(inspectCoreCampaignRecords(reader, records).calls[0]!.state).toBe(
      "unsettled",
    );
    finish();
    await pending;
    expect(campaign.lastSequence()).toBeGreaterThan(summary.lastSeq);
    expect(inspectCoreCampaignSummaryRecords(records)).toEqual(summary);
    expect(inspectCoreCampaignRecords(reader, records).calls[0]!.state).toBe(
      "unsettled",
    );
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

test("keeps understood spend when another Pi result is unsupported", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", null);
  try {
    await campaign.call(
      { label: "workflow/measured", request: piRequest() },
      async ({ call }) =>
        piResult(campaign, call, [
          {
            usage: {
              input: 8,
              output: 5,
              cacheRead: 2,
              cacheWrite: 0,
              totalTokens: 13,
              estimatedCostUsd: 0.25,
            },
          },
        ]),
    );
    await campaign.call(
      { label: "workflow/future", request: piRequest() },
      async () => ({ state: "succeeded", text: "done", transcript: [] }),
    );
  } finally {
    campaign.close();
  }

  const observation = inspectCoreCampaign(path);
  expect(observation.calls.map((call) => call.pi?.accounting.state)).toEqual([
    "available",
    "unsupported",
  ]);
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
    unsupportedCalls: [6],
    unaccountedCalls: [],
  });
});

test("reports missing usage as unmeasured instead of zero", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, "changing-workflow", null);
  try {
    await campaign.call(
      { label: "workflow/unmeasured", request: piRequest() },
      async ({ call }) => piResult(campaign, call, [{}]),
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

test("reports an unsettled Pi call as unaccounted", async () => {
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
          state: "unsettled",
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

test("separates fresh-call cache coverage from recovered request errors", async () => {
  const failure =
    "stream_incomplete: Upstream closed stream without completion";
  const path = campaignPath();
  const campaign = createCampaign(path, "recovered-workflow", null);
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
        piResult(campaign, call, [{ error: failure }, measured(cached)]),
    );
    await campaign.call(
      { label: "workflow/fresh", request: piRequest() },
      async ({ call }) => piResult(campaign, call, [measured(fresh)]),
    );
  } finally {
    campaign.close();
  }

  const observation = inspectCoreCampaign(path);
  const recovered = observation.calls[0]!.pi;
  expect(recovered?.outcome).toBe("succeeded");
  expect(recovered?.accounting).toMatchObject({
    state: "available",
    recoveredErrors: [
      { request: 1, stopReason: "error", errorMessage: failure },
    ],
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
  const failure = "Response incomplete: max_messages";
  try {
    await campaign.call(
      { label: "workflow/failed", request: piRequest() },
      async ({ call }) => ({
        ...(await piResult(campaign, call, [
          { error: failure },
          { error: failure },
        ])),
        state: "failed" as const,
        error: failure,
        providerRetryable: true,
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
      async ({ call }) => piResult(campaign, call, [measured(zero)]),
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
      async ({ call }) => piResult(campaign, call, [measured(usage)]),
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
  "observation resolves only text while full Pi reads reject %s %s attachments",
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
          piResult(
            campaign,
            call,
            [measured(firstUsage)],
            [message(firstUsage)],
          ),
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
          `DROP TRIGGER payloads_no_${corruption === "missing" ? "delete" : "update"}`,
        );
        database.run(
          corruption === "missing"
            ? "DELETE FROM payloads WHERE digest=?"
            : "UPDATE payloads SET body='null' WHERE digest=?",
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
      if (attachment === "textRef")
        expect(() => inspectCoreCampaignRecords(campaign, records)).toThrow();
      else expect(inspectCoreCampaignRecords(campaign, records)).toEqual(full);
    } finally {
      campaign.close();
    }
  },
);
