import {
  AI_TELEMETRY_SCHEMA,
  convertToLlm,
  createTypedSpanStarter,
  defineTelemetrySchema,
  InMemoryTelemetryContext,
  NOOP_TELEMETRY_CONTEXT,
  runAgentLoop,
  type AgentMessage,
  type AgentContext,
  type BeforeToolCallContext,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  cleanupSessionResources,
  contentText,
  createAssistantMessageEventStream,
  isContextOverflow,
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Models,
  type ThinkingLevel,
  type Transport,
  type TSchema,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { z } from "zod";

import { entryId, json } from "./schemas";
import { ReasoningRecovery } from "./pi-recovery";
import type {
  AuditedTool,
  Campaign,
  Entry,
  EntryId,
  Json,
  Reader,
  Tool,
} from "./types";

export { InMemoryCredentialStore } from "@earendil-works/pi-ai";
export { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-agent-core";
export { builtinModels as builtinPi } from "@earendil-works/pi-ai/providers/all";
export { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
export { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";

type PiModels = Pick<Models, "streamSimple">;
const reasoningLevels = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];
export const piReasoning = z.enum(reasoningLevels);

const piSubmissionGate = z.strictObject({
  completeArgument: z.string().regex(/\S/u),
  emptyArgument: z.string().regex(/\S/u).optional(),
  reserveTokens: z.number().int().positive().optional(),
  contextBudgetTokens: z.number().int().positive().optional(),
  maxResponses: z.number().int().positive().optional(),
  continuationPrompt: z.string().regex(/\S/u).optional(),
});
export type PiSubmissionGate = z.output<typeof piSubmissionGate>;

export interface PiRunOptions {
  readonly models: PiModels;
  readonly model: Model<Api>;
  readonly label: string;
  readonly role?: string;
  readonly system?: string;
  readonly prompt: string;
  readonly reasoning?: ThinkingLevel;
  readonly candidate?: EntryId;
  readonly tools?: readonly Tool[];
  readonly stopAfterToolResult?: true;
  /** Retryable provider errors; independent of output-length continuations. */
  readonly maxRecoveries?: number;
  /** Ordinary output-length continuations; omitted means no continuations. */
  readonly maxLengthContinuations?: number;
  readonly submissionGate?: PiSubmissionGate | undefined;
  readonly signal?: AbortSignal;
  readonly transport?: Transport;
  readonly cacheKey?: string;
}

type PiOutcomeBase = {
  readonly transcript: readonly Json[];
  readonly text: string;
};

type PiOutcome = PiOutcomeBase &
  (
    | { readonly state: "succeeded" }
    | {
        readonly state: "failed";
        readonly error: string;
        readonly providerRetryable: boolean;
        readonly truncated: boolean;
      }
    | { readonly state: "cancelled"; readonly error: string }
  );

type PiResultBody = PiOutcome & { readonly telemetry: PiTelemetry };

export type PiResult = PiResultBody & { readonly call: EntryId };

export const XEAN_PI_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    "xean.pi.run": {
      description: "One Pi agent loop inside a Xean logical call.",
      parents: { kind: "root_or_external" },
      startAttributes: {
        "xean.call.label": {
          type: "string",
          required: true,
          cardinality: "high",
          description: "Application-defined reason for the call.",
        },
        "xean.candidate": {
          type: "number",
          required: false,
          cardinality: "high",
          description: "Candidate sequence when the call evaluates one.",
        },
        "xean.pi.reasoning.requested": {
          type: "string",
          required: false,
          values: reasoningLevels,
          cardinality: "low",
          description:
            "Pi reasoning level requested for every turn in the loop.",
        },
      },
      endAttributes: {
        "xean.pi.outcome": {
          type: "string",
          values: ["succeeded", "failed", "cancelled"],
          cardinality: "low",
          description: "Normalized result of the complete Pi loop.",
        },
      },
      events: {},
      status: {
        default: "ok",
        errorWhen: "The loop fails, is cancelled, or throws.",
      },
    },
  },
} as const);

export const PI_TELEMETRY_SCHEMA_VERSIONS = {
  "xean.pi": XEAN_PI_TELEMETRY_SCHEMA.version,
  "pi.ai": AI_TELEMETRY_SCHEMA.version,
} as const;

const PI_REQUEST_TELEMETRY_SCHEMA = defineTelemetrySchema({
  ...AI_TELEMETRY_SCHEMA,
  spans: {
    "pi.ai.request": {
      ...AI_TELEMETRY_SCHEMA.spans["pi.ai.request"],
      endAttributes: {
        ...AI_TELEMETRY_SCHEMA.spans["pi.ai.request"].endAttributes,
        "xean.pi.request.checkpoint": {
          type: "number",
          description:
            "Durable request call whose result owns this measurement.",
        },
      },
    },
  },
} as const);

const telemetryAttribute = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()).readonly(),
  z.array(z.number()).readonly(),
  z.array(z.boolean()).readonly(),
  z.undefined(),
]);
const telemetryAttributes = z.record(z.string(), telemetryAttribute).readonly();
const telemetryStatus = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ok") }),
  z.strictObject({
    status: z.literal("error"),
    error: z.strictObject({ name: z.string(), message: z.string() }).optional(),
  }),
]);
const telemetrySpan = z
  .strictObject({
    id: z.number().int().positive(),
    parentId: z.number().int().positive().nullable(),
    name: z.string(),
    attributes: telemetryAttributes,
    events: z
      .array(
        z.strictObject({ name: z.string(), attributes: telemetryAttributes }),
      )
      .readonly(),
    status: telemetryStatus,
    settled: z.boolean(),
    endSequence: z.number().int().positive().optional(),
  })
  .readonly();

export const piTelemetry = z
  .strictObject({
    schemaVersions: z
      .strictObject({
        "xean.pi": z.literal(PI_TELEMETRY_SCHEMA_VERSIONS["xean.pi"]),
        "pi.ai": z.literal(PI_TELEMETRY_SCHEMA_VERSIONS["pi.ai"]),
      })
      .readonly(),
    spans: z.array(telemetrySpan).readonly(),
  })
  .readonly();

