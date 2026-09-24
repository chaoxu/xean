import { existsSync } from "node:fs";
import { type Campaign } from "xean";
import { builtinPi } from "xean/pi";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { z } from "zod";

import {
  piProfileNames,
  piProviders,
  RoleCallError,
  solveSettings,
  type PiRoleDependencies,
} from "./pi-roles";
import { createRoleHost } from "./role-host";
import type { RoleImplementations } from "./role-functions";
import { applicationId, nonblank, task } from "./roles";
import {
  allowanceLabel,
  appendAllowance,
  positiveTurns,
  turnAllowances,
} from "./allowance";
import {
  codexCommand,
  openConfiguredCampaign,
  requireCredentials,
  selectModel,
  withCampaignLock,
} from "./runtime";
import { withSerialToolCalls } from "./serial-tools";
import { prepareCodex } from "./source";
import {
  deriveWorkflow,
  Workflow,
  runWorkflow,
  workflowConfiguration,
  workflowResult,
  type WorkflowConfig,
  type WorkflowResult,
} from "./workflow";

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

export interface RunDependencies extends PiRoleDependencies {
  readonly roles?: Partial<RoleImplementations>;
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
    const campaign = openConfiguredCampaign(
      request.campaignPath,
      applicationId,
      config,
    );
    try {
      await prepareAllowance(campaign, request.turns);
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
  const allowances = turnAllowances(
    campaign.records({ kinds: ["call"], labels: [allowanceLabel] }),
  );
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
  const snapshot = deriveWorkflow(campaign);
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
  workflow = new Workflow(campaign),
): Promise<RunResult> {
  const roles = createRoleHost(
    campaign,
    config.settings,
    dependencies,
    dependencies.roles,
  );
  try {
    const phase = await runWorkflow(campaign, roles, dependencies, workflow);
    if (phase.kind === "accepted" || phase.kind === "turn-limit") {
      return workflowResult(phase);
    }
    return { outcome: "paused", at: phase.kind };
  } catch (error) {
    let at: string;
    try {
      at = workflow.read().phase.kind;
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
      ? openConfiguredCampaign(request.campaignPath, applicationId, config)
      : undefined;
    let initial: Workflow | undefined;
    try {
      if (campaign !== undefined) {
        await prepareAllowance(campaign, request.turns, request.id);
        initial = new Workflow(campaign);
        const snapshot = initial.read();
        const phase = snapshot.phase;
        if (phase.kind === "accepted" || phase.kind === "turn-limit")
          return workflowResult(phase);
      }
      const prepareModels = async () => {
        const models = withSerialToolCalls(
          typeof dependencies.models === "function"
            ? await dependencies.models()
            : (dependencies.models ?? builtinPi()),
        );
        // Validate the configured Pi runtime once before its first model call.
        for (const name of piProfileNames) {
          const profile = config.settings[name];
          try {
            const model = selectModel(models, {
              provider: profile.provider,
              modelId: profile.model,
            });
            if (
              !getSupportedThinkingLevels(model).includes(profile.reasoning)
            ) {
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
        return models;
      };
      let execution: RunDependencies = {
        ...dependencies,
        models: prepareModels,
      };
      // Default roles keep fail-fast preflight. Replacements acquire only the
      // backends they actually invoke through the host capabilities.
      if (Object.keys(dependencies.roles ?? {}).length === 0) {
        execution = {
          ...execution,
          models: await prepareModels(),
          codex:
            dependencies.codex ??
            (await prepareCodex({
              command: codexCommand(process.env),
              ...(dependencies.signal === undefined
                ? {}
                : { signal: dependencies.signal }),
            })),
        };
      }
      if (campaign === undefined) {
        campaign = openConfiguredCampaign(
          request.campaignPath,
          applicationId,
          config,
        );
        await prepareAllowance(campaign, request.turns, request.id);
      }
      const pending = drive(campaign, config, execution, initial);
      initial = undefined;
      return await pending;
    } finally {
      campaign?.close();
    }
  });
}
