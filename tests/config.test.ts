import { expect, test } from "bun:test";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { temporaryDirectory } from "./directory.ts";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  createModels,
  envApiKeyAuth,
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  type AuthContext,
  type Context,
  type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  capacityError,
  createRuntime,
  defaultSettings,
  readSettings,
  type ProfileName,
} from "../src/config.ts";

const auth = (values: Record<string, string>): AuthContext => ({
  env: async (name) => values[name],
  fileExists: async () => false,
});
const input: Context = {
  messages: [{ role: "user", content: "test", timestamp: 0 }],
};
const complete = (
  runtime: ReturnType<typeof createRuntime>,
  name: ProfileName,
  context = input,
  options?: ModelsSimpleStreamOptions,
) => {
  const { model, stream } = runtime.profiles[name];
  return stream!(
    runtime.models.getModel(model.provider, model.modelId)!,
    context,
    options,
  ).result();
};

test("Pi login credentials persist and refresh across Xean model runtimes", async () => {
  const authPath = join(await temporaryDirectory("xean-login-"), "auth.json");
  const faux = fauxProvider({
    provider: "anthropic",
    models: [{ id: "fixture" }],
  });
  let refreshes = 0;
  const provider = {
    ...faux.provider,
    auth: {
      apiKey: envApiKeyAuth("Fixture key", []),
      oauth: {
        name: "Fixture login",
        login: async () => ({
          type: "oauth" as const,
          access: "old-fixture",
          refresh: "rotate-fixture",
          expires: 0,
        }),
        refresh: async () => {
          refreshes++;
          return {
            type: "oauth" as const,
            access: "new-fixture",
            refresh: "rotated-fixture",
            expires: Date.now() + 3_600_000,
          };
        },
        toAuth: async (credential: { access: string }) => ({
          headers: { Authorization: `Bearer ${credential.access}` },
        }),
      },
    },
  };
  const reopen = async () => {
    const models = await ModelRuntime.create({
      authPath,
      modelsPath: null,
      refreshOnCreate: false,
    });
    models.registerNativeProvider(provider);
    return models;
  };
  const first = await reopen();
  await first.login("anthropic", "oauth", {
    prompt: async () => "",
    notify() {},
  });
  expect(refreshes).toBe(0);
  const models = await reopen();
  const settings = {
    profiles: { default: { provider: "anthropic", model: "fixture" } },
  };
  const runtime = createRuntime(settings, { models });
  const seen: unknown[] = [];
  const response = (_input: unknown, options: any) => {
    seen.push({ key: options.apiKey, headers: options.headers });
    return fauxAssistantMessage("done");
  };
  faux.setResponses([response, response, response]);
  expect((await complete(runtime, "coordinator")).stopReason).toBe("stop");
  expect(refreshes).toBe(1);
  expect((await Bun.file(authPath).json()).anthropic.refresh).toBe(
    "rotated-fixture",
  );
  const reopened = createRuntime(settings, { models: await reopen() });
  expect((await complete(reopened, "coordinator")).stopReason).toBe("stop");
  expect(refreshes).toBe(1);
  expect(seen.slice(0, 2)).toEqual(
    Array(2).fill({
      key: undefined,
      headers: { Authorization: "Bearer new-fixture" },
    }),
  );
  const explicit = createRuntime(settings, { models, key: "explicit-fixture" });
  expect((await complete(explicit, "coordinator")).stopReason).toBe("stop");
  expect(seen[2]).toMatchObject({ key: "explicit-fixture" });
  await models.logout("anthropic");
  expect(await (await reopen()).checkAuth("anthropic")).toBeUndefined();
});

test("settings reject credential literals, unsafe endpoints, and non-ChatGPT browser routes", () => {
  expect(() =>
    readSettings({ ...defaultSettings, apiKey: "not-a-setting" }),
  ).toThrow("Invalid research settings");
  for (const baseUrl of [
    "file:///tmp/endpoint",
    "https://user:pass@example.test",
    "https://example.test?key=x",
    "https://example.test#x",
  ])
    expect(() =>
      readSettings({
        profiles: { default: { ...defaultSettings.profiles.default, baseUrl } },
      }),
    ).toThrow("baseUrl");
  expect(() =>
    readSettings({
      ...defaultSettings,
      codex: { model: "gpt-6-astra", workspace: "relative" },
    }),
  ).toThrow("absolute");
  const chatgpt = {
    baseUrl: "http://127.0.0.1:17841/v1",
    model: "chatgpt-web/gpt-6-pro",
  };
  expect(() =>
    readSettings({
      ...defaultSettings,
      chatgpt: { ...chatgpt, model: "gpt-6-astra" },
    }),
  ).toThrow("Invalid research settings");
  expect(() =>
    readSettings({
      ...defaultSettings,
      chatgpt: { ...chatgpt, baseUrl: "file:///tmp/server" },
    }),
  ).toThrow("baseUrl");
  const settings = readSettings({ ...defaultSettings, chatgpt });
  expect(() =>
    readSettings({
      ...settings,
      profiles: { ...settings.profiles, explorer: settings.profiles.default },
    }),
  ).toThrow("not both");
  expect(settings.chatgpt).toEqual(chatgpt);
  expect(
    createRuntime(settings).models.getProvider("codex-chatgpt-web"),
  ).toBeUndefined();
});

