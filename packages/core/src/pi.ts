import {
  createAssistantMessageEventStream,
  normalizeContext,
  retryAssistantCall,
  type Api,
  type AssistantMessage,
  type Model,
  type Models,
  type RetryPolicy,
  type ThinkingContent,
  type Usage,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import type { JsonValue } from "@earendil-works/chord";
import type {
  CallRecorder,
  GenerationReference,
  RecordedCall,
} from "./calls.ts";
export {
  chatGptWebProvider,
  chatGptWebProviderId,
} from "./providers/chatgpt-web.ts";

/** Pi output tokens already include reasoning tokens. */
export function reportedPiUsage(message: AssistantMessage): Usage | null {
  const usage = message.usage;
  // Patched adapters distinguish absent/invalid counts from explicit zero.
  // Only adapters without the marker need the nonzero-count fallback.
  if (
    message.usageReported === false ||
    (message.usageReported === undefined &&
      ![
        usage.input,
        usage.output,
        usage.cacheRead,
        usage.cacheWrite,
        usage.totalTokens,
        usage.reasoning ?? 0,
      ].some((value) => Number.isFinite(value) && value !== 0))
  ) {
    return null;
  }
  return structuredClone(usage);
}

function failure(
  model: Model<Api>,
  error: unknown,
  aborted: boolean,
  partial?: AssistantMessage,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: Date.now(),
    ...partial,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function reasoningId(
  block: AssistantMessage["content"][number] | undefined,
): string | undefined {
  if (block?.type !== "thinking" || !block.thinkingSignature) return;
  try {
    const item = JSON.parse(block.thinkingSignature);
    if (
      item?.type === "reasoning" &&
      typeof item.id === "string" &&
      item.id &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content &&
      (item.status == null || item.status === "completed") &&
      Array.isArray(item.summary)
    )
      return item.id;
  } catch {
    /* An unusable signature cannot supply recovery state. */
  }
  return undefined;
}

/**
 * A native Pi stream function with durable call accounting, supplied to
 * Pi Durable's generation hook or a caller's Models collection.
 * Pi owns request conversion, streaming, retry policy, and tools. Its options
 * pass through unchanged, including cancellation, authentication, and retries.
 * The caller owns the Pi session and cleanupSessionResources(sessionId).
 * An optional Pi policy recovers interrupted responses within the same turn.
 * Each recovery has its own record; adapter-internal HTTP/WS retries share one.
 */
export function auditedStream(
  models: Pick<Models, "streamSimple">,
  recorder: CallRecorder,
  retry?: RetryPolicy,
  generation?: GenerationReference,
): Models["streamSimple"] {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    let started = false;
    let fatal: AssistantMessage | undefined;
    const input = normalizeContext({
      ...context,
      messages: [...context.messages],
    });
    const recovered = new Map<string, ThinkingContent>();
    const seen = new Set(
      context.messages.flatMap((message) =>
        message.role === "assistant" ? message.content.map(reasoningId) : [],
      ),
    );
    const canRecover =
      retry?.enabled &&
      ["openai-responses", "openai-codex-responses"].includes(model.api);
    async function attempt(): Promise<AssistantMessage> {
      let call: RecordedCall | undefined;
      let final: AssistantMessage | undefined;
      let failed = false;
      let requestRecorded = false;
      const completed = new Map<string, ThinkingContent>();
      const controller = new AbortController();
      const signal = options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      try {
        signal.throwIfAborted();
        if (
          recovered.size &&
          clampMaxTokensToContext(model, input, model.maxTokens) <
            model.maxTokens
        )
          throw new Error(
            "Recovered reasoning leaves insufficient context for an answer",
          );
        call = await recorder.begin(
          {
            provider: model.provider,
            id: model.id,
            api: model.api,
          },
          generation,
        );
        signal.throwIfAborted();
        const stream = models.streamSimple(model, input, {
          ...options,
          signal,
          onPayload: async (payload, requestModel) => {
            const replacement = await options?.onPayload?.(
              payload,
              requestModel,
            );
            const effective = replacement === undefined ? payload : replacement;
            const encoded = generation ? undefined : JSON.stringify(effective);
            if (!generation && encoded === undefined)
              throw new TypeError("Pi request body must be JSON");
            signal.throwIfAborted();
            await call!.recordRequest(
              encoded === undefined
                ? undefined
                : (JSON.parse(encoded) as JsonValue),
            );
            requestRecorded = true;
            signal.throwIfAborted();
            if (
              encoded !== undefined &&
              JSON.stringify(effective) !== encoded
            ) {
              throw new Error(
                "Pi request changed while its snapshot was being recorded",
              );
            }
            // Give the observer a JSON snapshot while preserving Pi's native
            // payload types (for example Bedrock's Uint8Array image content).
            return effective;
          },
        });
        for await (const event of stream) {
          if (event.type === "done") final = event.message;
          else if (event.type === "error") final = event.error;
          else {
            final = event.partial;
            if (canRecover && event.type === "thinking_end") {
              const block = event.partial.content[event.contentIndex];
              const id = reasoningId(block);
              if (
                block?.type === "thinking" &&
                id &&
                !seen.has(id) &&
                !completed.has(id)
              )
                completed.set(id, { ...block });
            }
            // Response retries belong to one stream. Emit its start event once.
            if (event.type !== "start" || !started) output.push(event);
            if (event.type === "start") started = true;
          }
        }
        final = await stream.result();
        if (
          !requestRecorded &&
          final.stopReason !== "error" &&
          final.stopReason !== "aborted"
        ) {
          throw new Error(
            "Pi completed without recording its effective request",
          );
        }
      } catch (error) {
        failed = true;
        controller.abort();
        final = failure(model, error, options?.signal?.aborted === true, final);
      }
      // Settlement is awaited even after cancellation; usage cannot disappear.
      if (call) {
        try {
          await call.settle(
            generation
              ? {
                  stopReason: final!.stopReason,
                  errorMessage: final!.errorMessage,
                }
              : final!,
            reportedPiUsage(final!),
          );
        } catch (error) {
          failed = true;
          controller.abort();
          final = failure(model, error, false, final);
        }
      }
      // Admission, payload-hook, and accounting failures are not provider
      // recovery opportunities, even if their text resembles a network error.
      if (failed || !requestRecorded) {
        fatal = final!;
        throw new Error(fatal.errorMessage ?? "Pi request was not recorded");
      }
      if (
        completed.size &&
        final!.stopReason === "error" &&
        (final!.responseModel === undefined ||
          final!.responseModel === model.id)
      ) {
        input.messages.push({
          ...final!,
          content: [...completed.values()],
          stopReason: "stop",
        });
        for (const [id, block] of completed) {
          seen.add(id);
          recovered.set(id, block);
        }
      }
      return final!;
    }
    const finish = (message: AssistantMessage) => {
      // Settlement and retry completion both yield before terminal delivery.
      // Preserve the provider record, but never deliver success after abort.
      if (options?.signal?.aborted && message.stopReason !== "error")
        message = failure(model, options.signal.reason, true, message);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        output.push({
          type: "error",
          reason: message.stopReason,
          error: message,
        });
      } else {
        // Preserve recovered reasoning for later turns without rewriting any
        // recorded provider response or admitting failed text and tool calls.
        if (recovered.size)
          message = {
            ...message,
            content: [
              ...recovered.values(),
              ...message.content.filter(
                (block) => !recovered.has(reasoningId(block) ?? ""),
              ),
            ],
          };
        output.push({
          type: "done",
          reason: message.stopReason as
            "stop" | "length" | "toolUse" | "deferred",
          message,
        });
      }
      output.end();
    };
    void retryAssistantCall(attempt, retry, options?.signal).then(
      finish,
      (error) =>
        finish(
          fatal ?? failure(model, error, options?.signal?.aborted === true),
        ),
    );
    return output;
  };
}
