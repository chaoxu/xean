import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupSessionResources,
  normalizeContext,
  type AssistantMessage,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import {
  getOpenAICodexWebSocketDebugStats,
  streamSimple as streamCodex,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import {
  parseJsonWithRepair,
  parseStreamingJson,
  repairJson,
} from "@earendil-works/pi-ai/utils/json-parse";
import { createCampaign } from "../src";
import { derivePiSpend, runPi } from "../src/pi";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});
const proxyCompatibility = { supportsStrictMode: true, codexProxyAuth: true };
const model: Model<"openai-codex-responses"> = {
  id: "test-proxy",
  name: "Proxy fixture",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "https://proxy.invalid/backend-api",
  reasoning: true,
  input: ["text"],
  contextWindow: 20_000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: proxyCompatibility,
};
const apiKey = "offline-proxy-api-key";

test("JSON repair preserves unchanged spans, escapes, and partial tool arguments", () => {
  const unchanged = '{"proof":"quoted \\"text\\" and \\u03b1 and \\\\ path';
  expect(repairJson(unchanged)).toBe(unchanged);
  expect(parseStreamingJson<Record<string, string>>(unchanged)).toEqual({
    proof: 'quoted "text" and α and \\ path',
  });
  expect(
    parseJsonWithRepair<Record<string, string>>(
      '{"proof":"line\n\ttab \\q \\u1234 \\\\","nul":"a\u0000b"}',
    ),
  ).toEqual({ proof: "line\n\ttab \\q ሴ \\", nul: "a\u0000b" });
  expect(
    parseStreamingJson<Record<string, string>>('{"proof":"valid\\'),
  ).toEqual({
    proof: "valid",
  });
  expect(
    parseStreamingJson<Record<string, string>>(
      '{"proof":"raw\ninvalid \\q then trailing\\',
    ),
  ).toEqual({});
});

function campaign() {
  const directory = mkdtempSync(join(tmpdir(), "xean-provider-"));
  directories.push(directory);
  return createCampaign(join(directory, "campaign.db"), "provider-test", null);
}

