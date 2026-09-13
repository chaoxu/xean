import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { z } from "zod";
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-agent-core";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";

import { createCampaign, defineTool } from "../src";
import { derivePiSpend, piRequestAttempts, runPi } from "../src/pi";
import { ReasoningRecovery } from "../src/pi-recovery";

const platformModel: Model<"openai-responses"> = {
  id: "test-recovery",
  name: "Recovery test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://invalid.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};
const codexModel: Model<"openai-codex-responses"> = {
  ...platformModel,
  api: "openai-codex-responses",
  provider: "openai-codex",
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function campaign() {
  const directory = mkdtempSync(join(tmpdir(), "xean-recovery-"));
  directories.push(directory);
  return createCampaign(join(directory, "campaign.db"), "recovery-test", null);
}

type WireItem = Record<string, unknown>;
type WireEvent = Record<string, unknown>;

function reasoning(id: string): WireItem {
  return {
    type: "reasoning",
    id,
    status: "completed",
    summary: [{ type: "summary_text", text: `Completed ${id}` }],
    encrypted_content: `opaque/${id}+bytes==`,
  };
}

function itemDone(item: WireItem, output_index: number): WireEvent[] {
  return [
    { type: "response.output_item.added", output_index, item },
    { type: "response.output_item.done", output_index, item },
  ];
}

function toolItem(id: string, value: number): WireItem {
  return {
    type: "function_call",
    id: `fc_${id}`,
    call_id: id,
    name: "record",
    arguments: JSON.stringify({ value }),
    status: "completed",
  };
}

function completed(output: WireItem[]): WireEvent {
  return {
    type: "response.completed",
    response: {
      id: "resp_completed",
      model: platformModel.id,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };
}

const dropped: WireEvent = {
  type: "response.failed",
  response: {
    status: "failed",
    error: {
      code: "stream_incomplete",
      message: "Upstream closed stream without completion",
    },
  },
};

function incomplete(reason: string, output: WireItem[] = []): WireEvent {
  return {
    type: "response.incomplete",
    response: {
      id: "resp_incomplete",
      model: platformModel.id,
      status: "incomplete",
      incomplete_details: { reason },
      output,
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
  };
}

function textReply(text: string): WireEvent[] {
  const item = {
    type: "message",
    id: "msg_answer",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [...itemDone(item, 0), completed([item])];
}

function scriptedAdapter(
  model: typeof platformModel | typeof codexModel,
  replies: WireEvent[][],
) {
  let fetches = 0;
  const sent: WireItem[] = [];
  const stubFetch: typeof fetch = Object.assign(
    async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const request =
        args[0] instanceof Request
          ? new Request(args[0], args[1])
          : new Request(args[0].toString(), args[1]);
      const bytes = Buffer.from(await request.arrayBuffer());
      const body =
        request.headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(bytes).toString("utf8")
          : bytes.toString("utf8");
      sent.push(JSON.parse(body) as WireItem);
      const events = replies[fetches++];
      if (events === undefined) throw new Error("unexpected extra request");
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { preconnect: fetch.preconnect },
  );
  const apiKey = `stub.${Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
    }),
  ).toString("base64url")}.stub`;
  const models: Pick<Models, "streamSimple"> = {
    streamSimple(_requested, context, options) {
      const configured = {
        ...options,
        apiKey,
        transport: "sse" as const,
        maxRetries: 0,
        fetch: stubFetch,
      };
      return model.api === "openai-responses"
        ? streamResponses(model, context, configured)
        : streamCodex(model, context, configured);
    },
  };
  return { models, sent };
}

function input(payload: unknown): WireItem[] {
  return z
    .object({ input: z.array(z.record(z.string(), z.unknown())) })
    .parse(payload).input;
}

describe.each([platformModel, codexModel])(
  "$api interrupted reasoning",
  (model) => {
    test.each(["stream failure", "max_messages"])(
      "replays only completed encrypted reasoning and never executes failed tools after %s",
      async (failure) => {
        const store = campaign();
        const checkpoint = reasoning("rs_checkpoint");
        const unsigned = {
          ...reasoning("rs_unsigned"),
          encrypted_content: null,
        };
        const failedTool = toolItem("failed_tool", 99);
        const validTool = toolItem("valid_tool", 7);
        const adapter = scriptedAdapter(model, [
          [
            ...itemDone(checkpoint, 0),
            ...itemDone(unsigned, 1),
            {
              type: "response.output_item.added",
              output_index: 2,
              item: { type: "reasoning", id: "rs_unfinished", summary: [] },
            },
            {
              type: "response.reasoning_summary_text.delta",
              output_index: 2,
              delta: "Unfinished private plan",
            },
            { type: "response.reasoning_summary_part.done", output_index: 2 },
            {
              type: "response.output_item.added",
              output_index: 3,
              item: { type: "message", id: "msg_partial", content: [] },
            },
            {
              type: "response.output_text.delta",
              output_index: 3,
              delta: "Unfinished public answer",
            },
            ...itemDone(failedTool, 4),
            failure === "max_messages"
              ? incomplete("max_messages", [checkpoint, unsigned, failedTool])
              : dropped,
          ],
          [...itemDone(validTool, 0), completed([validTool])],
        ]);
        const executed: number[] = [];
        const record = defineTool({
          name: "record",
          description: "Record one value",
          input: z.strictObject({ value: z.number() }),
          replay: "safe",
          async run({ value }) {
            executed.push(value);
            return { recorded: value };
          },
        });
        const result = await runPi(store, {
          models: adapter.models,
          model,
          label: "recovery/signed",
          prompt: "Record 7 after reasoning",
          tools: [record],
          stopAfterToolResult: true,
          maxRecoveries: 1,
        });

        expect(result.state).toBe("succeeded");
        expect(result.text).toBe("");
        expect(executed).toEqual([7]);
        expect(adapter.sent).toHaveLength(2);
        expect(input(adapter.sent[1])).toEqual([
          ...input(adapter.sent[0]),
          checkpoint,
        ]);
        const requests = piRequestAttempts(store.records(), result.call, store);
        expect(requests).toHaveLength(2);
        expect(requests[1]?.payload as unknown).toEqual(adapter.sent[1]);
        expect(result.transcript).toMatchObject([
          { role: "user" },
          {
            role: "assistant",
            stopReason: "error",
            content: [
              {
                type: "thinking",
                thinkingSignature: JSON.stringify(checkpoint),
              },
              { type: "thinking" },
              { type: "thinking", thinking: "Unfinished private plan\n\n" },
              { type: "text", text: "Unfinished public answer" },
              { type: "toolCall", name: "record", arguments: { value: 99 } },
            ],
          },
          { role: "assistant", stopReason: "toolUse" },
          { role: "toolResult", isError: false },
        ]);
        expect(
          result.telemetry.spans
            .filter(({ name }) => name === "pi.ai.request")
            .map(({ status, attributes }) => ({
              status: status.status,
              stop: attributes["pi.ai.response.stop_reason"],
            })),
        ).toEqual([
          { status: "error", stop: "error" },
          { status: "ok", stop: "tool_use" },
        ]);
        expect(
          derivePiSpend(store.records()).summary.logicalProviderRequests,
        ).toBe(2);
      },
    );

    test.each([false, true])(
      "max_messages keeps completed reasoning while consuming the error budget (gate=%s)",
      async (gated) => {
        const checkpoints = Array.from({ length: 10 }, (_, index) =>
          reasoning(`rs_limit_${index}`),
        );
        const terminal = {
          ...toolItem("completed_limit", 7),
          arguments: JSON.stringify({ value: 7, solution: true }),
        };
        const adapter = scriptedAdapter(model, [
          ...checkpoints.map((checkpoint) => [
            ...itemDone(checkpoint, 0),
            incomplete("max_messages", [checkpoint]),
          ]),
          [...itemDone(terminal, 0), completed([terminal])],
        ]);
        const executed: number[] = [];
        const store = campaign();
        const result = await runPi(store, {
          models: adapter.models,
          model,
          label: "recovery/message-limit-progress",
          prompt: "Record 7 after reasoning",
          tools: [
            defineTool({
              name: "record",
              description: "Record the completed result",
              input: z.strictObject({
                value: z.number(),
                solution: z.boolean(),
              }),
              replay: "safe",
              async run({ value }) {
                executed.push(value);
                return null;
              },
            }),
          ],
          stopAfterToolResult: true,
          maxRecoveries: 1,
          maxLengthContinuations: 1,
          ...(gated
            ? {
                submissionGate: {
                  completeArgument: "solution",
                  reserveTokens: 2000,
                  continuationPrompt: "Keep trying, you can do it.",
                },
              }
            : {}),
        });
        expect(result.state).toBe("failed");
        expect(adapter.sent).toHaveLength(2);
        expect(input(adapter.sent.at(-1))).toEqual([
          ...input(adapter.sent[0]),
          ...checkpoints.slice(0, 1).flatMap((checkpoint) =>
            gated
              ? [
                  checkpoint,
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_text",
                        text: "Keep trying, you can do it.",
                      },
                    ],
                  },
                ]
              : [checkpoint],
          ),
        ]);
        expect(executed).toEqual([]);
        expect(derivePiSpend(store.records()).summary.requestErrors).toBe(2);
      },
    );

    test.each([false, true])(
      "max_messages with a checkpoint stops at exhausted context (gate=%s)",
      async (gated) => {
        const checkpoint = reasoning("rs_limit_full");
        const ending = incomplete("max_messages", [checkpoint]);
        (ending.response as WireItem).usage = {
          input_tokens: model.contextWindow,
          output_tokens: 5,
          total_tokens: model.contextWindow + 5,
        };
        const adapter = scriptedAdapter(model, [
          [...itemDone(checkpoint, 0), ending],
        ]);
        const result = await runPi(campaign(), {
          models: adapter.models,
          model,
          label: "recovery/message-limit-full",
          prompt: "Reason",
          maxRecoveries: 1,
          maxLengthContinuations: 1,
          ...(gated
            ? {
                tools: [
                  defineTool({
                    name: "record",
                    description: "Record",
                    input: z.strictObject({ solution: z.boolean() }),
                    replay: "safe",
                    async run() {
                      return null;
                    },
                  }),
                ],
                stopAfterToolResult: true,
                submissionGate: {
                  completeArgument: "solution",
                  reserveTokens: 2000,
                },
              }
            : {}),
        });
        expect(result.state).toBe("failed");
        expect(adapter.sent).toHaveLength(1);
      },
    );

    test("max_messages respects a gate budget below the model capacity", async () => {
      const checkpoint = reasoning("rs_limit_budget");
      const ending = incomplete("max_messages", [checkpoint]);
      (ending.response as WireItem).usage = {
        input_tokens: 20_000,
        output_tokens: 5,
        total_tokens: 20_005,
      };
      const largerModel = { ...model, contextWindow: 100_000 };
      const adapter = scriptedAdapter(largerModel, [
        [...itemDone(checkpoint, 0), ending],
      ]);
      const result = await runPi(campaign(), {
        models: adapter.models,
        model: largerModel,
        label: "recovery/message-limit-budget",
        prompt: "Reason",
        tools: [
          defineTool({
            name: "record",
            description: "Record the result",
            input: z.strictObject({ solution: z.boolean() }),
            replay: "safe",
            async run() {
              return null;
            },
          }),
        ],
        stopAfterToolResult: true,
        maxRecoveries: 1,
        maxLengthContinuations: 1,
        submissionGate: {
          completeArgument: "solution",
          reserveTokens: 2000,
          contextBudgetTokens: 20_000,
        },
      });
      expect(result.state).toBe("failed");
      expect(adapter.sent).toHaveLength(1);
    });

    test("repeated max_messages checkpoints exhaust the no-progress error budget", async () => {
      const store = campaign();
      const first = reasoning("rs_limit_first");
      const adapter = scriptedAdapter(model, [
        [...itemDone(first, 0), incomplete("max_messages", [first])],
        [...itemDone(first, 0), incomplete("max_messages", [first])],
        [...itemDone(first, 0), incomplete("max_messages", [first])],
      ]);
      const result = await runPi(store, {
        models: adapter.models,
        model,
        label: "recovery/message-limit",
        prompt: "Continue reasoning",
        maxRecoveries: 1,
        maxLengthContinuations: 8,
      });
      expect(result).toMatchObject({
        state: "failed",
        providerRetryable: true,
        truncated: false,
        error: "Response incomplete: max_messages",
        text: "",
      });
      expect(adapter.sent).toHaveLength(2);
      expect(input(adapter.sent[1])).toEqual([
        ...input(adapter.sent[0]),
        first,
      ]);
      expect(result.transcript).toMatchObject([
        { role: "user" },
        { stopReason: "error", rawStopReason: "incomplete.max_messages" },
        { stopReason: "error", rawStopReason: "incomplete.max_messages" },
      ]);
      expect(piRequestAttempts(store.records(), result.call)).toHaveLength(2);
    });

    test.each(["content_filter", "unknown_limit"])(
      "does not retry incomplete.%s",
      async (reason) => {
        const adapter = scriptedAdapter(model, [[incomplete(reason)]]);
        const result = await runPi(campaign(), {
          models: adapter.models,
          model,
          label: "recovery/other-incomplete",
          prompt: "Reason",
          maxRecoveries: 1,
          maxLengthContinuations: 8,
        });
        expect(result).toMatchObject({
          state: "failed",
          providerRetryable: false,
          truncated: false,
        });
        expect(adapter.sent).toHaveLength(1);
      },
    );

    test("keeps multiple checkpoints ordered, preserves prior tool results, and isolates calls", async () => {
      const store = campaign();
      const first = reasoning("rs_first");
      const second = reasoning("rs_second");
      const initialTool = toolItem("initial_tool", 3);
      const adapter = scriptedAdapter(model, [
        [...itemDone(initialTool, 0), completed([initialTool])],
        [...itemDone(first, 0), dropped],
        [...itemDone(first, 0), ...itemDone(second, 1), dropped],
        textReply("Recovered"),
        textReply("Fresh call"),
      ]);
      const executed: number[] = [];
      const record = defineTool({
        name: "record",
        description: "Record one value",
        input: z.strictObject({ value: z.number() }),
        replay: "safe",
        async run({ value }) {
          executed.push(value);
          return { recorded: value };
        },
      });
      const recovered = await runPi(store, {
        models: adapter.models,
        model,
        label: "recovery/multiple",
        prompt: "Record once, then reason",
        tools: [record],
        maxRecoveries: 2,
      });
      expect(recovered).toMatchObject({
        state: "succeeded",
        text: "Recovered",
      });
      expect(executed).toEqual([3]);
      const prior = input(adapter.sent[1]);
      expect(prior.map(({ type }) => type).filter(Boolean)).toEqual([
        "function_call",
        "function_call_output",
      ]);
      expect(input(adapter.sent[2])).toEqual([...prior, first]);
      expect(input(adapter.sent[3])).toEqual([...prior, first, second]);
      expect(recovered.transcript).toMatchObject([
        { role: "user" },
        { role: "assistant", stopReason: "toolUse" },
        { role: "toolResult" },
        { role: "assistant", stopReason: "error" },
        { role: "assistant", stopReason: "error" },
        { role: "assistant", stopReason: "stop" },
      ]);
      const fresh = await runPi(store, {
        models: adapter.models,
        model,
        label: "recovery/fresh",
        prompt: "Start over",
      });
      expect(fresh).toMatchObject({ state: "succeeded", text: "Fresh call" });
      expect(input(adapter.sent[4])).toEqual([
        { role: "user", content: [{ type: "input_text", text: "Start over" }] },
      ]);
      expect(piRequestAttempts(store.records(), recovered.call)).toHaveLength(
        4,
      );
      expect(piRequestAttempts(store.records(), fresh.call)).toHaveLength(1);
    });

    test("does not turn completed reasoning into success when retries are disabled", async () => {
      const store = campaign();
      const checkpoint = reasoning("rs_exhausted");
      const adapter = scriptedAdapter(model, [
        [...itemDone(checkpoint, 0), dropped],
      ]);
      const result = await runPi(store, {
        models: adapter.models,
        model,
        label: "recovery/exhausted",
        prompt: "Reason without retries",
      });
      expect(result).toMatchObject({ state: "failed", text: "" });
      expect(adapter.sent).toHaveLength(1);
      expect(result.transcript).toMatchObject([
        { role: "user" },
        {
          role: "assistant",
          stopReason: "error",
          content: [
            { type: "thinking", thinkingSignature: JSON.stringify(checkpoint) },
          ],
        },
      ]);
    });
  },
);

function failedMessage(model: Model<Api>, signature: string): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [
      { type: "thinking", thinking: "Completed", thinkingSignature: signature },
    ],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "stream_incomplete",
    timestamp: 0,
  };
}

