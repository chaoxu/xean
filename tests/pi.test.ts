import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import {
  createAssistantMessageEventStream,
  registerSessionResourceCleanup,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";

import {
  createCampaign,
  defineTool,
  deriveCandidateStatus,
  openReader,
  type Entry,
} from "../src";
import {
  PI_TELEMETRY_SCHEMA_VERSIONS,
  derivePiSpend,
  piRequest,
  piRequestAttempts,
  piStoredResult,
  piResultRecord,
  readPiResult,
  storePiResult,
  piTelemetry,
  runPi,
  type PiSubmissionGate,
} from "../src/pi";
import {
  inspectCoreCampaign,
  inspectCoreCampaignSummary,
} from "../src/observe";

test("forwards provider events before completion and cleans the logical session", async () => {
  const store = campaign();
  let consumed!: () => void;
  const observed = new Promise<void>((resolve) => {
    consumed = resolve;
  });
  let session: string | undefined;
  const cleaned: (string | undefined)[] = [];
  const unregister = registerSessionResourceCleanup((id) => {
    cleaned.push(id);
  });
  const models: PiModels = {
    streamSimple(requestModel, _context, options) {
      session = options?.sessionId;
      const stream = createAssistantMessageEventStream();
      const final = assistant([{ type: "text", text: "done" }], "stop");
      void (async () => {
        await options?.onPayload?.({ input: "streaming" }, requestModel);
        expect(piRequestAttempts(store.records())[0]?.state).toBe("unsettled");
        const start: AssistantMessageEvent = {
          type: "start",
          get partial() {
            consumed();
            return final;
          },
        };
        stream.push(start);
        await observed;
        stream.push({ type: "done", reason: "stop", message: final });
        stream.end();
      })().catch((error: unknown) => {
        stream.push({
          type: "error",
          reason: "error",
          error: {
            ...final,
            stopReason: "error",
            errorMessage: String(error),
          },
        });
        stream.end();
      });
      return stream;
    },
  };
  try {
    const result = await runPi(store, {
      models,
      model,
      label: "forwarding",
      prompt: "Test",
    });
    expect(result.state).toBe("succeeded");
    expect(session).toBeDefined();
    expect(cleaned).toEqual([session]);
    expect(piRequestAttempts(store.records())[0]?.state).toBe("completed");
  } finally {
    unregister();
    store.close();
  }
}, 1000);

test("request accounting is durable before tool execution and counted once after continuation", async () => {
  const store = campaign();
  let checked = false;
  const record = defineTool({
    name: "record",
    description: "Record",
    input: z.strictObject({}),
    replay: "safe",
    async run() {
      const spend = derivePiSpend(store.records());
      expect(spend.unaccountedCalls).toHaveLength(1);
      expect(spend.summary).toMatchObject({
        logicalProviderRequests: 1,
        unmeasuredRequests: 0,
      });
      expect(piRequestAttempts(store.records())[0]?.state).toBe("completed");
      checked = true;
      return null;
    },
  });
  try {
    await runPi(store, {
      model,
      label: "durable-usage",
      prompt: "Record",
      tools: [record],
      models: payloadModels(
        [
          assistant(
            [{ type: "toolCall", id: "first", name: "record", arguments: {} }],
            "toolUse",
          ),
          assistant([{ type: "text", text: "done" }], "stop"),
        ],
        [{ input: "first" }, { input: "second" }],
        [],
      ),
    });
    expect(checked).toBe(true);
    expect(derivePiSpend(store.records()).summary.logicalProviderRequests).toBe(
      2,
    );
  } finally {
    store.close();
  }
});

test.each(["checkpoint", "provider-result"] as const)(
  "settles calls and cleans the session after a %s rejection",
  async (failure) => {
    const store = campaign();
    const call = store.call.bind(store);
    store.call = (options, runner) =>
      failure === "checkpoint" && options.label === "xean/pi-request"
        ? Promise.reject(new Error("checkpoint rejected"))
        : call(options, runner);
    const provider = invalidPayloadModels(1);
    const cleaned: (string | undefined)[] = [];
    const unregister = registerSessionResourceCleanup((id) => {
      cleaned.push(id);
    });
    let session: string | undefined;
    try {
      await expect(
        runPi(store, {
          models: {
            streamSimple(model, context, options) {
              session = options?.sessionId;
              const stream = provider.streamSimple(model, context, options);
              if (failure === "provider-result")
                stream.result = async () => {
                  throw new Error("provider-result rejected");
                };
              return stream;
            },
          },
          model,
          label: "rejected-request",
          prompt: "Test",
        }),
      ).rejects.toThrow(`${failure} rejected`);
      const entries = store.records();
      const calls = entries.filter((entry) => entry.kind === "call");
      expect(calls).toHaveLength(failure === "checkpoint" ? 1 : 2);
      for (const call of calls)
        expect(entries).toContainEqual(
          expect.objectContaining({
            kind: "call-result",
            parent: call.seq,
            state: "threw",
          }),
        );
      expect(session).toBeDefined();
      expect(cleaned).toEqual([session]);
    } finally {
      unregister();
      store.close();
    }
  },
  1000,
);

type PiModels = Pick<Models, "streamSimple">;

const model: Model<"openai-responses"> = {
  id: "test-v1",
  name: "Test",
  api: "openai-responses",
  provider: "fake",
  baseUrl: "https://invalid.test",
  reasoning: true,
  thinkingLevelMap: { max: "max" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};
const submitVerdict = defineTool({
  name: "submit_verdict",
  description: "Submit a verdict",
  input: z.strictObject({
    verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    evidence: z.json(),
  }),
  replay: "safe",
  async run() {
    return null;
  },
});

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function campaign() {
  const directory = mkdtempSync(join(tmpdir(), "xean-pi-"));
  directories.push(directory);
  return createCampaign(join(directory, "campaign.db"), "pi-test", null);
}

function spendEntries(
  attributes: Record<string, string | number | boolean>,
  error = false,
): Entry[] {
  return [
    {
      seq: 1,
      atMs: 1,
      kind: "campaign",
      application: "test",
      config: null,
    },
    {
      seq: 2,
      atMs: 2,
      kind: "call",
      label: "test/v1",
      request: {
        protocol: "xean/pi-run/v1",
        model: { provider: "fake", id: "test-v1", api: "openai-responses" },
        modelProfile: null,
        prompt: "test",
      },
      tools: [],
    },
    {
      seq: 3,
      atMs: 3,
      kind: "call-result",
      parent: 2,
      state: "returned",
      output: {
        state: "succeeded",
        call: 2,
        textRef: "a".repeat(64),
        transcriptRef: "b".repeat(64),
        assistantUsage: [],
        telemetry: {
          schemaVersions: PI_TELEMETRY_SCHEMA_VERSIONS,
          spans: [
            {
              id: 1,
              parentId: null,
              name: "xean.pi.run",
              attributes: {},
              events: [],
              status: { status: "ok" },
              settled: true,
            },
            {
              id: 2,
              parentId: 1,
              name: "pi.ai.request",
              attributes,
              events: [],
              status: error
                ? { status: "error", error: { name: "Error", message: "x" } }
                : { status: "ok" },
              settled: true,
            },
          ],
        },
      },
    },
  ];
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  reasoning?: number,
  measured = true,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseModel: "served-test-v1",
    usage: measured
      ? {
          input: 11,
          output: 7,
          cacheRead: 5,
          cacheWrite: 0,
          ...(reasoning === undefined ? {} : { reasoning }),
          totalTokens: 23,
          cost: {
            input: 0.011,
            output: 0.014,
            cacheRead: 0.001,
            cacheWrite: 0,
            total: 0.026,
          },
        }
      : {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
    stopReason,
    timestamp: 1,
  };
}

function models(
  replies: readonly AssistantMessage[],
  inspect?: (
    context: Context,
    options: SimpleStreamOptions | undefined,
  ) => void,
): PiModels {
  let index = 0;
  return {
    streamSimple(requestModel, context, options) {
      inspect?.(context, options);
      const reply = replies[index++];
      if (reply === undefined) throw new Error("no scripted Pi reply");
      const stream = createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.(
          { model: requestModel.id, context },
          requestModel,
        );
        if (reply.stopReason === "error" || reply.stopReason === "aborted") {
          stream.push({
            type: "error",
            reason: reply.stopReason,
            error: reply,
          });
        } else if (reply.stopReason !== "pending") {
          stream.push({
            type: "done",
            reason: reply.stopReason,
            message: reply,
          });
        } else {
          throw new Error("pending is not a terminal Pi event");
        }
      })();
      return stream;
    },
  } as PiModels;
}

const gatedTool = defineTool({
  name: "submit_result",
  description: "Return the result when complete or near the context limit",
  input: z.strictObject({ solution: z.boolean(), text: z.string() }),
  replay: "safe",
  async run() {
    return null;
  },
});
const submissionGate = {
  completeArgument: "solution",
  reserveTokens: 2000,
};

function gateReply(
  index: number,
  tokens: number,
  solution: boolean,
  stop: "toolUse" | "stop" | "length" = "toolUse",
) {
  const message = assistant(
    stop === "toolUse"
      ? [
          {
            type: "thinking",
            thinking: `Intermediate reasoning ${index}`,
            thinkingSignature: `retained-${index}`,
          },
          {
            type: "toolCall",
            id: `result-${index}`,
            name: gatedTool.name,
            arguments: { solution, text: `Result ${index}` },
          },
        ]
      : [{ type: "text", text: `Intermediate reasoning ${index}` }],
    stop,
  );
  message.usage = {
    ...message.usage,
    input: Math.max(0, tokens - 50),
    output: Math.min(50, tokens),
    cacheRead: 0,
    totalTokens: tokens,
  };
  return message;
}

