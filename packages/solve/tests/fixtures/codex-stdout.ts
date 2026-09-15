import type { Json } from "xean";

/** The JSONL a Codex run prints for one turn that ends in the given message. */
export function codexStdout(message: Json, searched = true): string {
  return [
    { type: "thread.started", thread_id: "fake" },
    { type: "turn.started" },
    ...(searched
      ? [
          {
            type: "item.completed",
            item: {
              id: "search-1",
              type: "web_search",
              query: "authoritative source",
            },
          },
        ]
      : []),
    {
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(message) },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 1,
      },
    },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
}