export type PiTelemetry = z.output<typeof piTelemetry>;

const piModel = z.strictObject({
  provider: z.string().min(1),
  id: z.string().min(1),
  api: z.string().min(1),
  baseUrl: z.string().optional(),
});

function modelRecord(model: Model<Api>): z.output<typeof piModel> {
  return piModel.parse({
    provider: model.provider,
    id: model.id,
    api: model.api,
    baseUrl: model.baseUrl,
  });
}

function modelProfile(model: Model<Api>): Json {
  return jsonSnapshot({
    reasoning: model.reasoning,
    thinkingLevelMap: jsonSnapshot(model.thinkingLevelMap ?? null),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    samplingParams: jsonSnapshot(model.samplingParams ?? null),
    compat: jsonSnapshot(model.compat ?? null),
  });
}

export const piRequest = z.strictObject({
  protocol: z.literal("xean/pi-run/v1"),
  model: piModel,
  modelProfile: json,
  system: z.string().optional(),
  prompt: z.string(),
  reasoning: piReasoning.optional(),
  stopAfterToolResult: z.literal(true).optional(),
  maxRecoveries: z.number().int().min(1).max(31).optional(),
  maxLengthContinuations: z.number().int().min(1).max(31).optional(),
  submissionGate: piSubmissionGate.optional(),
  cacheKey: z.string().min(1).max(64).optional(),
});

const lengthContinuation =
  "The previous response was interrupted before completion. Continue exactly where you left off; do not restart or repeat completed work.";

// codex-lb reports transient upstream and transport failures with codes Pi's
// classifier does not recognize: upstream_unavailable, upstream_error,
// premature upstream EOFs, proxy failures, and aiohttp's ClientPayloadError.
// Quota and auth codes stay outside this pattern.
const transientGatewayErrorPattern =
  /upstream_(?:unavailable|error)|proxy_unavailable|ClientPayloadError/i;
const incompleteStreamErrorPattern =
  /^(?:(?:stream_incomplete:\s*)?Upstream closed stream without completion|upstream_eof_before_terminal_event)$/i;
const deterministicProviderErrorPattern =
  /\b(?:401|403)\b|invalid_api_key|permission denied|insufficient_quota|out of budget|quota exceeded|billing|invalid_request(?:_error)?|context_length_exceeded|tool submission|schema validation/i;
const transientGatewayDiagnosticCodes = new Set([
  "stream_incomplete",
  "upstream_eof_before_terminal_event",
]);

function hasTransientGatewayDiagnostic(message: AssistantMessage): boolean {
  return (message.diagnostics ?? []).some((diagnostic) => {
    const detail =
      diagnostic.details?.failure_detail ?? diagnostic.details?.failureDetail;
    return (
      (typeof diagnostic.error?.code === "string" &&
        transientGatewayDiagnosticCodes.has(diagnostic.error.code)) ||
      (typeof detail === "string" &&
        transientGatewayDiagnosticCodes.has(detail))
    );
  });
}

function isRetryableProviderError(message: AssistantMessage): boolean {
  if (
    message.stopReason === "error" &&
    message.errorMessage !== undefined &&
    deterministicProviderErrorPattern.test(message.errorMessage)
  ) {
    return false;
  }
  if (isRetryableAssistantError(message)) return true;
  if (message.stopReason !== "error") return false;
  // Pi reports the Responses message limit as an error. Completed reasoning
  // may advance past it; otherwise the ordinary error budget applies.
  if (
    ["openai-responses", "openai-codex-responses"].includes(message.api) &&
    message.rawStopReason === "incomplete.max_messages"
  )
    return true;
  if (hasTransientGatewayDiagnostic(message)) return true;
  return (
    message.errorMessage !== undefined &&
    (transientGatewayErrorPattern.test(message.errorMessage) ||
      incompleteStreamErrorPattern.test(message.errorMessage.trim()))
  );
}

function parsePiRequest(
  value: unknown,
): z.output<typeof piRequest> | undefined {
  const parsed = piRequest.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const piRequestLabel = "xean/pi-request";
const piRequestAttempt = z.strictObject({
  protocol: z.literal("xean/pi-request/v1"),
  parent: entryId,
  model: piModel,
  payloadRef: z.string().regex(/^[a-f0-9]{64}$/),
});

export type PiRequestAttempt = z.output<typeof piRequestAttempt> & {
  readonly call: EntryId;
  /** Expanded only when a payload reader is explicitly supplied. */
  readonly payload?: Json;
} & ({ readonly state: "completed" } | { readonly state: "unsettled" });

export function piRequestAttempts(
  entries: readonly Entry[],
  parent?: EntryId,
  payloadReader?: Pick<Reader, "payload">,
): readonly PiRequestAttempt[] {
  const selected = parent === undefined ? undefined : entryId.parse(parent);
  const calls = new Map(
    entries
      .filter((entry) => entry.kind === "call")
      .map((entry) => [entry.seq, entry]),
  );
  const results = new Map(
    entries
      .filter((entry) => entry.kind === "call-result")
      .map((entry) => [entry.parent, entry]),
  );
  return [...calls.values()].flatMap((call) => {
    if (call.label !== piRequestLabel) return [];
    const parsed = piRequestAttempt.safeParse(call.request);
    if (!parsed.success) return [];
    const attempt = parsed.data;
    if (selected !== undefined && attempt.parent !== selected) return [];
    const owner = calls.get(attempt.parent);
    if (
      owner === undefined ||
      owner.seq >= call.seq ||
      parsePiRequest(owner.request) === undefined
    ) {
      throw new Error(`invalid Pi request checkpoint call ${call.seq}`);
    }
    const settled = results.get(call.seq);
    if (settled?.state === "returned")
      piRequestCompletion.parse(settled.output);
    const state =
      settled?.state === "returned"
        ? ({ state: "completed" } as const)
        : ({ state: "unsettled" } as const);
    return [
      {
        call: call.seq,
        ...attempt,
        ...(payloadReader !== undefined
          ? { payload: payloadReader.payload(attempt.payloadRef) }
          : {}),
        ...state,
      },
    ];
  });
}

const nonnegative = z.number().finite().nonnegative();
const assistantUsageRecord = z.object({
  input: nonnegative,
  output: nonnegative,
  cacheRead: nonnegative,
  cacheWrite: nonnegative,
  totalTokens: nonnegative,
  reasoning: nonnegative.optional(),
  cost: z.object({
    input: nonnegative,
    output: nonnegative,
    cacheRead: nonnegative,
    cacheWrite: nonnegative,
    total: nonnegative,
  }),
});

function resultSchema<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion("state", [
    z.strictObject({ ...fields, state: z.literal("succeeded") }),
    z.strictObject({
      ...fields,
      state: z.literal("failed"),
      error: z.string(),
      providerRetryable: z.boolean(),
      truncated: z.boolean(),
    }),
    z.strictObject({
      ...fields,
      state: z.literal("cancelled"),
      error: z.string(),
    }),
  ]);
}

