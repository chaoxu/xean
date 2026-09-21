import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { createCampaign, openCampaign, type Campaign } from "xean";
import { builtinPi } from "xean/pi";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";

import {
  createPiRoles,
  piProfileNames,
  piProviders,
  RoleCallError,
  solveSettings,
  type PiRoleDependencies,
  type SolveSettings,
} from "./pi-roles";
import { applicationId, nonblank, task, workflowRecords } from "./roles";
import {
  appendAllowance,
  initializeAllowance,
  positiveTurns,
  turnAllowances,
} from "./allowance";
import {
  codexCommand,
  requireCredentials,
  selectModel,
  withCampaignLock,
} from "./runtime";
import { requireCodex } from "./source";
import {
  deriveWorkflow,
  runWorkflow,
  workflowConfig,
  workflowConfiguration,
  workflowResult,
  type WorkflowConfig,
  type WorkflowResult,
  type WorkflowSnapshot,
} from "./workflow";

export const settings = solveSettings;
export type Settings = SolveSettings;

const runRequest = z
  .strictObject({
    task,
    campaignPath: z.string().min(1),
    settings: solveSettings,
    turns: positiveTurns.optional(),
    id: nonblank.optional(),
  })
  .refine((value) => value.id === undefined || value.turns !== undefined, {
    message: "an allowance id requires turns",
  });

export interface RunDependencies extends Omit<PiRoleDependencies, "models"> {
  readonly models?:
    | PiRoleDependencies["models"]
    | (() => Promise<PiRoleDependencies["models"]>);
  readonly pauseRequested?: () => boolean;
  readonly status?: (message: string) => void;
}

export type RunResult =
  | WorkflowResult
  | {
      readonly outcome: "paused" | "call-failure" | "interrupted";
      readonly at: string;
      readonly reason?: string;
    };

/** Create or match the workflow declaration without resolving any provider. */
export async function init(input: z.input<typeof runRequest>) {
  const request = runRequest.parse(input);
  if (request.id !== undefined)
    throw new Error("init does not accept an allowance id");
  const config = workflowConfiguration({
    task: request.task,
    settings: request.settings,
  });
  return withCampaignLock(request.campaignPath, async () => {
    const existing = existsSync(request.campaignPath);
    const campaign = existing
      ? openCampaign(request.campaignPath)
      : createCampaign(request.campaignPath, applicationId, config);
    try {
      const declaration = campaign.record(1);
      if (
        declaration?.kind !== "campaign" ||
        declaration.application !== applicationId
      )
        throw new Error("not a current Xean solver journal");
      const frozen = workflowConfig.parse(declaration.config);
      if (!isDeepStrictEqual(frozen, config))
        throw new Error("task or settings disagree with the workflow journal");
      await initializeAllowance(campaign, request.turns);
      return {
        application: applicationId,
        campaignPath: request.campaignPath,
        created: !existing,
      };
    } finally {
      campaign.close();
    }
  });
}

/** Explicit IDs make retries of a spending authorization idempotent. */
async function prepareAllowance(
  campaign: Campaign,
  turns?: number,
  id?: string,
) {
  const records = workflowRecords(campaign);
  const allowances = turnAllowances(records);
  if (allowances.length === 0) {
    await appendAllowance(campaign, turns ?? 20, 0, id ?? "initial");
    return;
  }
  if (turns === undefined) return;
  const existing = allowances.find((entry) => entry.id === (id ?? "initial"));
  if (existing !== undefined) {
    if (existing.turns !== turns)
      throw new Error(
        `allowance id already has different turns: ${existing.id}`,
      );
    return;
  }
  if (id === undefined) throw new Error("adding turns requires a new --id");
  const snapshot = await deriveWorkflow(records);
  if (snapshot.phase.kind !== "turn-limit")
    throw new Error(
      "only a campaign at its turn limit can receive another allowance",
    );
  await appendAllowance(campaign, turns, snapshot.phase.turns, id);
}

