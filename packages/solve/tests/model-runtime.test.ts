import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelRuntimeOptions } from "../solve";
import { createModelRuntime } from "../runtime";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runtimeOptions() {
  const directory = await mkdtemp(join(tmpdir(), "elenx-model-runtime-"));
  directories.push(directory);
  return {
    modelsPath: join(directory, "models.json"),
    authPath: join(directory, "auth.json"),
    refreshOnCreate: false,
  };
}

test("custom model configuration is disabled unless explicitly selected", () => {
  expect(modelRuntimeOptions({})).toEqual({ modelsPath: null });
});

test("custom model configuration requires an absolute path", () => {
  expect(
    modelRuntimeOptions({ ELENX_MODELS_PATH: "/run/elenx/models.json" }),
  ).toEqual({
    modelsPath: "/run/elenx/models.json",
  });
  expect(() =>
    modelRuntimeOptions({ ELENX_MODELS_PATH: "models.json" }),
  ).toThrow("ELENX_MODELS_PATH must be absolute");
});

test("a missing explicit registry fails instead of selecting public models", async () => {
  const options = await runtimeOptions();
  await expect(createModelRuntime(options)).rejects.toThrow("ENOENT");
});

test.each([
  ["{ invalid json }", "Failed to parse models.json"],
  ['{"providers":{"openai":{"baseUrl":42}}}', "Invalid models.json schema"],
])("an invalid explicit registry fails: %s", async (content, message) => {
  const options = await runtimeOptions();
  await Bun.write(options.modelsPath, content);
  await expect(createModelRuntime(options)).rejects.toThrow(message);
});

test("a valid explicit registry preserves Pi provider overrides", async () => {
  const options = await runtimeOptions();
  await Bun.write(
    options.modelsPath,
    JSON.stringify({
      providers: {
        openai: {
          baseUrl: "https://provider.invalid/v1",
          apiKey: "test-key",
        },
      },
    }),
  );
  const runtime = await createModelRuntime(options);
  expect(runtime.getModel("openai", "gpt-5.6-luna")?.baseUrl).toBe(
    "https://provider.invalid/v1",
  );
});

test.each(["openai-responses", "openai-codex-responses"] as const)(
  "%s preserves proxy credentials, registry headers, and failed usage",
  async (api) => {
    const options = await runtimeOptions();
    await Bun.write(
      options.modelsPath,
      JSON.stringify({
        providers: {
          "codex-proxy-fixture": {
            baseUrl: "https://proxy.invalid/v1",
            apiKey: "test-key",
            api,
            headers: { "X-Registry-Fixture": "preserved" },
            models: [
              {
                id: "fixture-astra",
                name: "Proxy fixture",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 400000,
                maxTokens: 128000,
                compat: { codexProxyAuth: true },
              },
            ],
          },
        },
      }),
    );
    const runtime = await createModelRuntime(options);
    const model = runtime.getModel("codex-proxy-fixture", "fixture-astra");
    expect(model).toMatchObject({
      api,
      baseUrl: "https://proxy.invalid/v1",
      compat: { codexProxyAuth: true },
    });
    if (model === undefined) throw new Error("missing configured model");
    let sentHeaders: Headers | undefined;
    const stubFetch: typeof fetch = Object.assign(
      async (_input: unknown, init?: RequestInit) => {
        sentHeaders = new Headers(init?.headers);
        return new Response(
          "data: " +
            JSON.stringify({
              type: "response.failed",
              response: {
                id: "runtime-fixture",
                status: "failed",
                output: [],
                error: { code: "invalid_request_error", message: "fixture" },
                usage: {
                  input_tokens: 10,
                  output_tokens: 5,
                  total_tokens: 15,
                  output_tokens_details: { reasoning_tokens: 3 },
                },
              },
            }) +
            "\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { preconnect: fetch.preconnect },
    );
    for (const method of ["stream", "streamSimple"] as const) {
      const stream = runtime[method](
        model,
        {
          messages: [
            { role: "user", content: "Offline fixture", timestamp: 1 },
          ],
        },
        { transport: "sse", fetch: stubFetch },
      );
      for await (const _event of stream) {
        // The real runtime must reach Elenx's patched native provider.
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.usage.reasoning).toBe(3);
      expect(sentHeaders?.get("authorization")).toBe("Bearer test-key");
      expect(sentHeaders?.get("x-registry-fixture")).toBe("preserved");
    }
  },
);
