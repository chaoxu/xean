import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createModels,
  normalizeContext,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { bool, obj } from "@earendil-works/pi-schema";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  type GenerationPolicy,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

const continuationPrompt = "Continue the interrupted response.";
const policy: GenerationPolicy = {
  maxResponses: 32,
  maxLengthContinuations: 8,
  maxRecoveries: 8,
  continueEmptyLength: true,
  retryContent: "completed-reasoning",
};
const truncated = (text = "Partial") =>
  fauxAssistantMessage(text, { stopReason: "length" });
const failure = () =>
  fauxAssistantMessage("Uncommitted draft", {
    stopReason: "error",
    errorMessage: "upstream_unavailable",
  });
const finish = (done: boolean | string = true) =>
  fauxAssistantMessage(fauxToolCall("finish", { done }), {
    stopReason: "toolUse",
  });

function fixture(
  responses: FauxResponseStep[],
  generation: GenerationPolicy | undefined = policy,
  clock: Pick<HarnessOptions, "now" | "onWake"> & { baseDelayMs?: number } = {},
  fetchFixture?: typeof fetch,
) {
  const provider = fauxProvider({
    api: "openai-responses",
    provider: "test",
    models: [{ id: "model" }],
  });
  provider.setResponses(responses);
  const models = createModels();
  models.setProvider(provider.provider);
  const requests: Message[][] = [];
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (model, transcript, options) => {
    requests.push(structuredClone(transcript.messages));
    if (fetchFixture)
      return responsesStream(
        {
          ...model,
          api: "openai-responses",
          baseUrl: "https://fixture.invalid/v1",
        },
        normalizeContext(transcript),
        { ...options, apiKey: "fixture", fetch: fetchFixture, maxRetries: 0 },
      );
    return stream(model, transcript, options);
  };
  const tool = defineTool({
    name: "finish",
    description: "Finish when done.",
    parameters: obj({ done: bool() }, { open: true }),
    replay: "safe",
    async execute({ done }) {
      return {
        output: [{ type: "text", text: "OK" }],
        ...(done ? { control: { terminate: true as const } } : {}),
      };
    },
  });
  const extension = defineExtension({
    name: "test",
    tools: [tool],
    hooks: [
      hook(GenerationTask, {
        onYield(answer) {
          if (answer.stopReason === "length")
            return { continue: continuationPrompt };
        },
      }),
    ],
  });
  return {
    provider,
    requests,
    async open(directory?: string) {
      const registry = createRegistry();
      registry.install(extension);
      const harness = await Harness.open(
        directory
          ? await openNodeJsonlStorage(directory, context)
          : new MemoryStorage(),
        {
          models,
          registry,
          now: clock.now,
          onWake: clock.onWake,
          settings: {
            generation,
            retry: {
              enabled: true,
              maxRetries: 99,
              baseDelayMs: clock.baseDelayMs ?? 0,
            },
            compaction: { enabled: false },
          },
        },
        context,
      );
      const conversation = await harness.root(context, {
        agent: {
          model: { provider: "test", modelId: "model" },
          extensions: [extension],
        },
      });
      return { harness, conversation };
    },
    async run() {
      const { harness, conversation } = await this.open();
      try {
        const result = await (
          await conversation.submit(
            { type: "input", content: "Begin." },
            context,
          )
        ).wait(context);
        const entries = (
          await conversation.entries(
            { order: "ascending" },
            256,
            undefined,
            context,
          )
        ).items;
        const raw = entries
          .flatMap((entry) => entry.model ?? [])
          .filter((m): m is AssistantMessage => m.role === "assistant");
        return {
          result,
          raw,
          usage: await harness.usage(context),
          projected: await conversation.context(context, {
            projection: {
              retryContent: "completed-reasoning",
              model: {
                api: "openai-responses",
                provider: "test",
                modelId: "model",
              },
            },
          }),
          diagnostic: await conversation.context(context),
        };
      } finally {
        await harness.close(context);
      }
    },
  };
}

