import {
  convertToLlm,
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
  createInitialSystemMessage,
  normalizeContext,
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
  contextBudgetTokens: z.number().int().positive().optional(),
  maxResponses: z.number().int().positive().optional(),
  continuationPrompt: z.string().regex(/\S/u),
});
export type PiSubmissionGate = z.output<typeof piSubmissionGate>;

export type PiRunOptions = Readonly<
  Omit<
    z.input<typeof piRequest>,
    "protocol" | "model" | "modelProfile" | "replayReasoning"
  >
> & {
  readonly models: PiModels;
  readonly model: Model<Api>;
  readonly label: string;
  readonly role?: string;
  readonly parent?: EntryId;
  readonly tools?: readonly Tool[];
  readonly signal?: AbortSignal;
  readonly transport?: Transport;
  /** False keeps completed reasoning out of later model input in this call. */
  readonly replayReasoning?: boolean;
};
type PiOutcome = Readonly<z.output<typeof piStoredResult>>;
export type PiResult = PiOutcome & { readonly call: EntryId };

const piModel = z.strictObject({
  provider: z.string().min(1),
  id: z.string().min(1),
  api: z.string().min(1),
  baseUrl: z.string().optional(),
});

const modelRecord = piModel.strip();

function modelProfile(model: Model<Api>): Json {
  return jsonSnapshot({
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap ?? null,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    samplingParams: model.samplingParams ?? null,
    compat: model.compat ?? null,
  });
}

