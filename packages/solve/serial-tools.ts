import type { SolveModels } from "./runtime";

const openAiResponsesApis = new Set([
  "openai-responses",
  "openai-codex-responses",
]);

/**
 * Pi's simple stream lacks required/serial tools and Codex output caps.
 * Apply these controls before checkpointing; Pi owns cached transport.
 */
export function withSerialToolCalls(models: SolveModels): SolveModels {
  return {
    ...(models.checkAuth === undefined
      ? {}
      : { checkAuth: (provider: string) => models.checkAuth!(provider) }),
    getModel(provider, id) {
      return models.getModel(provider, id);
    },
    streamSimple(model, context, options) {
      if (!openAiResponsesApis.has(model.api)) {
        return models.streamSimple(model, context, options);
      }
      const inner = options?.onPayload;
      const onPayload = async (
        payload: unknown,
        requestModel: Parameters<NonNullable<typeof inner>>[1],
      ) => {
        let effective = payload;
        if (typeof payload === "object" && payload !== null) {
          const request: Record<string, unknown> = { ...payload };
          if ("tools" in payload || "parallel_tool_calls" in payload)
            request.parallel_tool_calls = false;
          if (
            "tools" in payload &&
            Array.isArray(payload.tools) &&
            payload.tools.length
          )
            request.tool_choice = "required";
          if (
            model.api === "openai-codex-responses" &&
            model.compat !== undefined &&
            "supportsMaxOutputTokens" in model.compat &&
            model.compat.supportsMaxOutputTokens === true
          )
            request.max_output_tokens = options?.maxTokens ?? model.maxTokens;
          effective = request;
        }
        return (await inner?.(effective, requestModel)) ?? effective;
      };
      return models.streamSimple(model, context, { ...options, onPayload });
    },
  };
}
