#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { executionContract, executionReport } from "./execution-contract";
import {
  exportCandidate,
  guideCampaign,
  inspectCampaign,
  isRoleCommand,
  readSettings,
  runRoleCommand,
  submitNotes,
} from "./role-cli";
import {
  init,
  run,
  settings,
  type RunDependencies,
  type Settings,
} from "./runner";
import { task } from "./roles";
import { review } from "./review";
import { codexProfile } from "./pi-roles";
import {
  createModelRuntime,
  modelRegistryPath,
  type SolveModels,
} from "./runtime";

export { executionContract, guideCampaign, init, run, settings, submitNotes };
export type { ExecutionContract, ExecutionReport } from "./execution-contract";
export type { RunDependencies, Settings, SolveModels };

const usage = `Usage:
  xean-solve contract
  xean-solve init [--turns N] TASK.json CAMPAIGN.db SETTINGS.json
  xean-solve run [--turns N] [--id ID] TASK.json CAMPAIGN.db SETTINGS.json
  xean-solve explorer INPUT.json CAMPAIGN.db SETTINGS.json
  xean-solve coordinator INPUT.json CAMPAIGN.db SETTINGS.json
  xean-solve literature INPUT.json CAMPAIGN.db SETTINGS.json
  xean-solve verifier INPUT.json CAMPAIGN.db SETTINGS.json
  xean-solve review TASK.json ARGUMENT.md REVIEW.db PROFILE.json
  xean-solve guide [--id ID] CAMPAIGN.db GUIDANCE.txt
  xean-solve submit [--id ID] CAMPAIGN.db NOTES.json
  xean-solve inspect [--include-requests] [--include-guidance] [--include-submissions] CAMPAIGN.db
  xean-solve export CAMPAIGN.db

run starts or resumes the durable workflow: the coordinator chooses explorer,
literature, or verifier, and control returns after the dispatched work settles.
coordinatorBehavior.overlap enables optional concurrent Explorer and verification.
init creates or matches its declaration without provider setup or model calls.
--turns sets the initial allowance (default 20), outside the frozen settings.
run --turns N --id ID adds an allowance to an exhausted campaign, then resumes.
Reuse the same ID and turns to retry without granting more turns.
guide appends explorer guidance from a UTF-8 file (or - for stdin).
Guidance takes effect at the next unfrozen explorer turn. Reuse --id for retries.
submit appends text notes and optional external verification receipts from JSON (or - for stdin).
Submitted notes reach a coordinator before the next unfrozen explorer turn. Terminal runs stay terminal.
Standalone role commands execute the same role boundaries independently.`;

export function modelRuntimeOptions(environment: NodeJS.ProcessEnv): {
  readonly modelsPath: string | null;
} {
  return { modelsPath: modelRegistryPath(environment) };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main(args: readonly string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      "include-requests": { type: "boolean" },
      "include-guidance": { type: "boolean" },
      "include-submissions": { type: "boolean" },
      id: { type: "string" },
      turns: { type: "string" },
    },
  });
  if (parsed.values.help) {
    console.log(usage);
    return;
  }
  const [command, ...positionals] = parsed.positionals;
  if (
    parsed.values.turns !== undefined &&
    command !== "init" &&
    command !== "run"
  )
    throw new Error(usage);
  if (command === "review") {
    if (positionals.length !== 4 || Object.keys(parsed.values).length !== 0)
      throw new Error(usage);
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      writeJson(
        await review(
          {
            task: task.parse(await readJson(positionals[0]!)),
            argument: await readFile(positionals[1]!, "utf8"),
            campaignPath: positionals[2]!,
            profile: codexProfile.parse(await readJson(positionals[3]!)),
          },
          { signal: controller.signal },
        ),
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (parsed.values["include-guidance"] === true && command !== "inspect")
    throw new Error(usage);
  if (parsed.values["include-submissions"] === true && command !== "inspect")
    throw new Error(usage);
  if (
    parsed.values.id !== undefined &&
    command !== "guide" &&
    command !== "submit" &&
    command !== "run"
  )
    throw new Error(usage);
  if (command === "guide" || command === "submit") {
    if (positionals.length !== 2 || parsed.values["include-requests"] === true)
      throw new Error(usage);
    const text =
      positionals[1] === "-"
        ? await Bun.stdin.text()
        : await readFile(positionals[1]!, "utf8");
    writeJson(
      command === "guide"
        ? await guideCampaign(positionals[0]!, text, parsed.values.id)
        : await submitNotes(
            positionals[0]!,
            JSON.parse(text),
            parsed.values.id,
          ),
    );
    return;
  }
  if (isRoleCommand(command)) {
    if (parsed.values["include-requests"] === true) throw new Error(usage);
    writeJson(await runRoleCommand(command, positionals));
    return;
  }
  if (command === "contract") {
    if (
      positionals.length !== 0 ||
      parsed.values["include-requests"] === true
    ) {
      throw new Error(usage);
    }
    writeJson(executionContract);
    return;
  }
  if (command === "inspect") {
    if (positionals.length !== 1) throw new Error(usage);
    writeJson(
      await inspectCampaign(positionals[0]!, {
        includeRequests: parsed.values["include-requests"] === true,
        includeGuidance: parsed.values["include-guidance"] === true,
        includeSubmissions: parsed.values["include-submissions"] === true,
      }),
    );
    return;
  }
  if (command === "export") {
    if (
      positionals.length !== 1 ||
      parsed.values["include-requests"] === true
    ) {
      throw new Error(usage);
    }
    process.stdout.write(await exportCandidate(positionals[0]!));
    return;
  }
  if (
    (command !== "run" && command !== "init") ||
    positionals.length !== 3 ||
    parsed.values["include-requests"] === true
  ) {
    throw new Error(usage);
  }

  const taskPath = positionals[0]!;
  const campaignPath = positionals[1]!;
  const settingsPath = positionals[2]!;
  const workflowSettings = await readSettings(settingsPath);
  const request = {
    task: task.parse(await readJson(taskPath)),
    campaignPath,
    settings: workflowSettings,
    ...(parsed.values.turns === undefined
      ? {}
      : { turns: Number(parsed.values.turns) }),
    ...(parsed.values.id === undefined ? {} : { id: parsed.values.id }),
  };
  if (command === "init") {
    writeJson(await init(request));
    return;
  }
  const controller = new AbortController();
  let pauseRequested = false;
  const stop = () => {
    if (!pauseRequested) {
      pauseRequested = true;
      console.error("Pausing after the active role call settles...");
    } else {
      controller.abort();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const result = await run(request, {
      models: () => createModelRuntime(modelRuntimeOptions(process.env)),
      signal: controller.signal,
      pauseRequested: () => pauseRequested,
      status: (phase) => console.error(phase),
    });
    writeJson(executionReport(result));
    if (result.outcome === "interrupted") process.exitCode = 130;
    if (result.outcome === "call-failure") process.exitCode = 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