export const piRequest = z.strictObject({
  protocol: z.literal("xean/pi-run/v4"),
  model: piModel,
  modelProfile: json,
  system: z.string().optional(),
  prompt: z.string(),
  reasoning: piReasoning.optional(),
  maxRecoveries: z.number().int().min(1).max(31).optional(),
  maxLengthContinuations: z.number().int().min(1).max(31).optional(),
  submissionGate: piSubmissionGate.optional(),
  cacheKey: z.string().min(1).max(64).optional(),
  replayReasoning: z.literal(false).optional(),
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
  /\b(?:401|403)\b|invalid_api_key|permission denied|insufficient_quota|out of budget|quota exceeded|billing|invalid_request(?:_error)?|context_length_exceeded/i;

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
  // Pi's codex adapter records a failed WebSocket transport as a diagnostic
  // rather than in the error text.
  if (
    message.diagnostics?.some(
      ({ type }) => type === "provider_transport_failure",
    )
  )
    return true;
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

function piRequestData(
  entries: readonly Entry[],
  parent?: EntryId,
  payloadReader?: Pick<Reader, "payload">,
) {
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
  const completions = new Map<EntryId, z.output<typeof piRequestCompletion>>();
  const attempts: PiRequestAttempt[] = [...calls.values()].flatMap((call) => {
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
      completions.set(call.seq, piRequestCompletion.parse(settled.output));
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
  return { results, attempts, completions };
}

export function piRequestAttempts(
  entries: readonly Entry[],
  parent?: EntryId,
  payloadReader?: Pick<Reader, "payload">,
): readonly PiRequestAttempt[] {
  return piRequestData(entries, parent, payloadReader).attempts;
}

const nonnegative = z.number().finite().nonnegative();
function resultSchema<T extends z.ZodRawShape>(fields: T) {
  return z.discriminatedUnion("state", [
    z.strictObject({ ...fields, state: z.literal("succeeded") }),
    z.strictObject({
      ...fields,
      state: z.literal("failed"),
      error: z.string(),
      providerRetryable: z.boolean(),
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
});

export const piResultRecord = resultSchema({
  call: entryId,
  textRef: z.string().regex(/^[a-f0-9]{64}$/),
  transcriptRef: z.string().regex(/^[a-f0-9]{64}$/),
});

export function storePiResult(
  campaign: Campaign,
  value: PiResult,
): z.output<typeof piResultRecord> {
  const { transcript, text, ...metadata } = value;
  return piResultRecord.parse({
    ...metadata,
    textRef: campaign.storePayloadJson(JSON.stringify(text)),
    transcriptRef: campaign.storePayloadJson(JSON.stringify(transcript)),
  });
}

/** Attachment integrity is checked on full resolution, as for checkpoint payloads. */
export function readPiResult(
  output: unknown,
  reader: Pick<Reader, "payload">,
): PiResult {
  const { call, textRef, transcriptRef, ...metadata } =
    piResultRecord.parse(output);
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

export type PiMeasuredUsage = z.output<typeof measuredUsageValue>;

/** The durable terminal measurement for one provider request. */
export const piRequestCompletion = z.strictObject({
  protocol: z.literal("xean/pi-request-completion/v2"),
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
  httpStatus: z.number().int().min(100).max(599).optional(),
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
  httpStatus: number | undefined,
): z.output<typeof piRequestCompletion> {
  return piRequestCompletion.parse(
    jsonSnapshot({
      protocol: "xean/pi-request-completion/v2",
      parent,
      operation: {
        provider: model.provider,
        requestedModel: model.id,
        servedModel: final.responseModel,
        api: model.api,
        stopReason: completionStopReason(final.stopReason),
        error: final.stopReason === "error" || final.stopReason === "aborted",
        usage: assistantUsage(final),
      },
      responseId: final.responseId,
      httpStatus,
      rawStopReason: final.rawStopReason,
      errorMessage: final.errorMessage,
    }),
  );
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

/** Shared accounting interpretation; readers decide how unsupported records are presented. */
export function derivePiAccounting(entries: readonly Entry[]) {
  const { results, attempts, completions } = piRequestData(entries);
  const attemptsByParent = new Map<EntryId, PiRequestAttempt[]>();
  for (const attempt of attempts) {
    const values = attemptsByParent.get(attempt.parent) ?? [];
    values.push(attempt);
    attemptsByParent.set(attempt.parent, values);
  }
  const calls = entries
    .filter((entry) => entry.kind === "call")
    .map((call) => {
      const request = parsePiRequest(call.request);
      if (request === undefined) return undefined;
      const result = results.get(call.seq);
      const base = {
        call,
        request,
        attempts: attemptsByParent.get(call.seq) ?? [],
        settled: result?.state === "returned",
      };
      try {
        const stored =
          result?.state === "returned"
            ? piResultRecord.parse(result.output)
            : undefined;
        if (stored !== undefined && stored.call !== call.seq)
          throw new Error(`invalid Pi result call ${call.seq}`);
        const operations = base.attempts.flatMap((attempt) => {
          const completion = completions.get(attempt.call);
          if (completion === undefined) return [];
          const { parent, operation } = completion;
          if (
            parent !== call.seq ||
            operation.provider !== attempt.model.provider ||
            operation.requestedModel !== attempt.model.id ||
            operation.api !== attempt.model.api
          )
            throw new Error("invalid Pi request completion " + attempt.call);
          return [operation];
        });
        return stored === undefined && operations.length === 0
          ? { ...base, state: "unaccounted" as const }
          : {
              ...base,
              state: "available" as const,
              stored,
              operations,
            };
      } catch (error) {
        return { ...base, state: "unsupported" as const, error };
      }
    })
    .filter((value) => value !== undefined);
  return {
    calls,
    attempts,
    results,
    completions,
    byCall: new Map(calls.map((value) => [value.call.seq, value])),
  };
}

export function derivePiSpend(entries: readonly Entry[]) {
  const accounting = derivePiAccounting(entries);
  const calls = accounting.calls.flatMap((value) => {
    if (value.state === "unsupported") throw value.error;
    return value.state === "available"
      ? [
          {
            call: value.call.seq,
            operations: value.operations,
            ...summarizePiSpend(value.operations),
          },
        ]
      : [];
  });
  return {
    calls,
    unaccountedCalls: accounting.calls
      .filter((value) => !value.settled)
      .map(({ call }) => call.seq),
    potentialRequests: accounting.attempts.flatMap((attempt) =>
      attempt.state === "unsettled"
        ? [
            {
              call: attempt.parent,
              checkpoint: attempt.call,
              model: attempt.model,
            },
          ]
        : [],
    ),
    summary: summarizePiSpend(calls.flatMap(({ operations }) => operations)),
  };
}

export type PiSpend = ReturnType<typeof derivePiSpend>;

function piTool(
  tool: AuditedTool,
  terminate: boolean,
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
        ...(terminate ? { terminate } : {}),
      };
    },
  };
}

function submissionContext(
  gate: PiSubmissionGate,
  model: Model<Api>,
  context: Context,
) {
  const reserveTokens = model.maxTokens;
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
      normalizeContext({ messages: [] }),
      budgetedModel.contextWindow,
    ) - reserveTokens;
  if (!(threshold > 0))
    throw new Error(
      "submission reserve and native safety margin leave no usable context",
    );
  const transcript = normalizeContext(context);
  const { tokens } = estimateContextTokens(transcript);
  const maxTokens = clampMaxTokensToContext(
    tokens < threshold
      ? {
          ...budgetedModel,
          contextWindow: budgetedModel.contextWindow - reserveTokens,
        }
      : budgetedModel,
    transcript,
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
  return state.tokens < state.threshold
    ? gate.continuationPrompt
    : `${occupancy} Finalize now. Set ${gate.completeArgument} truthfully: true only if the task is complete, otherwise false.`;
}

function jsonSnapshot(value: unknown): Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Pi value is not JSON");
  return JSON.parse(encoded) as Json;
}

function result(
  messages: readonly AgentMessage[],
  signal: AbortSignal | undefined,
  contextWindow: number,
  requireSubmission: boolean,
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
    (final?.stopReason === "toolUse" || final?.stopReason === "stop") &&
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

function completionStopReason(
  value: AssistantMessage["stopReason"],
): z.output<typeof stopReason> {
  if (value === "toolUse") return "tool_use";
  return value === "pending" ? "error" : value;
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
    const finished = (async () => {
      let hookCalls = 0;
      let checkpointed = false;
      let httpStatus: number | undefined;
      let checkpoint: ReturnType<Campaign["call"]> | undefined;
      const completion =
        Promise.withResolvers<z.output<typeof piRequestCompletion>>();
      // Own a rejection even when the writer fails before entering its handler.
      void completion.promise.catch(() => {});
      try {
        const stream = models.streamSimple(model, context, {
          ...requestOptions,
          onResponse: async (response, responseModel) => {
            httpStatus = response.status;
            await options?.onResponse?.(response, responseModel);
          },
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
              replacement === undefined ? payload : replacement,
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
                  model: modelRecord.parse(requestModel),
                  payloadRef,
                }),
              },
              async () => {
                started.resolve();
                return completion.promise;
              },
            );
            void checkpoint.catch(started.reject);
            await started.promise;
            checkpointed = true;
            return effective;
          },
        });
        const observed = recovery.observe(model);
        let terminal:
          | Extract<AssistantMessageEvent, { type: "done" | "error" }>
          | undefined;
        for await (const event of stream) {
          observed.event(event);
          if (event.type === "done" || event.type === "error") terminal = event;
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
        completion.resolve(requestCompletion(parent, model, final, httpStatus));
        await checkpoint;
        // Deltas forward immediately; terminal events wait for durable completion.
        if (terminal !== undefined) forwarded.push(terminal);
        forwarded.end(final);
        return final;
      } catch (error) {
        completion.reject(error);
        await checkpoint?.catch(() => {});
        forwarded.end();
        throw error;
      }
    })();
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

async function runPiBody(
  campaign: Campaign,
  call: EntryId,
  exact: z.output<typeof piRequest>,
  tools: readonly AuditedTool[],
  signal: AbortSignal,
  options: Pick<PiRunOptions, "models" | "model" | "transport">,
): Promise<PiOutcome> {
  // One transport session per logical call. Pi adapters key provider-side
  // prompt caching, session affinity, and the WebSocket-to-SSE failure
  // fallback on this ID; without it a WebSocket failure repeats on every
  // recovery attempt. The ID is transport configuration and is not persisted.
  const sessionId = crypto.randomUUID();
  const recovery = new ReasoningRecovery();
  // The transcript always retains reasoning; only the model-input view drops
  // it when the request declines replay.
  const modelInput = (messages: AgentMessage[]): AgentMessage[] =>
    recovery.forModel(messages, exact.replayReasoning !== false);
  try {
    let responses = 0;
    let errorRecoveries = 0;
    const gate = exact.submissionGate;
    const responseLimitReached = () =>
      gate?.maxResponses !== undefined && responses >= gate.maxResponses;
    const contextState = (context: AgentContext) =>
      submissionContext(gate!, options.model, {
        messages: convertToLlm(modelInput(context.messages)),
      });
    const agentContext = (messages: readonly AgentMessage[]): AgentContext => ({
      messages: [...messages],
      ...(tools.length === 0
        ? {}
        : { tools: tools.map((tool) => piTool(tool, gate === undefined)) }),
    });
    const loop = (
      content: string | undefined,
      prior: readonly AgentMessage[],
    ): Promise<AgentMessage[]> =>
      runAgentLoop(
        [
          ...(prior.length === 0
            ? [createInitialSystemMessage(exact.system, undefined)].filter(
                (message) => message !== undefined,
              )
            : []),
          ...(content === undefined
            ? []
            : [{ role: "user" as const, content, timestamp: Date.now() }]),
        ],
        agentContext(prior),
        {
          model: options.model,
          convertToLlm: (messages) => convertToLlm(modelInput(messages)),
          toolExecution: "sequential",
          sessionId,
          ...(options.transport === undefined
            ? {}
            : { transport: options.transport }),
          finishTurn: async ({ message, context, toolResults }) => {
            if (signal.aborted) return { action: "end" };
            if (["error", "aborted"].includes(message.stopReason)) return;
            if (
              message.stopReason === "stop" ||
              message.stopReason === "toolUse"
            )
              errorRecoveries = 0;
            responses += 1;
            if (gate === undefined)
              return responses >= 32 || message.stopReason === "length"
                ? { action: "end" }
                : undefined;
            if (responseLimitReached()) return { action: "end" };
            const state = contextState(context);
            if (
              state.exhausted ||
              (message.stopReason !== "length" &&
                message.content.filter((block) => block.type === "toolCall")
                  .length > 1)
            )
              return { action: "end" };
            if (
              message.stopReason === "length" ||
              (message.stopReason === "stop" && toolResults.length === 0)
            )
              return { action: "continue" };
            return undefined;
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
                afterToolCall: async ({ toolCall, args, context, isError }) => {
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
                  return { terminate };
                },
                prepareNextTurn: async ({ message, context, toolResults }) => {
                  if (
                    signal.aborted ||
                    !(
                      message.stopReason === "length" ||
                      (message.stopReason === "stop" &&
                        toolResults.length === 0) ||
                      toolResults.some((result) => !result.isError)
                    )
                  )
                    return undefined;
                  return {
                    messages: [
                      {
                        role: "user",
                        content: submissionFeedback(
                          gate,
                          contextState(context),
                        ),
                        timestamp: Date.now(),
                      },
                    ],
                  };
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
      if (gate === undefined && responses >= 32) break;
      if (responseLimitReached()) break;
      const final = messages.findLast(
        (message): message is AssistantMessage => message.role === "assistant",
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
          ? modelInput(messages)
          : undefined;
      if (projected !== undefined) {
        // Preserve completed reasoning, while charging every provider error
        // against the same recovery allowance.
        if (
          gate !== undefined
            ? contextState(agentContext(messages)).exhausted
            : clampMaxTokensToContext(
                options.model,
                normalizeContext({ messages: convertToLlm(projected) }),
                options.model.maxTokens,
              ) === 1
        )
          break;
      }
      if (retry) {
        if (errorRecoveries >= (exact.maxRecoveries ?? 0)) break;
        errorRecoveries += 1;
      } else {
        if (lengthContinuations >= (exact.maxLengthContinuations ?? 0)) break;
        lengthContinuations += 1;
      }
      const prior = messages;
      const direction =
        gate !== undefined && final.rawStopReason === "incomplete.max_messages"
          ? submissionFeedback(gate, contextState(agentContext(prior)))
          : retry
            ? undefined
            : lengthContinuation;
      messages = [...prior, ...(await loop(direction, prior))];
    }
    return result(
      messages,
      signal,
      options.model.contextWindow,
      gate !== undefined,
    );
  } finally {
    cleanupSessionResources(sessionId);
  }
}

/** The frozen request shared by execution and model-free role fixtures. */
export function piRequestFor(options: PiRunOptions) {
  // Select durable fields before serializing: runtime registries and credentials
  // are not JSON data and must never enter the request snapshot.
  const request = piRequest.strip().parse({
    ...options,
    protocol: "xean/pi-run/v4",
    model: modelRecord.parse(options.model),
    modelProfile: modelProfile(options.model),
    replayReasoning: options.replayReasoning === false ? false : undefined,
  });
  return piRequest.parse(jsonSnapshot(request));
}

export async function runPi(
  campaign: Campaign,
  options: PiRunOptions,
): Promise<PiResult> {
  if (typeof options.models?.streamSimple !== "function") {
    throw new TypeError("Pi models must provide streamSimple");
  }
  const request = piRequestFor(options);
  if (request.submissionGate !== undefined) {
    if (options.tools?.length !== 1)
      throw new TypeError("Pi submission gate requires one terminal tool");
    submissionContext(request.submissionGate, options.model, { messages: [] });
  }
  let full: PiResult | undefined;
  await campaign.call(
    {
      label: options.label,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.parent === undefined ? {} : { parent: options.parent }),
      request: jsonSnapshot(request),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    async ({ call, tools, signal }) => {
      full = {
        call,
        ...(await runPiBody(campaign, call, request, tools, signal, options)),
      };
      return storePiResult(campaign, full);
    },
  );
  if (full === undefined) throw new Error("Pi call returned without a result");
  return full;
}
