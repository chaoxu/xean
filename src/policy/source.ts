// Policy extracted without mathematical changes from Xean v1.0.0 (949a385).
import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import { nonblank } from "./contracts";

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

export type CodexResult = { stdout: string; stderr: string } & (
  | { state: "succeeded"; codexVersion: string; output: JsonValue }
  | {
      state: "failed" | "cancelled";
      codexVersion?: string;
      exitCode?: number | null;
      error: string;
    }
);
export type CodexExec = (
  request: CodexRequest,
  signal?: AbortSignal,
) => Promise<CodexResult>;
