#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { executionContract, executionReport } from "./execution-contract";
import {
  exportSolution,
  guideCampaign,
  inspectCampaign,
  isRoleCommand,
  readSettings,
  runRoleCommand,
  submitNotes,
} from "./role-cli";
import { init, run, type RunDependencies } from "./runner";
import { task } from "./roles";
import { review } from "./review";
import { codexProfile, solveSettings, type SolveSettings } from "./pi-roles";
import {
  createModelRuntime,
  modelRegistryPath,
  withSignals,
  type SolveModels,
} from "./runtime";

export {
  executionContract,
  guideCampaign,
  init,
  run,
  solveSettings,
  submitNotes,
};
export type { ExecutionContract, ExecutionReport } from "./execution-contract";
export type { RunDependencies, SolveSettings, SolveModels };

const commands: Record<string, readonly [string, readonly string[]]> = {
  contract: ["", []],
  init: ["TASK.json CAMPAIGN.db SETTINGS.json", ["turns"]],
  run: ["TASK.json CAMPAIGN.db SETTINGS.json", ["turns", "id"]],
  explorer: ["INPUT.json CAMPAIGN.db SETTINGS.json", []],
  coordinator: ["INPUT.json CAMPAIGN.db SETTINGS.json", []],
  literature: ["INPUT.json CAMPAIGN.db SETTINGS.json", []],
  verifier: ["INPUT.json CAMPAIGN.db SETTINGS.json", []],
  review: ["TASK.json ARGUMENT.md REVIEW.db PROFILE.json", []],
  guide: ["CAMPAIGN.db GUIDANCE.txt", ["id"]],
  submit: ["CAMPAIGN.db NOTES.json", ["id"]],
  inspect: [
    "CAMPAIGN.db",
    ["include-requests", "include-guidance", "include-submissions"],
  ],
  export: ["CAMPAIGN.db", []],
};
const usage = `Usage:\n${Object.entries(commands)
  .map(
    ([name, [args, flags]]) =>
      `  xean-solve ${name}${flags.map((flag) => ` [--${flag}${flag === "turns" ? " N" : flag === "id" ? " ID" : ""}]`).join("")}${args ? ` ${args}` : ""}`,
  )
  .join("\n")}

run starts or resumes the durable workflow: the coordinator chooses explorer,
literature, or verifier, and control returns after the dispatched work settles.
coordinatorBehavior.overlap pairs every verifier dispatch with Explorer when true.
init creates or matches its declaration without provider setup or model calls.
--turns sets the initial allowance (default 20), outside the frozen settings.
run --turns N --id ID adds an allowance to an exhausted campaign, then resumes.
Reuse the same ID and turns to retry without granting more turns.
guide appends explorer guidance from a UTF-8 file (or - for stdin).
Guidance takes effect at the next unfrozen explorer turn. Reuse --id for retries.
submit appends text notes and optional external verification receipts from JSON (or - for stdin).
Submitted notes reach a coordinator before the next unfrozen explorer turn. Terminal runs stay terminal.
Standalone role commands execute the same role boundaries independently.`;

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
  const spec =
    command === undefined || !Object.hasOwn(commands, command)
      ? undefined
      : commands[command];
  if (
    !spec ||
    positionals.length !== (spec[0] ? spec[0].split(" ").length : 0) ||
    Object.keys(parsed.values).some((flag) => !spec[1].includes(flag))
  )
    throw new Error(usage);
  if (command === "review") {
    const controller = new AbortController();
    await withSignals(
      () => controller.abort(),
      async () => {
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
      },
    );
    return;
  }
  if (command === "guide" || command === "submit") {
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
    writeJson(await runRoleCommand(command, positionals));
    return;
  }
  if (command === "contract") {
    writeJson(executionContract);
    return;
  }
  if (command === "inspect") {
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
    process.stdout.write(await exportSolution(positionals[0]!));
    return;
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
  await withSignals(stop, async () => {
    const result = await run(request, {
      models: () =>
        createModelRuntime({ modelsPath: modelRegistryPath(process.env) }),
      signal: controller.signal,
      pauseRequested: () => pauseRequested,
      status: (phase) => console.error(phase),
    });
    writeJson(executionReport(result));
    if (result.outcome === "interrupted") process.exitCode = 130;
    if (result.outcome === "call-failure") process.exitCode = 1;
  });
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
