import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import {
  createCampaign,
  openCampaign,
  openReader,
  type Campaign,
  type Entry,
  type Json,
} from "xean";
import { derivePiSpend, piRequest, piResultRecord } from "xean/pi";
import { z } from "zod";

import { campaignAccounting } from "./accounting";
import { appendGuidance, inspectGuidance } from "./guidance";
import { appendSubmittedNotes, inspectSubmittedNotes } from "./notes";
import { executionReport } from "./execution-contract";
import {
  createPiRoles,
  piProviders,
  solveSettings,
  type SolveSettings,
} from "./pi-roles";
import {
  applicationId,
  coordinatorInput,
  coordinatorResult,
  explorerInput,
  explorerResult,
  explorerContinuationResult,
  jsonSnapshot,
  roleFromLabel,
  roleNames,
  proof,
  reconstructionCalls,
  reconstructionResult,
  roleTools,
  sourceVerdicts,
  statement,
  succeededSubmission,
  savedExplorerSubmission,
  submittedNotes,
  verdicts,
  verifierFromLabel,
  verifierInput,
  workflowRecords,
  type RoleName,
} from "./roles";
import {
  createModelRuntime,
  modelRegistryPath,
  requireCredentials,
  withCampaignLock,
} from "./runtime";
import { withSerialToolCalls } from "./serial-tools";
import { codexRequest, codexResult, codexSubmission } from "./source";
import {
  deriveWorkflow,
  workflowConfig,
  workflowResult,
  type WorkflowPhase,
} from "./workflow";

const callsConfig = z.strictObject({ kind: z.literal("calls") });
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

function assertApplication(declaration: Entry | undefined): void {
  if (
    declaration?.kind !== "campaign" ||
    declaration.application !== applicationId
  ) {
    throw new Error("not a current Xean solver journal");
  }
}

function openCalls(path: string): Campaign {
  if (!existsSync(path)) {
    return createCampaign(path, applicationId, { kind: "calls" });
  }
  const campaign = openCampaign(path);
  try {
    const declaration = campaign.record(1);
    assertApplication(declaration);
    callsConfig.parse(
      declaration?.kind === "campaign" ? declaration.config : undefined,
    );
    return campaign;
  } catch (error) {
    campaign.close();
    throw error;
  }
}

function visibleSubmission(
  records: readonly Entry[],
  call: Extract<Entry, { readonly kind: "call" }>,
  role: RoleName,
): Json | undefined {
  const verifier = verifierFromLabel(call.label);
  try {
    if (verifier === "source" && codexRequest.safeParse(call.request).success) {
      const submission = codexSubmission(records, call.seq);
      if (submission === undefined) return undefined;
      return {
        verifier,
        ...sourceVerdicts.parse(submission.input),
        usage: submission.usage,
      };
    }
    for (const [name, schema] of [
      ["statement", statement],
      ["proof", proof],
    ] as const) {
      if (call.label !== reconstructionCalls[name].label) continue;
      const submission = succeededSubmission(
        records,
        call.seq,
        reconstructionCalls[name].tool,
      );
      return submission === undefined
        ? undefined
        : schema.parse(submission.input);
    }
    const continuation =
      role === "explorer" &&
      piRequest.parse(call.request).submissionGate !== undefined;
    const submission = continuation
      ? savedExplorerSubmission(records, call.seq)
      : succeededSubmission(records, call.seq, roleTools[role]);
    if (submission === undefined) return undefined;
    if (role === "explorer") {
      return (continuation ? explorerContinuationResult : explorerResult).parse(
        submission.input,
      );
    }
    if (role === "coordinator") {
      return jsonSnapshot(coordinatorResult.parse(submission.input));
    }
    if (verifier === undefined) return undefined;
    if (verifier === "reconstruction") {
      return { verifier, ...reconstructionResult.parse(submission.input) };
    }
    return { verifier, ...verdicts.parse(submission.input) };
  } catch {
    return undefined;
  }
}

