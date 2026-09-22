import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  ThinkingContent,
} from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { z } from "zod";

const reasoningItem = z.looseObject({
  type: z.literal("reasoning"),
  id: z.string().min(1),
  encrypted_content: z.string().min(1),
  status: z.literal("completed").nullable().optional(),
  summary: z.array(
    z.strictObject({
      type: z.literal("summary_text"),
      text: z.string(),
    }),
  ),
});

function itemId(signature: string): string | undefined {
  try {
    const parsed = reasoningItem.safeParse(JSON.parse(signature));
    return parsed.success ? parsed.data.id : undefined;
  } catch {
    return undefined;
  }
}

// Pi keeps signatures on failed messages, but its adapters omit those messages.
// Only the model-input view changes here; the transcript retains the failure.
export class ReasoningRecovery {
  private readonly ids = new Map<string, string | undefined>();
  private readonly completed = new WeakMap<
    AssistantMessage,
    ThinkingContent[]
  >();

  private itemId(block: ThinkingContent): string | undefined {
    const signature = block.thinkingSignature;
    if (signature === undefined) return undefined;
    if (!this.ids.has(signature)) this.ids.set(signature, itemId(signature));
    return this.ids.get(signature);
  }

  observe(model: Model<Api>) {
    const blocks: ThinkingContent[] = [];
    const ids = new Set<string>();
    return {
      event: (event: AssistantMessageEvent) => {
        if (
          !["openai-responses", "openai-codex-responses"].includes(model.api) ||
          event.type !== "thinking_end"
        )
          return;
        const block = event.partial.content[event.contentIndex];
        if (block?.type !== "thinking") return;
        const id = this.itemId(block);
        if (id === undefined || ids.has(id)) return;
        ids.add(id);
        // Event.partial is mutable; snapshot at the completed-block event.
        blocks.push({ ...block });
      },
      settle: (message: AssistantMessage) => {
        if (
          message.stopReason === "error" &&
          message.api === model.api &&
          message.provider === model.provider &&
          message.model === model.id &&
          (message.responseModel === undefined ||
            message.responseModel === model.id)
        )
          this.completed.set(message, blocks);
      },
    };
  }

  forModel(messages: AgentMessage[], replayReasoning = true): AgentMessage[] {
    const ids = new Set<string>();
    return messages.flatMap((message): AgentMessage[] => {
      if (message.role !== "assistant") return [message];
      if (!replayReasoning) {
        if (message.stopReason === "error") return [];
        const content = message.content.filter(
          (block) => block.type !== "thinking",
        );
        return content.length === 0 ? [] : [{ ...message, content }];
      }
      if (message.stopReason !== "error") {
        for (const block of message.content) {
          if (block.type !== "thinking") continue;
          const id = this.itemId(block);
          if (id !== undefined) ids.add(id);
        }
        return [message];
      }
      const blocks = (this.completed.get(message) ?? []).filter((block) => {
        const id = this.itemId(block)!;
        if (ids.has(id)) return false;
        ids.add(id);
        return true;
      });
      if (blocks.length === 0) return [];
      // This is a projection of completed reasoning, not a successful response.
      // No text or tool calls from the failed response enter Pi's next loop.
      return [{ ...message, content: blocks, stopReason: "stop" as const }];
    });
  }
}
