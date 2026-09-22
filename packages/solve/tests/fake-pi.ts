import type { Campaign, EntryId, Json } from "xean";
import { piRequestFor, type PiMeasuredUsage, type PiRunOptions } from "xean/pi";

type Outcome = "succeeded" | "failed" | "cancelled";

export function fakePiRequest(options: PiRunOptions): Json {
  return JSON.parse(JSON.stringify(piRequestFor(options))) as Json;
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
      protocol: "xean/pi-request-completion/v2",
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