async function gatedRun(
  replies: AssistantMessage[],
  enabled = true,
  maxRecoveries = 2,
  tool = gatedTool,
  cancelOnRequest?: AbortController,
  gate: PiSubmissionGate = submissionGate,
  extra: { readonly replayReasoning?: boolean } = {},
) {
  const requests: { context: Context; maxTokens: number | undefined }[] = [];
  const wire = models(replies, (context, options) => {
    cancelOnRequest?.abort();
    replies[requests.length]!.timestamp = Date.now();
    requests.push({
      context: JSON.parse(JSON.stringify(context)),
      maxTokens: options?.maxTokens,
    });
  });
  const c = campaign();
  try {
    const result = await runPi(c, {
      models: wire,
      model,
      label: "submission-gate",
      prompt: "Work on the task and use submit_result.",
      tools: [tool],
      maxRecoveries,
      maxLengthContinuations: 8,
      ...(cancelOnRequest === undefined
        ? {}
        : { signal: cancelOnRequest.signal }),
      ...(enabled ? { submissionGate: gate } : { stopAfterToolResult: true }),
      ...extra,
    });
    return { result, requests, records: [...c.records()] };
  } finally {
    c.close();
  }
}

test("submission gate saves every partial in the same context before the near-limit handoff", async () => {
  const { result, requests, records } = await gatedRun([
    gateReply(1, 1000, false),
    gateReply(2, 3200, false),
    gateReply(3, 4000, false),
  ]);
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(3);
  expect(requests[2]!.maxTokens).toBeLessThan(model.maxTokens);
  expect(requests[1]!.context.messages.slice(-2)).toMatchObject([
    { role: "toolResult", isError: false },
    {
      role: "user",
      content: expect.stringContaining("Continue substantive work"),
    },
  ]);
  const first = requests[1]!.context.messages.find(
    (message) => message.role === "assistant",
  );
  expect(first).toMatchObject({
    content: [
      { type: "thinking", thinkingSignature: "retained-1" },
      { type: "toolCall" },
    ],
  });
  expect(
    requests[1]!.context.messages.some(
      (message) => message.role === "toolResult" && message.isError,
    ),
  ).toBe(false);
  const submissions = records.filter((entry) => entry.kind === "tool-call");
  expect(submissions).toMatchObject([
    { input: { solution: false, text: "Result 1" } },
    { input: { solution: false, text: "Result 2" } },
    { input: { solution: false, text: "Result 3" } },
  ]);
  expect(
    records.find(
      (entry) => entry.kind === "call" && entry.label === "submission-gate",
    ),
  ).toMatchObject({ request: { submissionGate, stopAfterToolResult: true } });
  expect(
    requests.every((request) => request.maxTokens! <= model.maxTokens),
  ).toBe(true);
});

test("replayReasoning false keeps completed reasoning out of later model input", async () => {
  const { result, requests, records } = await gatedRun(
    [
      gateReply(1, 1000, false),
      gateReply(2, 3200, false),
      gateReply(3, 4000, true),
    ],
    true,
    2,
    gatedTool,
    undefined,
    submissionGate,
    { replayReasoning: false },
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(3);
  for (const request of requests.slice(1)) {
    const assistants = request.context.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistants.length).toBeGreaterThan(0);
    expect(JSON.stringify(assistants)).not.toContain('"thinking"');
    expect(JSON.stringify(assistants)).toContain('"toolCall"');
  }
  expect(JSON.stringify(result.transcript)).toContain("retained-1");
  expect(
    records.find(
      (entry) => entry.kind === "call" && entry.label === "submission-gate",
    ),
  ).toMatchObject({ request: { replayReasoning: false } });
});

test.each([1, 4, 5])(
  "a response limit of %s stops nonempty no-progress submissions without another push",
  async (maxResponses) => {
    const replies = Array.from({ length: maxResponses }, (_, index) =>
      gateReply(index, 1000, false),
    );
    for (const reply of replies) {
      const tool = reply.content.find((block) => block.type === "toolCall");
      if (tool?.type !== "toolCall") throw new Error("fixture");
      tool.arguments = {
        solution: false,
        text: "No new mathematical progress.",
      };
    }
    const { result, requests, records } = await gatedRun(
      replies,
      true,
      2,
      gatedTool,
      undefined,
      {
        ...submissionGate,
        maxResponses,
        continuationPrompt: "Keep trying, you can do it.",
      },
    );
    expect(result.state).toBe("succeeded");
    expect(requests).toHaveLength(maxResponses);
    expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(
      maxResponses,
    );
    expect(
      result.transcript.filter(
        (message: any) =>
          message.role === "user" &&
          message.content === "Keep trying, you can do it.",
      ),
    ).toHaveLength(maxResponses - 1);
    expect(requests.at(-1)!.maxTokens).toBeGreaterThan(1);
  },
);