export const piStoredResult = resultSchema({
  transcript: z.array(json).readonly(),
  text: z.string(),
  telemetry: piTelemetry,
});

export const piResultRecord = resultSchema({
  call: entryId,
  textRef: z.string().regex(/^[a-f0-9]{64}$/),
  transcriptRef: z.string().regex(/^[a-f0-9]{64}$/),
  telemetry: piTelemetry,
  assistantUsage: z.array(assistantUsageRecord.nullable()).readonly(),
});

export function storePiResult(
  campaign: Campaign,
  value: PiResult,
): z.output<typeof piResultRecord> {
  const { transcript, text, ...metadata } = value;
  const assistantUsage = transcript.flatMap((message) => {
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      (message as { readonly [key: string]: Json }).role !== "assistant"
    )
      return [];
    const parsed = assistantUsageRecord.safeParse(
      (message as { readonly [key: string]: Json }).usage,
    );
    return [parsed.success ? parsed.data : null];
  });
  return piResultRecord.parse({
    ...metadata,
    assistantUsage,
    textRef: campaign.storePayloadJson(JSON.stringify(text)),
    transcriptRef: campaign.storePayloadJson(JSON.stringify(transcript)),
  });
}

/** Attachment integrity is checked on full resolution, as for checkpoint payloads. */
export function readPiResult(
  output: unknown,
  reader: Pick<Reader, "payload">,
): PiResult {
  const {
    call,
    textRef,
    transcriptRef,
    assistantUsage: _,
    ...metadata
  } = piResultRecord.parse(output);
  return {
    call,
    ...piStoredResult.parse({
      ...metadata,
      text: reader.payload(textRef),
      transcript: reader.payload(transcriptRef),
    }),
  };
}

const stopReason = z.enum([
  "stop",
  "length",
  "tool_use",
  "error",
  "aborted",
  "deferred",
]);
const requestAttributes = z.object({
  "pi.ai.provider": z.string().min(1),
  "pi.ai.model": z.string().min(1),
  "pi.ai.api": z.string().min(1),
  "pi.ai.response.model": z.string().min(1).optional(),
  "pi.ai.response.stop_reason": stopReason.optional(),
});
const usageAttributes = z
  .object({
    "pi.ai.usage.input_tokens": nonnegative,
    "pi.ai.usage.output_tokens": nonnegative,
    "pi.ai.usage.cache_read_tokens": nonnegative,
    "pi.ai.usage.cache_write_tokens": nonnegative,
    "pi.ai.usage.total_tokens": nonnegative,
    "pi.ai.usage.cost": nonnegative,
    "pi.ai.usage.reasoning_tokens": nonnegative.optional(),
  })
  .transform((usage) => ({
    input: usage["pi.ai.usage.input_tokens"],
    output: usage["pi.ai.usage.output_tokens"],
    cacheRead: usage["pi.ai.usage.cache_read_tokens"],
    cacheWrite: usage["pi.ai.usage.cache_write_tokens"],
    totalTokens: usage["pi.ai.usage.total_tokens"],
    estimatedCostUsd: usage["pi.ai.usage.cost"],
    ...(usage["pi.ai.usage.reasoning_tokens"] === undefined
      ? {}
      : { reasoning: usage["pi.ai.usage.reasoning_tokens"] }),
  }));
const usageKeys = [
  "pi.ai.usage.input_tokens",
  "pi.ai.usage.output_tokens",
  "pi.ai.usage.cache_read_tokens",
  "pi.ai.usage.cache_write_tokens",
  "pi.ai.usage.total_tokens",
  "pi.ai.usage.cost",
] as const;

export type PiMeasuredUsage = z.output<typeof usageAttributes>;

export type PiSpendOperation = Readonly<
  z.output<typeof piRequestCompletion>["operation"]
>;

const measuredUsageValue = z
  .strictObject({
    input: nonnegative,
    output: nonnegative,
    cacheRead: nonnegative,
    cacheWrite: nonnegative,
    totalTokens: nonnegative,
    estimatedCostUsd: nonnegative,
    reasoning: nonnegative.optional(),
  })
  .transform(({ reasoning, ...usage }) => ({
    ...usage,
    ...(reasoning === undefined ? {} : { reasoning }),
  }));

/** The durable terminal measurement for one provider request. */
export const piRequestCompletion = z.strictObject({
  protocol: z.literal("xean/pi-request-completion/v1"),
  parent: entryId,
  operation: z
    .strictObject({
      provider: z.string().min(1),
      requestedModel: z.string().min(1),
      servedModel: z.string().min(1).optional(),
      api: z.string().min(1),
      stopReason: stopReason.optional(),
      error: z.boolean(),
      usage: measuredUsageValue.nullable(),
    })
    .transform(({ servedModel, stopReason, ...operation }) => ({
      ...operation,
      ...(servedModel === undefined ? {} : { servedModel }),
      ...(stopReason === undefined ? {} : { stopReason }),
    })),
  responseId: z.string().optional(),
  rawStopReason: z.string().optional(),
  errorMessage: z.string().optional(),
});

