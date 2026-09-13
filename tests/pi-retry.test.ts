import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import {
  retryAssistantCall,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";

const proxyCompatibility = { supportsStrictMode: true, codexProxyAuth: true };
const model: Model<"openai-codex-responses"> = {
  id: "retry-fixture",
  name: "Retry fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://proxy.invalid/backend-api",
  reasoning: false,
  input: ["text"],
  contextWindow: 20_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: proxyCompatibility,
};

async function retry(
  kind: "codex" | "assistant",
  signal: AbortSignal,
  delay: number,
) {
  let calls = 0;
  let result: AssistantMessage;
  if (kind === "codex") {
    const stubFetch: typeof fetch = Object.assign(
      async () => {
        if (calls++ === 0)
          return new Response("Service unavailable", {
            status: 503,
            headers: { "retry-after-ms": String(delay) },
          });
        return new Response(
          "data: " +
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "retry-success",
                status: "completed",
                output: [],
                usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
              },
            }) +
            "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { preconnect: fetch.preconnect },
    );
    result = await streamSimple(
      model,
      { messages: [] },
      {
        apiKey: "offline-proxy-key",
        transport: "sse",
        fetch: stubFetch,
        maxRetries: 1,
        signal,
      },
    ).result();
  } else {
    result = await retryAssistantCall(
      async () => ({
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: calls++ === 0 ? "error" : "stop",
        errorMessage: "503 Service unavailable",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      }),
      { enabled: true, maxRetries: 1, baseDelayMs: delay },
      signal,
    );
  }
  return { result, calls };
}

test.each(["codex", "assistant"] as const)(
  "%s retries release completed backoff listeners",
  async (kind) => {
    const controller = new AbortController();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { result, calls } = await retry(kind, controller.signal, 1);
      expect(result.stopReason).toBe("stop");
      expect(calls).toBe(2);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    }
  },
);

test.each(["codex", "assistant"] as const)(
  "%s retries cancel backoff and release listeners",
  async (kind) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      const { result, calls } = await retry(kind, controller.signal, 1000);
      expect(result.stopReason).toBe("aborted");
      expect(calls).toBe(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      clearTimeout(timer);
    }
  },
);
