import { expect, test } from "bun:test";
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
    baseUrl: "https://configured.invalid",
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

test("caller native custom-provider routes retain context guards", async () => {
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
  faux.setResponses([fauxAssistantMessage("ok")]);
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
  expect(faux.state.callCount).toBe(1);
});