test("provider retries do not consume the response limit", async () => {
  const failure = {
    ...assistant([], "error"),
    errorMessage: "upstream_error: Codex upstream request failed",
  };
  const { result, requests, records } = await gatedRun(
    [
      failure,
      gateReply(1, 1000, false),
      { ...failure },
      gateReply(2, 2000, false),
    ],
    true,
    1,
    gatedTool,
    undefined,
    { ...submissionGate, maxResponses: 2 },
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(4);
  expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(2);
});

test.each([1, 2])(
  "rejected submissions count toward a response limit of %s",
  async (maxResponses) => {
    const invalid = gateReply(1, 1000, false);
    const tool = invalid.content.find((block) => block.type === "toolCall");
    if (tool?.type !== "toolCall") throw new Error("fixture");
    tool.arguments = { text: "Missing the required solution field." };
    const { result, requests, records } = await gatedRun(
      [invalid, gateReply(2, 2000, false)],
      true,
      2,
      gatedTool,
      undefined,
      { ...submissionGate, maxResponses },
    );
    expect(result.state).toBe(maxResponses === 1 ? "failed" : "succeeded");
    expect(requests).toHaveLength(maxResponses);
    expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(
      maxResponses - 1,
    );
  },
);

test.each(["stop", "length"] as const)(
  "plain %s responses cannot bypass the response limit",
  async (stop) => {
    const { result, requests } = await gatedRun(
      [gateReply(1, 1000, false, stop), gateReply(2, 1000, false, stop)],
      true,
      2,
      gatedTool,
      undefined,
      { ...submissionGate, maxResponses: 2 },
    );
    expect(requests).toHaveLength(2);
    expect(result.state).toBe("failed");
  },
);

test("a large response limit retains the context handoff", async () => {
  const { result, requests } = await gatedRun(
    [gateReply(1, 1000, false), gateReply(2, 4000, false)],
    true,
    2,
    gatedTool,
    undefined,
    { ...submissionGate, maxResponses: 1_000_000_000_000_000 },
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(2);
});

test.each([false, true])(
  "an empty submission hands off only when configured: %s",
  async (stopOnEmpty) => {
    const saved: string[] = [];
    const tool = defineTool({
      name: gatedTool.name,
      description: "Save new work while continuing the original task",
      input: z.strictObject({
        solution: z.boolean(),
        notes: z.array(z.string()),
      }),
      replay: "safe",
      async run({ notes }) {
        const noteIds = notes.map((_, index) => `n${saved.length + index + 1}`);
        saved.push(...notes);
        return { noteIds };
      },
    });
    const replies = [
      gateReply(1, 1000, false),
      gateReply(2, 1500, false),
      gateReply(3, 2000, true),
    ];
    for (const [index, reply] of replies.entries()) {
      const call = reply.content.find((block) => block.type === "toolCall");
      if (call?.type !== "toolCall")
        throw new Error("missing fixture tool call");
      call.arguments = {
        solution: index === 2,
        notes: index === 1 ? [] : [`Result ${index + 1}`],
      };
    }
    const gate = {
      ...submissionGate,
      ...(stopOnEmpty ? { emptyArgument: "notes" } : {}),
      continuationPrompt:
        "Begin another substantial research attempt using the saved work.",
    };
    const { result, requests, records } = await gatedRun(
      replies,
      true,
      2,
      tool,
      undefined,
      gate,
    );
    expect(result.state).toBe("succeeded");
    expect(requests).toHaveLength(stopOnEmpty ? 2 : 3);
    expect(saved).toEqual(
      stopOnEmpty ? ["Result 1"] : ["Result 1", "Result 3"],
    );
    const continued = requests[1]!.context.messages;
    expect(JSON.stringify(continued)).toContain("retained-1");
    expect(JSON.stringify(continued)).toContain("Result 1");
    const feedback = continued.findLast(
      (message) => message.role === "toolResult",
    );
    expect(feedback).toMatchObject({ isError: false });
    expect(JSON.stringify(feedback)).toContain("n1");
    expect(JSON.stringify(feedback)).not.toContain(gate.continuationPrompt);
    expect(continued.slice(-2)).toMatchObject([
      { role: "toolResult", isError: false },
      { role: "user", content: gate.continuationPrompt },
    ]);
    if (!stopOnEmpty)
      expect(requests[2]!.context.messages.slice(-2)).toMatchObject([
        {
          role: "toolResult",
          content: [{ type: "text", text: '{"noteIds":[]}' }],
        },
        { role: "user", content: gate.continuationPrompt },
      ]);
    expect(
      records.find(
        (entry) => entry.kind === "call" && entry.label === "submission-gate",
      ),
    ).toMatchObject({ request: { submissionGate: gate } });
    expect(
      records.filter((entry) => entry.kind === "tool-result"),
    ).toMatchObject([
      { output: { noteIds: ["n1"] } },
      { output: { noteIds: [] } },
      ...(stopOnEmpty ? [] : [{ output: { noteIds: ["n2"] } }]),
    ]);
  },
);

test("the first submission may hand off empty without a solution claim", async () => {
  const tool = defineTool({
    name: gatedTool.name,
    description: "Save notes or hand off",
    input: z.strictObject({
      solution: z.boolean(),
      notes: z.array(z.string()),
    }),
    replay: "safe",
    async run() {
      return { noteIds: [] };
    },
  });
  const reply = gateReply(1, 1000, false);
  const call = reply.content.find((block) => block.type === "toolCall");
  if (call?.type !== "toolCall") throw new Error("missing fixture tool call");
  call.arguments = { solution: false, notes: [] };
  const { result, requests, records } = await gatedRun(
    [reply],
    true,
    2,
    tool,
    undefined,
    { ...submissionGate, emptyArgument: "notes" },
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(1);
  expect(records.filter((entry) => entry.kind === "tool-call")).toMatchObject([
    { input: { solution: false, notes: [] } },
  ]);
});

test("empty submissions receive user continuation until the context threshold", async () => {
  const tool = defineTool({
    name: gatedTool.name,
    description: "Save partial notes",
    input: z.strictObject({
      solution: z.boolean(),
      notes: z.array(z.string()),
    }),
    replay: "safe",
    async run() {
      return { noteIds: [] };
    },
  });
  const replies = [gateReply(1, 1000, false), gateReply(2, 4000, false)];
  for (const reply of replies) {
    const call = reply.content.find((block) => block.type === "toolCall");
    if (call?.type !== "toolCall") throw new Error("missing fixture tool call");
    call.arguments = { solution: false, notes: [] };
  }
  const prompt = "Keep trying, you can do it.";
  const { result, requests, records } = await gatedRun(
    replies,
    true,
    2,
    tool,
    undefined,
    { ...submissionGate, continuationPrompt: prompt },
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(2);
  expect(requests[1]!.context.messages.slice(-2)).toMatchObject([
    { role: "toolResult", content: [{ type: "text", text: '{"noteIds":[]}' }] },
    { role: "user", content: prompt },
  ]);
  expect(records.filter((entry) => entry.kind === "tool-call")).toMatchObject([
    { input: { solution: false, notes: [] } },
    { input: { solution: false, notes: [] } },
  ]);
});

test("the application continuation prompt reaches native steering but yields to finalization", async () => {
  const gate = {
    ...submissionGate,
    continuationPrompt: "Investigate another route.",
  };
  const { result, requests } = await gatedRun(
    [
      gateReply(1, 1000, false, "length"),
      gateReply(2, 4000, false, "stop"),
      gateReply(3, 4000, false),
    ],
    true,
    2,
    gatedTool,
    undefined,
    gate,
  );
  expect(result.state).toBe("succeeded");
  expect(JSON.stringify(requests[1]!.context.messages.at(-1))).toContain(
    gate.continuationPrompt,
  );
  const finalization = JSON.stringify(requests[2]!.context.messages.at(-1));
  expect(finalization).toContain("Finalize now.");
  expect(finalization).not.toContain(gate.continuationPrompt);
});

test.each([
  [378_000, "toolUse", 1_520, 16_384, 379_520],
  [379_600, "stop", 16_304, 16_384, 379_700],
  [266_000, "toolUse", 1_904, undefined, 267_904],
  [268_000, "stop", 127_904, undefined, 268_100],
] as const)(
  "a 400k context budget preserves finalization space after %i tokens and %s",
  async (tokens, stop, nextMaxTokens, reserveTokens, settledTokens) => {
    const requests: (number | undefined)[] = [];
    const replies = [
      gateReply(1, tokens, false, stop),
      gateReply(2, settledTokens, false),
    ];
    const c = campaign();
    const largeModel = {
      ...model,
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    };
    try {
      const result = await runPi(c, {
        models: models(replies, (_context, options) => {
          replies[requests.length]!.timestamp = Date.now();
          requests.push(options?.maxTokens);
        }),
        model: largeModel,
        label: "budgeted-explorer",
        prompt: "Do useful work, then submit partial notes.",
        tools: [gatedTool],
        stopAfterToolResult: true,
        submissionGate: {
          completeArgument: "solution",
          ...(reserveTokens === undefined ? {} : { reserveTokens }),
          contextBudgetTokens: 400_000,
        },
      });
      expect(result.state).toBe("succeeded");
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(128_000);
      // Native estimation also charges the intervening tool/steering feedback.
      expect(requests[1]).toBeGreaterThan(nextMaxTokens - 256);
      expect(requests[1]).toBeLessThanOrEqual(nextMaxTokens);
      const records = c.records();
      expect(
        records.filter((entry) => entry.kind === "tool-call"),
      ).toHaveLength(stop === "toolUse" ? 2 : 1);
      expect(
        records.find(
          (entry) =>
            entry.kind === "call" && entry.label === "budgeted-explorer",
        ),
      ).toMatchObject({
        request: {
          modelProfile: { contextWindow: 1_050_000 },
          submissionGate: { contextBudgetTokens: 400_000 },
        },
      });
    } finally {
      c.close();
    }
  },
);

test("a submission budget above model capacity still respects the model window", async () => {
  const c = campaign();
  let requests = 0;
  const reply = gateReply(1, 4_000, false);
  try {
    const result = await runPi(c, {
      models: models([reply], () => {
        reply.timestamp = Date.now();
        requests += 1;
      }),
      model,
      label: "small-model-budget",
      prompt: "Work.",
      tools: [gatedTool],
      stopAfterToolResult: true,
      submissionGate: { ...submissionGate, contextBudgetTokens: 400_000 },
    });
    expect(result.state).toBe("succeeded");
    expect(requests).toBe(1);
  } finally {
    c.close();
  }
});

test.each(["toolUse", "stop"] as const)(
  "a claimed solution terminates on native %s without another request",
  async (stopReason) => {
    const reply = gateReply(1, 1000, true);
    reply.stopReason = stopReason;
    const { result, requests, records } = await gatedRun([reply]);
    expect(result.state).toBe("succeeded");
    expect(requests).toHaveLength(1);
    expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(
      1,
    );
  },
);

test.each(["valid", "invalid", "unknown"])(
  "a gated batch with a %s second call executes no submissions",
  async (secondKind) => {
    const first = gateReply(1, 1000, true);
    first.content.push({
      type: "toolCall",
      id: "second",
      name: secondKind === "unknown" ? "missing_tool" : gatedTool.name,
      arguments:
        secondKind === "invalid" ? {} : { solution: true, text: "second" },
    });
    const { result, requests, records } = await gatedRun([first]);
    expect(result.state).toBe("failed");
    expect(requests).toHaveLength(1);
    expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(
      0,
    );
  },
);

test("Pi continues a length-truncated tool batch without executing its submissions", async () => {
  const first = gateReply(1, 1000, false);
  first.stopReason = "length";
  first.content.push(gateReply(2, 1000, true).content[1]!);
  const { result, requests, records } = await gatedRun([
    first,
    gateReply(3, 2000, true),
  ]);
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(2);
  expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(1);
});

test("a gated schema rejection stays in context for correction before committing", async () => {
  const refined = {
    ...gatedTool,
    input: z
      .strictObject({ solution: z.boolean(), text: z.string() })
      .refine((value) => value.text !== "Result 1", {
        message: "submission fails the application schema",
      }),
  };
  const { result, requests, records } = await gatedRun(
    [gateReply(1, 1000, true), gateReply(2, 2000, true)],
    true,
    2,
    refined,
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1]!.context.messages)).toContain(
    "submission fails the application schema",
  );
  expect(records.filter((entry) => entry.kind === "tool-call")).toMatchObject([
    { input: { solution: true, text: "Result 2" } },
  ]);
});

test("a recorded gated tool execution error ends the call without another submission attempt", async () => {
  const failing = {
    ...gatedTool,
    async run() {
      throw new Error("submission failed");
    },
  };
  const { result, requests, records } = await gatedRun(
    [gateReply(1, 1000, true), gateReply(2, 2000, true)],
    true,
    2,
    failing,
  );
  expect(result.state).toBe("failed");
  expect(requests).toHaveLength(1);
  expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(1);
  expect(records.filter((entry) => entry.kind === "tool-result")).toMatchObject(
    [{ state: "threw" }],
  );
});

test("without the gate, ordinary early partial submission still finishes immediately", async () => {
  const { result, requests } = await gatedRun(
    [gateReply(1, 1000, false)],
    false,
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(1);
  expect(requests[0]!.maxTokens).toBeUndefined();
});

test.each([
  [1000, true],
  [4000, false],
] as const)(
  "plain text at %i tokens continues with the correct finalization rule",
  async (tokens, solution) => {
    const { result, requests } = await gatedRun([
      gateReply(1, tokens, false, "stop"),
      gateReply(2, tokens + 1000, solution),
    ]);
    expect(result.state).toBe("succeeded");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.context.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "Intermediate reasoning 1" }],
      }),
    );
    expect(requests[1]!.context.messages.at(-1)).toMatchObject({
      role: "user",
    });
    if (!solution)
      expect(JSON.stringify(requests[1]!.context.messages.at(-1))).toContain(
        "otherwise false",
      );
  },
);

test("gated exploration can exceed the ordinary 32 inner turns", async () => {
  const replies = Array.from({ length: 34 }, (_, index) =>
    gateReply(index, (index + 1) * 100, index === 33),
  );
  const { result, requests, records } = await gatedRun(replies);
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(34);
  expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(
    34,
  );
});

test("gated length continuation uses context instead of the ordinary eight-continuation cap", async () => {
  const replies = [
    ...Array.from({ length: 9 }, (_, index) =>
      gateReply(index, (index + 1) * 300, false, "length"),
    ),
    gateReply(10, 3000, true),
  ];
  const { result, requests } = await gatedRun(replies);
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(10);
  expect(
    requests
      .at(-1)!
      .context.messages.filter((message) => message.role === "assistant"),
  ).toHaveLength(9);
});