test("native routes retain per-profile auth and transport without persisting credentials", async () => {
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "gpt-6-astra", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const settings = readSettings({
    profiles: {
      default: {
        provider: "openai",
        model: "gpt-6-astra",
        baseUrl: "https://default.invalid/v1",
        apiKeyEnv: "DEFAULT_KEY",
      },
      explorer: {
        provider: "openai",
        model: "gpt-6-astra",
        baseUrl: "https://explorer.invalid/v1",
        apiKeyEnv: "EXPLORER_KEY",
        transport: "websocket",
        reasoning: "high",
      },
    },
  });
  const runtime = createRuntime(settings, {
    models,
    authContext: auth({
      DEFAULT_KEY: "default-fixture",
      EXPLORER_KEY: "explorer-fixture",
    }),
  });
  const seen: unknown[] = [];
  const respond = (
    _input: unknown,
    options: any,
    _state: unknown,
    model: any,
  ) => {
    seen.push({
      key: options.apiKey,
      transport: options.transport,
      reasoning: options.reasoning,
      baseUrl: model.baseUrl,
      provider: model.provider,
    });
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond, respond]);
  expect(runtime.profiles.explorer.model).toEqual({
    provider: "openai",
    modelId: "gpt-6-astra",
  });
  expect(runtime.models.getProvider("openai")).toBe(faux.provider);
  for (const name of ["explorer", "coordinator"] as const) {
    await complete(runtime, name, input, {
      reasoning: runtime.profiles[name].thinkingLevel,
    });
  }
  expect(seen).toEqual([
    {
      key: "explorer-fixture",
      transport: "websocket",
      reasoning: "high",
      baseUrl: "https://explorer.invalid/v1",
      provider: "openai",
    },
    {
      key: "default-fixture",
      transport: undefined,
      reasoning: "max",
      baseUrl: "https://default.invalid/v1",
      provider: "openai",
    },
  ]);
  expect(JSON.stringify(settings)).not.toContain("fixture");
  expect(JSON.stringify(runtime.profiles)).not.toContain("fixture");
});

test("custom endpoints require an explicit key instead of inheriting Pi subscription credentials", async () => {
  for (const provider of [openaiProvider(), anthropicProvider()]) {
    const credentials = new InMemoryCredentialStore();
    const models = createModels({ credentials });
    const faux = fauxProvider({
      provider: provider.id,
      models: [{ id: "fixture" }],
    });
    models.setProvider({ ...faux.provider, auth: provider.auth });
    await credentials.modify(provider.id, async () => ({
      type: "oauth",
      access: "subscription-fixture",
      refresh: "refresh-fixture",
      expires: Date.now() + 3_600_000,
    }));
    const settings = {
      profiles: {
        default: {
          provider: provider.id,
          model: models.getModels(provider.id)[0]!.id,
          baseUrl: "https://gateway.invalid/v1",
        },
      },
    };
    expect(() => createRuntime(settings, { models })).toThrow(
      "Custom baseUrl requires apiKeyEnv or --key-stdin",
    );
    const explicit = createRuntime(settings, {
      models,
      key: "gateway-fixture",
    });
    expect(await explicit.profiles.coordinator.checkAuth!()).toBe(true);
    faux.setResponses([
      (_input, options, _state, model) => {
        expect(options?.apiKey).toBe("gateway-fixture");
        expect(model.baseUrl).toBe("https://gateway.invalid/v1");
        return fauxAssistantMessage("done");
      },
    ]);
    expect((await complete(explicit, "coordinator")).stopReason).toBe("stop");
    const missing = createRuntime(
      {
        profiles: {
          default: {
            ...settings.profiles.default,
            apiKeyEnv: "MISSING_FIXTURE_KEY",
          },
        },
      },
      { models, authContext: auth({}) },
    );
    expect(await missing.profiles.coordinator.checkAuth!()).toBe(false);
    expect((await complete(missing, "coordinator")).errorMessage).toContain(
      "MISSING_FIXTURE_KEY",
    );
    expect(faux.state.callCount).toBe(1);
  }
});

