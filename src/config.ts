import { isAbsolute } from "node:path";
import {
  createModels,
  defaultProviderAuthContext,
  lazyStream,
  normalizeContext,
  StringEnum,
  Type,
  type AuthContext,
  type Models,
  type ProviderHeaders,
  type SimpleStreamOptions,
  type Static,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { ThinkingLevelSchema } from "@earendil-works/pi-ai/providers/model-schema";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { Check } from "typebox/value";
import { object, submissionSchemas } from "./math/contracts.ts";

export type ProfileName = keyof typeof submissionSchemas;
export const profileNames = Object.keys(submissionSchemas) as ProfileName[];
export type Profile = {
  model: ModelRef;
  thinkingLevel: ThinkingLevel;
  stream?: Models["streamSimple"];
  checkAuth?: () => Promise<boolean>;
};
export const defaultMaxExplorerReads = 4;
export const explorerResponseLimit = (settings: {
  maxExplorerResponses?: number;
  maxExplorerReads?: number;
}) =>
  settings.maxExplorerResponses ??
  (settings.maxExplorerReads ?? defaultMaxExplorerReads) + 4;
export const capacityError =
  "Research input leaves insufficient context for an answer";
const text = Type.String({ minLength: 1, pattern: "\\S" });
const reasoning = Type.Optional(ThinkingLevelSchema);
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const usageTagSchema = Type.String({
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]*$",
  maxLength: 128,
});
const profileSchema = object({
  provider: text,
  model: text,
  reasoning,
  baseUrl: Type.Optional(text),
  samplingParams: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    ),
  ),
  apiKeyEnv: Type.Optional(
    Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  ),
  transport: Type.Optional(
    StringEnum(["sse", "websocket", "websocket-cached"] as const),
  ),
});
const researchSchema = object({
  model: text,
  reasoning,
  command: Type.Optional(text),
  profile: Type.Optional(text),
});
export const settingsSchema = object({
  profiles: object({
    default: profileSchema,
    ...Type.Record(
      Type.KeyOf(object(submissionSchemas)),
      Type.Optional(profileSchema),
    ).properties,
  }),
  maxExplorerResponses: Type.Optional(positive),
  maxExplorerReads: Type.Optional(positive),
  chatgpt: Type.Optional(
    object({
      baseUrl: text,
      model: Type.String({ pattern: "^chatgpt-web/\\S+$" }),
    }),
  ),
  literature: Type.Optional(Type.Boolean()),
  research: Type.Optional(Type.Union([researchSchema, Type.Literal(false)])),
  codex: Type.Optional(
    object({ ...researchSchema.properties, workspace: text }),
  ),
  usagePrefix: Type.Optional(Type.String({ ...usageTagSchema, maxLength: 91 })),
});
export type Settings = Static<typeof settingsSchema>;
export const defaultSettings: Settings = {
  profiles: {
    default: { provider: "openai", model: "gpt-6-astra", reasoning: "max" },
  },
};

/** Settings contain credential references, never credential values. */
export function readSettings(value: unknown): Settings {
  if (!Check(settingsSchema, value))
    throw new Error("Invalid research settings");
  const settings = structuredClone(value);
  if (settings.chatgpt && settings.profiles.explorer)
    throw new Error("Choose chatgpt or profiles.explorer, not both");
  if (settings.codex && !isAbsolute(settings.codex.workspace))
    throw new Error("codex.workspace must be an absolute directory");
  for (const configured of [
    ...Object.values(settings.profiles),
    settings.chatgpt,
  ]) {
    if (!configured) continue;
    if (configured.baseUrl) {
      const url = URL.parse(configured.baseUrl);
      if (
        !url ||
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error(
          "baseUrl must be HTTP(S) without credentials, query, or fragment",
        );
    }
  }
  return settings;
}

function builtinModels(authContext: AuthContext) {
  const models = createModels({ authContext });
  for (const provider of [
    openaiProvider(),
    openaiCodexProvider(),
    anthropicProvider(),
    googleProvider(),
  ])
    models.setProvider(provider);
  return models;
}

/** Profiles retain native model identities and configure each request. */
export function createRuntime(
  value: Settings,
  options: {
    models?: Models;
    key?: string;
    authContext?: AuthContext;
  } = {},
) {
  const settings = readSettings(value);
  const authContext = options.authContext ?? defaultProviderAuthContext();
  const models = options.models ?? builtinModels(authContext);
  const requestHeaders = (
    request: SimpleStreamOptions,
    headers: ProviderHeaders,
  ) => {
    if (!settings.usagePrefix) return headers;
    const tag = `${settings.usagePrefix}/${request.sessionId ?? ""}`;
    if (!request.sessionId || !Check(usageTagSchema, tag))
      throw new Error(
        "Usage attribution requires a valid native provider session identity",
      );
    return {
      ...Object.fromEntries(
        Object.entries(headers).filter(
          ([name]) =>
            !/^x-codex-lb-(usage-tag|required-capability)$/i.test(name),
        ),
      ),
      "X-Codex-LB-Usage-Tag": tag,
      "X-Codex-LB-Required-Capability": "usage_tag_v1",
    };
  };
  const profiles = {} as Record<ProfileName, Profile>;
  for (const name of profileNames) {
    const configured = settings.profiles[name] ?? settings.profiles.default;
    const explicit = configured.apiKeyEnv || options.key;
    if (configured.baseUrl && !explicit)
      throw new Error("Custom baseUrl requires apiKeyEnv or --key-stdin");
    const key = async () => {
      if (!models.getProvider(configured.provider)?.auth.apiKey)
        throw new Error(
          `${configured.provider} does not support API-key authentication`,
        );
      return configured.apiKeyEnv
        ? authContext.env(configured.apiKeyEnv)
        : options.key;
    };
    profiles[name] = {
      model: { provider: configured.provider, modelId: configured.model },
      thinkingLevel: configured.reasoning ?? "max",
      checkAuth: async () =>
        explicit
          ? !!(await key())
          : !!(await models.checkAuth(configured.provider)),
      stream: (model, input, request = {}) =>
        lazyStream(model, async () => {
          const transcript = normalizeContext(input);
          const maxTokens = clampMaxTokensToContext(
            model,
            transcript,
            request.maxTokens ?? model.maxTokens,
          );
          if (request.maxTokens === undefined && maxTokens < model.maxTokens)
            throw new Error(capacityError);
          const apiKey = explicit ? await key() : request.apiKey;
          if (explicit && !apiKey)
            throw new Error(`No credential in ${configured.apiKeyEnv}`);
          return models.streamSimple(
            configured.baseUrl
              ? { ...model, baseUrl: configured.baseUrl }
              : model,
            transcript,
            {
              ...request,
              maxTokens,
              apiKey,
              transport: configured.transport ?? request.transport,
              samplingParams: {
                ...request.samplingParams,
                ...configured.samplingParams,
              },
              transformHeaders: async (headers) =>
                requestHeaders(
                  request,
                  (await request.transformHeaders?.(headers)) ?? headers,
                ),
            },
          );
        }),
    };
  }
  return { models, profiles };
}