function assistantUsage(message: AssistantMessage): PiMeasuredUsage | null {
  const usage = message.usage;
  if (
    (message as AssistantMessage & { usageReported?: boolean })
      .usageReported !== true &&
    ![
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.totalTokens,
      usage.reasoning ?? 0,
    ].some((value) => value !== 0)
  )
    return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    estimatedCostUsd: usage.cost.total,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
  };
}

function requestCompletion(
  parent: EntryId,
  model: Model<Api>,
  final: AssistantMessage,
): z.output<typeof piRequestCompletion> {
  return piRequestCompletion.parse({
    protocol: "xean/pi-request-completion/v1",
    parent,
    operation: {
      provider: model.provider,
      requestedModel: model.id,
      ...(final.responseModel === undefined
        ? {}
        : { servedModel: final.responseModel }),
      api: model.api,
      stopReason: telemetryStopReason(final.stopReason),
      error: final.stopReason === "error" || final.stopReason === "aborted",
      usage: assistantUsage(final),
    },
    ...(final.responseId === undefined ? {} : { responseId: final.responseId }),
    ...(final.rawStopReason === undefined
      ? {}
      : { rawStopReason: final.rawStopReason }),
    ...(final.errorMessage === undefined
      ? {}
      : { errorMessage: final.errorMessage }),
  });
}

function measuredUsage(
  attributes: Record<string, unknown>,
): PiMeasuredUsage | null {
  const present = usageKeys.filter((key) => attributes[key] !== undefined);
  const reasoning = attributes["pi.ai.usage.reasoning_tokens"] !== undefined;
  if (present.length === 0 && !reasoning) return null;
  if (present.length !== usageKeys.length) {
    throw new Error("partial Pi usage measurement");
  }
  return usageAttributes.parse(attributes);
}

export function summarizePiSpend(operations: readonly PiSpendOperation[]) {
  const measured = operations.flatMap(({ usage }) =>
    usage === null ? [] : [usage],
  );
  const sum = (key: keyof Omit<PiMeasuredUsage, "reasoning">) =>
    measured.reduce((total, usage) => total + usage[key], 0);
  const summary = {
    logicalProviderRequests: operations.length,
    requestErrors: operations.filter(({ error }) => error).length,
    unmeasuredRequests: operations.length - measured.length,
  };
  if (measured.length === 0) return summary;
  const completeReasoning = measured.every(
    ({ reasoning }) => reasoning !== undefined,
  );
  return {
    ...summary,
    measuredUsage: {
      input: sum("input"),
      output: sum("output"),
      cacheRead: sum("cacheRead"),
      cacheWrite: sum("cacheWrite"),
      totalTokens: sum("totalTokens"),
      estimatedCostUsd: sum("estimatedCostUsd"),
      ...(completeReasoning
        ? {
            reasoning: measured.reduce(
              (total, usage) => total + usage.reasoning!,
              0,
            ),
          }
        : {}),
    },
  };
}

export type PiSpendSummary = ReturnType<typeof summarizePiSpend>;

export function derivePiSpend(entries: readonly Entry[]) {
  const calls = entries.filter(
    (item): item is Extract<Entry, { kind: "call" }> =>
      item.kind === "call" && parsePiRequest(item.request) !== undefined,
  );
  const results = new Map(
    entries
      .filter((item) => item.kind === "call-result")
      .map((item) => [item.parent, item]),
  );
  const attemptsByParent = new Map<EntryId, PiRequestAttempt[]>();
  for (const attempt of piRequestAttempts(entries)) {
    const attempts = attemptsByParent.get(attempt.parent) ?? [];
    attempts.push(attempt);
    attemptsByParent.set(attempt.parent, attempts);
  }
  const accounted: (PiSpendSummary & {
    call: EntryId;
    operations: PiSpendOperation[];
  })[] = [];
  const unaccountedCalls: EntryId[] = [];
  for (const call of calls) {
    const durable = new Map<EntryId, PiSpendOperation>();
    for (const attempt of attemptsByParent.get(call.seq) ?? []) {
      const completion = results.get(attempt.call);
      if (completion?.state !== "returned") continue;
      const value = piRequestCompletion.parse(completion.output);
      if (
        value.parent !== call.seq ||
        value.operation.provider !== attempt.model.provider ||
        value.operation.requestedModel !== attempt.model.id ||
        value.operation.api !== attempt.model.api
      )
        throw new Error("invalid Pi request completion " + attempt.call);
      durable.set(attempt.call, value.operation);
    }
    const result = results.get(call.seq);
    if (result?.state !== "returned") {
      unaccountedCalls.push(call.seq);
      if (durable.size > 0) {
        const operations = [...durable.values()];
        accounted.push({
          call: call.seq,
          operations,
          ...summarizePiSpend(operations),
        });
      }
      continue;
    }
    const stored = piResultRecord.parse(result.output);
    if (stored.call !== call.seq)
      throw new Error("invalid Pi result owner " + call.seq);
    const { spans } = stored.telemetry;
    if (new Set(spans.map(({ id }) => id)).size !== spans.length)
      throw new Error("duplicate Pi telemetry span in call " + call.seq);
    const roots = spans.filter(
      ({ name, parentId }) => name === "xean.pi.run" && parentId === null,
    );
    if (roots.length !== 1 || !roots[0]!.settled)
      throw new Error("invalid Pi telemetry root in call " + call.seq);
    const operations = spans.flatMap((span): PiSpendOperation[] => {
      if (span.name !== "pi.ai.request" || span.parentId !== roots[0]!.id)
        return [];
      if (!span.settled)
        throw new Error("unsettled Pi request span in call " + call.seq);
      const checkpoint = span.attributes["xean.pi.request.checkpoint"];
      if (checkpoint !== undefined) {
        const id = entryId.parse(checkpoint);
        const operation = durable.get(id);
        if (operation === undefined)
          throw new Error("missing or duplicate Pi request completion " + id);
        durable.delete(id);
        return [operation];
      }
      // Failures before payload construction have only a logical-call span.
      // A checkpointed request is counted through its completion once.
      const attributes = requestAttributes.parse(span.attributes);
      return [
        {
          provider: attributes["pi.ai.provider"],
          requestedModel: attributes["pi.ai.model"],
          ...(attributes["pi.ai.response.model"] === undefined
            ? {}
            : { servedModel: attributes["pi.ai.response.model"] }),
          api: attributes["pi.ai.api"],
          ...(attributes["pi.ai.response.stop_reason"] === undefined
            ? {}
            : { stopReason: attributes["pi.ai.response.stop_reason"] }),
          error: span.status.status === "error",
          usage: measuredUsage(span.attributes),
        },
      ];
    });
    if (durable.size !== 0)
      throw new Error("unmatched Pi request completion in call " + call.seq);
    accounted.push({
      call: call.seq,
      operations,
      ...summarizePiSpend(operations),
    });
  }
  const potentialRequests = unaccountedCalls.flatMap((call) =>
    (attemptsByParent.get(call) ?? []).flatMap((attempt) =>
      attempt.state === "unsettled"
        ? [{ call, checkpoint: attempt.call, model: attempt.model }]
        : [],
    ),
  );
  return {
    calls: accounted,
    unaccountedCalls,
    potentialRequests,
    summary: summarizePiSpend(
      accounted.flatMap(({ operations }) => operations),
    ),
  };
}

