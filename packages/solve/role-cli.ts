import { readFile } from "node:fs/promises";

import { openCampaign, openReader, type Entry, type Json } from "xean";
import {
  builtinPi,
  derivePiAccounting,
  derivePiSpend,
  piRequestAttempts,
  summarizePiSpend,
  type PiSpend,
} from "xean/pi";
import { z } from "zod";
import { inspectCoreCallSummaries, type CoreCallSummaryV2 } from "xean/observe";

import { campaignAccounting, roleAccounting } from "./accounting";
import { appendGuidance, inspectGuidance } from "./guidance";
import { appendSubmittedNotes, inspectSubmittedNotes } from "./notes";
import { executionReport } from "./execution-contract";
import { piProviders, solveSettings, type SolveSettings } from "./pi-roles";
import { createRoleHost } from "./role-host";
import { historyAt, recordSource, type RecordSource } from "./history";
import { callsConfig, roleSubmission } from "./role-records";
import {
  applicationId,
  assertApplication,
  coordinatorInput,
  explorerInput,
  literatureInput,
  jsonSnapshot,
  VerdictHistory,
  roleCallRecords,
  roleFromLabel,
  roleNames,
  roleRequest,
  submittedNotes,
  verifierFromLabel,
  verifierInput,
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
import { prepareCodex } from "./source";
import {
  deriveWorkflow,
  workflowConfig,
  workflowResult,
  type WorkflowPhase,
} from "./workflow";

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
    return inspectCampaignSnapshot(reader, options).inspection;
  } finally {
    reader.close();
  }
}

/** Inspect one captured journal boundary, without reopening its database. */
export function inspectCampaignRecords(
  records: readonly Entry[],
  options: InspectionOptions = {},
): Json {
  return inspectCampaignSnapshot(records, options).inspection;
}

/** Share one workflow derivation between inspection and accepted-proof export. */
export function inspectAndExportCampaignRecords(
  records: readonly Entry[] | RecordSource,
  options: InspectionOptions = {},
): { inspection: Json; solution?: Uint8Array } {
  const { coreCalls: _, ...result } = inspectCampaignSnapshot(records, {
    ...options,
    includeSolution: true,
  });
  return result;
}

/** Derive accounting once for all projections of one captured journal boundary. */
export function inspectCampaignSnapshot(
  records: readonly Entry[] | RecordSource,
  options: InspectionOptions & { readonly includeSolution?: boolean } = {},
): {
  inspection: Json;
  coreCalls: readonly CoreCallSummaryV2[];
  solution?: Uint8Array;
} {
  const reader = recordSource(records);
  const source = historyAt(reader, reader.lastSequence());
  const declaration = source.record(1);
  assertApplication(declaration);
  const config = inspectionConfig.parse(
    declaration?.kind === "campaign" ? declaration.config : undefined,
  );
  if (config.kind === "calls") new VerdictHistory(source).read();
  const snapshot =
    config.kind === "workflow" ? deriveWorkflow(source) : undefined;
  const { coreCalls, spend } = inspectCalls(source, declaration);
  const cost = campaignAccounting(source.scan({ kinds: ["call"] }), spend);
  const results = source.records({ kinds: ["call-result"] });
  const calls = coreCalls
    .filter(({ label }) => roleFromLabel(label) !== undefined)
    .map(({ pi: _pi, tools: _tools, ...facts }) => {
      const entry = source.record(facts.call)!;
      if (entry.kind !== "call") throw new Error(`missing call ${facts.call}`);
      const verifier = verifierFromLabel(entry.label);
      const models = coreCalls.filter(
        ({ parent, label }) =>
          parent === facts.call && label.startsWith("xean-solve/model/"),
      );
      let submission: Json | undefined;
      let submissionError: string | undefined;
      try {
        submission = roleSubmission(roleCallRecords(source, entry.seq), entry);
      } catch (error) {
        submissionError =
          error instanceof Error ? error.message : String(error);
      }
      const noteSubmission = snapshot?.noteSubmissions.find(
        (value) => value.call === entry.seq,
      );
      return {
        ...facts,
        ...noteSubmission,
        support:
          noteSubmission !== undefined && entry.role === "explorer"
            ? explorerInput
                .parse(roleRequest.parse(entry.request).input)
                .support.map(({ id }) => id)
            : undefined,
        elapsedMs:
          facts.settledAtMs === undefined
            ? undefined
            : facts.settledAtMs - facts.startedAtMs,
        verifier,
        outcome:
          facts.state === "returned"
            ? "succeeded"
            : facts.state === "threw"
              ? "failed"
              : undefined,
        modelCalls: models.map(({ call }) => call),
        accounting: roleAccounting(results, facts, models, cost),
        submission,
        submissionError,
        evidence: source
          .records({ kinds: ["evidence"], call: facts.call })
          .find((entry) => entry.kind === "evidence")?.evidence,
        request: options.includeRequests ? entry.request : undefined,
        modelRequests: options.includeRequests
          ? models.map(({ call }) => {
              const model = source.record(call)!;
              if (model.kind !== "call")
                throw new Error(`missing call ${call}`);
              return { call, request: model.request };
            })
          : undefined,
      };
    });
  const phase = snapshot?.phase;
  const report =
    phase?.kind === "accepted" || phase?.kind === "turn-limit"
      ? workflowResult(phase)
      : undefined;
  // Delivery only needs identities for role starts, not their historical inputs.
  const inboxRecords: Entry[] = [];
  if (options.includeGuidance || options.includeSubmissions)
    for (const entry of source.scan({
      kinds: ["call"],
      labels: [
        "xean-solve/notes",
        "xean-solve/guidance",
        "xean-solve/inbox-boundary",
        "xean-solve/coordinator",
        "xean-solve/explorer",
      ],
    })) {
      inboxRecords.push(
        entry.kind === "call" && roleFromLabel(entry.label) !== undefined
          ? { ...entry, request: null, tools: [] }
          : entry,
      );
    }
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
    accounting: cost,
    guidance: options.includeGuidance
      ? inspectGuidance(inboxRecords)
      : undefined,
    submissions: options.includeSubmissions
      ? inspectSubmittedNotes(inboxRecords, snapshot?.noteSubmissions)
      : undefined,
  });
  return {
    inspection,
    coreCalls,
    ...(options.includeSolution && phase?.kind === "accepted"
      ? { solution: solutionBytes(phase) }
      : {}),
  };
}

