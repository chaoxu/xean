import { readFile } from "node:fs/promises";

import { openCampaign, openReader, type Entry, type Json } from "xean";
import { builtinPi, derivePiSpend } from "xean/pi";
import { z } from "zod";
import { inspectCoreCallSummaries } from "xean/observe";

import { campaignAccounting } from "./accounting";
import { appendGuidance, inspectGuidance } from "./guidance";
import { appendSubmittedNotes, inspectSubmittedNotes } from "./notes";
import { executionReport } from "./execution-contract";
import {
  createPiRoles,
  roleSubmission,
  piProviders,
  solveSettings,
  localSourceRequest,
  type SolveSettings,
} from "./pi-roles";
import {
  applicationId,
  assertApplication,
  coordinatorInput,
  explorerInput,
  literatureInput,
  jsonSnapshot,
  roleFromLabel,
  roleNames,
  submittedNotes,
  verifierFromLabel,
  verifierInput,
  workflowRecords,
  type RoleName,
} from "./roles";
import {
  createModelRuntime,
  codexCommand,
  modelRegistryPath,
  openConfiguredCampaign,
  requireCredentials,
  withCampaignLock,
  withSignals,
} from "./runtime";
import { withSerialToolCalls } from "./serial-tools";
import { codexRequest, codexOutcome, requireCodex } from "./source";
import {
  deriveWorkflow,
  workflowConfig,
  workflowResult,
  type WorkflowPhase,
} from "./workflow";

const callsConfig = z.strictObject({ kind: z.literal("calls") });
const inspectionConfig = z.discriminatedUnion("kind", [
  workflowConfig,
  callsConfig,
]);
export type RoleCommand = RoleName;