export type PiSpend = ReturnType<typeof derivePiSpend>;

function piTool(
  tool: AuditedTool,
  stopAfterToolResult: boolean,
): AgentTool<TSchema, Json> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as TSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(id, input) {
      const output = await tool.execute(input, id);
      return {
        content: [{ type: "text", text: JSON.stringify(output) }],
        details: output,
        ...(stopAfterToolResult ? { terminate: true } : {}),
      };
    },
  };
}

function submissionContext(
  gate: PiSubmissionGate,
  model: Model<Api>,
  context: Context,
) {
  const reserveTokens = gate.reserveTokens ?? model.maxTokens;
  const budgetedModel = {
    ...model,
    contextWindow: Math.min(
      model.contextWindow,
      gate.contextBudgetTokens ?? model.contextWindow,
    ),
  };
  const threshold =
    clampMaxTokensToContext(
      budgetedModel,
      { messages: [] },
      budgetedModel.contextWindow,
    ) - reserveTokens;
  if (!(threshold > 0))
    throw new Error(
      "submission reserve and native safety margin leave no usable context",
    );
  const { tokens } = estimateContextTokens(context);
  const maxTokens = clampMaxTokensToContext(
    tokens < threshold
      ? {
          ...budgetedModel,
          contextWindow: budgetedModel.contextWindow - reserveTokens,
        }
      : budgetedModel,
    context,
    model.maxTokens,
  );
  return {
    tokens,
    threshold,
    exhausted: tokens >= threshold && maxTokens === 1,
    maxTokens,
  };
}

function submissionFeedback(
  gate: PiSubmissionGate,
  state: ReturnType<typeof submissionContext>,
): string {
  const occupancy = `Estimated context occupancy: ${state.tokens} tokens; submission threshold: ${state.threshold} tokens.`;
  const continuation =
    gate.continuationPrompt ??
    "The original task remains unresolved. Treat saved work as intermediate progress. Reassess the current approach using what you have learned: identify the unresolved obstacle, then work through it or choose another promising approach. Continue substantive work in this context. Save new results, concrete gaps, or failed approaches with their reasons when useful.";
  return state.tokens < state.threshold
    ? continuation
    : `${occupancy} Finalize now. Set ${gate.completeArgument} truthfully: true only if the task is complete, otherwise false.`;
}

function jsonSnapshot(value: unknown): Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Pi value is not JSON");
  return JSON.parse(encoded) as Json;
}

function result(
  messages: readonly AgentMessage[],
  stopAfterToolResult: boolean,
  signal: AbortSignal | undefined,
  contextWindow: number,
  requireSubmission = false,
): PiOutcome {
  const stored = jsonSnapshot(messages) as readonly Json[];
  let final: AssistantMessage | undefined;
  let finalAt = -1;
  let next: AgentMessage | undefined;
  const parts: string[] = [];
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!;
    if (message.role === "assistant") {
      if (final === undefined) {
        final = message;
        finalAt = at;
      }
      const interrupted =
        next?.role === "user" &&
        next.content === lengthContinuation &&
        message.stopReason === "length";
      if (message === final || interrupted)
        parts.push(contentText(message.content));
    }
    if (message.role !== "toolResult") next = message;
  }
  parts.reverse();
  const text = parts.join("");
  if (signal?.aborted || final?.stopReason === "aborted") {
    return {
      state: "cancelled",
      text,
      transcript: stored,
      error: final?.errorMessage ?? "Pi call was cancelled",
    };
  }
  const afterFinal = messages.slice(finalAt + 1);
  const stoppedAfterTool =
    stopAfterToolResult &&
    (final?.stopReason === "toolUse" ||
      (requireSubmission && final?.stopReason === "stop")) &&
    afterFinal.length > 0 &&
    afterFinal.every(
      (message) => message.role === "toolResult" && !message.isError,
    );
  const overflow =
    final !== undefined && isContextOverflow(final, contextWindow);
  if (
    final === undefined ||
    overflow ||
    (requireSubmission && !stoppedAfterTool) ||
    (final.stopReason !== "stop" && !stoppedAfterTool)
  ) {
    return {
      state: "failed",
      text,
      transcript: stored,
      providerRetryable:
        final !== undefined && !overflow && isRetryableProviderError(final),
      truncated:
        final !== undefined &&
        final.stopReason === "length" &&
        !overflow &&
        final.usage.output > 0,
      error:
        final?.errorMessage ??
        (final === undefined
          ? "Pi returned no assistant message"
          : overflow
            ? "Pi exceeded its context window"
            : requireSubmission && final.stopReason === "stop"
              ? "Pi ended without a terminal submission"
              : `Pi stopped with ${final.stopReason}`),
    };
  }
  return { state: "succeeded", text, transcript: stored };
}

function telemetryStopReason(
  value: AssistantMessage["stopReason"],
): "stop" | "length" | "tool_use" | "error" | "aborted" | "deferred" {
  if (value === "toolUse") return "tool_use";
  return value === "pending" ? "error" : value;
}

