import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCampaign, type Campaign } from "xean";
import { InMemoryCredentialStore, runPi, type PiRunOptions } from "xean/pi";

import { modelRegistryPath } from "../runtime";
import { createModelRuntime } from "../runtime";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runtimeOptions() {
  const directory = await mkdtemp(join(tmpdir(), "xean-model-runtime-"));
  directories.push(directory);
  return {
    modelsPath: join(directory, "models.json"),
    authPath: join(directory, "auth.json"),
    refreshOnCreate: false,
  };
}

const apis = ["openai-responses", "openai-codex-responses"] as const;
const tagVariable = "XEAN_LAB_CODEX_LB_USAGE_TAG";
const baseUrlVariable = "XEAN_LAB_CODEX_LB_BASE_URL";
const usageHeaders = {
  "X-Codex-LB-Usage-Tag": `$${tagVariable}`,
  "X-Codex-LB-Required-Capability": "usage_tag_v1",
  "X-Registry-Fixture": "preserved",
};

function environment(values: Record<string, string | undefined>) {
  const prior = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  const assign = (entries: typeof values) => {
    for (const [key, value] of Object.entries(entries))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  assign(values);
  return { [Symbol.dispose]: () => assign(prior) };
}

async function proxyRuntime(
  api: (typeof apis)[number],
  headers: Record<string, string> = { "X-Registry-Fixture": "preserved" },
) {
  const options = await runtimeOptions();
  await Bun.write(
    options.modelsPath,
    JSON.stringify({
      providers: {
        "codex-proxy-fixture": {
          baseUrl: "https://proxy.invalid/v1",
          apiKey: "test-key",
          api,
          headers,
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
  if (model === undefined) throw new Error("missing configured model");
  return { options, runtime, model };
}

function failedFetch(captured: Headers[]): typeof fetch {
  return Object.assign(
    async (_input: unknown, init?: RequestInit) => {
      captured.push(new Headers(init?.headers));
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
}

function runFixture(
  campaign: Campaign,
  runtime: Awaited<ReturnType<typeof createModelRuntime>>,
  model: PiRunOptions["model"],
  options: NonNullable<Parameters<typeof runtime.streamSimple>[2]>,
) {
  return runPi(campaign, {
    model,
    label: "runtime-fixture",
    prompt: "Offline fixture",
    models: {
      streamSimple(requestModel, context, piOptions) {
        return runtime.streamSimple(requestModel, context, {
          ...piOptions,
          ...options,
          transport: "sse",
        });
      },
    },
  });
}

test("custom model configuration is disabled unless explicitly selected", () => {
  expect(modelRegistryPath({})).toBeNull();
});

test("custom model configuration requires an absolute path", () => {
  expect(modelRegistryPath({ XEAN_MODELS_PATH: "/run/xean/models.json" })).toBe(
    "/run/xean/models.json",
  );
  expect(() => modelRegistryPath({ XEAN_MODELS_PATH: "models.json" })).toThrow(
    "XEAN_MODELS_PATH must be absolute",
  );
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

test.each([...apis])(
  "%s preserves proxy credentials, registry headers, and failed usage",
  async (api) => {
    const { runtime, model } = await proxyRuntime(api);
    expect(model).toMatchObject({
      api,
      baseUrl: "https://proxy.invalid/v1",
      compat: { codexProxyAuth: true },
    });
    const captured: Headers[] = [];
    const stubFetch = failedFetch(captured);
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
        // The real runtime must reach Xean's patched native provider.
      }
      const result = await stream.result();
      expect(result.stopReason).toBe("error");
      expect(result.usage.reasoning).toBe(3);
      expect(captured.at(-1)?.get("authorization")).toBe("Bearer test-key");
      expect(captured.at(-1)?.get("x-registry-fixture")).toBe("preserved");
    }
  },
);

test.each([...apis])(
  "%s attributes each attempt through native configuration and composes header transforms",
  async (api) => {
    using _environment = environment({
      [tagVariable]: "fixture/run/attempt-1",
      [baseUrlVariable]: undefined,
    });
    const { options, runtime, model } = await proxyRuntime(api, usageHeaders);
    const campaign = createCampaign(
      `${options.modelsPath}.db`,
      "runtime",
      null,
    );
    const captured: Headers[] = [];
    let transforms = 0;
    try {
      for (const tag of ["fixture/run/attempt-1", "fixture/run/attempt-2"]) {
        process.env[tagVariable] = tag;
        const result = await runFixture(campaign, runtime, model, {
          fetch: failedFetch(captured),
          transformHeaders(headers) {
            transforms++;
            expect(headers["X-Codex-LB-Usage-Tag"]).toBe(tag);
            expect(headers["X-Registry-Fixture"]).toBe("preserved");
            return { ...headers, "X-Transform-Fixture": "composed" };
          },
        });
        expect(result).toMatchObject({
          state: "failed",
          error: expect.stringContaining("fixture"),
        });
        expect(captured.at(-1)?.get("x-codex-lb-usage-tag")).toBe(tag);
        expect(captured.at(-1)?.get("x-codex-lb-required-capability")).toBe(
          "usage_tag_v1",
        );
        expect(captured.at(-1)?.get("x-registry-fixture")).toBe("preserved");
        expect(captured.at(-1)?.get("x-transform-fixture")).toBe("composed");
      }
      expect(captured).toHaveLength(2);
      expect(transforms).toBe(2);
    } finally {
      campaign.close();
    }
  },
);

test.each([...apis])(
  "%s rejects missing or empty configured attribution before fetch",
  async (api) => {
    using _environment = environment({
      [tagVariable]: undefined,
      [baseUrlVariable]: undefined,
    });
    const { options, runtime, model } = await proxyRuntime(api, usageHeaders);
    const campaign = createCampaign(
      `${options.modelsPath}.db`,
      "runtime",
      null,
    );
    const captured: Headers[] = [];
    try {
      for (const tag of [undefined, ""]) {
        if (tag === undefined) delete process.env[tagVariable];
        else process.env[tagVariable] = tag;
        const result = await runFixture(campaign, runtime, model, {
          fetch: failedFetch(captured),
        });
        expect(result.state).toBe("failed");
        if (result.state !== "failed")
          throw new Error("expected unresolved header failure");
        expect(result.error).toContain(tagVariable);
        expect(captured).toHaveLength(0);
      }
    } finally {
      campaign.close();
    }
  },
);

test.each(["openai", "openai-codex"])(
  "%s adds no automatic Lab headers to builtin or custom endpoints",
  async (provider) => {
    using _environment = environment({
      [tagVariable]: "fixture/run/attempt-1",
      [baseUrlVariable]: undefined,
    });
    const options = await runtimeOptions();
    const apiKey = `stub.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.stub`;
    const credentials = new InMemoryCredentialStore();
    await credentials.modify(provider, async () =>
      provider === "openai-codex"
        ? {
            type: "oauth",
            access: apiKey,
            refresh: "fixture-refresh",
            expires: Number.MAX_SAFE_INTEGER,
          }
        : { type: "api_key", key: apiKey },
    );
    const runtime = await createModelRuntime({
      ...options,
      modelsPath: null,
      credentials,
    });
    const model = runtime.getModel(provider, "gpt-6-astra");
    if (model === undefined) throw new Error("missing builtin fixture model");
    const campaign = createCampaign(
      `${options.modelsPath}.db`,
      "runtime",
      null,
    );
    const captured: Headers[] = [];
    try {
      for (const baseUrl of [
        model.baseUrl,
        "https://unconfigured-proxy.invalid/v1",
      ]) {
        process.env[baseUrlVariable] = baseUrl;
        const result = await runFixture(
          campaign,
          runtime,
          { ...model, baseUrl },
          { fetch: failedFetch(captured) },
        );
        expect(result).toMatchObject({
          state: "failed",
          error: expect.stringContaining("fixture"),
        });
        expect(captured.at(-1)?.has("x-codex-lb-usage-tag")).toBe(false);
        expect(captured.at(-1)?.has("x-codex-lb-required-capability")).toBe(
          false,
        );
      }
      expect(captured).toHaveLength(2);
    } finally {
      campaign.close();
    }
  },
);
