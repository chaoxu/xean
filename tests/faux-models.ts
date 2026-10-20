import type { JsonValue } from "@earendil-works/chord";
import { createModels, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

/** Queue provider responses; Pi still owns role tools, failures and recovery. */
export function fauxModels(
  values: (JsonValue | Error)[] = [],
  beforeResponse?: (transcript: TranscriptContext) => void | Promise<void>,
) {
  const provider = fauxProvider({
    provider: "test",
    models: [
      { id: "math", reasoning: true },
      { id: "test", reasoning: true },
    ],
  });
  const replies = {
    push: (...values: (JsonValue | Error)[]) =>
      provider.appendResponses(
        values.map((value) => async (transcript: TranscriptContext) => {
          await beforeResponse?.(transcript);
          if (value instanceof Error)
            return fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: value.message,
            });
          const tool = getCurrentTools(transcript.messages)[0];
          if (!tool) throw new Error("Expected a native role tool");
          return fauxAssistantMessage(
            [fauxToolCall(tool.name, value as Record<string, JsonValue>)],
            { stopReason: "toolUse" },
          );
        }),
      ),
  };
  replies.push(...values);
  const models = createModels();
  models.setProvider(provider.provider);
  return { models, provider, replies };
}