/** Kernel settlement and provider execution outcome are separate facts. */
function callDiagnostic(
  call: Extract<Entry, { readonly kind: "call" }>,
  result: Extract<Entry, { readonly kind: "call-result" }> | undefined,
) {
  if (result === undefined) return {};
  if (result.state === "threw") return { error: result.error };
  const parsed = piRequest.safeParse(call.request).success
    ? piResultRecord.safeParse(result.output)
    : codexRequest.safeParse(call.request).success
      ? codexResult.safeParse(result.output)
      : undefined;
  if (!parsed?.success) return {};
  return {
    outcome: parsed.data.state,
    ...(parsed.data.state === "succeeded" ? {} : { error: parsed.data.error }),
  };
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
export async function inspectCampaignRecords(
  records: readonly Entry[],
  options: InspectionOptions = {},
): Promise<Json> {
  return (await projectCampaignRecords(records, options, false)).inspection;
}

/** Share one workflow derivation between inspection and accepted-proof export. */
export async function inspectAndExportCampaignRecords(
  records: readonly Entry[],
  options: InspectionOptions = {},
): Promise<{ inspection: Json; candidate?: Uint8Array }> {
  return projectCampaignRecords(records, options, true);
}

async function projectCampaignRecords(
  records: readonly Entry[],
  options: InspectionOptions,
  includeCandidate: boolean,
): Promise<{ inspection: Json; candidate?: Uint8Array }> {
  assertApplication(records[0]);
  const results = new Map(
    records
      .filter((entry) => entry.kind === "call-result")
      .map((entry) => [entry.parent, entry]),
  );
  const calls = records
    .filter(
      (entry): entry is Extract<Entry, { readonly kind: "call" }> =>
        entry.kind === "call" && roleFromLabel(entry.label) !== undefined,
    )
    .map((entry) => {
      const role = roleFromLabel(entry.label)!;
      const verifier = verifierFromLabel(entry.label);
      const result = results.get(entry.seq);
      const visible =
        entry.role === role
          ? visibleSubmission(records, entry, role)
          : undefined;
      return {
        call: entry.seq,
        role,
        label: entry.label,
        ...(verifier === undefined ? {} : { verifier }),
        ...(entry.candidate === undefined
          ? {}
          : { candidate: entry.candidate }),
        startedAtMs: entry.atMs,
        ...(result === undefined
          ? {}
          : {
              settledAtMs: result.atMs,
              elapsedMs: result.atMs - entry.atMs,
              state: result.state,
            }),
        ...callDiagnostic(entry, result),
        ...(visible === undefined ? {} : { submission: visible }),
        ...(options.includeRequests === true ? { request: entry.request } : {}),
      };
    });
  const declaration = records[0];
  const config = workflowConfig.safeParse(
    declaration?.kind === "campaign" ? declaration.config : undefined,
  );
  const snapshot = config.success ? await deriveWorkflow(records) : undefined;
  const phase = snapshot?.phase;
  const report =
    phase?.kind === "accepted" || phase?.kind === "turn-limit"
      ? workflowResult(phase)
      : undefined;
  const spend = derivePiSpend(records);
  const inspection = JSON.parse(
    JSON.stringify({
      ...(snapshot === undefined
        ? {}
        : {
            task: snapshot.config.task,
            phase: phase?.kind,
            notes: snapshot.notes,
            ...(report === undefined
              ? {}
              : { result: executionReport(report) }),
          }),
      calls,
      spend: spend.summary,
      accounting: campaignAccounting(records, spend),
      ...(options.includeGuidance === true
        ? { guidance: inspectGuidance(records) }
        : {}),
      ...(options.includeSubmissions === true
        ? {
            submissions: inspectSubmittedNotes(
              records,
              snapshot?.noteSubmissions,
            ),
          }
        : {}),
    }),
  ) as Json;
  return {
    inspection,
    ...(includeCandidate && phase?.kind === "accepted"
      ? { candidate: candidateBytes(phase) }
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
            new Set(note.support).size !== note.support.length ||
            note.support.some((support) => !live.has(support))
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
export async function exportCandidate(path: string): Promise<Uint8Array> {
  const reader = openReader(path);
  try {
    return await exportCandidateRecords(workflowRecords(reader));
  } finally {
    reader.close();
  }
}

export async function exportCandidateRecords(
  records: readonly Entry[],
): Promise<Uint8Array> {
  assertApplication(records[0]);
  const phase = (await deriveWorkflow(records)).phase;
  if (phase.kind !== "accepted")
    throw new Error("workflow has no accepted candidate");
  return candidateBytes(phase);
}

function candidateBytes(
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
  else await verifierInput.parseAsync(input);
  const runtime = await createModelRuntime({
    modelsPath: modelRegistryPath(process.env),
  });
  await requireCredentials(runtime, piProviders(settings, command));
  const models = withSerialToolCalls(runtime);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await withCampaignLock(campaignPath, async () => {
      const campaign = openCalls(campaignPath);
      try {
        const roles = createPiRoles(campaign, settings, {
          models,
          signal: controller.signal,
        });
        return jsonSnapshot(await roles[command](input as never));
      } finally {
        campaign.close();
      }
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
