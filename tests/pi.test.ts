import { expect, test } from "bun:test";
import { zstdDecompressSync } from "node:zlib";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  normalizeContext,
  Type,
  type AssistantMessage,
  type JsonValue,
  type Model,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { auditedStream, reportedPiUsage } from "../packages/core/src/pi";
import type { CallIdentity, CallRecorder } from "../packages/core/src/calls";
import { piRuntime, readSettings } from "../packages/core/src/solve/config.ts";
import { createSolver } from "../packages/core/src/solve/solver.ts";
import { createRoles } from "../packages/core/src/solve/roles.ts";
import { validateNotes } from "../packages/core/src/solve/notes.ts";
import { offlineResearch } from "../scripts/bounded-solve.ts";
import type { Note, Plan } from "../packages/core/src/solve/contracts.ts";
import { Xean, type Limits } from "../packages/core/src/index.ts";
import { ask, invoke, fixtureRuntime, model } from "./fixtures/pi.ts";
const context = {
  messages: [{ role: "user" as const, content: "Test", timestamp: 0 }],
};
const apiKey = "xean-offline-fixture-key";

test("native provider profiles preserve explicit credentials instead of a shared gateway key", () => {
  const variable = "XEAN_TEST_PROVIDER_CREDENTIAL";
  const previous = process.env[variable];
  try {
    for (const [provider, model, api, credential] of [
      [
        "anthropic",
        "claude-opus-5-5",
        "anthropic-messages",
        "sk-ant-oat-fixture",
      ],
      [
        "anthropic",
        "claude-opus-5-5",
        "anthropic-messages",
        "anthropic-api-fixture",
      ],
      [
        "google",
        "gemini-3.1-pro-preview",
        "google-generative-ai",
        "gemini-api-fixture",
      ],
    ] as const) {
      process.env[variable] = credential;
      const profile = piRuntime(
        readSettings({
          profiles: {
            default: {
              provider,
              model,
              apiKeyEnv: variable,
            },
          },
        }),
        "unrelated-gateway-key",
      ).profiles.explorer;
      expect(profile.model.api).toBe(api);
      expect(profile.options).toMatchObject({
        apiKey: credential,
        reasoning: "max",
      });
    }
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test("configuration and library limits share safe integer boundaries", async () => {
  const profiles = { default: { provider: "openai", model: "unused" } };
  const runtime = () => {
    throw new Error("Numeric validation needs no model runtime");
  };
  const roles = (maxExplorerResponses: number, maxExplorerReads = 1) =>
    createRoles(runtime, offlineResearch, {
      maxExplorerResponses,
      maxExplorerReads,
      literature: false,
    });
  const solver = (maxExplorerResponses: number) =>
    createSolver(
      { problem: "Exact task", completionCriteria: "Complete proof" },
      runtime,
      { maxExplorerResponses },
    );
  const open = (limits: Partial<Limits>) =>
    Xean.open(new MemoryStorage(), { ...solver(1), limits });
  const maximum = Number.MAX_SAFE_INTEGER;
  for (const value of [0, maximum + 1, Infinity, NaN, "2", 1.5] as number[]) {
    expect(() =>
      readSettings({ profiles, maxExplorerResponses: value }),
    ).toThrow();
    expect(() => solver(value)).toThrow();
    expect(() => roles(value)).toThrow(
      "maxExplorerResponses must be a positive integer",
    );
    expect(() => roles(1, value)).toThrow(
      "maxExplorerReads must be a positive integer",
    );
    expect(() =>
      readSettings({ profiles, limits: { concurrency: value } }),
    ).toThrow();
    await expect(open({ concurrency: value })).rejects.toThrow();
  }
  const retiredCalls = { concurrency: maximum, attempts: 1, providerCalls: 1 };
  expect(() =>
    readSettings({
      profiles,
      limits: retiredCalls,
      maxExplorerResponses: maximum,
    }),
  ).toThrow();
  await expect(open(retiredCalls as Partial<Limits>)).rejects.toThrow(
    "Invalid campaign limits",
  );
  expect(() => solver(maximum)).not.toThrow();
  expect(() => roles(maximum, maximum)).not.toThrow();
  const retired = { deadline: Date.now() + 60_000 };
  expect(() => readSettings({ profiles, limits: retired })).toThrow();
  await expect(open(retired as Partial<Limits>)).rejects.toThrow(
    "Invalid campaign limits",
  );
});

function eventResponse(
  ...events: { type: string; [key: string]: unknown }[]
): Response {
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    },
  );
}

function toolResponse(...output: object[]): Response {
  return eventResponse(
    ...output.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item },
      { type: "response.output_item.done", output_index, item },
    ]),
    {
      type: "response.completed",
      response: { id: "xean-tools", status: "completed", output },
    },
  );
}

async function requestBody(init: RequestInit | undefined) {
  const bytes = await new Response(init?.body).bytes();
  return JSON.parse(
    new TextDecoder().decode(
      new Headers(init?.headers).get("content-encoding") === "zstd"
        ? zstdDecompressSync(bytes)
        : bytes,
    ),
  );
}