describe("reasoning recovery admission", () => {
  test("snapshots a completed event, deduplicates its ID, and leaves the failed original unchanged", () => {
    const recovery = new ReasoningRecovery();
    const signature = JSON.stringify(reasoning("rs_snapshot"));
    const message = failedMessage(platformModel, signature);
    const observation = recovery.observe(platformModel);
    const event = {
      type: "thinking_end" as const,
      partial: message,
      contentIndex: 0,
      content: "Completed",
    };
    observation.event(event);
    observation.event(event);
    message.content[0] = { type: "thinking", thinking: "Changed after event" };
    observation.settle(message);
    expect(recovery.forModel([message])).toMatchObject([
      {
        stopReason: "stop",
        content: [
          {
            type: "thinking",
            thinking: "Completed",
            thinkingSignature: signature,
          },
        ],
      },
    ]);
    expect(message.stopReason).toBe("error");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "Changed after event" },
    ]);
    expect(recovery.forModel([{ ...message }])).toEqual([]);
  });

  test.each([
    ["invalid JSON", "{"],
    [
      "unsigned",
      JSON.stringify({ ...reasoning("rs_bad"), encrypted_content: undefined }),
    ],
    [
      "empty encrypted content",
      JSON.stringify({ ...reasoning("rs_bad"), encrypted_content: "" }),
    ],
    [
      "in-progress item",
      JSON.stringify({ ...reasoning("rs_bad"), status: "in_progress" }),
    ],
    [
      "non-reasoning item",
      JSON.stringify({ ...reasoning("rs_bad"), type: "message" }),
    ],
  ])("rejects %s", (_name, signature) => {
    const recovery = new ReasoningRecovery();
    const message = failedMessage(platformModel, signature!);
    const observation = recovery.observe(platformModel);
    observation.event({
      type: "thinking_end",
      partial: message,
      contentIndex: 0,
      content: "Completed",
    });
    observation.settle(message);
    expect(recovery.forModel([message])).toEqual([]);
  });

  test.each(["api", "provider", "model", "responseModel"] as const)(
    "does not salvage a failed message with mismatched %s",
    (field) => {
      const recovery = new ReasoningRecovery();
      const message = failedMessage(
        platformModel,
        JSON.stringify(reasoning("rs_mismatch")),
      );
      const observation = recovery.observe(platformModel);
      observation.event({
        type: "thinking_end",
        partial: message,
        contentIndex: 0,
        content: "Completed",
      });
      Object.assign(message, { [field]: "different" });
      observation.settle(message);
      expect(recovery.forModel([message])).toEqual([]);
    },
  );

  test("does not recover signatures without a completion event, foreign APIs, or cancelled responses", () => {
    for (const mode of ["unfinished", "foreign", "aborted"] as const) {
      const recovery = new ReasoningRecovery();
      const model: Model<Api> =
        mode === "foreign"
          ? { ...platformModel, api: "anthropic-messages" }
          : platformModel;
      const message = failedMessage(
        model,
        JSON.stringify(reasoning("rs_rejected")),
      );
      const observation = recovery.observe(model);
      if (mode !== "unfinished") {
        observation.event({
          type: "thinking_end",
          partial: message,
          contentIndex: 0,
          content: "Completed",
        });
      }
      if (mode === "aborted") message.stopReason = "aborted";
      observation.settle(message);
      const messages = convertToLlm(recovery.forModel([message]));
      expect(
        convertResponsesMessages(
          platformModel,
          { messages },
          new Set([platformModel.provider]),
        ),
      ).toEqual([]);
    }
  });
});