test("exhausted headroom without a submission fails rather than handing off plain text", async () => {
  const { result, requests, records } = await gatedRun([
    gateReply(1, 5904, false, "stop"),
  ]);
  expect(result).toMatchObject({
    state: "failed",
    error: "Pi ended without a terminal submission",
  });
  expect(requests).toHaveLength(1);
  expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(0);
});

test.each(["stop", "length"] as const)(
  "cancelled %s completion does not schedule another request",
  async (reason) => {
    const { result, requests } = await gatedRun(
      [gateReply(1, 1000, false, reason), assistant([], "aborted")],
      true,
      2,
      gatedTool,
      new AbortController(),
    );
    expect(result.state).toBe("cancelled");
    expect(requests).toHaveLength(1);
  },
);

test("successful partial submissions reset the consecutive provider-error budget", async () => {
  const failure = {
    ...assistant([], "error"),
    errorMessage: "upstream_error: Codex upstream request failed",
  };
  const { result, requests } = await gatedRun(
    [
      failure,
      gateReply(1, 1000, false),
      { ...failure },
      gateReply(2, 2000, true),
    ],
    true,
    1,
  );
  expect(result.state).toBe("succeeded");
  expect(requests).toHaveLength(4);
});

test("a length-truncated response does not reset the consecutive error budget", async () => {
  const failure = {
    ...assistant([], "error"),
    errorMessage: "upstream_error: Codex upstream request failed",
  };
  const { result, requests } = await gatedRun(
    [
      failure,
      gateReply(1, 1000, false, "length"),
      { ...failure },
      gateReply(2, 2000, true),
    ],
    true,
    1,
  );
  expect(result.state).toBe("failed");
  expect(requests).toHaveLength(3);
});

test("the submission gate preserves the consecutive transient-error recovery budget", async () => {
  const replies = Array.from({ length: 3 }, () => ({
    ...assistant([], "error"),
    rawStopReason: "incomplete.max_messages",
    errorMessage: "retryable provider failure",
  }));
  const prompt = "Keep trying, you can do it.";
  const { result, requests, records } = await gatedRun(
    replies,
    true,
    2,
    gatedTool,
    undefined,
    { ...submissionGate, continuationPrompt: prompt },
  );
  expect(result.state).toBe("failed");
  expect(requests).toHaveLength(3);
  for (const request of requests.slice(1))
    expect(request.context.messages.at(-1)).toMatchObject({
      role: "user",
      content: prompt,
    });
  expect(records.filter((entry) => entry.kind === "tool-call")).toHaveLength(0);
});

test("a submission gate requires one tool before creating a call", async () => {
  const c = campaign();
  try {
    for (const options of [
      {},
      { tools: [] },
      { tools: [gatedTool, submitVerdict] },
      {
        tools: [gatedTool],
        submissionGate: { ...submissionGate, completeArgument: " \n" },
      },
    ]) {
      await expect(
        runPi(c, {
          models: models([]),
          model,
          label: "bad-gate",
          prompt: "test",
          submissionGate,
          ...options,
        }),
      ).rejects.toThrow();
    }
    await expect(
      runPi(c, {
        models: models([]),
        model,
        label: "bad-reserve",
        prompt: "test",
        tools: [gatedTool],
        submissionGate: {
          ...submissionGate,
          reserveTokens: model.contextWindow,
        },
      }),
    ).rejects.toThrow("leave no usable context");
    expect(c.records()).toHaveLength(1);
  } finally {
    c.close();
  }
});

function payloadModels(
  replies: readonly AssistantMessage[],
  payloads: readonly unknown[],
  sent: unknown[],
): PiModels {
  let index = 0;
  return {
    streamSimple(requestModel, _context, options) {
      const turn = index++;
      const reply = replies[turn];
      if (reply === undefined) throw new Error("no scripted Pi reply");
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const payload = payloads[turn];
        const replacement = await options?.onPayload?.(payload, requestModel);
        sent.push(replacement === undefined ? payload : replacement);
        stream.push({
          type: "done",
          reason: reply.stopReason as "stop" | "toolUse",
          message: reply,
        });
      })();
      return stream;
    },
  } as PiModels;
}

function invalidPayloadModels(calls: number): PiModels {
  return {
    streamSimple(requestModel, _context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        try {
          for (let index = 0; index < calls; index++) {
            await options?.onPayload?.({ index }, requestModel);
          }
          const reply = assistant([{ type: "text", text: "done" }], "stop");
          stream.push({ type: "done", reason: "stop", message: reply });
        } catch (error) {
          const reply = {
            ...assistant([], "error", undefined, false),
            errorMessage:
              error instanceof Error ? error.message : String(error),
          };
          stream.push({ type: "error", reason: "error", error: reply });
        }
      })();
      return stream;
    },
  } as PiModels;
}