test("caller credential stores retain API keys, native OAuth refresh, and authentication context", async () => {
  const credentials = new InMemoryCredentialStore();
  const supplied = createModels({
    credentials,
    authContext: auth({ NATIVE_KEY: "ambient-fixture" }),
  });
  const faux = fauxProvider({
    provider: "custom",
    models: [{ id: "fixture" }],
  });
  let refreshes = 0;
  let failRefresh = false;
  supplied.setProvider({
    ...faux.provider,
    auth: {
      apiKey: envApiKeyAuth("Native fixture", ["NATIVE_KEY"]),
      oauth: {
        name: "Native OAuth fixture",
        async login() {
          throw new Error("Login was not requested");
        },
        async refresh(previous) {
          refreshes++;
          if (failRefresh) throw new Error("Refresh rejected");
          return {
            ...previous,
            access: "refreshed-fixture",
            expires: Date.now() + 3_600_000,
          };
        },
        async toAuth(credential) {
          return {
            headers: { Authorization: `Bearer ${credential.access}` },
            baseUrl: "https://credential.invalid",
          };
        },
      },
    },
  });
  await credentials.modify("custom", async () => ({
    type: "api_key",
    key: "stored-fixture",
  }));
  const profile = {
    provider: "custom",
    model: "fixture",
  };
  const runtime = createRuntime(
    {
      profiles: {
        default: profile,
        explorer: { ...profile, apiKeyEnv: "OVERRIDE_KEY" },
      },
    },
    {
      models: supplied,
      authContext: auth({ OVERRIDE_KEY: "override-fixture" }),
    },
  );
  const seen: { key?: string; headers: unknown; baseUrl: string }[] = [];
  const respond = (
    _input: unknown,
    options: any,
    _state: unknown,
    model: any,
  ) => {
    seen.push({
      key: options.apiKey,
      headers: options.headers,
      baseUrl: model.baseUrl,
    });
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond, respond, respond, respond]);
  expect((await complete(runtime, "coordinator")).stopReason).toBe("stop");
  expect((await complete(runtime, "explorer")).stopReason).toBe("stop");
  expect(seen.slice(0, 2).map(({ key }) => key)).toEqual([
    "stored-fixture",
    "override-fixture",
  ]);

  const expired = {
    type: "oauth" as const,
    access: "expired-fixture",
    refresh: "refresh-fixture",
    expires: 0,
  };
  await credentials.modify("custom", async () => expired);
  expect(await runtime.profiles.coordinator.checkAuth!()).toBe(true);
  expect(refreshes).toBe(0);
  expect((await complete(runtime, "coordinator")).stopReason).toBe("stop");
  expect(refreshes).toBe(1);
  expect(await credentials.read("custom")).toMatchObject({
    access: "refreshed-fixture",
  });
  expect(seen[2]).toMatchObject({
    headers: { Authorization: "Bearer refreshed-fixture" },
    baseUrl: "https://credential.invalid",
  });

  failRefresh = true;
  await credentials.modify("custom", async () => expired);
  expect((await complete(runtime, "coordinator")).errorMessage).toContain(
    "OAuth refresh failed",
  );
  expect(faux.state.callCount).toBe(3);
  expect(await credentials.read("custom")).toEqual(expired);
  await credentials.delete("custom");
  expect((await complete(runtime, "coordinator")).stopReason).toBe("stop");
  expect(seen[3]!.key).toBe("ambient-fixture");
  const missing = createRuntime(
    { profiles: { default: { ...profile, apiKeyEnv: "MISSING_TEST_KEY" } } },
    { models: supplied, key: "fallback-fixture", authContext: auth({}) },
  );
  expect(await missing.profiles.coordinator.checkAuth!()).toBe(false);
  expect((await complete(missing, "coordinator")).errorMessage).toContain(
    "MISSING_TEST_KEY",
  );
  expect(faux.state.callCount).toBe(4);
});