test.each([
  {
    name: "server identity",
    type: "server_error",
    code: "internal_server_error",
    retry: true,
  },
  { name: "type only", type: "server_error", code: null, retry: true },
  { name: "code only", type: null, code: "internal_server_error", retry: true },
  {
    name: "client error",
    type: "invalid_request_error",
    code: "unsupported_parameter",
    retry: false,
  },
  {
    name: "billing error",
    type: "server_error",
    code: "insufficient_quota",
    retry: false,
  },
  {
    name: "HTTP authentication error",
    type: "authentication_error",
    code: "invalid_api_key",
    retry: false,
    status: 401,
  },
  {
    name: "response.failed",
    type: null,
    code: "internal_server_error",
    retry: true,
    failed: true,
  },
])(
  "native Responses recovery preserves $name",
  async ({ type, code, retry, status, failed }) => {
    let calls = 0;
    const error = {
      type,
      code,
      message: retry ? "Request did not complete." : "Server error.",
    };
    const fetchFixture = Object.assign(
      async () => {
        calls++;
        if (calls === 1 && status) return Response.json({ error }, { status });
        const events =
          calls === 1
            ? [
                failed
                  ? {
                      type: "response.failed",
                      response: { status: "failed", output: [], error },
                    }
                  : { error },
              ]
            : [
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "function_call",
                    id: "fc_finish",
                    call_id: "finish-call",
                    name: "finish",
                    arguments: '{"done":true}',
                    status: "completed",
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "completed",
                    status: "completed",
                    output: [],
                  },
                },
              ];
        return new Response(
          events
            .map(
              (event) =>
                `${"error" in event ? "event: error\n" : ""}data: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      },
      { preconnect: fetch.preconnect },
    );
    const run = fixture([], policy, {}, fetchFixture);
    const { result, raw } = await run.run();
    expect(result.status).toBe(retry ? "done" : "unanswered");
    expect(calls).toBe(retry ? 2 : 1);
    expect(raw[0]!.providerError?.status).toBe(status);
    expect(raw[0]!.providerError?.type).toBe(
      failed ? undefined : (type ?? undefined),
    );
    expect(raw[0]!.providerError?.code).toBe(
      failed ? undefined : (code ?? undefined),
    );
    if (retry)
      expect(raw[1]!.content).toContainEqual(
        expect.objectContaining({
          type: "toolCall",
          name: "finish",
          arguments: { done: true },
        }),
      );
  },
);

test("native Responses SSE parser treats max_output_tokens and max_messages as resumable limits", async () => {
  for (const reason of ["max_output_tokens", "max_messages"]) {
    const model = {
      ...fauxProvider().getModel(),
      api: "openai-responses" as const,
      baseUrl: "https://fixture.invalid/v1",
    };
    const response = {
      id: "response-fixture",
      model: model.id,
      status: "incomplete",
      output: [],
      incomplete_details: { reason },
      usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
    };
    const fetchFixture = Object.assign(
      async () =>
        new Response(
          `data: ${JSON.stringify({ type: "response.incomplete", response })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect: fetch.preconnect },
    );
    const parsed = await responsesStream(
      model,
      normalizeContext({
        messages: [{ role: "user", content: "Begin", timestamp: 0 }],
      }),
      { apiKey: "fixture", fetch: fetchFixture, maxRetries: 0 },
    ).result();
    expect(parsed).toMatchObject({
      stopReason: "length",
      rawStopReason: `incomplete.${reason}`,
      usageReported: true,
      usage: { input: 11, output: 7, totalTokens: 18 },
    });
    const run = fixture([parsed, finish()]);
    const result = await run.run();
    expect(result.result.status).toBe("done");
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]!.at(-1)).toMatchObject({
      role: "user",
      content: continuationPrompt,
    });
    expect(result.raw[0]!.rawStopReason).toBe(`incomplete.${reason}`);
  }
});

test("empty and whitespace length continuation is opt-in and remains bounded", async () => {
  for (const content of ["", "   \n"]) {
    const run = fixture([truncated(content), finish()]);
    expect((await run.run()).result.status).toBe("done");
    expect(run.provider.state.callCount).toBe(2);
    const unchanged = fixture([truncated(content), finish()], {});
    expect((await unchanged.run()).result.status).toBe("unanswered");
    expect(unchanged.provider.state.callCount).toBe(1);
  }
  const run = fixture([
    ...Array.from({ length: 9 }, () => truncated("")),
    finish(),
  ]);
  const { result, raw } = await run.run();
  expect(result).toMatchObject({
    status: "unanswered",
    detail: "Model run exhausted 8 output-length continuations",
  });
  expect(raw).toHaveLength(9);
  expect(run.provider.state.callCount).toBe(9);
});

test("recovery budget persists across length responses and resets after a tool response", async () => {
  const exhausted = fixture([
    ...Array.from({ length: 8 }, failure),
    truncated(),
    failure(),
    finish(),
  ]);
  const { result, raw, usage } = await exhausted.run();
  expect(result).toMatchObject({
    status: "unanswered",
    detail: "Model run exhausted 8 error recoveries",
  });
  expect(raw).toHaveLength(10);
  expect(raw.filter((m) => m.stopReason === "error")).toHaveLength(9);
  expect(usage.models["test/model"]!.totalTokens).toBe(
    raw.reduce((total, m) => total + m.usage.totalTokens, 0),
  );
  const reset = fixture([
    ...Array.from({ length: 8 }, failure),
    finish("invalid"),
    ...Array.from({ length: 8 }, failure),
    finish(),
  ]);
  expect((await reset.run()).result.status).toBe("done");
  expect(reset.provider.state.callCount).toBe(18);
});