function completedResponse(): Response {
  return eventResponse({
    type: "response.completed",
    response: {
      id: "xean-success",
      status: "completed",
      output: [],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
  });
}

test("Codex profiles keep native auth on official hosts and opaque keys on gateways", async () => {
  const token = `fixture.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
    }),
  ).toString("base64url")}.fixture`;
  for (const baseUrl of [
    undefined,
    "https://CHATGPT.com/backend-api",
    "https://api.chatgpt.com/backend-api",
    "https://xean.invalid/backend-api",
  ]) {
    const gateway = baseUrl?.includes("xean.invalid");
    const key = gateway ? apiKey : token;
    const runtime = piRuntime(
      readSettings({
        profiles: {
          default: {
            provider: "openai-codex",
            model: "gpt-6-astra",
            ...(baseUrl ? { baseUrl, reasoning: "max" } : {}),
          },
        },
      }),
      key,
    );
    const profile = runtime.profiles.explorer;
    let sent = false;
    const result = await runtime.models
      .streamSimple(profile.model, context, {
        ...profile.options,
        transport: "sse",
        maxRetries: 0,
        onPayload(payload) {
          expect(payload).toMatchObject({ reasoning: { effort: "max" } });
        },
        fetch: Object.assign(
          async (_url: string | URL | Request, init?: RequestInit) => {
            sent = true;
            const headers = new Headers(init?.headers);
            expect(headers.get("authorization")).toBe(`Bearer ${key}`);
            expect(headers.get("chatgpt-account-id")).toBe(
              gateway ? null : "fixture-account",
            );
            return eventResponse({
              type: "response.completed",
              response: {
                id: "xean-auth",
                status: "completed",
                output: [],
              },
            });
          },
          { preconnect: fetch.preconnect },
        ),
      })
      .result();
    expect(result.stopReason).toBe("stop");
    expect(sent).toBe(true);
  }
});

function fixtureModels(
  fetchResponse: (
    init: RequestInit | undefined,
  ) => Response | Promise<Response>,
): Pick<Models, "streamSimple"> {
  const stubFetch: typeof fetch = Object.assign(
    async (_url: string | URL | Request, init?: RequestInit) =>
      fetchResponse(init),
    { preconnect: fetch.preconnect },
  );
  return {
    streamSimple(requestModel, requestContext, options) {
      const configured = {
        ...options,
        apiKey,
        maxRetries: 0,
        transport: "sse" as const,
        fetch: stubFetch,
      };
      const transcript = normalizeContext(requestContext);
      return requestModel.api === "anthropic-messages"
        ? anthropic(
            requestModel as Model<"anthropic-messages">,
            transcript,
            configured,
          )
        : requestModel.api === "openai-responses"
          ? responses(
              requestModel as Model<"openai-responses">,
              transcript,
              configured,
            )
          : codex(
              requestModel as Model<"openai-codex-responses">,
              transcript,
              configured,
            );
    },
  };
}

test.each(["openai-responses", "openai-codex-responses"] as const)(
  "%s retains terminal failure usage with a custom endpoint",
  async (api) => {
    const state = recording();
    const models = fixtureModels(() => {
      return eventResponse({
        type: "response.failed",
        response: {
          id: "xean-failure",
          status: "failed",
          output: [],
          error: { code: "invalid_request_error", message: "fixture failure" },
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      });
    });
    const result = await auditedStream(models, state.recorder)(
      { ...model, api },
      context,
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.usageReported).toBe(true);
    expect(result.usage).toMatchObject({
      input: 60,
      cacheRead: 40,
      output: 5,
      reasoning: 3,
      totalTokens: 105,
    });
    expect(state.calls[0]?.usage).toEqual(result.usage);
  },
);

test("Responses distinguishes explicit zero usage from absent or invalid counts", async () => {
  const cases = [
    { usage: undefined, reported: false },
    { usage: {}, reported: false },
    { usage: { input_tokens: "5" }, reported: false },
    { usage: { input_tokens: 0 }, reported: true },
  ];
  for (const { usage, reported } of cases) {
    const event = {
      type: "response.completed",
      response: {
        id: "xean-zero",
        status: "completed",
        output: [],
        usage,
      },
    };
    const models = fixtureModels(() => eventResponse(event));
    const result = await models
      .streamSimple({ ...model, api: "openai-responses" }, context)
      .result();
    expect(result.stopReason).toBe("stop");
    expect(result.usageReported === true).toBe(reported);
    expect(reportedPiUsage(result)).toEqual(reported ? result.usage : null);
  }
});

test("Anthropic distinguishes zero from unknown usage and preserves it across empty updates", async () => {
  const cases = [
    { usage: undefined, reported: false },
    { usage: {}, reported: false },
    { usage: { input_tokens: "5" }, reported: false },
    { usage: { input_tokens: 0 }, delta: {}, reported: true },
  ];
  for (const { usage, delta, reported } of cases) {
    const state = recording();
    const events = [
      ...(usage !== undefined
        ? [
            {
              type: "message_start",
              message: {
                id: "xean-zero",
                model: model.id,
                usage,
              },
            },
          ]
        : []),
      ...(delta !== undefined
        ? [
            {
              type: "message_delta",
              delta: {},
              usage: delta,
            },
          ]
        : []),
      {
        type: "error",
        error: { type: "api_error", message: "fixture interruption" },
      },
    ];
    const stream = auditedStream(
      fixtureModels(() => eventResponse(...events)),
      state.recorder,
    );
    const result = await stream(
      { ...model, api: "anthropic-messages" },
      context,
    ).result();
    expect(result.stopReason).toBe("error");
    expect(result.usageReported === true).toBe(reported);
    expect(state.calls[0]?.usage).toEqual(reported ? result.usage : null);
  }
});

function recording() {
  const calls: {
    model: CallIdentity;
    payload?: JsonValue;
    message?: AssistantMessage;
    usage?: Usage | null;
  }[] = [];
  const recorder: CallRecorder = {
    begin(identity) {
      const call: (typeof calls)[number] = { model: identity };
      calls.push(call);
      return {
        recordRequest(payload) {
          call.payload = payload;
        },
        settle(message, usage) {
          call.message = message as AssistantMessage;
          call.usage = usage as Usage | null;
        },
      };
    },
  };
  return { calls, recorder };
}

test("roles recover missing submissions once without accepting prose or bypassing response limits", async () => {
  const prose = fauxAssistantMessage('{"answer":7}');
  const valid = fauxAssistantMessage(
    [fauxToolCall("submit_result", { answer: 7 })],
    { stopReason: "toolUse" },
  );
  const invalid = fauxAssistantMessage(
    [fauxToolCall("submit_result", { answer: "not a number" })],
    { stopReason: "toolUse" },
  );
  for (const { replies, calls, maxResponses, error } of [
    { replies: [prose, invalid, valid], calls: 3 },
    {
      replies: [prose, invalid, prose, valid],
      calls: 3,
      error: "after one reminder",
    },
    { replies: [prose, valid], calls: 1, maxResponses: 1, error: "exhausted" },
  ]) {
    const state = recording();
    const sessions: (string | undefined)[] = [];
    const runtime = fixtureRuntime((input, options) => {
      const turn = sessions.push(options?.sessionId) - 1;
      if (turn === 1) {
        expect(input.messages.slice(-2)).toMatchObject([
          { role: "assistant", content: prose.content },
          { role: "user" },
        ]);
        expect(input.messages.at(-1)!.content).toContain("submit_result");
      }
      if (turn === 2)
        expect(input.messages.at(-1)).toMatchObject({
          role: "toolResult",
          isError: true,
        });
      const reply = replies[turn];
      if (!reply) throw new Error("Unexpected provider request");
      return structuredClone(reply);
    });
    const result = ask(
      runtime,
      "coordinator",
      "Return an answer",
      {},
      Type.Object({ answer: Type.Number() }),
      {
        attemptId: "submission-recovery",
        attempt: 1,
        recorder: state.recorder,
      },
      BACKGROUND_CONTEXT,
      { maxResponses },
    );
    if (error) await expect(result).rejects.toThrow(error);
    else expect(await result).toEqual({ answer: 7 });
    expect(state.calls).toHaveLength(calls);
    expect(sessions).toHaveLength(calls);
    expect(sessions[0]).toBeTruthy();
    expect(new Set(sessions).size).toBe(1);
  }
});

test("roles hand off valid private submissions and never continue a rejected one", async () => {
  const state = recording();
  const replies = [
    fauxAssistantMessage([fauxToolCall("submit_result", { answer: 1 })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("submit_result", { answer: 7 })], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("No further progress."),
  ];
  let turn = 0;
  const runtime = fixtureRuntime((input) => {
    const [previous, last] = input.messages.slice(-2);
    // Rejected submissions consume a response without the continuation prompt.
    if (turn === 1) {
      expect(previous).toMatchObject({ role: "toolResult", isError: true });
      expect(last).toMatchObject({
        role: "user",
        content: "3 of 4 responses remain.",
      });
    }
    if (turn === 2)
      expect(last).toMatchObject({
        content: "Continue\n\n2 of 4 responses remain.",
      });
    return structuredClone(replies[turn++]!);
  });
  const result = await ask(
    runtime,
    "explorer",
    "Return an answer",
    {},
    Type.Object({ answer: Type.Number() }),
    { attemptId: "submission-handoff", attempt: 1, recorder: state.recorder },
    BACKGROUND_CONTEXT,
    {
      maxResponses: 4,
      continuation: "Continue",
      submit(value) {
        if (value.answer !== 7) throw new Error("Rejected answer");
        return { done: false, receipt: { recorded: true } };
      },
    },
  );
  expect(result).toEqual({ answer: 7 });
  expect(state.calls).toHaveLength(3);
});

test("Codex keeps required submission tools on a rejected-submission retry", async () => {
  const payloads: any[] = [];
  const tool = {
    type: "function_call",
    id: "fc_submission",
    call_id: "submission",
    name: "submit_result",
    arguments: '{"answer":1}',
    status: "completed",
  };
  const runtime = fixtureRuntime(() => fauxAssistantMessage(""));
  runtime.profiles.requirements.model = {
    ...model,
    compat: {
      ...model.compat,
      supportsAdditionalTools: true,
      supportsMidConvoSystemMessages: true,
    },
  };
  runtime.models.streamSimple = fixtureModels(async (init) => {
    const payload = await requestBody(init);
    payloads.push(payload);
    const responseTool = {
      ...tool,
      arguments: payloads.length === 1 ? '{"answer":0}' : tool.arguments,
    };
    return toolResponse(responseTool);
  }).streamSimple;
  const result = await ask(
    runtime,
    "requirements",
    "Judge the supplied notes",
    {},
    Type.Object({ answer: Type.Number() }),
    {
      attemptId: "required-submission",
      attempt: 1,
      recorder: recording().recorder,
    },
    BACKGROUND_CONTEXT,
    {
      maxResponses: 2,
      submit(value) {
        if (value.answer === 0) throw new Error("Missing coverage");
        return { done: true, receipt: { recorded: true } };
      },
    },
  );
  expect(result).toEqual({ answer: 1 });
  expect(payloads).toHaveLength(2);
  for (const payload of payloads) {
    expect(payload.tools.map((item: { name: string }) => item.name)).toEqual([
      "submit_result",
    ]);
    expect(payload.tool_choice).toBe("required");
    expect(payload.parallel_tool_calls).toBe(false);
    expect(
      payload.input.some(
        (item: { type: string }) => item.type === "additional_tools",
      ),
    ).toBe(false);
  }
});

test("cache routing follows identical prefixes while sessions and caller choices remain independent", async () => {
  const payloads: { prompt_cache_key?: string }[] = [];
  const sessions: (string | undefined)[] = [];
  const tool = {
    type: "function_call",
    id: "fc_cache",
    call_id: "cache",
    name: "submit_result",
    arguments: '{"answer":1}',
    status: "completed",
  };
  const transport = fixtureModels(async (init) => {
    payloads.push(await requestBody(init));
    return toolResponse(tool);
  });
  const runtime = fixtureRuntime(() => fauxAssistantMessage(""));
  runtime.models.streamSimple = (model, input, options) => {
    sessions.push(options?.sessionId);
    return transport.streamSimple(model, input, options);
  };
  for (const mode of [
    "same",
    "same",
    "system",
    "custom",
    "disabled",
    "schema",
    "model",
  ]) {
    runtime.profiles.explorer.options =
      mode === "custom"
        ? {
            onPayload: (payload) => ({
              ...(payload as object),
              prompt_cache_key: "caller-choice",
            }),
          }
        : mode === "disabled"
          ? { cacheRetention: "none" }
          : {};
    if (mode === "model")
      runtime.profiles.explorer.model = { ...model, id: "another-model" };
    await ask(
      runtime,
      "explorer",
      mode === "system" ? "Changed system" : "Same system",
      {},
      Type.Object({
        answer: mode === "schema" ? Type.Integer() : Type.Number(),
      }),
      {
        attemptId: "cache-routing",
        attempt: 1,
        recorder: recording().recorder,
      },
      BACKGROUND_CONTEXT,
    );
  }
  const keys = payloads.map((payload) => payload.prompt_cache_key);
  expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(keys[1]).toBe(keys[0]);
  for (const index of [2, 5, 6]) expect(keys[index]).not.toBe(keys[0]);
  expect(keys[3]).toBe("caller-choice");
  expect(keys[4]).toBeUndefined();
  expect(new Set(sessions).size).toBe(7);
});

test("Responses preserves cache boundaries and tool definitions when reading ends", async () => {
  const prefix = [{ task: "Exact task" }, { id: "n1", summary: "Useful note" }];
  for (const { reads, responses: maxResponses, cache } of [
    { reads: 1, responses: 4, cache: "auto" },
    { reads: 4, responses: 2, cache: "auto" },
    { reads: 0, responses: 4, cache: "disabled" },
    { reads: 1, responses: 4, cache: "custom" },
    { reads: 1, responses: 4, cache: "explicit-disabled" },
  ]) {
    const payloads: {
      input: { role?: string; content?: unknown }[];
      tools: { name: string }[];
      tool_choice?: unknown;
      prompt_cache_key?: string;
      metadata?: unknown;
    }[] = [];
    let admitted = 0;
    const runtime = fixtureRuntime(() => fauxAssistantMessage(""));
    runtime.profiles.explorer = {
      model: {
        ...model,
        api: "openai-responses",
        compat: { supportsExplicitPromptCacheMode: true },
      },
      options: {
        ...(cache === "disabled" ? { cacheRetention: "none" } : {}),
        onPayload: (payload) => ({
          ...(payload as object),
          metadata: { caller: "preserved" },
          ...(cache === "custom" ? { prompt_cache_key: "caller-key" } : {}),
          ...(cache === "explicit-disabled"
            ? { prompt_cache_options: { mode: "explicit" } }
            : {}),
        }),
      },
    };
    runtime.models.streamSimple = fixtureModels(async (init) => {
      payloads.push(await requestBody(init));
      const first = payloads.length === 1;
      const tool = {
        type: "function_call",
        id: `fc_${payloads.length}`,
        call_id: `call_${payloads.length}`,
        name: first ? "read_notes" : "submit_result",
        arguments: first ? '{"ids":["n1"]}' : '{"answer":7}',
        status: "completed",
      };
      const output = first
        ? [tool]
        : [
            {
              ...tool,
              id: "fc_blocked_read",
              call_id: "call_blocked_read",
              name: "read_notes",
              arguments: '{"ids":["n1"]}',
            },
            tool,
          ];
      return toolResponse(...output);
    }).streamSimple;
    expect(
      await ask(
        runtime,
        "explorer",
        "Read notes and answer",
        { guidance: "Use the relevant note" },
        Type.Object({ answer: Type.Number() }),
        {
          attemptId: "reader-payload",
          attempt: 1,
          recorder: recording().recorder,
        },
        BACKGROUND_CONTEXT,
        {
          prefix,
          maxReads: reads,
          maxResponses,
          tools: [
            {
              name: "read_notes",
              description: "Read complete notes by ID",
              parameters: Type.Object({ ids: Type.Array(Type.String()) }),
              async execute() {
                admitted++;
                return {
                  content: [{ type: "text", text: "Full note" }],
                  details: undefined,
                };
              },
            },
          ],
        },
      ),
    ).toEqual({ answer: 7 });
    expect(admitted).toBe(reads === 0 ? 0 : 1);
    expect(payloads).toHaveLength(2);
    const [first, last] = payloads;
    expect(last!.tools).toEqual(first!.tools);
    expect(last!.tools.map(({ name }) => name)).toEqual([
      "submit_result",
      "read_notes",
    ]);
    const restriction = {
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "submit_result" }],
    };
    expect(first!.tool_choice).toEqual(reads === 0 ? restriction : undefined);
    expect(last!.tool_choice).toEqual(restriction);
    for (const payload of payloads) {
      expect(payload.metadata).toEqual({ caller: "preserved" });
      expect(
        payload.input.filter(({ role }) => role === "user").slice(0, 3),
      ).toEqual(
        [...prefix, { guidance: "Use the relevant note" }].map((value, i) => ({
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(value),
              ...(i < prefix.length && !cache.endsWith("disabled")
                ? { prompt_cache_breakpoint: { mode: "explicit" } }
                : {}),
            },
          ],
        })),
      );
      if (cache === "disabled")
        expect(payload.prompt_cache_key).toBeUndefined();
      else if (cache === "custom")
        expect(payload.prompt_cache_key).toBe("caller-key");
      else expect(payload.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(last!.prompt_cache_key).toBe(first!.prompt_cache_key);
  }
});

test("interrupted turns retain completed reasoning and prior submissions without executing failed tools", async () => {
  const state = recording();
  const replies = [1, 99, 2, 3].map((answer) =>
    fauxAssistantMessage([fauxToolCall("submit_result", { answer })], {
      stopReason: "toolUse",
    }),
  );
  Object.assign(replies[1]!, {
    stopReason: "error",
    errorMessage:
      "Upstream websocket closed before response.completed (close_code=1012)",
  });
  replies[1]!.usage.output = 7;
  const thought = (id: string) => ({
    type: "thinking" as const,
    thinking: `Summary ${id}`,
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id,
      status: "completed",
      summary: [],
      encrypted_content: `opaque-${id}`,
    }),
  });
  replies[0]!.content.unshift(thought("previous"));
  const recovered = thought("recovered");
  replies[1]!.content.unshift(
    thought("previous"),
    recovered,
    recovered,
    { ...recovered, thinkingSignature: "invalid JSON" },
    {
      ...recovered,
      thinkingSignature: JSON.stringify({
        type: "reasoning",
        id: "unfinished",
        status: "in_progress",
        summary: [],
        encrypted_content: "opaque",
      }),
    },
    { type: "text", text: "Failed text" },
  );
  const sessions: (string | undefined)[] = [];
  const inputs: Parameters<Models["streamSimple"]>[1][] = [];
  const runtime = fixtureRuntime((input, options, selected) => {
    const turn = sessions.push(options?.sessionId) - 1;
    inputs.push(structuredClone(input));
    if (turn === 2) {
      expect(input.messages.slice(0, -1)).toEqual(inputs[1]!.messages);
      expect(input.messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [recovered],
        stopReason: "stop",
      });
      expect(state.calls[1]?.usage?.output).toBe(7);
    }
    if (turn === 3) {
      expect(
        input.messages.filter((message) => message.role === "assistant"),
      ).toHaveLength(2);
      expect(
        input.messages.filter((message) => message.role === "assistant").at(-1)
          ?.content,
      ).toContainEqual(recovered);
      expect(JSON.stringify(input)).not.toContain("Failed text");
    }
    if (!replies[turn]) throw new Error("Unexpected recovery request");
    return {
      ...structuredClone(replies[turn]!),
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
    };
  });
  const submitted: number[] = [];
  const answer = await ask(
    runtime,
    "explorer",
    "Return an answer",
    {},
    Type.Object({ answer: Type.Number() }),
    { attemptId: "stream-recovery", attempt: 1, recorder: state.recorder },
    BACKGROUND_CONTEXT,
    {
      maxResponses: 3,
      continuation: "Continue",
      submit(value) {
        submitted.push(value.answer);
        return { done: value.answer === 3, receipt: { recorded: true } };
      },
    },
  );
  expect(answer).toEqual({ answer: 3 });
  expect(submitted).toEqual([1, 2, 3]);
  expect(new Set(sessions).size).toBe(1);
  expect(state.calls.map((call) => call.message?.stopReason)).toEqual([
    "toolUse",
    "error",
    "toolUse",
    "toolUse",
  ]);
});

