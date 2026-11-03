import { expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";

const model: Model<"openai-codex-responses"> = {
  id: "fixture",
  name: "Fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://invalid.example",
  input: ["text"],
  reasoning: false,
  contextWindow: 65_536,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({
  messages: [{ role: "user", content: "Say P.", timestamp: 0 }],
});
// A synthetic account claim reaches request construction without consulting credentials.
const apiKey = `e30.${Buffer.from(
  JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
  }),
).toString("base64url")}.fixture`;

async function capture(selected: typeof model, maxTokens?: number) {
  let payload: unknown;
  const result = await streamSimple(selected, context, {
    apiKey,
    transport: "sse",
    ...(maxTokens === undefined ? {} : { maxTokens }),
    onPayload(value) {
      payload = value;
      // Stop after the real adapter builds its body and before any HTTP request.
      throw new Error("request captured without network");
    },
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("request captured without network");
  expect(payload).toBeDefined();
  return payload as Record<string, unknown>;
}

test("Codex adapter owns explicit and default output limits", async () => {
  const selected = { ...model, compat: { supportsMaxOutputTokens: true } };
  expect((await capture(selected, 128)).max_output_tokens).toBe(128);
  expect((await capture(selected)).max_output_tokens).toBe(model.maxTokens);
});

test("Codex output limit stays omitted without explicit compatibility opt-in", async () => {
  const baseline = await capture(model);
  expect(baseline).not.toHaveProperty("max_output_tokens");
  expect(await capture(model, 128)).toEqual(baseline);
  expect(
    await capture(
      { ...model, compat: { supportsMaxOutputTokens: false } },
      128,
    ),
  ).toEqual(baseline);
});