describe("thin Pi runner", () => {
  test("hoists a leading developer system message into instructions", async () => {
    const store = campaign();
    const sent: unknown[] = [];
    await runPi(store, {
      models: payloadModels(
        [assistant([{ type: "text", text: "ok" }], "stop")],
        [
          {
            model: model.id,
            stream: true,
            input: [
              { role: "developer", content: "System role text." },
              {
                role: "user",
                content: [{ type: "input_text", text: "Hi" }],
              },
            ],
            reasoning: { effort: "max" },
          },
        ],
        sent,
      ),
      model,
      label: "hoist/v1",
      system: "System role text.",
      prompt: "Hi",
      reasoning: "max",
    });
    expect(sent[0]).toEqual({
      model: model.id,
      stream: true,
      instructions: "System role text.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Hi" }] }],
      reasoning: { effort: "max" },
    });
  });

  test("leaves a populated instructions field untouched", async () => {
    const store = campaign();
    const sent: unknown[] = [];
    await runPi(store, {
      models: payloadModels(
        [assistant([{ type: "text", text: "ok" }], "stop")],
        [
          {
            instructions: "Already set.",
            input: [{ role: "developer", content: "kept in place" }],
          },
        ],
        sent,
      ),
      model,
      label: "hoist-skip/v1",
      system: "Already set.",
      prompt: "Hi",
      reasoning: "max",
    });
    expect(sent[0]).toEqual({
      instructions: "Already set.",
      input: [{ role: "developer", content: "kept in place" }],
    });
  });

  test("does not hoist for a non-responses adapter", async () => {
    const store = campaign();
    const sent: unknown[] = [];
    const codexModel: Model<"openai-codex-responses"> = {
      ...model,
      api: "openai-codex-responses",
    };
    await runPi(store, {
      models: payloadModels(
        [assistant([{ type: "text", text: "ok" }], "stop")],
        [{ input: [{ role: "developer", content: "kept in place" }] }],
        sent,
      ),
      model: codexModel,
      label: "hoist-codex/v1",
      system: "kept in place",
      prompt: "Hi",
      reasoning: "max",
    });
    expect(sent[0]).toEqual({
      input: [{ role: "developer", content: "kept in place" }],
    });
  });

  test("treats complete zero usage as measured and rejects partial usage", () => {
    const attributes = {
      "pi.ai.provider": "fake",
      "pi.ai.model": "test-v1",
      "pi.ai.api": "openai-responses",
      "pi.ai.response.stop_reason": "error",
      "pi.ai.usage.input_tokens": 0,
      "pi.ai.usage.output_tokens": 0,
      "pi.ai.usage.cache_read_tokens": 0,
      "pi.ai.usage.cache_write_tokens": 0,
      "pi.ai.usage.total_tokens": 0,
      "pi.ai.usage.cost": 0,
    };
    expect(derivePiSpend(spendEntries(attributes, true)).summary).toEqual({
      logicalProviderRequests: 1,
      requestErrors: 1,
      unmeasuredRequests: 0,
      measuredUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
    });
    const { "pi.ai.usage.cost": _cost, ...partial } = attributes;
    expect(() => derivePiSpend(spendEntries(partial))).toThrow(
      "partial Pi usage measurement",
    );
    expect(() =>
      derivePiSpend(
        spendEntries({
          "pi.ai.provider": "fake",
          "pi.ai.model": "test-v1",
          "pi.ai.api": "openai-responses",
          "pi.ai.usage.reasoning_tokens": 1,
        }),
      ),
    ).toThrow("partial Pi usage measurement");
  });

  test("does not mistake an ordinary model-shaped request for a Pi call", () => {
    const entries = spendEntries({
      "pi.ai.provider": "fake",
      "pi.ai.model": "test-v1",
      "pi.ai.api": "openai-responses",
    }).map((entry) =>
      entry.kind === "call"
        ? {
            ...entry,
            request: {
              model: {
                provider: "fake",
                id: "test-v1",
                api: "openai-responses",
              },
              prompt: "ordinary application request",
            },
          }
        : entry,
    );

    expect(derivePiSpend(entries)).toEqual({
      calls: [],
      unaccountedCalls: [],
      potentialRequests: [],
      summary: {
        logicalProviderRequests: 0,
        requestErrors: 0,
        unmeasuredRequests: 0,
      },
    });
  });

  test("runs a fresh Pi loop and stores its native transcript", async () => {
    const store = campaign();
    const requests: (SimpleStreamOptions | undefined)[] = [];
    const candidate = store.submitCandidate(
      new TextEncoder().encode("answer"),
      ["answer/v1"],
    );
    const result = await runPi(store, {
      models: models(
        [assistant([{ type: "text", text: "answer" }], "stop", 3)],
        (_context, options) => requests.push(options),
      ),
      model,
      label: "answer/v1",
      candidate,
      system: "Answer exactly.",
      prompt: "Question",
      reasoning: "max",
    });

    expect(result).toMatchObject({ state: "succeeded", text: "answer" });
    expect(requests.map((options) => options?.reasoning)).toEqual(["max"]);
    const [runSpan, requestSpan] = result.telemetry.spans;
    expect(runSpan).toMatchObject({
      name: "xean.pi.run",
      parentId: null,
      settled: true,
      status: { status: "ok" },
      attributes: {
        "xean.call.label": "answer/v1",
        "xean.candidate": candidate,
        "xean.pi.reasoning.requested": "max",
        "xean.pi.outcome": "succeeded",
      },
    });
    expect(requestSpan).toMatchObject({
      name: "pi.ai.request",
      parentId: runSpan?.id,
      settled: true,
      status: { status: "ok" },
      attributes: {
        "pi.ai.operation": "stream",
        "pi.ai.provider": model.provider,
        "pi.ai.model": model.id,
        "pi.ai.response.model": "served-test-v1",
        "pi.ai.response.stop_reason": "stop",
        "pi.ai.usage.input_tokens": 11,
        "pi.ai.usage.output_tokens": 7,
        "pi.ai.usage.cache_read_tokens": 5,
        "pi.ai.usage.reasoning_tokens": 3,
        "pi.ai.usage.total_tokens": 23,
        "pi.ai.usage.cost": 0.026,
      },
    });
    const records = store.records();
    expect(records.map((entry) => entry.kind)).toEqual([
      "campaign",
      "candidate",
      "call",
      "call",
      "call-result",
      "call-result",
    ]);
    const call = records.find((entry) => entry.kind === "call");
    expect(call).toMatchObject({
      seq: result.call,
      candidate,
      request: { reasoning: "max" },
    });
    if (call?.kind !== "call") throw new Error("missing Pi call");
    expect(piRequest.parse(call.request)).toMatchObject({ reasoning: "max" });
    const terminal = records.at(-1);
    expect(terminal?.kind).toBe("call-result");
    if (terminal?.kind !== "call-result" || terminal.state !== "returned") {
      throw new Error("missing Pi result");
    }
    expect(terminal.output).toMatchObject({
      state: "succeeded",
      call: result.call,
      telemetry: result.telemetry,
    });
    expect(readPiResult(terminal.output, store)).toEqual(result);
    expect(piResultRecord.parse(terminal.output)).not.toHaveProperty(
      "transcript",
    );
    expect(piResultRecord.parse(terminal.output)).not.toHaveProperty("text");
    expect(readPiResult(terminal.output, store)).toMatchObject({
      state: "succeeded",
      text: "answer",
      transcript: [{ role: "user" }, { role: "assistant" }],
      telemetry: result.telemetry,
    });
    expect(
      piStoredResult.safeParse({
        state: "succeeded",
        text: "answer",
        transcript: [],
        unknown: true,
      }).success,
    ).toBe(false);
    expect(piTelemetry.safeParse(result.telemetry).success).toBe(true);
    const spend = derivePiSpend(records);
    expect(spend).toMatchObject({
      calls: [
        {
          call: result.call,
          logicalProviderRequests: 1,
          requestErrors: 0,
          unmeasuredRequests: 0,
          operations: [
            {
              provider: "fake",
              requestedModel: "test-v1",
              servedModel: "served-test-v1",
              api: "openai-responses",
              stopReason: "stop",
              error: false,
              usage: {
                input: 11,
                output: 7,
                cacheRead: 5,
                cacheWrite: 0,
                reasoning: 3,
                totalTokens: 23,
                estimatedCostUsd: 0.026,
              },
            },
          ],
        },
      ],
      unaccountedCalls: [],
      potentialRequests: [],
      summary: {
        logicalProviderRequests: 1,
        requestErrors: 0,
        unmeasuredRequests: 0,
        measuredUsage: { totalTokens: 23, reasoning: 3 },
      },
    });
    expect(
      piStoredResult.safeParse({
        state: "succeeded",
        text: "answer",
        telemetry: {},
      }).success,
    ).toBe(false);
  });

  test("gives Pi only the selected audited Zod tools", async () => {
    const store = campaign();
    const contexts: Context[] = [];
    const reasoning: (SimpleStreamOptions["reasoning"] | undefined)[] = [];
    const add = defineTool({
      name: "add",
      description: "Add integers",
      input: z.strictObject({
        left: z.number().int(),
        right: z.number().int(),
      }),
      replay: "safe",
      async run({ left, right }) {
        return { sum: left + right };
      },
    });
    const result = await runPi(store, {
      models: models(
        [
          assistant(
            [
              {
                type: "toolCall",
                id: "add-1",
                name: "add",
                arguments: { left: 2, right: 5 },
              },
            ],
            "toolUse",
          ),
          assistant([{ type: "text", text: "7" }], "stop"),
        ],
        (context, options) => {
          contexts.push(context);
          reasoning.push(options?.reasoning);
        },
      ),
      model,
      label: "math/v1",
      prompt: "Add 2 and 5",
      reasoning: "max",
      tools: [add],
    });

    expect(result).toMatchObject({ state: "succeeded", text: "7" });
    const requests = result.telemetry.spans.filter(
      ({ name }) => name === "pi.ai.request",
    );
    expect(requests).toHaveLength(2);
    expect(reasoning).toEqual(["max", "max"]);
    expect(
      requests.every(
        ({ attributes }) => !("pi.ai.usage.reasoning_tokens" in attributes),
      ),
    ).toBe(true);
    expect(
      requests.every(
        ({ parentId }) => parentId === result.telemetry.spans[0]?.id,
      ),
    ).toBe(true);
    expect(contexts[0]?.tools).toMatchObject([
      {
        name: "add",
        constrainedSampling: { type: "json_schema", strict: "prefer" },
      },
    ]);
    expect(store.records().map((entry) => entry.kind)).toEqual([
      "campaign",
      "call",
      "call",
      "call-result",
      "tool-call",
      "tool-result",
      "call",
      "call-result",
      "call-result",
    ]);
    expect(
      store.records().find((entry) => entry.kind === "tool-call"),
    ).toMatchObject({ source: "add-1", input: { left: 2, right: 5 } });
    expect(derivePiSpend(store.records()).summary).toEqual({
      logicalProviderRequests: 2,
      requestErrors: 0,
      unmeasuredRequests: 0,
      measuredUsage: {
        input: 22,
        output: 14,
        cacheRead: 10,
        cacheWrite: 0,
        totalTokens: 46,
        estimatedCostUsd: 0.052,
      },
    });
  });

  test("reconstructs every adapter-expanded request from durable checkpoints", async () => {
    const store = campaign();
    const payloads = [
      {
        instructions: "Use the adder.",
        input: [
          JSON.parse(
            '{"__proto__":{"safe":true},"role":"user","content":"Add 2 and 5"}',
          ),
        ],
        tools: [{ name: "add", strict: true }],
        reasoning: { effort: "high" },
        prompt_cache_key: undefined,
      },
      {
        instructions: "Use the adder.",
        input: [
          { role: "user", content: "Add 2 and 5" },
          { type: "function_call", call_id: "add-1" },
          { type: "function_call_output", output: '{"sum":7}' },
        ],
        tools: [{ name: "add", strict: true }],
        reasoning: { effort: "high" },
      },
    ];
    const sent: unknown[] = [];
    const add = defineTool({
      name: "add",
      description: "Add integers",
      input: z.strictObject({
        left: z.number().int(),
        right: z.number().int(),
      }),
      replay: "safe",
      async run({ left, right }) {
        return { sum: left + right };
      },
    });

    const result = await runPi(store, {
      models: payloadModels(
        [
          assistant(
            [
              {
                type: "toolCall",
                id: "add-1",
                name: "add",
                arguments: { left: 2, right: 5 },
              },
            ],
            "toolUse",
          ),
          assistant([{ type: "text", text: "7" }], "stop"),
        ],
        payloads,
        sent,
      ),
      model,
      label: "checkpoint/v1",
      system: "Use the adder.",
      prompt: "Add 2 and 5",
      reasoning: "max",
      tools: [add],
    });

    expect(sent).toEqual(payloads);
    expect(
      piRequestAttempts(store.records(), result.call).every(
        (attempt) =>
          attempt.protocol === "xean/pi-request/v1" &&
          attempt.payload === undefined,
      ),
    ).toBe(true);
    const attempts = piRequestAttempts(store.records(), result.call, store);
    expect(attempts.map(({ payload }) => JSON.stringify(payload))).toEqual(
      payloads.map((payload) => JSON.stringify(payload)),
    );
    expect(attempts.map(({ call }) => call)).toEqual([3, 7]);
    expect(attempts.map(({ model }) => model.baseUrl)).toEqual([
      "https://invalid.test",
      "https://invalid.test",
    ]);
    expect(attempts.map(({ state }) => state)).toEqual([
      "completed",
      "completed",
    ]);
    expect(store.records().map(({ kind }) => kind)).toEqual([
      "campaign",
      "call",
      "call",
      "call-result",
      "tool-call",
      "tool-result",
      "call",
      "call-result",
      "call-result",
    ]);
  });

  test("keeps a pre-dispatch payload after a hard provider crash", () => {
    const directory = mkdtempSync(join(tmpdir(), "xean-pi-crash-"));
    directories.push(directory);
    const path = join(directory, "campaign.db");
    const fixture = resolve("tests/fixtures/crash-pi-request.ts");
    const child = Bun.spawnSync([process.execPath, fixture, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const reader = openReader(path);
    const records = reader.records();
    expect(records.map(({ kind }) => kind)).toEqual([
      "campaign",
      "call",
      "call",
    ]);
    expect(piRequestAttempts(records, undefined, reader)).toMatchObject([
      {
        parent: 2,
        call: 3,
        payload: { input: "durable request" },
        state: "unsettled",
      },
    ]);
    expect(derivePiSpend(records)).toMatchObject({
      calls: [],
      unaccountedCalls: [2],
      potentialRequests: [
        {
          call: 2,
          checkpoint: 3,
          model: {
            provider: "fake",
            id: "crash-test",
            api: "openai-responses",
          },
        },
      ],
      summary: {
        logicalProviderRequests: 0,
        requestErrors: 0,
        unmeasuredRequests: 0,
      },
    });
    reader.close();
  });

  test("rejects adapters that omit or repeat the pre-send hook", async () => {
    for (const calls of [0, 2]) {
      const store = campaign();
      await expect(
        runPi(store, {
          models: invalidPayloadModels(calls),
          model,
          label: `invalid-hook/${calls}`,
          prompt: "Test adapter contract",
        }),
      ).rejects.toThrow("exactly once");
      expect(piRequestAttempts(store.records())).toHaveLength(
        calls === 0 ? 0 : 1,
      );
    }
  });

  test("keeps completed request usage after a later continuation crashes", () => {
    const directory = mkdtempSync(join(tmpdir(), "xean-pi-usage-crash-"));
    directories.push(directory);
    const path = join(directory, "campaign.db");
    const child = Bun.spawnSync(
      [
        process.execPath,
        resolve("tests/fixtures/crash-pi-request.ts"),
        path,
        "after-first",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode).toBe(0);
    const reader = openReader(path);
    try {
      const spend = derivePiSpend(reader.records());
      expect(spend.summary).toMatchObject({
        logicalProviderRequests: 1,
        unmeasuredRequests: 0,
        measuredUsage: { input: 10, output: 5, totalTokens: 15 },
      });
      expect(spend.unaccountedCalls).toHaveLength(1);
      expect(spend.potentialRequests).toHaveLength(1);
      expect(
        piRequestAttempts(reader.records()).map(({ state }) => state),
      ).toEqual(["completed", "unsettled"]);
      expect(inspectCoreCampaignSummary(path).spend).toMatchObject({
        logicalProviderRequests: 1,
        unaccountedCalls: 1,
      });
      expect(inspectCoreCampaign(path).calls[0]?.pi?.accounting).toMatchObject({
        state: "available",
        complete: false,
      });
    } finally {
      reader.close();
    }
  });

  test("allows an adapter to fail before it constructs a payload", async () => {
    const store = campaign();
    const preflightFailure: PiModels = {
      streamSimple() {
        const stream = createAssistantMessageEventStream();
        const failure = {
          ...assistant([], "error", undefined, false),
          errorMessage: "missing credentials",
        };
        stream.push({ type: "error", reason: "error", error: failure });
        return stream;
      },
    };
    const result = await runPi(store, {
      models: preflightFailure,
      model,
      label: "preflight-failure/v1",
      prompt: "Test adapter preflight",
    });

    expect(result).toMatchObject({
      state: "failed",
      error: "missing credentials",
    });
    expect(piRequestAttempts(store.records())).toEqual([]);
  });

  test("projects completed and unsettled request attempts", async () => {
    const store = campaign();
    await store.call(
      { label: "xean/pi-request", request: null },
      async () => null,
    );
    let release!: () => void;
    let observed: ReturnType<typeof piRequestAttempts> = [];
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    await store.call(
      {
        label: "owner",
        request: {
          protocol: "xean/pi-run/v1",
          model: { provider: model.provider, id: model.id, api: model.api },
          modelProfile: null,
          prompt: "test",
        },
      },
      async ({ call }) => {
        const request = {
          protocol: "xean/pi-request/v1" as const,
          parent: call,
          model: { provider: model.provider, id: model.id, api: model.api },
          payloadRef: store.storePayload({ input: "test" }),
        };
        const internalRequest = {
          label: "xean/pi-request",
          request,
        };
        const completion = {
          protocol: "xean/pi-request-completion/v1",
          parent: call,
          operation: {
            provider: model.provider,
            requestedModel: model.id,
            api: model.api,
            error: false,
            usage: null,
          },
        };
        await store.call(internalRequest, async () => completion);
        const pending = store.call(internalRequest, async () => {
          await blocked;
          return completion;
        });
        await Promise.resolve();
        observed = piRequestAttempts(store.records(), call);
        release();
        await pending;
        return null;
      },
    );

    expect(observed.map(({ state }) => state)).toEqual([
      "completed",
      "unsettled",
    ]);
  });

  test("checkpoints the real Pi OpenAI adapter before a stub transport", async () => {
    const store = campaign();
    let fetches = 0;
    const stubFetch: typeof fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        fetches += 1;
        throw new Error("stub transport stopped here");
      },
      { preconnect: fetch.preconnect },
    );
    const adapter: PiModels = {
      streamSimple(_requestModel, context, options) {
        return streamSimpleOpenAIResponses(model, context, {
          ...options,
          apiKey: "stub-key",
          maxRetries: 0,
          fetch: stubFetch,
        });
      },
    };
    const result = await runPi(store, {
      models: adapter,
      model,
      label: "real-adapter/v1",
      system: "Answer briefly.",
      prompt: "Test",
      reasoning: "max",
      cacheKey: "stable-test-cache",
    });

    expect(result.state).toBe("failed");
    expect(fetches).toBe(1);
    expect(
      piRequestAttempts(store.records(), result.call, store),
    ).toMatchObject([
      {
        parent: result.call,
        model: {
          provider: model.provider,
          id: model.id,
          api: model.api,
        },
        payload: {
          model: model.id,
          stream: true,
          instructions: "Answer briefly.",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "Test" }],
            },
          ],
          reasoning: { effort: "max" },
          prompt_cache_key: "stable-test-cache",
        },
        state: "completed",
      },
    ]);
  });

  test("keeps concurrent Pi request checkpoints under their own calls", async () => {
    const store = campaign();
    const results = await Promise.all(
      ["first", "second"].map((name) =>
        runPi(store, {
          models: models([assistant([{ type: "text", text: name }], "stop")]),
          model,
          label: `concurrent/${name}`,
          prompt: name,
        }),
      ),
    );
    const first = results[0]!;
    const second = results[1]!;

    expect(first.text).toBe("first");
    expect(second.text).toBe("second");
    expect(piRequestAttempts(store.records(), first.call)).toHaveLength(1);
    expect(piRequestAttempts(store.records(), second.call)).toHaveLength(1);
  });

  test("can stop after a successful structured tool result", async () => {
    const store = campaign();
    const submit = defineTool({
      name: "submit",
      description: "Submit one answer",
      input: z.strictObject({ answer: z.number().int() }),
      replay: "safe",
      async run(input) {
        return input;
      },
    });
    let requests = 0;
    const result = await runPi(store, {
      models: models(
        [
          assistant(
            [
              {
                type: "toolCall",
                id: "submit-1",
                name: "submit",
                arguments: { answer: 7 },
              },
            ],
            "toolUse",
          ),
        ],
        () => {
          requests += 1;
        },
      ),
      model,
      label: "structured/v1",
      prompt: "Submit 7",
      tools: [submit],
      stopAfterToolResult: true,
    });

    expect(result).toMatchObject({ state: "succeeded", text: "" });
    expect(requests).toBe(1);
    expect(result.transcript).toMatchObject([
      { role: "user" },
      { role: "assistant" },
      { role: "toolResult" },
    ]);
    expect(
      store.records().find((entry) => entry.kind === "call"),
    ).toMatchObject({ request: { stopAfterToolResult: true } });
  });

  test("does not accept a terminal tool result after cancellation", async () => {
    const controller = new AbortController();
    const submit = defineTool({
      name: "submit",
      description: "Submit one answer",
      input: z.strictObject({ answer: z.number().int() }),
      replay: "safe",
      async run(input) {
        controller.abort();
        return input;
      },
    });
    const result = await runPi(campaign(), {
      models: models([
        assistant(
          [
            {
              type: "toolCall",
              id: "submit-1",
              name: "submit",
              arguments: { answer: 7 },
            },
          ],
          "toolUse",
        ),
      ]),
      model,
      label: "structured/v1",
      prompt: "Submit 7",
      tools: [submit],
      stopAfterToolResult: true,
      signal: controller.signal,
    });

    expect(result).toMatchObject({ state: "cancelled" });
  });

  test("does not accept incomplete Pi completions as successful", async () => {
    for (const stopReason of ["length", "deferred", "toolUse"] as const) {
      const store = campaign();
      const result = await runPi(store, {
        models: models([
          assistant([{ type: "text", text: "PASS" }], stopReason),
        ]),
        model,
        label: "audit/v1",
        prompt: "Audit",
      });
      expect(result).toMatchObject({
        state: "failed",
        error: `Pi stopped with ${stopReason}`,
      });
    }
  });

  test("continues a length-stopped response within one logical call", async () => {
    const store = campaign();
    const observed: Context[] = [];
    const result = await runPi(store, {
      models: models(
        [
          assistant([{ type: "text", text: "The proof begins" }], "length"),
          assistant([{ type: "text", text: " and concludes." }], "stop"),
        ],
        (context) => observed.push(context),
      ),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxLengthContinuations: 2,
    });
    expect(result).toMatchObject({
      state: "succeeded",
      text: "The proof begins and concludes.",
    });
    const roles = (
      result.transcript as readonly { role?: string; content?: unknown }[]
    ).map(({ role }) => role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant"]);
    const continuation = (
      result.transcript as readonly { role?: string; content?: unknown }[]
    )[2];
    expect(String(continuation?.content)).toContain("interrupted");
    expect(observed[1]?.messages.map(({ role }) => role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  test("separates length continuations from provider error recoveries", async () => {
    const store = campaign();
    const result = await runPi(store, {
      models: models([
        assistant([{ type: "text", text: "part one" }], "length"),
        {
          ...assistant([], "error", undefined, false),
          errorMessage: "WebSocket closed 1006 Connection ended",
        },
        assistant([{ type: "text", text: " and part two" }], "stop"),
      ]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 1,
      maxLengthContinuations: 8,
    });
    expect(result).toMatchObject({
      state: "succeeded",
      text: "part one and part two",
    });
    expect(derivePiSpend(store.records()).summary.logicalProviderRequests).toBe(
      3,
    );
  });

  test("a provider recovery allowance does not enable length continuations", async () => {
    let requests = 0;
    const result = await runPi(campaign(), {
      models: models(
        [
          assistant([{ type: "text", text: "partial" }], "length"),
          assistant([{ type: "text", text: "must not run" }], "stop"),
        ],
        () => {
          requests += 1;
        },
      ),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 2,
    });
    expect(requests).toBe(1);
    expect(result).toMatchObject({
      state: "failed",
      truncated: true,
      error: "Pi stopped with length",
    });
  });

  test("permits several length continuations under their own budget", async () => {
    const store = campaign();
    const result = await runPi(store, {
      models: models([
        assistant([{ type: "text", text: "one" }], "length"),
        assistant([{ type: "text", text: " two" }], "length"),
        assistant([{ type: "text", text: " three" }], "stop"),
      ]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 1,
      maxLengthContinuations: 8,
    });
    expect(result).toMatchObject({
      state: "succeeded",
      text: "one two three",
    });
    expect(derivePiSpend(store.records()).summary.logicalProviderRequests).toBe(
      3,
    );
  });

  test("does not continue an overflow-shaped length stop", async () => {
    const store = campaign();
    const overflowed = assistant([], "length");
    overflowed.usage = {
      ...overflowed.usage,
      input: 9_950,
      output: 0,
      cacheRead: 0,
    };
    const result = await runPi(store, {
      models: models([overflowed]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 3,
    });
    expect(result).toMatchObject({
      state: "failed",
      providerRetryable: false,
      truncated: false,
      error: "Pi exceeded its context window",
    });
  });

  test("retries a provider error without preserving unseen partial text", async () => {
    const store = campaign();
    const observed: Context[] = [];
    const interrupted = assistant(
      [{ type: "text", text: "half the proof" }],
      "error",
    );
    interrupted.errorMessage = "Codex error: 502 upstream server error";
    const result = await runPi(store, {
      models: models(
        [
          interrupted,
          assistant([{ type: "text", text: "complete retry" }], "stop"),
        ],
        (context) => observed.push(context),
      ),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 2,
    });
    expect(result).toMatchObject({
      state: "succeeded",
      text: "complete retry",
    });
    expect(observed[1]?.messages.map(({ role }) => role)).toEqual(["user"]);
  });

  test("retries codex-lb transient gateway errors", async () => {
    const store = campaign();
    const dropped = assistant([], "error");
    dropped.errorMessage =
      "upstream_unavailable: Codex upstream stream failed (ClientPayloadError: Response payload is not completed)";
    const result = await runPi(store, {
      models: models([
        dropped,
        assistant([{ type: "text", text: "recovered" }], "stop"),
      ]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 1,
    });
    expect(result).toMatchObject({ state: "succeeded", text: "recovered" });
  });

  test("keeps one transport session across recovery attempts and separates calls", async () => {
    const store = campaign();
    const sessions: (string | undefined)[] = [];
    const transports: (string | undefined)[] = [];
    const observe = (
      _context: Context,
      options: SimpleStreamOptions | undefined,
    ) => {
      sessions.push(options?.sessionId);
      transports.push(options?.transport);
    };
    const interrupted = assistant([], "error");
    interrupted.errorMessage = "WebSocket closed 1006 Connection ended";
    await runPi(store, {
      models: models(
        [interrupted, assistant([{ type: "text", text: "done" }], "stop")],
        observe,
      ),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 1,
      transport: "sse",
    });
    await runPi(store, {
      models: models(
        [assistant([{ type: "text", text: "fresh" }], "stop")],
        observe,
      ),
      model,
      label: "audit/v1",
      prompt: "Audit",
    });
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toBeString();
    expect(transports).toEqual(["sse", "sse", undefined]);
    // The failed attempt and its recovery share one session so adapters can
    // key caching and transport-fallback state; a new call starts fresh.
    expect(sessions[1]).toBe(sessions[0]!);
    expect(sessions[2]).toBeString();
    expect(sessions[2]).not.toBe(sessions[0]!);
  });

  test("classifies an unrecovered codex-lb gateway error as retryable", async () => {
    const store = campaign();
    const dropped = assistant([], "error");
    dropped.errorMessage = "upstream_error: Codex upstream request failed";
    const result = await runPi(store, {
      models: models([dropped]),
      model,
      label: "audit/v1",
      prompt: "Audit",
    });
    expect(result).toMatchObject({
      state: "failed",
      providerRetryable: true,
    });
  });

  test("recovers the recorded incomplete upstream stream internally", async () => {
    const store = campaign();
    const dropped = assistant([], "error");
    dropped.errorMessage =
      "stream_incomplete: Upstream closed stream without completion";
    const result = await runPi(store, {
      models: models([
        dropped,
        assistant([{ type: "text", text: "recovered" }], "stop"),
      ]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 1,
    });
    expect(result).toMatchObject({ state: "succeeded", text: "recovered" });
    expect(derivePiSpend(store.records()).summary.logicalProviderRequests).toBe(
      2,
    );
  });

  test.each([
    undefined,
    "incomplete.max_messages_extra",
    "incomplete.content_filter",
  ])(
    "does not infer message-limit recovery from error text with raw reason %s",
    async (rawStopReason) => {
      const failed = assistant([], "error");
      failed.errorMessage = "Response incomplete: max_messages";
      if (rawStopReason !== undefined) failed.rawStopReason = rawStopReason;
      const result = await runPi(campaign(), {
        models: models([failed]),
        model,
        label: "recovery/exact-reason",
        prompt: "Reason",
        maxRecoveries: 1,
      });
      expect(result).toMatchObject({
        state: "failed",
        providerRetryable: false,
        truncated: false,
      });
    },
  );

  test("keeps an exhausted incomplete upstream stream retryable", async () => {
    const store = campaign();
    const dropped = () => {
      const message = assistant([], "error");
      message.errorMessage =
        "stream_incomplete: Upstream closed stream without completion";
      return message;
    };
    const result = await runPi(store, {
      models: models([dropped(), dropped()]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 1,
    });
    expect(result).toMatchObject({
      state: "failed",
      error: "stream_incomplete: Upstream closed stream without completion",
      providerRetryable: true,
    });
    expect(derivePiSpend(store.records()).summary.logicalProviderRequests).toBe(
      2,
    );
  });

  test("prefers structured incomplete-stream diagnostics", async () => {
    const byCode = assistant([], "error");
    byCode.errorMessage = "opaque provider failure";
    byCode.diagnostics = [
      {
        type: "provider_response_failure",
        timestamp: 1,
        error: {
          message: "opaque provider failure",
          code: "stream_incomplete",
        },
      },
    ];
    const codeResult = await runPi(campaign(), {
      models: models([byCode]),
      model,
      label: "code/v1",
      prompt: "Code",
    });
    expect(codeResult).toMatchObject({
      state: "failed",
      providerRetryable: true,
    });

    const byDetail = assistant([], "error");
    byDetail.errorMessage = "opaque provider failure";
    byDetail.diagnostics = [
      {
        type: "provider_response_failure",
        timestamp: 1,
        details: { failure_detail: "upstream_eof_before_terminal_event" },
      },
    ];
    const detailResult = await runPi(campaign(), {
      models: models([byDetail]),
      model,
      label: "detail/v1",
      prompt: "Detail",
    });
    expect(detailResult).toMatchObject({
      state: "failed",
      providerRetryable: true,
    });
  });

  test.each([
    "401 invalid_api_key: authentication failed",
    "403 permission denied",
    "429 insufficient_quota: billing hard limit reached",
    "400 invalid_request_error",
    "tool submission schema validation failed",
    "401 invalid_api_key: stream_incomplete: Upstream closed stream without completion",
    "429 insufficient_quota: stream_incomplete: Upstream closed stream without completion",
    "400 invalid_request_error: upstream_eof_before_terminal_event",
    "tool submission failed: upstream_eof_before_terminal_event",
  ])(
    "keeps deterministic provider failure non-retryable: %s",
    async (error) => {
      const failed = assistant([], "error");
      failed.errorMessage = error;
      const result = await runPi(campaign(), {
        models: models([failed]),
        model,
        label: "deterministic/v1",
        prompt: "Deterministic",
      });
      expect(result).toMatchObject({
        state: "failed",
        providerRetryable: false,
      });
    },
  );

  test("does not continue a non-retryable error stop", async () => {
    const store = campaign();
    const exhausted = assistant([], "error");
    exhausted.errorMessage = "insufficient_quota: billing hard limit reached";
    const result = await runPi(store, {
      models: models([exhausted]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxRecoveries: 3,
    });
    expect(result).toMatchObject({ state: "failed" });
    expect(result.state === "failed" && result.providerRetryable).toBe(false);
  });

  test("caps one request loop at thirty-two turns", async () => {
    const store = campaign();
    const echo = defineTool({
      name: "echo",
      description: "Echo",
      input: z.strictObject({ value: z.string() }),
      replay: "safe",
      async run({ value }) {
        return { value };
      },
    });
    const replies = Array.from({ length: 40 }, (_, index) =>
      assistant(
        [
          {
            type: "toolCall",
            id: `echo-${index}`,
            name: "echo",
            arguments: { value: "again" },
          },
        ],
        "toolUse",
      ),
    );
    const result = await runPi(store, {
      models: models(replies),
      model,
      label: "audit/v1",
      prompt: "Audit",
      tools: [echo],
    });
    expect(result.state).toBe("failed");
    const assistants = (
      result.transcript as readonly { role?: string }[]
    ).filter(({ role }) => role === "assistant");
    expect(assistants).toHaveLength(32);
  });

  test("shares the thirty-two-turn cap across length continuations", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo",
      input: z.strictObject({ value: z.string() }),
      replay: "safe",
      async run({ value }) {
        return { value };
      },
    });
    const replies = [
      assistant([{ type: "text", text: "partial" }], "length"),
      ...Array.from({ length: 40 }, (_, index) =>
        assistant(
          [
            {
              type: "toolCall" as const,
              id: `recovered-echo-${index}`,
              name: "echo",
              arguments: { value: "again" },
            },
          ],
          "toolUse",
        ),
      ),
    ];
    const result = await runPi(campaign(), {
      models: models(replies),
      model,
      label: "audit/v1",
      prompt: "Audit",
      tools: [echo],
      maxLengthContinuations: 1,
    });

    expect(result.state).toBe("failed");
    expect(
      (result.transcript as readonly { role?: string }[]).filter(
        ({ role }) => role === "assistant",
      ),
    ).toHaveLength(32);
  });

  test("does not continue after the thirty-second turn ends at length", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo",
      input: z.strictObject({ value: z.string() }),
      replay: "safe",
      async run({ value }) {
        return { value };
      },
    });
    const replies = [
      ...Array.from({ length: 31 }, (_, index) =>
        assistant(
          [
            {
              type: "toolCall" as const,
              id: `pre-limit-echo-${index}`,
              name: "echo",
              arguments: { value: "again" },
            },
          ],
          "toolUse",
        ),
      ),
      assistant([{ type: "text", text: "limit" }], "length"),
      assistant([{ type: "text", text: "turn 33" }], "stop"),
    ];
    let providerCalls = 0;
    const result = await runPi(campaign(), {
      models: models(replies, () => {
        providerCalls += 1;
      }),
      model,
      label: "audit/v1",
      prompt: "Audit",
      tools: [echo],
      maxLengthContinuations: 1,
    });

    expect(result).toMatchObject({ state: "failed", truncated: true });
    expect(providerCalls).toBe(32);
    expect(
      (result.transcript as readonly { role?: string }[]).filter(
        ({ role }) => role === "assistant",
      ),
    ).toHaveLength(32);
  });

  test("does not accept a mixed terminal tool batch at the turn cap", async () => {
    const store = campaign();
    const candidate = store.submitCandidate(new TextEncoder().encode("claim"), [
      "audit/v1",
    ]);
    const invalid = (id: string) => ({
      type: "toolCall" as const,
      id,
      name: submitVerdict.name,
      arguments: { verdict: "INVALID", evidence: null },
    });
    const replies = Array.from({ length: 31 }, (_, index) =>
      assistant([invalid(`invalid-${index}`)], "toolUse"),
    );
    replies.push(
      assistant(
        [
          invalid("invalid-final"),
          {
            type: "toolCall",
            id: "valid-final",
            name: submitVerdict.name,
            arguments: { verdict: "PASS", evidence: null },
          },
        ],
        "toolUse",
      ),
    );
    const result = await runPi(store, {
      models: models(replies),
      model,
      label: "audit/v1",
      candidate,
      prompt: "Audit",
      tools: [submitVerdict],
      stopAfterToolResult: true,
    });
    expect(result.state).toBe("failed");
    expect(() => store.recordVerdict(result.call, "PASS", null)).toThrow(
      "fresh successful verifier call",
    );
    expect(deriveCandidateStatus(store.records(), candidate).verified).toBe(
      false,
    );
  });

  test("keeps interrupted text when a continuation uses tools", async () => {
    const echo = defineTool({
      name: "echo",
      description: "Echo",
      input: z.strictObject({ value: z.string() }),
      replay: "safe",
      async run({ value }) {
        return { value };
      },
    });
    const result = await runPi(campaign(), {
      models: models([
        assistant([{ type: "text", text: "partial " }], "length"),
        assistant(
          [
            {
              type: "toolCall",
              id: "echo",
              name: "echo",
              arguments: { value: "continue" },
            },
          ],
          "toolUse",
        ),
        assistant([{ type: "text", text: "done" }], "stop"),
      ]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      tools: [echo],
      maxLengthContinuations: 1,
    });
    expect(result).toMatchObject({ state: "succeeded", text: "partial done" });
  });

  test("fails after exhausting length continuations", async () => {
    const store = campaign();
    const result = await runPi(store, {
      models: models([
        assistant([{ type: "text", text: "partial" }], "length"),
        assistant([{ type: "text", text: "more partial" }], "length"),
      ]),
      model,
      label: "audit/v1",
      prompt: "Audit",
      maxLengthContinuations: 1,
    });
    expect(result).toMatchObject({
      state: "failed",
      truncated: true,
      error: "Pi stopped with length",
    });
  });

  test("preserves Pi failure and cancellation states", async () => {
    const failedCampaign = campaign();
    const failed = await runPi(failedCampaign, {
      models: models([
        {
          ...assistant([], "error", undefined, false),
          errorMessage: "WebSocket closed 1006 Connection ended",
        },
      ]),
      model,
      label: "failure/v1",
      prompt: "Fail",
    });
    expect(failed).toMatchObject({
      state: "failed",
      error: "WebSocket closed 1006 Connection ended",
      providerRetryable: true,
    });
    if (failed.state !== "failed") throw new Error("expected Pi failure");
    expect(failed.providerRetryable).toBe(true);
    const storedFailure = failedCampaign
      .records()
      .find(
        (entry) => entry.kind === "call-result" && entry.parent === failed.call,
      );
    if (
      storedFailure?.kind !== "call-result" ||
      storedFailure.state !== "returned"
    ) {
      throw new Error("missing stored Pi failure");
    }
    expect(readPiResult(storedFailure.output, failedCampaign)).toMatchObject({
      state: "failed",
      providerRetryable: true,
    });
    expect(
      failed.telemetry.spans.every(({ status }) => status.status === "error"),
    ).toBe(true);
    const failedRequest = failed.telemetry.spans.find(
      ({ name }) => name === "pi.ai.request",
    );
    expect(
      failedRequest === undefined
        ? undefined
        : Object.hasOwn(failedRequest.attributes, "pi.ai.usage.total_tokens"),
    ).toBe(false);

    const cancelled = await runPi(campaign(), {
      models: models([assistant([], "aborted", undefined, false)]),
      model,
      label: "cancel/v1",
      prompt: "Cancel",
    });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled).not.toHaveProperty("providerRetryable");
    expect(
      cancelled.telemetry.spans.every(
        ({ status }) => status.status === "error",
      ),
    ).toBe(true);
    const cancelledRequest = cancelled.telemetry.spans.find(
      ({ name }) => name === "pi.ai.request",
    );
    expect(
      cancelledRequest === undefined
        ? undefined
        : Object.hasOwn(
            cancelledRequest.attributes,
            "pi.ai.usage.total_tokens",
          ),
    ).toBe(false);
  });

  test("does not classify context overflow or malformed failure records as retryable", async () => {
    let requests = 0;
    const overflow = await runPi(campaign(), {
      models: models(
        [
          {
            ...assistant([], "error", undefined, false),
            errorMessage: "500 internal error: context_length_exceeded",
          },
          assistant([{ type: "text", text: "must not run" }], "stop"),
        ],
        () => (requests += 1),
      ),
      model,
      label: "overflow/v1",
      prompt: "Overflow",
      maxRecoveries: 1,
    });
    expect(overflow).toMatchObject({
      state: "failed",
      providerRetryable: false,
    });
    expect(requests).toBe(1);
    const silentOverflow = await runPi(campaign(), {
      models: models([assistant([{ type: "text", text: "answer" }], "stop")]),
      model: { ...model, contextWindow: 10 },
      label: "silent-overflow/v1",
      prompt: "Overflow",
    });
    expect(silentOverflow).toMatchObject({
      state: "failed",
      providerRetryable: false,
      error: "Pi exceeded its context window",
    });
    expect(
      piStoredResult.safeParse({
        state: "failed",
        text: "",
        error: "incomplete failure record",
      }).success,
    ).toBe(false);
  });
});

test.each(["succeeded", "failed", "cancelled"] as const)(
  "compact Pi storage round-trips %s without retaining content in the journal",
  async (state) => {
    const store = campaign();
    const text = "large answer ".repeat(10_000);
    const body = piStoredResult.parse({
      state,
      text,
      transcript: [{ role: "assistant", content: text, usage: null }],
      telemetry: { schemaVersions: PI_TELEMETRY_SCHEMA_VERSIONS, spans: [] },
      ...(state === "succeeded" ? {} : { error: "terminal error" }),
      ...(state === "failed"
        ? { providerRetryable: false, truncated: true }
        : {}),
    });
    try {
      const receipt = await store.call(
        { label: "storage", request: null },
        async ({ call }) => storePiResult(store, { call, ...body }),
      );
      expect(JSON.stringify(receipt.output).length).toBeLessThan(1000);
      expect(piResultRecord.parse(receipt.output).assistantUsage).toEqual([
        null,
      ]);
      expect(readPiResult(receipt.output, store)).toEqual({
        call: receipt.call,
        ...body,
      });
    } finally {
      store.close();
    }
  },
);

test("collects final text in order across a long interrupted response chain", async () => {
  const store = campaign();
  try {
    const fragments = Array.from({ length: 21 }, (_, index) => `[${index}]`);
    const output = await runPi(store, {
      models: models(
        fragments.map((text, index) =>
          assistant(
            [
              { type: "thinking", thinking: "private reasoning" },
              { type: "text", text },
            ],
            index === fragments.length - 1 ? "stop" : "length",
          ),
        ),
      ),
      model,
      label: "linear-text",
      prompt: "Continue",
      maxLengthContinuations: 20,
    });
    expect(output.state).toBe("succeeded");
    expect(output.text).toBe(fragments.join(""));
    expect(derivePiSpend(store.records()).summary.logicalProviderRequests).toBe(
      21,
    );
  } finally {
    store.close();
  }
});
