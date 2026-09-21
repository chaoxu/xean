import { expect, test } from "bun:test";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";

import type { PiRunOptions } from "xean/pi";

import { withSerialToolCalls } from "../serial-tools";
import type { SolveModels } from "../solve";

const platformModel: PiRunOptions["model"] = {
  id: "gpt-platform-test",
  name: "Test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://pool.test/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};
const codexModel: PiRunOptions["model"] = {
  ...platformModel,
  id: "gpt-codex-test",
  api: "openai-codex-responses",
  provider: "openai-codex",
};
const foreignModel: PiRunOptions["model"] = {
  ...platformModel,
  id: "foreign-test",
  api: "anthropic-messages",
  provider: "anthropic",
};

function fakeModels(observed: { options?: unknown }): SolveModels {
  return {
    getModel(provider, id) {
      return [platformModel, codexModel, foreignModel].find(
        (model) => model.provider === provider && model.id === id,
      );
    },
    streamSimple(_model, _context, options) {
      observed.options = options;
      throw new Error("stream not exercised");
    },
  };
}

async function observedRewrite(
  model: PiRunOptions["model"],
  payload: unknown,
): Promise<unknown> {
  const observed: { options?: unknown } = {};
  const models = withSerialToolCalls(fakeModels(observed));
  expect(() =>
    models.streamSimple(
      model,
      { messages: [] },
      {
        onPayload: async (sent) => sent,
      },
    ),
  ).toThrow("stream not exercised");
  const options = observed.options as {
    onPayload?: (payload: unknown, model: unknown) => Promise<unknown>;
  };
  return options.onPayload!(payload, model);
}

test("openai platform payloads require one serial terminal tool", async () => {
  expect(
    await observedRewrite(platformModel, { model: "m", tools: [{}] }),
  ).toEqual({
    model: "m",
    tools: [{}],
    tool_choice: "required",
    parallel_tool_calls: false,
  });
});

test("payloads without tools stay untouched", async () => {
  expect(await observedRewrite(platformModel, { model: "m" })).toEqual({
    model: "m",
  });
});

test("empty tool declarations are never required", async () => {
  expect(
    await observedRewrite(platformModel, { model: "m", tools: [] }),
  ).toEqual({ model: "m", tools: [], parallel_tool_calls: false });
});

test("codex payloads have parallel_tool_calls forced to false", async () => {
  expect(
    await observedRewrite(codexModel, {
      model: "m",
      tools: [{}],
      parallel_tool_calls: true,
    }),
  ).toEqual({
    model: "m",
    tools: [{}],
    tool_choice: "required",
    parallel_tool_calls: false,
  });
});

test.each([
  [
    "hoists a leading developer message into instructions",
    platformModel,
    {
      model: "m",
      input: [
        { role: "developer", content: "System role text." },
        { role: "user", content: "Hi" },
      ],
    },
    {
      model: "m",
      instructions: "System role text.",
      input: [{ role: "user", content: "Hi" }],
    },
  ],
  [
    "leaves populated instructions untouched",
    platformModel,
    {
      instructions: "Already set.",
      input: [{ role: "developer", content: "kept in place" }],
    },
    {
      instructions: "Already set.",
      input: [{ role: "developer", content: "kept in place" }],
    },
  ],
  [
    "does not hoist for the codex adapter",
    codexModel,
    { input: [{ role: "developer", content: "kept in place" }] },
    { input: [{ role: "developer", content: "kept in place" }] },
  ],
])("%s", async (_name, model, payload, expected) => {
  expect(await observedRewrite(model, payload)).toEqual(expected);
});

test.each([
  [platformModel, "sse"],
  [codexModel, "auto"],
])("$api streams over its transport", (model, transport) => {
  const observed: { options?: unknown } = {};
  const models = withSerialToolCalls(fakeModels(observed));
  expect(() =>
    models.streamSimple(model, { messages: [] }, { transport: "websocket" }),
  ).toThrow("stream not exercised");
  expect(observed.options).toMatchObject({ transport });
});

test("getModel passes through unchanged", () => {
  const observed: { options?: unknown } = {};
  const models = withSerialToolCalls(fakeModels(observed));
  expect(models.getModel("openai", "gpt-platform-test")).toBe(platformModel);
});

test("non-openai APIs stream with untouched options", () => {
  const observed: { options?: unknown } = {};
  const models = withSerialToolCalls(fakeModels(observed));
  expect(() => models.streamSimple(foreignModel, { messages: [] }, {})).toThrow(
    "stream not exercised",
  );
  expect(observed.options).toEqual({});
});

test.each([platformModel, codexModel])(
  "$api sends custom Astra reasoning and terminal tool controls before checkpointing",
  async (baseModel) => {
    const model: PiRunOptions["model"] = {
      ...baseModel,
      id: "gpt-6-astra",
      compat: { supportsMaxOutputTokens: true },
      thinkingLevelMap: {
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    };
    const apiKey = `stub.${Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
      }),
    ).toString("base64url")}.stub`;
    const models = withSerialToolCalls({
      getModel: () => model,
      streamSimple(_model, context, options) {
        const configured = { ...options, apiKey, transport: "sse" as const };
        return model.api === "openai-responses"
          ? streamResponses(
              model as Parameters<typeof streamResponses>[0],
              context,
              configured,
            )
          : streamCodexResponses(
              model as Parameters<typeof streamCodexResponses>[0],
              context,
              configured,
            );
      },
    });
    for (const tools of [
      undefined,
      [],
      [
        {
          name: "submit",
          description: "Submit the result",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    ]) {
      let checkpoint: unknown;
      const stream = models.streamSimple(
        model,
        {
          messages: [
            { role: "user", content: "Submit the result", timestamp: 0 },
          ],
          ...(tools === undefined ? {} : { tools }),
        },
        {
          reasoning: "max",
          maxTokens: 321,
          onPayload(payload) {
            checkpoint = payload;
            throw new Error("stopped before transport");
          },
        },
      );
      expect((await stream.result()).stopReason).toBe("error");
      expect(checkpoint).toMatchObject({
        model: "gpt-6-astra",
        reasoning: { effort: "max" },
        max_output_tokens: 321,
      });
      if (tools?.length) {
        expect(checkpoint).toMatchObject({
          tool_choice: "required",
          parallel_tool_calls: false,
        });
      } else {
        expect(checkpoint).not.toMatchObject({ tool_choice: "required" });
      }
    }
  },
);