// Pi's openai-responses adapter renders the system prompt as a leading
// developer message and leaves the top-level instructions field empty, whereas
// its codex adapter places the system prompt in instructions. On the ChatGPT
// reasoning backend the developer-message shape, combined with a required
// terminal tool, makes the model emit the tool call before reasoning (a few
// hundred reasoning tokens); the instructions shape reasons first (tens of
// thousands). Normalize the responses payload to the codex shape by hoisting
// the leading developer message into instructions.
function hoistResponsesInstructions(
  payload: unknown,
  model: Model<Api>,
): unknown {
  if (model.api !== "openai-responses") return payload;
  if (typeof payload !== "object" || payload === null) return payload;
  const record = payload as Record<string, unknown>;
  if (
    typeof record.instructions === "string" &&
    record.instructions.length > 0
  ) {
    return payload;
  }
  const input = record.input;
  if (!Array.isArray(input)) return payload;
  const [head, ...rest] = input;
  if (
    typeof head !== "object" ||
    head === null ||
    (head as { role?: unknown }).role !== "developer" ||
    typeof (head as { content?: unknown }).content !== "string"
  ) {
    return payload;
  }
  return {
    ...record,
    instructions: (head as { content: string }).content,
    input: rest,
  };
}

function measuredStream(
  campaign: Campaign,
  parent: EntryId,
  models: PiModels,
  cacheKey: string | undefined,
  recovery: ReasoningRecovery,
  submissionGate: PiSubmissionGate | undefined,
): StreamFn {
  return (model, context, options) => {
    const forwarded = createAssistantMessageEventStream();
    const requestOptions =
      submissionGate === undefined
        ? options
        : {
            ...options,
            maxTokens: submissionContext(submissionGate, model, context)
              .maxTokens,
          };
    const producer = createTypedSpanStarter(
      options?.telemetryContext ?? NOOP_TELEMETRY_CONTEXT,
      [PI_REQUEST_TELEMETRY_SCHEMA],
    )(
      "pi.ai.request",
      {
        "pi.ai.operation": "stream",
        "pi.ai.provider": model.provider,
        "pi.ai.model": model.id,
        "pi.ai.api": model.api,
        "pi.ai.streaming": true,
      },
      async (span) => {
        let httpStatus: number | undefined;
        let hookCalls = 0;
        let checkpointed = false;
        let checkpoint: ReturnType<Campaign["call"]> | undefined;
        const completion =
          Promise.withResolvers<z.output<typeof piRequestCompletion>>();
        // Own a rejection even when the writer fails before entering its handler.
        void completion.promise.catch(() => {});
        try {
          const stream = models.streamSimple(model, context, {
            ...requestOptions,
            telemetryContext: span,
            onPayload: async (payload, requestModel) => {
              hookCalls += 1;
              if (hookCalls !== 1)
                throw new Error(
                  "Pi adapter must invoke onPayload exactly once per request",
                );
              const replacement = await options?.onPayload?.(
                payload,
                requestModel,
              );
              const effective = withPromptCacheKey(
                hoistResponsesInstructions(
                  replacement === undefined ? payload : replacement,
                  requestModel,
                ),
                cacheKey,
              );
              const encoded = JSON.stringify(effective);
              if (encoded === undefined)
                throw new TypeError("Pi value is not JSON");
              const payloadRef = campaign.storePayloadJson(encoded);
              const started = Promise.withResolvers<void>();
              checkpoint = campaign.call(
                {
                  label: piRequestLabel,
                  request: jsonSnapshot({
                    protocol: "xean/pi-request/v1",
                    parent,
                    model: modelRecord(requestModel),
                    payloadRef,
                  }),
                },
                async ({ call }) => {
                  span.setAttributes({ "xean.pi.request.checkpoint": call });
                  started.resolve();
                  return completion.promise;
                },
              );
              void checkpoint.catch(started.reject);
              await started.promise;
              checkpointed = true;
              return effective;
            },
            onResponse: async (response, responseModel) => {
              httpStatus = response.status;
              await options?.onResponse?.(response, responseModel);
            },
          });
          const observed = recovery.observe(model);
          let terminal:
            | Extract<AssistantMessageEvent, { type: "done" | "error" }>
            | undefined;
          for await (const event of stream) {
            observed.event(event);
            if (event.type === "done" || event.type === "error")
              terminal = event;
            else forwarded.push(event);
          }
          const final = await stream.result();
          observed.settle(final);
          const failedBeforeCheckpoint =
            hookCalls <= 1 &&
            !checkpointed &&
            (final.stopReason === "error" || final.stopReason === "aborted");
          if ((hookCalls !== 1 || !checkpointed) && !failedBeforeCheckpoint)
            throw new Error(
              "Pi adapter must invoke onPayload exactly once per request",
            );
          const measurement = requestCompletion(parent, model, final);
          const { usage } = measurement.operation;
          span.setAttributes({
            ...(final.responseModel === undefined
              ? {}
              : { "pi.ai.response.model": final.responseModel }),
            ...(final.responseId === undefined
              ? {}
              : { "pi.ai.response.id": final.responseId }),
            "pi.ai.response.stop_reason": telemetryStopReason(final.stopReason),
            ...(httpStatus === undefined
              ? {}
              : { "pi.ai.http.status_code": httpStatus }),
            ...(usage === null
              ? {}
              : {
                  "pi.ai.usage.input_tokens": usage.input,
                  "pi.ai.usage.output_tokens": usage.output,
                  "pi.ai.usage.cache_read_tokens": usage.cacheRead,
                  "pi.ai.usage.cache_write_tokens": usage.cacheWrite,
                  ...(usage.reasoning === undefined
                    ? {}
                    : { "pi.ai.usage.reasoning_tokens": usage.reasoning }),
                  "pi.ai.usage.total_tokens": usage.totalTokens,
                  "pi.ai.usage.cost": usage.estimatedCostUsd,
                }),
          });
          if (final.stopReason === "error" || final.stopReason === "aborted")
            span.setStatus({
              status: "error",
              error: {
                name:
                  final.stopReason === "aborted"
                    ? "AbortError"
                    : "ProviderError",
                message: final.errorMessage ?? "Pi request " + final.stopReason,
              },
            });
          completion.resolve(measurement);
          await checkpoint;
          return { final, terminal };
        } catch (error) {
          completion.reject(error);
          await checkpoint?.catch(() => {});
          throw error;
        }
      },
    );
    // The agent can consume deltas immediately. Its terminal event/result are
    // released only after the producer, durable completion, and span settle.
    const finished = producer.then(
      ({ final, terminal }) => {
        if (terminal !== undefined) forwarded.push(terminal);
        forwarded.end(final);
        return final;
      },
      (error: unknown) => {
        forwarded.end();
        throw error;
      },
    );
    void finished.catch(() => {});
    forwarded.result = () => finished;
    return forwarded;
  };
}