test("roles bound context, preserve frozen note reads, and verify imported dependencies", async () => {
  const state = recording();
  const execution = {
    attemptId: "role-context",
    attempt: 1,
    recorder: state.recorder,
  };
  // This schema fits once; counting Pi's tool declaration twice exceeds capacity.
  const schema = Type.Object(
    { answer: Type.Number() },
    { description: "x".repeat(40_000) },
  );
  const reply = (
    name: string,
    args: Parameters<typeof fauxToolCall>[1],
    stopReason: "toolUse" | "length" = "toolUse",
  ) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason });
  let respond: (
    input: Parameters<Models["streamSimple"]>[1],
  ) => AssistantMessage = () => {
    throw new Error("Oversized input must not reach the provider");
  };
  const runtime = fixtureRuntime((input) => respond(input));
  const explore = (
    input: unknown,
    options: Parameters<typeof ask<typeof schema>>[7] = {},
  ) =>
    ask(
      runtime,
      "explorer",
      "Return notes",
      input,
      schema,
      execution,
      BACKGROUND_CONTEXT,
      options,
    );
  await expect(explore("x".repeat(100_000))).rejects.toThrow("context");
  runtime.profiles.explorer.options = { deferred: true };
  await expect(explore({})).rejects.toThrow("Deferred model requests");
  runtime.profiles.explorer.options = undefined;
  expect(state.calls).toHaveLength(0);
  let submissions = 0;
  respond = () => {
    const message = reply("submit_result", { answer: 1 });
    message.usage = { ...message.usage, totalTokens: model.contextWindow };
    return message;
  };
  expect(
    await explore(
      {},
      {
        submit() {
          submissions++;
          return { done: false, receipt: { recorded: true } };
        },
        continuation: "Continue",
      },
    ),
  ).toEqual({ answer: 1 });
  expect(state.calls).toHaveLength(1);
  expect(submissions).toBe(1);
  respond = () => reply("submit_result", { answer: 2 }, "length");
  await expect(
    explore(
      {},
      {
        submit() {
          submissions++;
          return { done: true, receipt: null };
        },
      },
    ),
  ).rejects.toThrow("truncated");
  expect(submissions).toBe(1);
  expect(state.calls).toHaveLength(2);
  expect(state.calls[1]!.message?.stopReason).toBe("length");

  const note: Note = {
    id: "n1",
    text: "FROZEN-PROOF",
    summary: "A result",
    detailedSummary: "A result with a frozen proof.",
    revision: 0,
    imported: false,
    support: [],
    checks: [],
    dead: false,
    verified: false,
    accepted: false,
    candidate: false,
  };
  const rejected: Note = {
    ...note,
    id: "rejected",
    text: "REJECTED-PROOF",
    support: [],
    dead: true,
  };
  const imported: Note = {
    ...note,
    id: "input/import/n1",
    imported: true,
    support: [note.id],
  };
  expect(() =>
    validateNotes([{ ...note, support: [rejected.id] }], [rejected]),
  ).toThrow("Unknown, dead, or forward support");
  const plan: Plan = {
    work: [
      {
        kind: "explorer",
        guidance: "Try a new approach",
      },
      { kind: "verifier", notes: [imported.id], through: "source" },
    ],
  };
  let turn = 0;
  respond = (input) => {
    if (turn >= 5) throw new Error(JSON.stringify(input.messages.at(-1)));
    if (turn++ === 0) {
      const prompt = JSON.parse(
        String(input.messages.findLast((m) => m.role === "user")!.content),
      );
      expect(prompt.capabilities).toEqual({
        explorer: true,
        codex: false,
        literature: false,
        sourceRetrieval: false,
      });
      expect(
        prompt.notes.find((note: Note) => note.id === imported.id),
      ).toMatchObject({
        imported: true,
        verified: false,
        passed: ["correctness", "source"],
      });
      expect(JSON.stringify(input.messages)).not.toContain("FROZEN-PROOF");
      note.text = "CHANGED-AFTER-START";
      note.support.push("CHANGED-AFTER-START");
      note.dead = true;
      return reply("read_notes", { ids: ["missing"], level: "full" });
    }
    if (turn === 2) {
      expect(input.messages.at(-1)).toMatchObject({
        role: "toolResult",
        isError: true,
      });
      return reply("read_notes", { ids: ["n1", rejected.id], level: "full" });
    }
    expect(JSON.stringify(input.messages)).toContain("FROZEN-PROOF");
    expect(JSON.stringify(input.messages)).toContain("REJECTED-PROOF");
    expect(JSON.stringify(input.messages)).not.toContain("CHANGED-AFTER-START");
    if (turn === 3)
      return reply("submit_result", { work: [plan.work[0]!, plan.work[0]!] });
    expect(input.messages.at(-1)).toMatchObject({
      role: "toolResult",
      isError: true,
    });
    if (turn === 4) {
      expect(JSON.stringify(input.messages.at(-1))).toContain(
        "Dispatch at most one Explorer",
      );
      return reply("submit_result", {
        work: [
          { kind: "verifier", notes: [rejected.id], through: "correctness" },
        ],
      });
    }
    expect(JSON.stringify(input.messages.at(-1))).toContain(
      "Unknown or dead note",
    );
    return reply("submit_result", plan);
  };
  const roles = createRoles(runtime, offlineResearch, {
    maxExplorerReads: 1,
    maxExplorerResponses: 4,
    literature: true,
  });
  expect(
    await invoke(
      roles.coordinator,
      {
        task: { problem: "P", completionCriteria: "Prove P" },
        notes: [note, imported, rejected],
        guidance: [],
        failures: [],
        literatureUsed: false,
        explorerUsed: false,
      },
      execution,
    ),
  ).toEqual(plan);
  expect(state.calls).toHaveLength(7);
  await expect(invoke(roles.literature, null!, execution)).rejects.toThrow(
    "disabled",
  );
});

