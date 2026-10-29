// Role settings derived from Xean v1.0.0 (949a385).
import { z } from "zod";
import { THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import { nonblank } from "./contracts";
import { codexReasoning } from "./source";

export const piReasoning = z.enum(THINKING_LEVELS);
export const settingsDefaults = {
  maxExplorerTurns: 10,
  window: 100_000,
} as const;

export const piRoleProfile = z.strictObject({
  provider: nonblank,
  model: nonblank,
  reasoning: piReasoning,
});
export type PiRoleProfile = z.output<typeof piRoleProfile>;

// The source verifier runs the Codex CLI on its native credential, the only
// path that provides web search, so its profile names that provider.
export const codexProfile = z.strictObject({
  provider: z.literal("codex"),
  model: nonblank,
  reasoning: codexReasoning,
  // Without search the source verifier has no web access, for a task that
  // must not touch the internet; results are assessed from mathematical knowledge.
  search: z.boolean().default(true),
});
// Any other provider runs the source verifier as a Pi call without web
// search, for a task that must not reach the internet and a worker without a
// Codex credential; the provider name codex always means the Codex profile.
export const sourceProfile = z.union([
  codexProfile,
  piRoleProfile.refine((profile) => profile.provider !== "codex", {
    message: "the codex provider takes the Codex profile",
    path: ["provider"],
  }),
]);
export function codexSource(
  profile: z.output<typeof sourceProfile>,
): profile is z.output<typeof codexProfile> {
  return profile.provider === "codex";
}
// The window caps the characters of note and support texts one verification
// reads; the fold drains the coordinator's list in fitting batches, always
// taking at least the first entry of each batch.
export const solveSettings = z.strictObject({
  explorer: piRoleProfile,
  coordinator: piRoleProfile,
  correctness: piRoleProfile,
  source: sourceProfile,
  requirements: piRoleProfile,
  reconstruction: piRoleProfile,
  maxExplorerTurns: z
    .number()
    .int()
    .positive()
    .default(settingsDefaults.maxExplorerTurns),
  window: z.number().int().positive().default(settingsDefaults.window),
  verifyOnSolution: z.boolean().optional(),
});
export type SolveSettings = z.output<typeof solveSettings>;
