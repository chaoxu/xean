import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  cleanupSessionResources,
  createModels,
  fauxAssistantMessage,
  isRetryableAssistantError,
  normalizeContext,
  retryAssistantCall,
  type Model,
} from "@earendil-works/pi-ai";
import { streamSimple as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as codex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { verifyInstall } from "../scripts/dependencies.ts";

const transcript = normalizeContext({
  messages: [{ role: "user", content: "Fixture", timestamp: 0 }],
});
const jwt = `fixture.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }))}.signature`;
const model: Model<"openai-responses"> = {
  id: "fixture",
  name: "Fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://fixture.invalid",
  reasoning: false,
  input: ["text"],
  contextWindow: 20000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const codexModel = {
  ...model,
  api: "openai-codex-responses" as const,
  provider: "openai-codex",
};
const mockFetch = (
  run: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch => Object.assign(run, { preconnect: fetch.preconnect });
const terminal = (status = "completed", extra = {}) => ({
  type: `response.${status}`,
  response: { id: "fixture", status, output: [], ...extra },
});
function sse(events: object[], newline = "\n", fragmented = false) {
  const bytes = new TextEncoder().encode(
    events
      .map(
        (event) =>
          `event: ${(event as { type: string }).type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`,
      )
      .join(""),
  );
  return new Response(
    fragmented
      ? new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        })
      : bytes,
    { headers: { "content-type": "text/event-stream" } },
  );
}
const options = { apiKey: jwt, transport: "sse" as const, maxRetries: 0 };
function call(
  useCodex: boolean,
  events: object[],
  newline = "\n",
  fragmented = false,
) {
  const request = {
    ...options,
    fetch: mockFetch(async () => sse(events, newline, fragmented)),
  };
  return (
    useCodex
      ? codex(codexModel, transcript, request)
      : responses(model, transcript, request)
  ).result();
}

test.each([false, true])(
  "Responses message limits remain separate from token limits and terminal errors (Codex=%s)",
  async (useCodex) => {
    for (const reason of [
      "max_messages",
      "max_output_tokens",
      "max_messages_extra",
      "content_filter",
    ]) {
      const result = await call(useCodex, [
        terminal("incomplete", { incomplete_details: { reason } }),
      ]);
      expect(result.rawStopReason).toBe(`incomplete.${reason}`);
      expect(result.stopReason).toBe(
        reason === "max_output_tokens" ? "length" : "error",
      );
      expect(isRetryableAssistantError(result)).toBe(reason === "max_messages");
      if (reason === "max_messages") {
        for (const code of [
          "context_length_exceeded",
          "insufficient_quota",
          "authentication_error",
          "invalid_request_error",
        ])
          expect(
            isRetryableAssistantError({ ...result, providerError: { code } }),
          ).toBe(false);
      }
    }
  },
);

test("HTTP status survives adapter catches for native retry classification", async () => {
  const original = globalThis.fetch;
  try {
    for (const provider of [
      openaiProvider(),
      anthropicProvider(),
      googleProvider(),
    ]) {
      const models = createModels();
      models.setProvider(provider);
      const selected = provider.getModels().find((model) => model.reasoning)!;
      for (const status of [401, 404, 529]) {
        globalThis.fetch = mockFetch(async () =>
          Response.json(
            {
              error: {
                message:
                  status === 529
                    ? "Opaque detail 401 403"
                    : "Invalid timeout configuration",
              },
            },
            { status },
          ),
        );
        const result = await models.completeSimple(selected, transcript, {
          apiKey: "fixture",
          maxRetries: 0,
        });
        expect(result.providerError).toEqual({ status });
        expect(isRetryableAssistantError(result)).toBe(status === 529);
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("terminal usage distinguishes zero from absence without backfilling failed reasoning", async () => {
  const item = {
    type: "reasoning",
    id: "reasoning",
    summary: [{ type: "summary_text", text: "Partial reasoning" }],
  };
  for (const useCodex of [false, true]) {
    for (const status of ["completed", "failed"]) {
      const result = await call(useCodex, [
        { type: "response.output_item.done", output_index: 0, item },
        terminal(status, {
          output: [{ ...item, encrypted_content: "terminal-only" }],
          error: { code: "invalid_request_error", message: "Fixture failure" },
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            total_tokens: 105,
            input_tokens_details: { cached_tokens: 40 },
          },
        }),
      ]);
      expect(result.stopReason).toBe(status === "failed" ? "error" : "stop");
      expect(result.usageReported).toBe(true);
      expect(result.usage).toMatchObject({
        input: 60,
        cacheRead: 40,
        output: 5,
        totalTokens: 105,
      });
      const thinking = result.content.find(
        (block) => block.type === "thinking",
      )!;
      expect(JSON.parse(thinking.thinkingSignature!).encrypted_content).toBe(
        status === "failed" ? undefined : "terminal-only",
      );
    }
    for (const usage of [
      undefined,
      {},
      { input_tokens: "5" },
      { input_tokens: 0 },
    ]) {
      const result = await call(useCodex, [terminal("completed", { usage })]);
      expect(result.usageReported === true).toBe(usage?.input_tokens === 0);
    }
  }
  const original = globalThis.fetch;
  const provider = anthropicProvider();
  const selected = provider.getModels().find((model) => model.reasoning)!;
  try {
    for (const usage of [{}, { input_tokens: 0 }]) {
      globalThis.fetch = mockFetch(async () =>
        sse([
          {
            type: "message_start",
            message: { id: "fixture", model: selected.id, usage },
          },
          { type: "message_delta", delta: {}, usage: {} },
          {
            type: "error",
            error: { type: "api_error", message: "Fixture failure" },
          },
        ]),
      );
      const result = await provider
        .streamSimple(selected, transcript, {
          apiKey: "fixture",
          maxRetries: 0,
        })
        .result();
      expect(result.usageReported === true).toBe(usage.input_tokens === 0);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Codex preserves account limits and switches transient WebSocket failures to HTTP", async () => {
  for (const [status, code, retry] of [
    [429, "usage_limit_reached", false],
    [429, "usage_not_included", false],
    [429, "rate_limit_exceeded", true],
    [401, "future_error", false],
    [403, "future_error", false],
    [529, "future_error", true],
  ] as const) {
    let requests = 0;
    const result = await codex(codexModel, transcript, {
      ...options,
      maxRetries: 1,
      fetch: mockFetch(async () => {
        requests++;
        return Response.json(
          {
            error: {
              code,
              type: "rate_limit_error",
              message: "Timeout detail",
            },
          },
          { status, headers: { "retry-after-ms": "0" } },
        );
      }),
    }).result();
    expect(result.providerError).toEqual({
      status,
      type: "rate_limit_error",
      code,
    });
    expect(isRetryableAssistantError(result)).toBe(retry);
    expect(requests).toBe(retry ? 2 : 1);
    expect(result.errorMessage?.includes("ChatGPT usage limit")).toBe(
      code.startsWith("usage_"),
    );
  }
  for (const [errorMessage, retry] of [
    ["JSON Parse error: Unterminated string", false],
    ["Connection terminated unexpectedly", true],
    ["The pending stream has been canceled", true],
    ["invalid_request_error: timeout", false],
    ["project_spend_limit_exceeded: 429", false],
    ["credit_balance_exhausted: 429", false],
    ["Upstream closed stream without completion", true],
    ["stream_incomplete", true],
    ["Previous response owner account is unavailable", true],
  ] as const)
    expect(
      isRetryableAssistantError(
        fauxAssistantMessage([], { stopReason: "error", errorMessage }),
      ),
    ).toBe(retry);
  const original = globalThis.WebSocket;
  let sockets = 0,
    requests = 0;
  class OfflineWebSocket extends EventTarget {
    readyState = 0;
    constructor() {
      super();
      sockets++;
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }
    send() {
      setTimeout(
        () =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify(
                terminal("failed", {
                  error: {
                    code: "future_error",
                    type: "server_error",
                    message: "Opaque detail",
                  },
                }),
              ),
            }),
          ),
        0,
      );
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = OfflineWebSocket as unknown as typeof WebSocket;
  const sessionId = crypto.randomUUID();
  try {
    const result = await retryAssistantCall(
      () =>
        codex(codexModel, transcript, {
          ...options,
          sessionId,
          transport: "websocket-cached",
          env: {
            HTTP_PROXY: "",
            HTTPS_PROXY: "",
            ALL_PROXY: "",
            NO_PROXY: "*",
          },
          fetch: mockFetch(async () => {
            requests++;
            return sse([terminal()]);
          }),
        }).result(),
      { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      undefined,
    );
    expect([result.stopReason, sockets, requests]).toEqual(["stop", 1, 1]);
  } finally {
    cleanupSessionResources(sessionId);
    globalThis.WebSocket = original;
  }
});

test("Codex SSE accepts CRLF frames even when every byte arrives separately", async () => {
  for (const newline of ["\n", "\r\n"])
    for (const fragmented of [false, true]) {
      const result = await call(
        true,
        [{ type: "response.created", response: { id: "fixture" } }, terminal()],
        newline,
        fragmented,
      );
      expect(result.stopReason).toBe("stop");
    }
});

test("installation verification binds patches to the exact changed and untouched bytes", async () => {
  const root = await temporaryDirectory("pi-integrity-");
  const source = resolve(import.meta.dir, "..");
  const manifest = await Bun.file(
    join(source, "vendor/pi/provenance.json"),
  ).json();
  const patch = manifest.patches[0];

  for (const path of [
    "package.json",
    "vendor/pi/provenance.json",
    ...manifest.patches.map((entry: { path: string }) => entry.path),
  ])
    await Bun.write(join(root, path), Bun.file(join(source, path)));
  for (const artifact of manifest.artifacts) {
    await Bun.write(
      join(root, artifact.path),
      Bun.file(join(source, artifact.path)),
    );
    const path = join("node_modules", artifact.name);
    await cp(join(source, path), join(root, path), {
      recursive: true,
      dereference: true,
    });
  }
  await verifyInstall(root);
  for (const path of [
    patch.path,
    join("node_modules", patch.package, Object.keys(patch.files)[0]!),
    join("node_modules", patch.package, "package.json"),
  ]) {
    const file = Bun.file(join(root, path));
    const original = await file.text();
    await Bun.write(file, original + "\n");
    await expect(verifyInstall(root)).rejects.toThrow();
    await Bun.write(file, original);
  }
});
