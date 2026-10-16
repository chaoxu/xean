// Policy extracted without mathematical changes from Xean v1.0.0 (949a385).
import { z } from "zod";
import { nonblank, type Json } from "./contracts";

/** The reasoning levels the Codex CLI accepts for model_reasoning_effort. */
export const codexReasoning = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const codexRequest = z.strictObject({
  protocol: z.literal("xean/codex-exec/v1"),
  model: nonblank,
  reasoning: codexReasoning,
  search: z.boolean(),
  developerInstructions: nonblank,
  prompt: nonblank,
  outputSchema: z.json(),
});
export type CodexRequest = z.output<typeof codexRequest>;

const execution = {
  codexVersion: z.string().min(1).optional(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().nullable().optional(),
};
export const codexResult = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("succeeded"),
    codexVersion: z.string().min(1),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.strictObject({ state: z.literal("failed"), ...execution, error: nonblank }),
  z.strictObject({
    state: z.literal("cancelled"),
    ...execution,
    error: nonblank,
  }),
]);
export type CodexResult = z.output<typeof codexResult>;
export type CodexExec = (
  request: CodexRequest,
  signal?: AbortSignal,
) => Promise<CodexResult>;

export const codexUsage = z.strictObject({
  input: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
});
export type CodexUsage = z.output<typeof codexUsage>;

function eventObject(value: Json): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex emitted a non-object JSONL event");
  }
  return value as Record<string, Json>;
}

/** The final agent message, the searches made, and the usage of one Codex run. */
export function codexTranscript(stdout: string): {
  readonly message: string;
  readonly searches: number;
  readonly usage: CodexUsage;
} {
  let searches = 0;
  let usage: CodexUsage | undefined;
  let stage: "start" | "thread" | "turn" | "complete" = "start";
  let message: string | undefined;
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const event = eventObject(z.json().parse(JSON.parse(line)));
    const type = z.string().parse(event["type"]);
    if (type === "thread.started") {
      if (stage !== "start") throw new Error("thread.started out of order");
      stage = "thread";
      continue;
    }
    if (type === "turn.started") {
      if (stage !== "thread") throw new Error("turn.started out of order");
      stage = "turn";
      continue;
    }
    if (type === "turn.completed") {
      if (stage !== "turn") throw new Error("turn.completed out of order");
      const raw = eventObject(event["usage"] ?? {});
      usage = codexUsage.parse({
        input: raw["input_tokens"],
        cacheRead: raw["cached_input_tokens"],
        cacheWrite: raw["cache_write_input_tokens"],
        output: raw["output_tokens"],
        reasoning: raw["reasoning_output_tokens"],
      });
      stage = "complete";
      continue;
    }
    if (!["item.started", "item.updated", "item.completed"].includes(type)) {
      throw new Error(`Codex emitted forbidden event type: ${type}`);
    }
    if (stage !== "turn") throw new Error(`${type} outside an active turn`);
    const item = eventObject(event["item"] ?? null);
    const itemType = z.string().parse(item["type"]);
    if (!["reasoning", "agent_message", "web_search"].includes(itemType)) {
      throw new Error(`Codex used forbidden item type: ${itemType}`);
    }
    if (type !== "item.completed") continue;
    if (itemType === "web_search") searches += 1;
    last = itemType;
    if (itemType === "agent_message") message = nonblank.parse(item["text"]);
  }
  if (stage !== "complete") throw new Error("Codex emitted no complete turn");
  if (usage === undefined) throw new Error("Codex emitted no completed usage");
  if (last !== "agent_message" || message === undefined) {
    throw new Error("Codex emitted no final completed agent message");
  }
  return { message, searches, usage };
}