test.each(["openai-responses", "openai-codex-responses"] as const)(
  "%s preserves usage supplied with a failed terminal response",
  async (api) => {
    const configured = { ...model, api };
    const stubFetch: typeof fetch = Object.assign(
      async () =>
        new Response(
          "data: " +
            JSON.stringify({
              type: "response.failed",
              response: {
                id: "response_failed_usage",
                status: "failed",
                output: [],
                error: {
                  code: "invalid_request_error",
                  message: "offline failure",
                },
                usage: {
                  input_tokens: 100,
                  output_tokens: 5,
                  total_tokens: 105,
                  input_tokens_details: { cached_tokens: 40 },
                  output_tokens_details: { reasoning_tokens: 3 },
                },
              },
            }) +
            "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect: fetch.preconnect },
    );
    const models: Pick<Models, "streamSimple"> = {
      streamSimple(_model, context, options) {
        const opts = {
          ...options,
          apiKey,
          transport: "sse" as const,
          fetch: stubFetch,
        };
        return api === "openai-responses"
          ? streamResponses(
              { ...configured, api },
              normalizeContext(context),
              opts,
            )
          : streamCodex(
              { ...configured, api },
              normalizeContext(context),
              opts,
            );
      },
    };
    const store = campaign();
    try {
      const result = await runPi(store, {
        models,
        model: configured,
        label: "failed-usage",
        prompt: "Test",
      });
      expect(result.state).toBe("failed");
      expect(derivePiSpend(store.records()).summary).toMatchObject({
        logicalProviderRequests: 1,
        requestErrors: 1,
        unmeasuredRequests: 0,
        measuredUsage: {
          input: 60,
          cacheRead: 40,
          output: 5,
          reasoning: 3,
          totalTokens: 105,
        },
      });
    } finally {
      store.close();
    }
  },
);

test("native zero usage is measured and omitted usage stays unknown", async () => {
  for (const reported of [false, true]) {
    const stubFetch: typeof fetch = Object.assign(
      async () =>
        new Response(
          "data: " +
            JSON.stringify({
              type: "response.completed",
              response: {
                id: "response_zero",
                status: "completed",
                output: [],
                ...(reported
                  ? {
                      usage: {
                        input_tokens: 0,
                        output_tokens: 0,
                        total_tokens: 0,
                      },
                    }
                  : {}),
              },
            }) +
            "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect: fetch.preconnect },
    );
    const store = campaign();
    try {
      await runPi(store, {
        model,
        label: "zero-usage",
        prompt: "Test",
        models: {
          streamSimple(_model, context, options) {
            return streamCodex(model, normalizeContext(context), {
              ...options,
              apiKey,
              transport: "sse",
              fetch: stubFetch,
            });
          },
        },
      });
      expect(derivePiSpend(store.records()).summary.unmeasuredRequests).toBe(
        reported ? 0 : 1,
      );
    } finally {
      store.close();
    }
  }
});

function reply(index: number) {
  const item = {
    type: "message",
    id: "msg_" + index,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "reply " + index, annotations: [] }],
  };
  return [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp_" + index,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
}

test("Pi proxy WebSockets send full then delta input, recover missing context, and release the session", async () => {
  const sessionId = "offline-websocket-session";
  let fullBodySerializations = 0;
  const requestBodies = new WeakSet<object>();
  const stringify = JSON.stringify;
  const stringifySpy = spyOn(JSON, "stringify").mockImplementation(
    (value, replacer, space) => {
      if (requestBodies.has(value)) fullBodySerializations += 1;
      return stringify(value, replacer as never, space);
    },
  );
  const requests: Record<string, unknown>[] = [];
  const headers: {
    authorization: string | null;
    session: string | null;
    account: string | null;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      headers.push({
        authorization: request.headers.get("authorization"),
        session: request.headers.get("session-id"),
        account: request.headers.get("chatgpt-account-id"),
      });
      if (server.upgrade(request)) return;
      return new Response("WebSocket required", { status: 400 });
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(message.toString()) as Record<
          string,
          unknown
        >;
        requests.push(request);
        if (requests.length === 3) {
          socket.send(
            JSON.stringify({
              type: "error",
              code: "previous_response_not_found",
              message: "offline context expired",
            }),
          );
          return;
        }
        for (const event of reply(requests.length))
          socket.send(JSON.stringify(event));
      },
    },
  });
  const configured = {
    ...model,
    baseUrl: "http://127.0.0.1:" + server.port + "/backend-api",
  };
  const context = normalizeContext({
    messages: [
      { role: "system", content: "Offline fixture", timestamp: 0 },
      { role: "user", content: "Begin", timestamp: 1 },
    ],
  });
  const run = async (key = apiKey): Promise<AssistantMessage> => {
    const stream = streamCodex(configured, context, {
      apiKey: key,
      sessionId,
      transport: "websocket-cached",
      onPayload(payload) {
        if (typeof payload !== "object" || payload === null)
          throw new Error("Expected a request body");
        requestBodies.add(payload);
      },
    });
    for await (const _event of stream) {
      /* Drain the native stream. */
    }
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    context.messages.push(result, {
      role: "user",
      content: "Continue",
      timestamp: result.timestamp + 1,
    });
    return result;
  };
  try {
    await run();
    await run();
    await run();
    expect(requests).toHaveLength(4);
    expect(requests[0]).not.toHaveProperty("previous_response_id");
    expect(requests[1]).toMatchObject({
      previous_response_id: "resp_1",
      input: [{ role: "user" }],
    });
    expect(requests[2]).toHaveProperty("previous_response_id", "resp_2");
    expect(requests[3]).not.toHaveProperty("previous_response_id");
    expect((requests[3]!.input as unknown[]).length).toBeGreaterThan(
      (requests[2]!.input as unknown[]).length,
    );
    expect(fullBodySerializations).toBe(0);
    expect(
      headers.every(
        (value) =>
          value.authorization === "Bearer " + apiKey &&
          value.session === sessionId &&
          value.account === null,
      ),
    ).toBe(true);
    expect(getOpenAICodexWebSocketDebugStats(sessionId)).toMatchObject({
      requests: 4,
      deltaRequests: 2,
      fullContextRequests: 2,
    });
    await run("different-offline-proxy-key");
    expect(requests[4]).not.toHaveProperty("previous_response_id");
    cleanupSessionResources(sessionId);
    expect(getOpenAICodexWebSocketDebugStats(sessionId)).toBeUndefined();
  } finally {
    stringifySpy.mockRestore();
    cleanupSessionResources(sessionId);
    server.stop(true);
  }
});

test("proxy authentication requires an explicit custom endpoint", async () => {
  const direct = { ...model, baseUrl: "https://chatgpt.com/backend-api" };
  const stream = streamCodex(direct, normalizeContext({ messages: [] }), {
    apiKey,
  });
  for await (const _event of stream) {
    /* No transport is reached. */
  }
  expect((await stream.result()).errorMessage).toContain("custom base URL");
});