test("Responses recovery uses HTTP status instead of transient words in terminal errors", async () => {
  for (const [status, message, expectedCalls] of [
    [400, "Unsupported timeout parameter", 1],
    [404, "Model custom-500 is not available", 1],
    [503, "Provider temporarily unavailable", 2],
  ] as const) {
    const state = recording();
    let requests = 0;
    const models = fixtureModels(() => {
      requests++;
      return new Response(
        JSON.stringify({ error: { type: "fixture_error", message } }),
        { status, headers: { "content-type": "application/json" } },
      );
    });
    const result = await auditedStream(models, state.recorder, {
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 0,
    })({ ...model, api: "openai-responses" }, context).result();
    expect(result.stopReason).toBe("error");
    expect(requests).toBe(expectedCalls);
    expect(state.calls).toHaveLength(expectedCalls);
    expect(
      state.calls.every((call) => call.message?.stopReason === "error"),
    ).toBe(true);
  }
});

test("turn recovery stops at its allowance, refused admission, cancellation, and invalid requests", async () => {
  for (const stop of [
    "exhausted",
    "admission",
    "cancelled",
    "invalid",
  ] as const) {
    const state = recording();
    const controller = new AbortController();
    let admissions = 0;
    const runtime = fixtureRuntime(() =>
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          stop === "invalid"
            ? "invalid_request_error: invalid timeout (503 seconds)"
            : "Upstream websocket closed before response.completed",
      }),
    );
    const result = await auditedStream(
      runtime.models,
      {
        async begin(identity) {
          if (++admissions === 2 && stop === "admission")
            throw new Error("connection error during call admission");
          const call = await state.recorder.begin(identity);
          return {
            recordRequest: call.recordRequest,
            async settle(message, usage) {
              await call.settle(message, usage);
              if (stop === "cancelled") controller.abort();
            },
          };
        },
      },
      { enabled: true, maxRetries: 1, baseDelayMs: 0 },
    )(model, context, {
      signal: controller.signal,
    }).result();
    expect(result.stopReason).toBe(stop === "cancelled" ? "aborted" : "error");
    expect(admissions).toBe(stop === "invalid" || stop === "cancelled" ? 1 : 2);
    expect(state.calls).toHaveLength(stop === "exhausted" ? 2 : 1);
    expect(
      state.calls.every((call) => call.message?.stopReason === "error"),
    ).toBe(true);
    if (stop === "admission")
      expect(result.errorMessage).toContain("call admission");
  }
});