function withPromptCacheKey(payload: unknown, cacheKey: string | undefined) {
  return cacheKey !== undefined &&
    typeof payload === "object" &&
    payload !== null &&
    "prompt_cache_key" in payload
    ? { ...payload, prompt_cache_key: cacheKey }
    : payload;
}

interface PiCallExecutionOptions {
  readonly request: z.output<typeof piRequest>;
  readonly label: string;
  readonly role?: string;
  readonly candidate?: EntryId;
  readonly tools?: readonly Tool[];
  readonly models: PiModels;
  readonly model: Model<Api>;
  readonly signal?: AbortSignal;
  readonly transport?: Transport;
}

async function runPiCall(
  campaign: Campaign,
  options: PiCallExecutionOptions,
): Promise<PiResult> {
  if (typeof options.models?.streamSimple !== "function") {
    throw new TypeError("Pi models must provide streamSimple");
  }
  let full: PiResult | undefined;
  await campaign.call(
    {
      label: options.label,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.candidate === undefined
        ? {}
        : { candidate: options.candidate }),
      request: jsonSnapshot(options.request),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    async ({ call, request, tools, signal }) => {
      const exact = parsePiRequest(request);
      if (exact === undefined) throw new Error("invalid stored Pi request");
      full = {
        call,
        ...(await runPiBody(campaign, call, exact, tools, signal, options)),
      };
      return storePiResult(campaign, full);
    },
  );
  if (full === undefined) throw new Error("Pi call returned without a result");
  return full;
}