test("custom retry context excludes failed drafts without changing diagnostic projection", async () => {
  const run = fixture([failure(), finish()]);
  const { raw, projected, diagnostic } = await run.run();
  expect(JSON.stringify(run.requests[1])).not.toContain("Uncommitted draft");
  expect(run.requests[1]!.filter((m) => m.role === "user")).toHaveLength(1);
  expect(JSON.stringify(projected.messages)).not.toContain("Uncommitted draft");
  expect(JSON.stringify(diagnostic.messages)).toContain("Uncommitted draft");
  expect(raw[0]).toMatchObject({
    stopReason: "error",
    errorMessage: "upstream_unavailable",
    content: [{ type: "text", text: "Uncommitted draft" }],
  });
});

test("native length budget survives closing and reopening during the next request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-native-budget-"));
  const entered = Promise.withResolvers<void>();
  const run = fixture(
    [
      truncated(),
      (_transcript, options) =>
        new Promise((resolve) => {
          entered.resolve();
          options!.signal!.addEventListener(
            "abort",
            () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
            { once: true },
          );
        }),
    ],
    { ...policy, maxLengthContinuations: 1 },
  );
  let opened = await run.open(directory);
  try {
    const submitted = await opened.conversation.submit(
      { type: "input", content: "Begin." },
      context,
    );
    await entered.promise;
    await opened.harness.close(context);
    run.provider.setResponses([truncated(), finish()]);
    opened = await run.open(directory);
    const result = await (await opened.harness.submission(
      submitted.id,
      context,
    ))!.wait(context);
    expect(result).toMatchObject({
      status: "unanswered",
      detail: "Model run exhausted 1 output-length continuations",
    });
    expect(run.provider.state.callCount).toBe(3);
  } finally {
    await opened.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a retry sleep survives close and reopen, and idle waits until its original deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-native-retry-sleep-"));
  let now = 1_000;
  let sleeping = Promise.withResolvers<number>();
  const run = fixture([failure(), finish()], policy, {
    now: () => now,
    baseDelayMs: 1_000,
    onWake: ({ active, at }) => {
      if (!active && at !== undefined) sleeping.resolve(at);
    },
  });
  let opened = await run.open(directory);
  try {
    const submitted = await opened.conversation.submit(
      { type: "input", content: "Begin." },
      context,
    );
    const until = await sleeping.promise;
    expect(until).toBeGreaterThan(now);
    expect(run.provider.state.callCount).toBe(1);
    await opened.harness.close(context);
    sleeping = Promise.withResolvers<number>();
    opened = await run.open(directory);
    expect(await sleeping.promise).toBe(until);
    let idle = false;
    const settled = opened.conversation.waitForIdle(context).then(() => {
      idle = true;
    });
    void settled.catch(() => {});
    now = until - 1;
    opened.harness.resume();
    const inspection = await opened.harness.inspect(context);
    expect(
      inspection.tasks.some(({ state }) => state.kind === "sleeping"),
    ).toBe(true);
    expect(idle).toBe(false);
    expect(run.provider.state.callCount).toBe(1);
    now = until;
    opened.harness.resume();
    await settled;
    expect(
      await (await opened.harness.submission(submitted.id, context))!.wait(
        context,
      ),
    ).toMatchObject({ status: "done" });
    expect(run.provider.state.callCount).toBe(2);
  } finally {
    await opened.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Anthropic disconnect keeps completed and redacted signatures, drops unfinished signatures, and retains usage", async () => {
  // Provider indices deliberately differ from content-array positions.
  const body = `event: message_start
data: {"type":"message_start","message":{"id":"fixture","usage":{"input_tokens":13,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":3,"content_block":{"type":"thinking","thinking":"Complete","signature":"signed-complete"}}

event: content_block_stop
data: {"type":"content_block_stop","index":3}

event: content_block_start
data: {"type":"content_block_start","index":7,"content_block":{"type":"redacted_thinking","data":"opaque-redacted"}}

event: content_block_start
data: {"type":"content_block_start","index":11,"content_block":{"type":"thinking","thinking":"Unfinished","signature":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":11,"delta":{"type":"signature_delta","signature":"incomplete-signature"}}

`;
  const model = {
    ...fauxProvider().getModel(),
    api: "anthropic-messages" as const,
    provider: "anthropic",
    baseUrl: "https://fixture.invalid",
  };
  let requests = 0;
  const result = await anthropicStream(
    model,
    normalizeContext({ messages: [] }),
    {
      apiKey: "fixture",
      maxRetries: 0,
      fetch: Object.assign(
        async () => {
          requests++;
          return new Response(body, {
            headers: { "content-type": "text/event-stream" },
          });
        },
        { preconnect: fetch.preconnect },
      ),
    },
  ).result();
  expect(requests).toBe(1);
  expect(result).toMatchObject({
    stopReason: "error",
    usageReported: true,
    usage: { input: 13, output: 0 },
  });
  expect(result.errorMessage).toContain("before message_stop");
  expect(result.content).toEqual([
    {
      type: "thinking",
      thinking: "Complete",
      thinkingSignature: "signed-complete",
    },
    {
      type: "thinking",
      thinking: "[Reasoning redacted]",
      thinkingSignature: "opaque-redacted",
      redacted: true,
    },
    { type: "thinking", thinking: "Unfinished" },
  ]);
});