async function drive(
  campaign: Campaign,
  config: WorkflowConfig,
  dependencies: RunDependencies,
  models: PiRoleDependencies["models"],
  initial?: { readonly snapshot: WorkflowSnapshot; readonly through: number },
): Promise<RunResult> {
  const roles = createPiRoles(campaign, config.settings, {
    models,
    ...(dependencies.run === undefined ? {} : { run: dependencies.run }),
    ...(dependencies.codex === undefined ? {} : { codex: dependencies.codex }),
    ...(dependencies.signal === undefined
      ? {}
      : { signal: dependencies.signal }),
  });
  try {
    const pending = runWorkflow(campaign, roles, dependencies, initial);
    initial = undefined;
    const phase = await pending;
    if (phase.kind === "accepted" || phase.kind === "turn-limit") {
      return workflowResult(phase);
    }
    return { outcome: "paused", at: phase.kind };
  } catch (error) {
    let at: string;
    try {
      at = (await deriveWorkflow(workflowRecords(campaign))).phase.kind;
    } catch {
      throw error;
    }
    if (dependencies.signal?.aborted) {
      return { outcome: "interrupted", at, reason: "operator interruption" };
    }
    if (error instanceof RoleCallError) {
      return { outcome: "call-failure", at, reason: error.message };
    }
    throw error;
  }
}

export async function run(
  input: z.input<typeof runRequest>,
  dependencies: RunDependencies = {},
): Promise<RunResult> {
  const request = runRequest.parse(input);
  const config = workflowConfiguration({
    task: request.task,
    settings: request.settings,
  });
  return withCampaignLock(request.campaignPath, async () => {
    let campaign = existsSync(request.campaignPath)
      ? openCampaign(request.campaignPath)
      : undefined;
    let initial:
      | { readonly snapshot: WorkflowSnapshot; readonly through: number }
      | undefined;
    try {
      if (campaign !== undefined) {
        const declaration = campaign.record(1);
        if (
          declaration?.kind !== "campaign" ||
          declaration.application !== applicationId
        )
          throw new Error("not a current Xean solver journal");
        const frozen = workflowConfig.parse(
          declaration?.kind === "campaign" ? declaration.config : undefined,
        );
        if (!isDeepStrictEqual(frozen, config)) {
          throw new Error(
            "task or settings disagree with the workflow journal",
          );
        }
        await prepareAllowance(campaign, request.turns, request.id);
        const through = campaign.lastSequence();
        const snapshot = await deriveWorkflow(
          campaign.records({ excludeLabels: ["xean/pi-request"], through }),
        );
        initial = { snapshot, through };
        const phase = snapshot.phase;
        if (phase.kind === "accepted" || phase.kind === "turn-limit")
          return workflowResult(phase);
      }
      const models =
        typeof dependencies.models === "function"
          ? await dependencies.models()
          : (dependencies.models ?? builtinPi());
      // Resolve every configured Pi role before creating a fresh journal or
      // dispatching any work, including roles reached only after exploration.
      for (const name of piProfileNames) {
        const profile = config.settings[name];
        try {
          const model = selectModel(models, {
            provider: profile.provider,
            modelId: profile.model,
          });
          if (!getSupportedThinkingLevels(model).includes(profile.reasoning)) {
            throw new Error(
              `unsupported reasoning level ${profile.reasoning} for ${profile.provider}/${profile.model}`,
            );
          }
        } catch (error) {
          throw new Error(
            `${name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (models.checkAuth !== undefined) {
        await requireCredentials(
          { checkAuth: (provider) => models.checkAuth!(provider) },
          piProviders(config.settings),
        );
      }
      if (dependencies.codex === undefined) {
        await requireCodex({
          command: codexCommand(process.env),
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal }),
        });
      }
      campaign ??= createCampaign(request.campaignPath, applicationId, config);
      await prepareAllowance(campaign, request.turns, request.id);
      const pending = drive(campaign, config, dependencies, models, initial);
      initial = undefined;
      return await pending;
    } finally {
      campaign?.close();
    }
  });
}