export function isRoleCommand(value: string | undefined): value is RoleCommand {
  return roleNames.some((command) => command === value);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function readSettings(path: string): Promise<SolveSettings> {
  return solveSettings.parse(await readJson(path));
}

export interface InspectionOptions {
  readonly includeRequests?: boolean;
  readonly includeGuidance?: boolean;
  readonly includeSubmissions?: boolean;
}

export async function inspectCampaign(
  path: string,
  options: InspectionOptions = {},
): Promise<Json> {
  const reader = openReader(path);
  try {
    return await inspectCampaignRecords(reader.records(), options);
  } finally {
    reader.close();
  }
}

/** Inspect one captured journal boundary, without reopening its database. */
export function inspectCampaignRecords(
  records: readonly Entry[],
  options: InspectionOptions = {},
): Json {
  return projectCampaignRecords(records, options, false).inspection;
}

/** Share one workflow derivation between inspection and accepted-proof export. */
export function inspectAndExportCampaignRecords(
  records: readonly Entry[],
  options: InspectionOptions = {},
): { inspection: Json; solution?: Uint8Array } {
  return projectCampaignRecords(records, options, true);
}

function projectCampaignRecords(
  records: readonly Entry[],
  options: InspectionOptions,
  includeSolution: boolean,
): { inspection: Json; solution?: Uint8Array } {
  assertApplication(records[0]);
  const declaration = records[0];
  const config = inspectionConfig.parse(
    declaration?.kind === "campaign" ? declaration.config : undefined,
  );
  const entries = new Map(records.map((entry) => [entry.seq, entry]));
  const evidence = new Map(
    records.flatMap((entry) =>
      entry.kind === "evidence" ? [[entry.call, entry.evidence] as const] : [],
    ),
  );
  const calls = inspectCoreCallSummaries(records)
    .filter(({ label }) => roleFromLabel(label) !== undefined)
    .map(({ pi, tools: _tools, ...facts }) => {
      const entry = entries.get(facts.call)!;
      if (entry.kind !== "call") throw new Error(`missing call ${facts.call}`);
      const verifier = verifierFromLabel(entry.label);
      const provider = codexRequest.safeParse(entry.request).success
        ? codexOutcome(records, facts.call)
        : undefined;
      let submission: Json | undefined;
      let submissionError: string | undefined;
      try {
        submission = roleSubmission(records, entry);
      } catch (error) {
        submissionError =
          error instanceof Error ? error.message : String(error);
      }
      const outcome =
        pi?.outcome ??
        provider?.state ??
        (facts.state === "returned" &&
        localSourceRequest.safeParse(entry.request).success
          ? "succeeded"
          : undefined);
      return {
        ...facts,
        elapsedMs:
          facts.settledAtMs === undefined
            ? undefined
            : facts.settledAtMs - facts.startedAtMs,
        verifier,
        outcome,
        error:
          provider && provider.state !== "succeeded"
            ? provider.error
            : (pi?.error ?? facts.error),
        submission,
        submissionError,
        evidence: evidence.get(facts.call),
        request: options.includeRequests ? entry.request : undefined,
      };
    });
  const snapshot =
    config.kind === "workflow" ? deriveWorkflow(records) : undefined;
  const phase = snapshot?.phase;
  const report =
    phase?.kind === "accepted" || phase?.kind === "turn-limit"
      ? workflowResult(phase)
      : undefined;
  const spend = derivePiSpend(records);
  const inspection = jsonSnapshot({
    ...(snapshot === undefined
      ? {}
      : {
          task: snapshot.config.task,
          maxTurns: snapshot.maxTurns,
          allowances: snapshot.allowances,
          phase: phase?.kind,
          overlap:
            phase?.kind === "overlap"
              ? {
                  after: phase.after,
                  opened: phase.opened,
                  explorerPending: phase.explorer !== undefined,
                  verifierPending: phase.verifier !== undefined,
                  acceptedNote: phase.accepted?.note.id,
                }
              : undefined,
          notes: snapshot.notes,
          result: report === undefined ? undefined : executionReport(report),
        }),
    calls,
    spend: spend.summary,
    accounting: campaignAccounting(records, spend),
    guidance: options.includeGuidance ? inspectGuidance(records) : undefined,
    submissions: options.includeSubmissions
      ? inspectSubmittedNotes(records, snapshot?.noteSubmissions)
      : undefined,
  });
  return {
    inspection,
    ...(includeSolution && phase?.kind === "accepted"
      ? { solution: solutionBytes(phase) }
      : {}),
  };
}

export async function guideCampaign(
  path: string,
  text: string,
  id: string = crypto.randomUUID(),
) {
  const campaign = openCampaign(path);
  try {
    const declaration = campaign.record(1);
    assertApplication(declaration);
    workflowConfig.parse(
      declaration?.kind === "campaign" ? declaration.config : undefined,
    );
    return await appendGuidance(path, campaign, text, id);
  } finally {
    campaign.close();
  }
}

/** Submit ordinary note text and optional caller attestation without inference. */
export async function submitNotes(
  path: string,
  input: unknown,
  id: string = crypto.randomUUID(),
) {
  const value = submittedNotes.parse(input);
  const campaign = openCampaign(path);
  try {
    const declaration = campaign.record(1);
    assertApplication(declaration);
    workflowConfig.parse(
      declaration?.kind === "campaign" ? declaration.config : undefined,
    );
    return await appendSubmittedNotes(
      path,
      campaign,
      value,
      id,
      async (records) => {
        const snapshot = await deriveWorkflow(records);
        const live = new Set(
          snapshot.notes.filter((note) => !note.dead).map((note) => note.id),
        );
        for (const note of value.notes) {
          if (
            note.support.some(
              (support) => typeof support === "string" && !live.has(support),
            )
          )
            throw new Error(
              "submitted support must name distinct existing notes that are not dead",
            );
        }
      },
    );
  } finally {
    campaign.close();
  }
}

/** The accepted note preceded by its transitive support, in id order. */
export async function exportSolution(path: string): Promise<Uint8Array> {
  const reader = openReader(path);
  try {
    return await exportSolutionRecords(workflowRecords(reader));
  } finally {
    reader.close();
  }
}

export function exportSolutionRecords(records: readonly Entry[]): Uint8Array {
  assertApplication(records[0]);
  const phase = deriveWorkflow(records).phase;
  if (phase.kind !== "accepted")
    throw new Error("workflow has no accepted solution");
  return solutionBytes(phase);
}

function solutionBytes(
  phase: Extract<WorkflowPhase, { kind: "accepted" }>,
): Uint8Array {
  const text = [...phase.closure, phase.note.id]
    .map((id) => {
      const note = phase.notes.find((entry) => entry.id === id)!;
      return `--- ${id} ---\n\n${note.text}`;
    })
    .join("\n\n");
  return new TextEncoder().encode(text);
}

export async function runRoleCommand(
  command: RoleCommand,
  positionals: readonly string[],
): Promise<Json> {
  if (positionals.length !== 3) {
    throw new Error(`${command} requires INPUT.json CAMPAIGN.db SETTINGS.json`);
  }
  const [inputPath, campaignPath, settingsPath] = positionals as readonly [
    string,
    string,
    string,
  ];
  const settings = await readSettings(settingsPath);
  const input = await readJson(inputPath);
  if (command === "explorer") explorerInput.parse(input);
  else if (command === "coordinator") coordinatorInput.parse(input);
  else if (command === "literature") literatureInput.parse(input);
  else verifierInput.parse(input);
  const runtime =
    command === "literature"
      ? undefined
      : await createModelRuntime({
          modelsPath: modelRegistryPath(process.env),
        });
  if (command === "literature") {
    await requireCodex({ command: codexCommand(process.env) });
  } else {
    await requireCredentials(runtime!, piProviders(settings, command));
  }
  const models =
    runtime === undefined ? builtinPi() : withSerialToolCalls(runtime);
  const controller = new AbortController();
  return withSignals(
    () => controller.abort(),
    () =>
      withCampaignLock(campaignPath, async () => {
        const campaign = openConfiguredCampaign(campaignPath, applicationId, {
          kind: "calls",
        });
        try {
          const roles = createPiRoles(campaign, settings, {
            models,
            signal: controller.signal,
          });
          return jsonSnapshot(await roles[command](input as never));
        } finally {
          campaign.close();
        }
      }),
  );
}