test("native response recovery records each logical call before publication", async () => {
  let sent = 0;
  const item = {
    type: "reasoning",
    id: "rs_recovered",
    status: "completed",
    summary: [],
    encrypted_content: "opaque-native-signature",
  };
  const models = fixtureModels(async (init) => {
    if (++sent > 1) {
      expect(
        (await requestBody(init)).input.filter(
          (part: { type: string }) => part.type === "reasoning",
        ),
      ).toEqual([item]);
      return completedResponse();
    }
    return eventResponse(
      { type: "response.output_item.added", output_index: 0, item },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...item, id: "rs_unfinished" },
      },
      {
        type: "response.failed",
        response: {
          id: "interrupted",
          status: "failed",
          output: [],
          error: {
            code: "stream_incomplete",
            message:
              "Upstream websocket closed before response.completed (close_code=1012)",
          },
          usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10 },
        },
      },
    );
  });
  const engine = await Xean.open(new MemoryStorage(), {
    task: "recover a native provider response",
    limits: { attempts: 2 },
    roles: [
      {
        name: "worker",
        async run(_input, execution, scope) {
          const message = await auditedStream(models, execution.recorder, {
            enabled: true,
            maxRetries: 1,
            baseDelayMs: 0,
          })(model, context, { signal: scope.abortSignal }).result();
          if (message.stopReason !== "stop")
            throw new Error(message.errorMessage);
          return "recovered";
        },
      },
    ],
    coordinator: {
      name: "coordinate",
      async run(signal, view) {
        if (signal.kind === "start")
          return {
            state: null,
            dispatch: [{ id: "work", role: "worker", input: null }],
          };
        return {
          state: null,
          ...(signal.kind === "completed"
            ? { completion: view.work[0]!.result }
            : {}),
        };
      },
    },
    accept: (result) => result === "recovered",
  });
  try {
    const result = await engine.run();
    expect(result.status).toBe("completed");
    expect(result.work[0]!.result).toBe("recovered");
    expect(result.providerCalls).toBe(2);
    expect(sent).toBe(2);
    const settled = (await engine.records()).filter(
      (entry) => entry.kind === "xean.call.settled",
    );
    expect(settled).toHaveLength(2);
    expect(settled[0]!.data).toMatchObject({
      message: { stopReason: "error" },
      usage: { output: 7 },
    });
  } finally {
    await engine.close();
  }
});