async function runPiBody(
  campaign: Campaign,
  call: EntryId,
  exact: z.output<typeof piRequest>,
  tools: readonly AuditedTool[],
  signal: AbortSignal,
  options: Pick<
    PiCallExecutionOptions,
    "models" | "model" | "label" | "candidate" | "transport"
  >,
): Promise<PiResultBody> {
  const telemetry = new InMemoryTelemetryContext();
  // One transport session per logical call. Pi adapters key provider-side
  // prompt caching, session affinity, and the WebSocket-to-SSE failure
  // fallback on this ID; without it a WebSocket failure repeats on every
  // recovery attempt. The ID is transport configuration and is not persisted.
  const sessionId = crypto.randomUUID();
  const recovery = new ReasoningRecovery();
  const startSpan = createTypedSpanStarter(telemetry, [
    XEAN_PI_TELEMETRY_SCHEMA,
  ]);
  try {
    const body = await startSpan(
      "xean.pi.run",
      {
        "xean.call.label": options.label,
        ...(options.candidate === undefined
          ? {}
          : { "xean.candidate": options.candidate }),
        ...(exact.reasoning === undefined
          ? {}
          : { "xean.pi.reasoning.requested": exact.reasoning }),
      },
      async (span) => {
        let turns = 0;
        let responses = 0;
        let errorRecoveries = 0;
        const gate = exact.submissionGate;
        const responseLimitReached = () =>
          gate?.maxResponses !== undefined && responses >= gate.maxResponses;
        let steering: AgentMessage[] = [];
        const contextState = (context: AgentContext) =>
          submissionContext(gate!, options.model, {
            ...context,
            messages: convertToLlm(recovery.forModel(context.messages)),
          });
        const agentContext = (
          messages: readonly AgentMessage[],
        ): AgentContext => ({
          systemPrompt: exact.system ?? "",
          messages: [...messages],
          ...(tools.length === 0
            ? {}
            : {
                tools: tools.map((tool) =>
                  piTool(
                    tool,
                    exact.stopAfterToolResult === true && gate === undefined,
                  ),
                ),
              }),
        });
        const loop = (
          content: string | undefined,
          prior: readonly AgentMessage[],
        ): Promise<AgentMessage[]> =>
          runAgentLoop(
            content === undefined
              ? []
              : [{ role: "user", content, timestamp: Date.now() }],
            agentContext(prior),
            {
              model: options.model,
              convertToLlm: (messages) =>
                convertToLlm(recovery.forModel(messages)),
              toolExecution: "sequential",
              sessionId,
              ...(options.transport === undefined
                ? {}
                : { transport: options.transport }),
              telemetryContext: span,
              shouldStopAfterTurn: async ({
                message,
                context,
                toolResults,
              }) => {
                if (
                  message.stopReason === "stop" ||
                  message.stopReason === "toolUse"
                )
                  errorRecoveries = 0;
                turns += 1;
                if (!["error", "aborted"].includes(message.stopReason))
                  responses += 1;
                if (gate === undefined)
                  return turns >= 32 || message.stopReason === "length";
                if (responseLimitReached()) return true;
                const state = contextState(context);
                if (
                  message.stopReason === "length" ||
                  (message.stopReason === "stop" && toolResults.length === 0)
                )
                  steering = [
                    {
                      role: "user",
                      content: submissionFeedback(gate, state),
                      timestamp: Date.now(),
                    },
                  ];
                return (
                  state.exhausted ||
                  (message.stopReason !== "length" &&
                    message.content.filter((block) => block.type === "toolCall")
                      .length > 1)
                );
              },
              ...(gate === undefined
                ? {}
                : {
                    beforeToolCall: async (entry: BeforeToolCallContext) => {
                      if (
                        entry.assistantMessage.content.filter(
                          (block) => block.type === "toolCall",
                        ).length !== 1
                      ) {
                        return {
                          block: true,
                          terminate: true,
                          reason:
                            "A gated response permits exactly one submission tool call.",
                        };
                      }
                      return undefined;
                    },
                    // Schema rejection before the tool-call record is safe to correct.
                    afterToolCall: async ({
                      toolCall,
                      args,
                      context,
                      isError,
                    }) => {
                      if (isError) {
                        const recorded = campaign
                          .records({ kinds: ["tool-call"], call })
                          .some(
                            (entry) =>
                              entry.kind === "tool-call" &&
                              entry.source === toolCall.id,
                          );
                        return { terminate: recorded };
                      }
                      const state = contextState(context);
                      const submitted =
                        typeof args === "object" && args !== null
                          ? (args as Record<string, unknown>)
                          : {};
                      const empty =
                        gate.emptyArgument === undefined
                          ? undefined
                          : submitted[gate.emptyArgument];
                      const terminate =
                        submitted[gate.completeArgument] === true ||
                        (Array.isArray(empty) && empty.length === 0) ||
                        // This response is counted after its tool call finishes.
                        (gate.maxResponses !== undefined &&
                          responses + 1 >= gate.maxResponses) ||
                        state.tokens >= state.threshold;
                      if (!terminate)
                        steering = [
                          {
                            role: "user",
                            content: submissionFeedback(gate, state),
                            timestamp: Date.now(),
                          },
                        ];
                      return { terminate };
                    },
                    getSteeringMessages: async () => {
                      const messages = steering;
                      steering = [];
                      return signal.aborted ? [] : messages;
                    },
                  }),
              ...(exact.reasoning === undefined
                ? {}
                : { reasoning: exact.reasoning }),
            },
            () => {},
            signal,
            measuredStream(
              campaign,
              call,
              options.models,
              exact.cacheKey,
              recovery,
              gate,
            ),
          );
        let messages = await loop(exact.prompt, []);
        let lengthContinuations = 0;
        for (;;) {
          if (gate === undefined && turns >= 32) break;
          if (responseLimitReached()) break;
          const final = messages.findLast(
            (message): message is AssistantMessage =>
              message.role === "assistant",
          );
          const retry =
            final?.stopReason === "error" && isRetryableProviderError(final);
          const interrupted =
            final !== undefined &&
            !signal?.aborted &&
            !isContextOverflow(final, options.model.contextWindow) &&
            (retry || (gate === undefined && final.stopReason === "length"));
          if (!interrupted) break;
          const projected =
            retry && final.rawStopReason === "incomplete.max_messages"
              ? recovery.forModel(messages)
              : undefined;
          if (projected !== undefined) {
            // Preserve completed reasoning, while charging every provider error
            // against the same recovery allowance.
            if (
              gate !== undefined
                ? contextState(agentContext(messages)).exhausted
                : clampMaxTokensToContext(
                    options.model,
                    {
                      ...agentContext(messages),
                      messages: convertToLlm(projected),
                    },
                    options.model.maxTokens,
                  ) === 1
            )
              break;
          }
          if (retry) {
            if (errorRecoveries >= (exact.maxRecoveries ?? 0)) break;
            errorRecoveries += 1;
          } else {
            if (lengthContinuations >= (exact.maxLengthContinuations ?? 0))
              break;
            lengthContinuations += 1;
          }
          const prior = messages;
          const direction =
            gate !== undefined &&
            final.rawStopReason === "incomplete.max_messages"
              ? submissionFeedback(gate, contextState(agentContext(prior)))
              : retry
                ? undefined
                : lengthContinuation;
          messages = [...prior, ...(await loop(direction, prior))];
        }
        const outcome = result(
          messages,
          exact.stopAfterToolResult === true,
          signal,
          options.model.contextWindow,
          gate !== undefined,
        );
        span.setAttributes({ "xean.pi.outcome": outcome.state });
        if (outcome.state !== "succeeded") {
          span.setStatus({
            status: "error",
            error: { name: "PiRunError", message: outcome.error },
          });
        }
        return outcome;
      },
    );
    return {
      ...body,
      telemetry: {
        schemaVersions: PI_TELEMETRY_SCHEMA_VERSIONS,
        spans: telemetry.getSpans(),
      },
    } satisfies PiResultBody;
  } finally {
    cleanupSessionResources(sessionId);
  }
}

export async function runPi(
  campaign: Campaign,
  options: PiRunOptions,
): Promise<PiResult> {
  const parsed = piRequest.parse({
    protocol: "xean/pi-run/v1",
    model: modelRecord(options.model),
    modelProfile: modelProfile(options.model),
    ...(options.system === undefined ? {} : { system: options.system }),
    prompt: options.prompt,
    ...(options.reasoning === undefined
      ? {}
      : { reasoning: options.reasoning }),
    ...(options.stopAfterToolResult === true
      ? { stopAfterToolResult: true as const }
      : {}),
    ...(options.maxRecoveries === undefined
      ? {}
      : { maxRecoveries: options.maxRecoveries }),
    ...(options.maxLengthContinuations === undefined
      ? {}
      : { maxLengthContinuations: options.maxLengthContinuations }),
    ...(options.submissionGate === undefined
      ? {}
      : { submissionGate: options.submissionGate }),
    ...(options.cacheKey === undefined ? {} : { cacheKey: options.cacheKey }),
  });
  if (parsed.submissionGate !== undefined) {
    if (!parsed.stopAfterToolResult || options.tools?.length !== 1)
      throw new TypeError("Pi submission gate requires one terminal tool");
    submissionContext(parsed.submissionGate, options.model, { messages: [] });
  }
  return runPiCall(campaign, {
    request: parsed,
    label: options.label,
    ...(options.role === undefined ? {} : { role: options.role }),
    ...(options.candidate === undefined
      ? {}
      : { candidate: options.candidate }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    models: options.models,
    model: options.model,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.transport === undefined
      ? {}
      : { transport: options.transport }),
  });
}