test("native Anthropic auth is preserved and unused profiles remain lazy", async () => {
  let reads = 0;
  const runtime = createRuntime(
    readSettings({
      profiles: { default: { provider: "anthropic", model: "unused-model" } },
    }),
    {
      authContext: {
        ...auth({}),
        env: async (name) => {
          reads++;
          return name === "ANTHROPIC_AUTH_TOKEN" ? "native-fixture" : undefined;
        },
      },
    },
  );
  expect(reads).toBe(0);
  expect(await runtime.models.getAuth("anthropic")).toMatchObject({
    auth: { headers: { Authorization: "Bearer native-fixture" } },
    source: "ANTHROPIC_AUTH_TOKEN",
  });
  expect(runtime.models.getModel("anthropic", "unused-model")).toBeUndefined();
  const subscription = createRuntime(
    {
      profiles: {
        default: { provider: "openai-codex", model: "unused-model" },
      },
    },
    { key: "unsupported-fixture" },
  );
  await expect(subscription.profiles.coordinator.checkAuth!()).rejects.toThrow(
    "does not support API-key authentication",
  );
});

test("native stream routes require and preserve usage attribution headers", async () => {
  const faux = fauxProvider({
    provider: "custom",
    models: [{ id: "fixture" }],
  });
  const models = createModels();
  models.setProvider({
    ...faux.provider,
    getModels: () =>
      faux.provider.getModels().map((model) => ({
        ...model,
        headers: { "X-Codex-LB-Usage-Tag": "model", "X-Suppressed": "model" },
      })),
    auth: {
      apiKey: {
        name: "fixture",
        resolve: async () => ({
          auth: {
            headers: {
              "x-codex-lb-required-capability": "auth",
              "X-Auth": "retained",
            },
          },
        }),
      },
    },
  });
  const settings = readSettings({
    profiles: { default: { provider: "custom", model: "fixture" } },
    usagePrefix: "campaign",
  });
  const runtime = createRuntime(settings, { models });
  for (const sessionId of [undefined, "bad\nidentity", "x".repeat(128)]) {
    const result = await complete(runtime, "coordinator", input, {
      sessionId,
    });
    expect(result.errorMessage).toContain(
      "valid native provider session identity",
    );
  }
  expect(faux.state.callCount).toBe(0);
  const headers: unknown[] = [];
  const response = (_input: unknown, options: any) => {
    headers.push(options.headers);
    return fauxAssistantMessage("done");
  };
  faux.setResponses([response]);
  const options = {
    sessionId: "native-session",
    headers: {
      "x-codex-lb-usage-tag": "wrong",
      "X-CODEX-LB-REQUIRED-CAPABILITY": null,
      "X-Custom": "retained",
      "X-Suppressed": null,
    },
  };
  await complete(runtime, "coordinator", input, options);
  expect(headers).toEqual([
    {
      "X-Auth": "retained",
      "X-Custom": "retained",
      "X-Suppressed": null,
      "X-Codex-LB-Usage-Tag": "campaign/native-session",
      "X-Codex-LB-Required-Capability": "usage_tag_v1",
    },
  ]);
  expect(faux.state.callCount).toBe(1);
});

test("native custom-provider routes guard implicit limits and clamp explicit ceilings", async () => {
  const faux = fauxProvider({
    provider: "custom",
    models: [{ id: "small", contextWindow: 8192, maxTokens: 1024 }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const runtime = createRuntime(
    readSettings({
      profiles: { default: { provider: "custom", model: "small" } },
    }),
    { models },
  );
  expect(
    (
      await complete(runtime, "explorer", {
        systemPrompt: "word ".repeat(8000),
        messages: [],
      })
    ).errorMessage,
  ).toBe(capacityError);
  expect(faux.state.callCount).toBe(0);
  faux.setResponses([
    (_context, options) => {
      expect(options?.maxTokens).toBe(512);
      return fauxAssistantMessage("ok");
    },
    (_context, options) => {
      expect(options!.maxTokens!).toBeLessThan(512);
      expect(options!.maxTokens!).toBeGreaterThan(400);
      return fauxAssistantMessage("ok");
    },
    fauxAssistantMessage("ok"),
  ]);
  const constrained: Context = {
    messages: [{ role: "user", content: "x".repeat(14336), timestamp: 0 }],
  };
  const first = await complete(runtime, "proof", constrained, {
    maxTokens: 512,
  });
  expect(first.stopReason).toBe("stop");
  expect(
    (
      await complete(
        runtime,
        "proof",
        {
          messages: [
            ...constrained.messages,
            first,
            {
              role: "user",
              content: "x".repeat(100),
              timestamp: first.timestamp + 1,
            },
          ],
        },
        { maxTokens: 512 },
      )
    ).stopReason,
  ).toBe("stop");
  const retried = [
    input.messages[0]!,
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "temporary",
    }),
  ];
  expect(
    (
      await complete(runtime, "explorer", {
        messages: retried,
      })
    ).stopReason,
  ).toBe("stop");
  expect(faux.state.callCount).toBe(3);
});