/** Project one call at a time; retain accounting and call summaries, not prompts. */
function inspectCalls(source: RecordSource, declaration: Entry) {
  const checkpoints = new Map<number, Entry[]>();
  const checkpointIds = new Set<number>();
  for (const call of source.scan({
    kinds: ["call"],
    labels: ["xean/pi-request"],
  })) {
    if (call.kind !== "call") continue;
    const parent = (call.request as { parent?: unknown } | null)?.parent;
    const owner =
      typeof parent === "number" && Number.isInteger(parent) && parent > 0
        ? source.record(parent)
        : undefined;
    const frame = [
      call,
      ...source.records({ kinds: ["call-result"], parent: call.seq }),
    ];
    const attempt = piRequestAttempts([...(owner ? [owner] : []), ...frame])[0];
    if (attempt === undefined) continue;
    checkpointIds.add(call.seq);
    const entries = checkpoints.get(attempt.parent) ?? [];
    entries.push(...frame);
    checkpoints.set(attempt.parent, entries);
  }
  const coreCalls: CoreCallSummaryV2[] = [];
  const parts: PiSpend[] = [];
  for (const call of source.scan({ kinds: ["call"] })) {
    if (checkpointIds.has(call.seq)) continue;
    const frame = [
      declaration,
      call,
      ...source.records({ kinds: ["call-result"], parent: call.seq }),
      ...source.records({ kinds: ["tool-call"], call: call.seq }),
      ...(checkpoints.get(call.seq) ?? []),
    ].sort((a, b) => a.seq - b.seq);
    const accounting = derivePiAccounting(frame);
    coreCalls.push(...inspectCoreCallSummaries(frame, accounting));
    parts.push(derivePiSpend(frame, accounting));
  }
  const calls = parts.flatMap((part) => part.calls);
  const spend: PiSpend = {
    calls,
    unaccountedCalls: parts.flatMap((part) => part.unaccountedCalls),
    potentialRequests: parts
      .flatMap((part) => part.potentialRequests)
      .sort((a, b) => a.checkpoint - b.checkpoint),
    summary: summarizePiSpend(calls.flatMap(({ operations }) => operations)),
  };
  return { coreCalls, spend };
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
    return await appendSubmittedNotes(campaign, value, id, {
      path,
      validate: async (records) => {
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
    });
  } finally {
    campaign.close();
  }
}

/** The accepted note preceded by its transitive support, in id order. */
export async function exportSolution(path: string): Promise<Uint8Array> {
  const reader = openReader(path);
  try {
    return exportSolutionRecords(reader);
  } finally {
    reader.close();
  }
}

export function exportSolutionRecords(
  records: readonly Entry[] | RecordSource,
): Uint8Array {
  assertApplication(recordSource(records).record(1));
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
  const controller = new AbortController();
  return withSignals(
    () => controller.abort(),
    () =>
      withCampaignLock(campaignPath, async () => {
        const campaign = openConfiguredCampaign(campaignPath, applicationId, {
          kind: "calls",
          schemaVersion: 1,
        });
        try {
          const runtime =
            command === "literature"
              ? undefined
              : await createModelRuntime({
                  modelsPath: modelRegistryPath(process.env),
                });
          if (runtime !== undefined) {
            await requireCredentials(runtime, piProviders(settings, command));
          }
          const codex =
            command === "literature" || command === "verifier"
              ? await prepareCodex({ command: codexCommand(process.env) })
              : undefined;
          const models =
            runtime === undefined ? builtinPi() : withSerialToolCalls(runtime);
          const roles = createRoleHost(campaign, settings, {
            models,
            ...(codex === undefined ? {} : { codex }),
            signal: controller.signal,
          });
          return jsonSnapshot(await roles[command](input as never));
        } finally {
          campaign.close();
        }
      }),
  );
}