test.each(["none", "settlement", "delivery"])(
  "records requests and joins accounting before delivery (cancellation: %s)",
  async (cancellation) => {
    const controller = new AbortController();
    const requestRecorded = Promise.withResolvers<void>();
    const settlement = Promise.withResolvers<void>();
    const recordingReached = Promise.withResolvers<void>();
    const settlementReached = Promise.withResolvers<void>();
    const state = recording();
    let sent = false;
    let completed = false;
    const models = fixtureModels((init) => {
      sent = true;
      expect(JSON.parse(String(init?.body))).toEqual(state.calls[0]?.payload);
      return completedResponse();
    });
    const stream = auditedStream(models, {
      async begin(identity) {
        const call = await state.recorder.begin(identity);
        return {
          async recordRequest(payload) {
            await call.recordRequest(payload);
            recordingReached.resolve();
            await requestRecorded.promise;
          },
          async settle(message, usage) {
            await call.settle(message, usage);
            settlementReached.resolve();
            await settlement.promise;
            if (cancellation === "delivery")
              queueMicrotask(() => queueMicrotask(() => controller.abort()));
          },
        };
      },
    });
    const result = stream(
      {
        ...model,
        api: "openai-responses",
        baseUrl:
          "https://user:private-url-value@xean.invalid/v1?key=private-query-value",
        headers: { "x-fixture-auth": "private-header-value" },
      },
      context,
      {
        signal: controller.signal,
        onPayload: (payload) => ({
          ...(payload as object),
          metadata: { changed: true },
        }),
      },
    )
      .result()
      .then((value) => {
        completed = true;
        return value;
      });
    await recordingReached.promise;
    expect(sent).toBe(false);
    expect(state.calls[0]?.payload).toMatchObject({
      metadata: { changed: true },
    });
    expect(JSON.stringify(state.calls)).not.toContain("private-");
    requestRecorded.resolve();
    await settlementReached.promise;
    expect(sent).toBe(true);
    expect(completed).toBe(false);
    if (cancellation === "settlement") controller.abort();
    settlement.resolve();
    const message = await result;
    expect(message.stopReason).toBe(
      cancellation === "none" ? "stop" : "aborted",
    );
    expect(reportedPiUsage(message)?.totalTokens).toBe(5);
    expect(state.calls[0]?.message?.stopReason).toBe("stop");
    expect(state.calls[0]?.usage?.totalTokens).toBe(5);
  },
);

