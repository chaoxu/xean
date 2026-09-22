import { expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai";
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

test.each([
  [platformModel, "sse"],
  [codexModel, "auto"],
  [foreignModel, "websocket"],
])("$api streams over its transport", (model, transport) => {
  const observed: { options?: unknown } = {};
  const models = withSerialToolCalls(fakeModels(observed));
  const options = { transport: "websocket" as const };
  expect(() => models.streamSimple(model, { messages: [] }, options)).toThrow(
    "stream not exercised",
  );
  expect(observed.options).toMatchObject({ transport });
  if (model === foreignModel) expect(observed.options).toBe(options);
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
              normalizeContext(context),
              configured,
            )
          : streamCodexResponses(
              model as Parameters<typeof streamCodexResponses>[0],
              normalizeContext(context),
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
            {
              role: "system",
              content: "Stable role definition.",
              ...(tools === undefined ? {} : { toolsAdded: tools }),
              timestamp: 0,
            },
            { role: "user", content: "Submit the result", timestamp: 0 },
          ],
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
        instructions: "Stable role definition.",
      });
      expect(
        (checkpoint as { input: { role?: string }[] }).input.some(
          ({ role }) => role === "developer",
        ),
      ).toBe(false);
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
