import type { Campaign, EntryId, Json } from "xean";
import type { PiMeasuredUsage, PiRunOptions } from "xean/pi";

type Outcome = "succeeded" | "failed" | "cancelled";

export function fakePiRequest(options: PiRunOptions): Json {
  const request = {
    protocol: "xean/pi-run/v2",
    model: {
      provider: options.model.provider,
      id: options.model.id,
      api: options.model.api,
      baseUrl: options.model.baseUrl,
    },
    modelProfile: {
      reasoning: options.model.reasoning,
      thinkingLevelMap: options.model.thinkingLevelMap ?? null,
      contextWindow: options.model.contextWindow,
      maxTokens: options.model.maxTokens,
      samplingParams: options.model.samplingParams ?? null,
      compat: options.model.compat ?? null,
    },
    system: options.system,
    prompt: options.prompt,
    reasoning: options.reasoning,
    submissionGate: options.submissionGate,
    maxRecoveries: options.maxRecoveries,
    maxLengthContinuations: options.maxLengthContinuations,
    cacheKey: options.cacheKey,
    replayReasoning: options.replayReasoning === false ? false : undefined,
  };
  // The round-trip drops undefined-valued fields, matching the
  // omit-when-absent shape of real journaled requests.
  return JSON.parse(JSON.stringify(request)) as Json;
}

/** Append one request checkpoint and its completion under a Pi call. */
export async function fakePiRequestCheckpoint(
  campaign: Campaign,
  call: EntryId,
  options: PiRunOptions,
  outcome: Outcome,
  usage: PiMeasuredUsage | null = null,
): Promise<void> {
  const { provider, id, api, baseUrl } = options.model;
  await campaign.call(
    {
      label: "xean/pi-request",
      request: {
        protocol: "xean/pi-request/v1",
        parent: call,
        model: {
          provider,
          id,
          api,
          ...(baseUrl === undefined ? {} : { baseUrl }),
        },
        payloadRef: campaign.storePayload({ input: options.prompt }),
      },
    },
    async () => ({
      protocol: "xean/pi-request-completion/v1",
      parent: call,
      operation: {
        provider,
        requestedModel: id,
        api,
        stopReason:
          outcome === "succeeded"
            ? "stop"
            : outcome === "cancelled"
              ? "aborted"
              : "error",
        error: outcome !== "succeeded",
        usage,
      },
    }),
  );
}
