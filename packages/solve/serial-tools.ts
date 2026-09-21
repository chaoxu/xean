import type { SolveModels } from "./runtime";

const openAiResponsesApis = new Set([
  "openai-responses",
  "openai-codex-responses",
]);

// Pi's openai-responses adapter renders the system prompt as a leading
// developer message and leaves the top-level instructions field empty, whereas
// its codex adapter places the system prompt in instructions. On the ChatGPT
// reasoning backend the developer-message shape, combined with a required
// terminal tool, makes the model emit the tool call before reasoning (a few
// hundred reasoning tokens); the instructions shape reasons first (tens of
// thousands). Normalize the responses payload to the codex shape by hoisting
// the leading developer message into instructions.
function hoistInstructions(request: Record<string, unknown>): void {
  if (
    typeof request.instructions === "string" &&
    request.instructions.length > 0
  )
    return;
  if (!Array.isArray(request.input)) return;
  const [head, ...rest] = request.input as unknown[];
  if (
    typeof head !== "object" ||
    head === null ||
    (head as { role?: unknown }).role !== "developer" ||
    typeof (head as { content?: unknown }).content !== "string"
  )
    return;
  request.instructions = (head as { content: string }).content;
  request.input = rest;
}

/**
 * Pi's simple stream lacks required/serial tools, Codex output caps, the
 * instructions shape, and the transport choice. Apply these controls before
 * checkpointing; Pi owns cached transport.
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
          if (model.api === "openai-responses") hoistInstructions(request);
          effective = request;
        }
        return (await inner?.(effective, requestModel)) ?? effective;
      };
      return models.streamSimple(model, context, {
        ...options,
        onPayload,
        transport: model.api === "openai-codex-responses" ? "auto" : "sse",
      });
    },
  };
}