test("failed request recording prevents dispatch and preserves unknown usage", async () => {
  let sent = false;
  const state = recording();
  const stream = auditedStream(
    fixtureModels(() => {
      sent = true;
      throw new Error("must not send");
    }),
    {
      async begin(identity) {
        const call = await state.recorder.begin(identity);
        return {
          recordRequest() {
            throw new Error("connection error recording request");
          },
          settle: call.settle,
        };
      },
    },
    { enabled: true, maxRetries: 2, baseDelayMs: 0 },
  );
  const result = await stream(model, context).result();
  expect(sent).toBe(false);
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("connection error recording request");
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]?.usage).toBeNull();
});

test("changing a payload while request recording is pending prevents dispatch", async () => {
  const requestRecorded = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const payload = { input: "original", optional: undefined };
  const state = recording();
  let sent = false;
  const stream = auditedStream(
    fixtureModels(() => {
      sent = true;
      throw new Error("must not send");
    }),
    {
      async begin(identity) {
        const call = await state.recorder.begin(identity);
        return {
          async recordRequest(value) {
            await call.recordRequest(value);
            entered.resolve();
            await requestRecorded.promise;
          },
          settle: call.settle,
        };
      },
    },
  );
  const result = stream(model, context, { onPayload: () => payload }).result();
  await entered.promise;
  payload.input = "changed";
  requestRecorded.resolve();
  expect((await result).stopReason).toBe("error");
  expect(sent).toBe(false);
  expect(state.calls[0]?.payload).toEqual({ input: "original" });
  expect(state.calls[0]?.usage).toBeNull();
});

