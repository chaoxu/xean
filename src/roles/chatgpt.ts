import type { Context } from "@earendil-works/chord";
import type { Settings } from "../config.ts";
import { decode, explorationSchema } from "../math/contracts.ts";
import type { RoleRuntime } from "./types.ts";

export async function chatgpt(
  settings: NonNullable<Settings["chatgpt"]>,
  instructions: string,
  input: unknown,
  runtime: RoleRuntime,
  context: Context,
) {
  context.abortSignal?.throwIfAborted();
  const id = crypto.randomUUID();
  if ((await runtime.memo("research.chatgpt", id, context)) !== id)
    throw new Error(
      "ChatGPT request already admitted; refusing an ambiguous replay",
    );
  const response = await fetch(
    `${settings.baseUrl.replace(/\/$/, "")}/responses`,
    {
      method: "POST",
      signal: context.abortSignal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        stream: false,
        reasoning: { effort: "max" },
        instructions,
        input: [
          {
            type: "message",
            role: "user",
            content: JSON.stringify(input),
            internal_chat_message_metadata_passthrough: { turn_id: id },
          },
        ],
        client_metadata: {
          "x-codex-turn-metadata": { thread_id: id, turn_id: id },
        },
        text: {
          format: {
            type: "json_schema",
            name: "exploration",
            strict: true,
            schema: explorationSchema,
          },
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`ChatGPT HTTP ${response.status}`);
  const result = await response.json();
  context.abortSignal?.throwIfAborted();
  if (result.status !== "completed")
    throw new Error(`ChatGPT ${result.status}`);
  const answers = result.output.filter(
    (item: any) =>
      item.type === "message" &&
      item.role === "assistant" &&
      item.phase === "final_answer",
  );
  if (answers.length !== 1)
    throw new Error("ChatGPT returned no unique final answer");
  const text = answers[0].content
    .filter((part: any) => part.type === "output_text")
    .map((part: any) => part.text)
    .join("");
  return decode(explorationSchema, JSON.parse(text));
}