test("cancellation preserves received usage and leaves unread usage unknown", async () => {
  for (const afterUsage of [false, true]) {
    const state = recording();
    const controller = new AbortController();
    const stream = auditedStream(
      fixtureModels(completedResponse),
      state.recorder,
    );
    const message = await stream(
      { ...model, api: "openai-responses" },
      context,
      {
        signal: controller.signal,
        onResponse: () => {
          if (!afterUsage) controller.abort();
        },
        onProviderStreamEvent: (event) => {
          if (
            afterUsage &&
            (event as { type: string }).type === "response.completed"
          )
            controller.abort();
        },
      },
    ).result();
    expect(message.stopReason).toBe("aborted");
    if (afterUsage) expect(state.calls[0]?.usage?.totalTokens).toBe(5);
    else expect(state.calls[0]?.usage).toBeNull();
  }
});

test("settlement failure cannot escape as success or erase measured usage", async () => {
  let calls = 0;
  const stream = auditedStream(
    fixtureModels(completedResponse),
    {
      begin() {
        calls++;
        return {
          recordRequest() {},
          settle() {
            throw new Error("connection error settling request");
          },
        };
      },
    },
    { enabled: true, maxRetries: 2, baseDelayMs: 0 },
  );
  const result = await stream(model, context).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBe("connection error settling request");
  expect(calls).toBe(1);
  expect(reportedPiUsage(result)?.totalTokens).toBe(5);
});
