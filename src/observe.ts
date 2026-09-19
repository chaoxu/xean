import { openReader } from "./campaign";
import {
  derivePiCallOperations,
  piRequest,
  piRequestAttempts,
  piResultRecord,
  readPiResult,
  summarizePiSpend,
  type PiRequestAttempt,
  type PiSpendOperation,
  type PiSpendSummary,
} from "./pi";
import { deriveCandidateStatuses } from "./verification";
import type { CandidateStatus, Entry, EntryId, Json, Reader } from "./types";
import { z } from "zod";

type CallEntry = Extract<Entry, { kind: "call" }>;
type CallResultEntry = Extract<Entry, { kind: "call-result" }>;
type ToolCallEntry = Extract<Entry, { kind: "tool-call" }>;
type CandidateEntry = Extract<Entry, { kind: "candidate" }>;

export interface PiUsageBreakdownV1 {
  readonly freshInputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly nonReasoningOutputTokens: number;
  readonly estimatedReasoningCostUsd?: number;
  readonly reasoningCostShareOfMeasuredCost?: number;
}

export type PiObservationSpendV1 = PiSpendSummary & {
  readonly breakdown?: PiUsageBreakdownV1;
  /** Derived from accounted calls only. Later requests may be retries or ordinary tool continuations. */
  readonly requests?: {
    readonly first: PiRequestPhaseSpendV1;
    readonly continuation: PiRequestPhaseSpendV1;
  };
  /** Errors in provider requests whose enclosing Pi call ultimately succeeded. */
  readonly recoveredRequestErrors?: number;
};

export type PiRequestPhaseSpendV1 = PiSpendSummary & {
  /** cacheRead / (input + cacheRead + cacheWrite), omitted without measured input. */
  readonly cachedInputShare?: number;
};

export interface PiRecoveredErrorObservationV1 {
  /** One-based provider request position within the logical Pi call. */
  readonly request: number;
  readonly name?: string;
  readonly message?: string;
}

export interface CoreCampaignObservationV1 {
  readonly schema: "xean.core-observation/v1";
  readonly application: string;
  readonly applicationConfig: Json;
  readonly createdAtMs: number;
  readonly lastSeq: number;
  readonly lastAtMs: number;
  readonly calls: readonly CoreCallObservationV1[];
  readonly candidates: readonly CoreCandidateObservationV1[];
  readonly spend: PiObservationSpendV1 & {
    readonly unsupportedCalls: readonly EntryId[];
    readonly unaccountedCalls: readonly EntryId[];
  };
}

export interface CoreCampaignSummaryV1 {
  readonly schema: "xean.core-observation-summary/v1";
  readonly application: string;
  readonly createdAtMs: number;
  readonly lastSeq: number;
  readonly lastAtMs: number;
  readonly callCount: number;
  readonly callsWithoutResult?: {
    readonly count: number;
    readonly oldestStartedAtMs: number;
  };
  readonly candidateCount: number;
  readonly verifiedCandidateCount: number;
  readonly spend: PiObservationSpendV1 & {
    readonly unsupportedCalls: number;
    readonly unaccountedCalls: number;
  };
}

export interface CoreCallObservationV1 {
  readonly id: EntryId;
  readonly label: string;
  readonly role?: string;
  readonly candidateId?: EntryId;
  readonly startedAtMs: number;
  readonly settledAtMs?: number;
  readonly settlement: "returned" | "threw" | "unsettled";
  readonly error?: string;
  readonly tools: readonly { readonly id: EntryId; readonly name: string }[];
  readonly pi?: {
    readonly requested: {
      readonly provider: string;
      readonly model: string;
      readonly api: string;
      readonly reasoning?: string;
    };
    readonly outcome?: "succeeded" | "failed" | "cancelled";
    readonly responseText?: string;
    readonly checkpoints: readonly {
      readonly id: EntryId;
      readonly state: "completed" | "unsettled";
    }[];
    readonly accounting: PiAccountingObservationV1;
  };
}

export type CoreCallSummaryV1 = Omit<CoreCallObservationV1, "pi"> & {
  readonly pi?: Omit<NonNullable<CoreCallObservationV1["pi"]>, "responseText">;
};

export type PiAccountingObservationV1 =
  | {
      readonly state: "available";
      /** False when durable request measurements precede the enclosing call's settlement. */
      readonly complete?: false;
      readonly operations: readonly PiSpendOperation[];
      readonly spend: PiObservationSpendV1;
      readonly recoveredErrors?: readonly PiRecoveredErrorObservationV1[];
    }
  | { readonly state: "unaccounted" }
  | { readonly state: "unsupported" };

export interface CoreCandidateObservationV1 {
  readonly id: EntryId;
  readonly requiredVerifiers: readonly string[];
  readonly material:
    | {
        readonly bytes: number;
        readonly encoding: "utf8";
        readonly text: string;
      }
    | {
        readonly bytes: number;
        readonly encoding: "base64";
        readonly base64: string;
      };
  readonly status: CandidateStatus;
  readonly verdicts: readonly CoreVerdictObservationV1[];
}

export interface CoreVerdictObservationV1 {
  readonly call: EntryId;
  readonly verifier: string;
  readonly verdict: "PASS" | "FAIL" | "INCONCLUSIVE";
  readonly evidence: Json;
}

interface RecordIndex {
  readonly declaration: Extract<Entry, { kind: "campaign" }>;
  readonly last: Entry;
  readonly calls: readonly CallEntry[];
  readonly results: ReadonlyMap<EntryId, CallResultEntry>;
  readonly tools: ReadonlyMap<EntryId, readonly ToolCallEntry[]>;
  readonly attemptsByParent: ReadonlyMap<EntryId, readonly PiRequestAttempt[]>;
  readonly candidates: readonly CandidateEntry[];
  readonly verdicts: ReadonlyMap<EntryId, readonly CoreVerdictObservationV1[]>;
  readonly statuses: ReadonlyMap<EntryId, CandidateStatus>;
}

interface AccountingIndex {
  readonly byCall: ReadonlyMap<EntryId, PiAccountingObservationV1>;
  readonly stored: ReadonlyMap<EntryId, z.output<typeof piResultRecord>>;
  readonly spend: PiObservationSpendV1;
  readonly unsupportedCalls: readonly EntryId[];
  readonly unaccountedCalls: readonly EntryId[];
}

function closeEnough(left: number, right: number): boolean {
  return (
    Math.abs(left - right) <=
    1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
  );
}

function reasoningCost(
  assistantUsage: z.output<typeof piResultRecord>["assistantUsage"],
  usage: Extract<PiSpendSummary, { measuredUsage: unknown }>["measuredUsage"],
): number | undefined {
  if (assistantUsage.some((usage) => usage === null)) return undefined;
  const measured = assistantUsage.filter((usage) => usage !== null);
  const sum = (select: (value: (typeof measured)[number]) => number): number =>
    measured.reduce((total, value) => total + select(value), 0);
  const completeReasoning = measured.every(
    (value) =>
      value.reasoning !== undefined ||
      (value.output === 0 && value.cost.output === 0),
  );
  if (!completeReasoning) return undefined;
  const reasoning = sum((value) => value.reasoning ?? 0);
  if (
    measured.some((value) => (value.reasoning ?? 0) > value.output) ||
    measured.some(
      (value) =>
        !closeEnough(
          value.cost.total,
          value.cost.input +
            value.cost.output +
            value.cost.cacheRead +
            value.cost.cacheWrite,
        ) ||
        (value.cost.output > value.cost.total &&
          !closeEnough(value.cost.output, value.cost.total)),
    ) ||
    sum((value) => value.input) !== usage.input ||
    sum((value) => value.output) !== usage.output ||
    sum((value) => value.cacheRead) !== usage.cacheRead ||
    sum((value) => value.cacheWrite) !== usage.cacheWrite ||
    sum((value) => value.totalTokens) !== usage.totalTokens ||
    reasoning !== usage.reasoning ||
    !closeEnough(
      sum((value) => value.cost.total),
      usage.estimatedCostUsd,
    )
  ) {
    return undefined;
  }
  const cost = sum((value) =>
    value.output === 0
      ? 0
      : value.cost.output * ((value.reasoning ?? 0) / value.output),
  );
  return cost > usage.estimatedCostUsd &&
    !closeEnough(cost, usage.estimatedCostUsd)
    ? undefined
    : cost;
}

function observedSpend(
  spend: PiSpendSummary,
  assistantUsage: z.output<typeof piResultRecord>["assistantUsage"],
): PiObservationSpendV1 {
  if (!("measuredUsage" in spend)) return spend;
  const usage = spend.measuredUsage;
  const reasoning = usage.reasoning;
  if (
    reasoning === undefined ||
    reasoning > usage.output ||
    usage.input + usage.cacheRead + usage.cacheWrite + usage.output !==
      usage.totalTokens
  ) {
    return spend;
  }
  const estimatedReasoningCostUsd = reasoningCost(assistantUsage, usage);
  return {
    ...spend,
    breakdown: {
      freshInputTokens: usage.input + usage.cacheWrite,
      cachedInputTokens: usage.cacheRead,
      reasoningOutputTokens: reasoning,
      nonReasoningOutputTokens: usage.output - reasoning,
      ...(estimatedReasoningCostUsd === undefined
        ? {}
        : {
            estimatedReasoningCostUsd,
            ...(usage.estimatedCostUsd === 0
              ? {}
              : {
                  reasoningCostShareOfMeasuredCost:
                    estimatedReasoningCostUsd / usage.estimatedCostUsd,
                }),
          }),
    },
  };
}

function requestPhaseSpend(
  operations: readonly PiSpendOperation[],
): PiRequestPhaseSpendV1 {
  const spend = summarizePiSpend(operations);
  if (!("measuredUsage" in spend)) return spend;
  const { input, cacheRead, cacheWrite } = spend.measuredUsage;
  const promptTokens = input + cacheRead + cacheWrite;
  return {
    ...spend,
    ...(promptTokens === 0
      ? {}
      : { cachedInputShare: cacheRead / promptTokens }),
  };
}

function recoveredErrors(
  stored: z.output<typeof piResultRecord>,
): readonly PiRecoveredErrorObservationV1[] {
  if (stored.state !== "succeeded") return [];
  const root = stored.telemetry.spans.find(
    ({ name, parentId }) => name === "xean.pi.run" && parentId === null,
  );
  return stored.telemetry.spans
    .filter(
      ({ name, parentId }) => name === "pi.ai.request" && parentId === root?.id,
    )
    .flatMap(({ status }, index) =>
      status.status === "error"
        ? [{ request: index + 1, ...status.error }]
        : [],
    );
}

export function inspectCoreCampaign(path: string): CoreCampaignObservationV1 {
  const reader = openReader(path);
  try {
    return inspectCoreCampaignRecords(reader, reader.records());
  } finally {
    reader.close();
  }
}

export function inspectCoreCampaignSummary(
  path: string,
): CoreCampaignSummaryV1 {
  const reader = openReader(path);
  try {
    return inspectCoreCampaignSummaryRecords(reader.records());
  } finally {
    reader.close();
  }
}

/** Project a caller's captured journal boundary without reading it again. */
export function inspectCoreCampaignRecords(
  reader: Reader,
  records: readonly Entry[],
): CoreCampaignObservationV1 {
  const index = indexRecords(records);
  const accounting = indexAccounting(index);
  return {
    schema: "xean.core-observation/v1",
    application: index.declaration.application,
    applicationConfig: index.declaration.config,
    createdAtMs: index.declaration.atMs,
    lastSeq: index.last.seq,
    lastAtMs: index.last.atMs,
    calls: index.calls.map((call) => {
      const value = projectCall(index, accounting, call);
      const stored = accounting.stored.get(call.seq);
      const full =
        stored === undefined ? undefined : readPiResult(stored, reader);
      return full?.text && value.pi
        ? { ...value, pi: { ...value.pi, responseText: full.text } }
        : value;
    }),
    candidates: index.candidates.map((candidate) =>
      projectCandidate(reader, index, candidate),
    ),
    spend: {
      ...accounting.spend,
      unsupportedCalls: accounting.unsupportedCalls,
      unaccountedCalls: accounting.unaccountedCalls,
    },
  };
}

/** Project call metadata and accounting without reading result or candidate payloads. */
export function inspectCoreCallSummaries(
  records: readonly Entry[],
): readonly CoreCallSummaryV1[] {
  const index = indexRecords(records);
  const accounting = indexAccounting(index);
  return index.calls.map((call) => projectCall(index, accounting, call));
}

/** Summarize a caller's captured journal boundary without loading payloads. */
export function inspectCoreCampaignSummaryRecords(
  records: readonly Entry[],
): CoreCampaignSummaryV1 {
  const index = indexRecords(records);
  const accounting = indexAccounting(index);
  const unsettled = index.calls.filter(
    (call) => index.results.get(call.seq) === undefined,
  );
  return {
    schema: "xean.core-observation-summary/v1",
    application: index.declaration.application,
    createdAtMs: index.declaration.atMs,
    lastSeq: index.last.seq,
    lastAtMs: index.last.atMs,
    callCount: index.calls.length,
    ...(unsettled.length === 0
      ? {}
      : {
          callsWithoutResult: {
            count: unsettled.length,
            oldestStartedAtMs: Math.min(...unsettled.map(({ atMs }) => atMs)),
          },
        }),
    candidateCount: index.candidates.length,
    verifiedCandidateCount: index.candidates.filter(
      ({ seq }) => candidateStatus(index, seq).verified,
    ).length,
    spend: {
      ...accounting.spend,
      unsupportedCalls: accounting.unsupportedCalls.length,
      unaccountedCalls: accounting.unaccountedCalls.length,
    },
  };
}

function indexRecords(records: readonly Entry[]): RecordIndex {
  const declaration = records[0];
  if (declaration?.kind !== "campaign") {
    throw new Error("campaign declaration is unavailable");
  }
  const callsById = new Map<EntryId, CallEntry>();
  const results = new Map<EntryId, CallResultEntry>();
  const tools = new Map<EntryId, ToolCallEntry[]>();
  const candidates: CandidateEntry[] = [];
  for (const entry of records) {
    if (entry.kind === "call") callsById.set(entry.seq, entry);
    else if (entry.kind === "call-result") results.set(entry.parent, entry);
    else if (entry.kind === "tool-call") {
      const values = tools.get(entry.call) ?? [];
      values.push(entry);
      tools.set(entry.call, values);
    } else if (entry.kind === "candidate") candidates.push(entry);
  }
  const attempts = piRequestAttempts(records);
  const attemptIds = new Set(attempts.map(({ call }) => call));
  const attemptsByParent = new Map<EntryId, PiRequestAttempt[]>();
  for (const attempt of attempts) {
    const values = attemptsByParent.get(attempt.parent) ?? [];
    values.push(attempt);
    attemptsByParent.set(attempt.parent, values);
  }
  const verdicts = new Map<EntryId, CoreVerdictObservationV1[]>();
  for (const entry of records) {
    if (entry.kind !== "verdict") continue;
    const call = callsById.get(entry.call);
    if (call?.candidate === undefined) continue;
    const values = verdicts.get(call.candidate) ?? [];
    values.push({
      call: entry.call,
      verifier: call.label,
      verdict: entry.verdict,
      evidence: entry.evidence,
    });
    verdicts.set(call.candidate, values);
  }
  return {
    declaration,
    last: records.at(-1) ?? declaration,
    calls: [...callsById.values()].filter(({ seq }) => !attemptIds.has(seq)),
    results,
    tools,
    attemptsByParent,
    candidates,
    verdicts,
    statuses: deriveCandidateStatuses(records),
  };
}

function indexAccounting(index: RecordIndex): AccountingIndex {
  const byCall = new Map<EntryId, PiAccountingObservationV1>();
  const storedResults = new Map<EntryId, z.output<typeof piResultRecord>>();
  const understoodOperations: PiSpendOperation[] = [];
  const understoodUsage: z.output<
    typeof piResultRecord
  >["assistantUsage"][number][] = [];
  const firstOperations: PiSpendOperation[] = [];
  const continuationOperations: PiSpendOperation[] = [];
  let recoveredRequestErrors = 0;
  let availableCalls = 0;
  const unsupportedCalls: EntryId[] = [];
  const unaccountedCalls: EntryId[] = [];
  for (const call of index.calls) {
    if (!piRequest.safeParse(call.request).success) continue;
    const result = index.results.get(call.seq);
    if (result?.state !== "returned") unaccountedCalls.push(call.seq);
    try {
      const stored =
        result?.state === "returned"
          ? piResultRecord.parse(result.output)
          : undefined;
      if (stored !== undefined) storedResults.set(call.seq, stored);
      const operations = derivePiCallOperations(
        call.seq,
        stored,
        index.attemptsByParent.get(call.seq) ?? [],
        index.results,
      );
      if (operations.length === 0 && stored === undefined) {
        byCall.set(call.seq, { state: "unaccounted" });
        continue;
      }
      const spend = summarizePiSpend(operations);
      const recovered = stored === undefined ? [] : recoveredErrors(stored);
      const assistantUsage = stored?.assistantUsage ?? [];
      const first = operations.slice(0, 1);
      const continuation = operations.slice(1);
      understoodOperations.push(...operations);
      understoodUsage.push(...assistantUsage);
      firstOperations.push(...first);
      continuationOperations.push(...continuation);
      recoveredRequestErrors += recovered.length;
      availableCalls += 1;
      byCall.set(call.seq, {
        state: "available",
        ...(stored === undefined ? { complete: false as const } : {}),
        operations,
        spend: {
          ...observedSpend(spend, assistantUsage),
          recoveredRequestErrors: recovered.length,
          requests: {
            first: requestPhaseSpend(first),
            continuation: requestPhaseSpend(continuation),
          },
        },
        ...(recovered.length === 0 ? {} : { recoveredErrors: recovered }),
      });
    } catch {
      byCall.set(call.seq, { state: "unsupported" });
      unsupportedCalls.push(call.seq);
    }
  }
  return {
    byCall,
    stored: storedResults,
    spend: {
      ...observedSpend(summarizePiSpend(understoodOperations), understoodUsage),
      ...(availableCalls === 0
        ? {}
        : {
            recoveredRequestErrors,
            requests: {
              first: requestPhaseSpend(firstOperations),
              continuation: requestPhaseSpend(continuationOperations),
            },
          }),
    },
    unsupportedCalls,
    unaccountedCalls,
  };
}

function projectCall(
  index: RecordIndex,
  accounting: AccountingIndex,
  call: CallEntry,
): CoreCallSummaryV1 {
  const result = index.results.get(call.seq);
  const request = piRequest.safeParse(call.request);
  const parsed = accounting.stored.get(call.seq);
  const callAccounting = accounting.byCall.get(call.seq);
  return {
    id: call.seq,
    label: call.label,
    ...(call.role === undefined ? {} : { role: call.role }),
    ...(call.candidate === undefined ? {} : { candidateId: call.candidate }),
    startedAtMs: call.atMs,
    ...(result === undefined ? {} : { settledAtMs: result.atMs }),
    settlement: result?.state ?? "unsettled",
    ...(result?.state === "threw" ? { error: result.error } : {}),
    tools: (index.tools.get(call.seq) ?? []).map(({ seq, tool }) => ({
      id: seq,
      name: tool,
    })),
    ...(request.success && callAccounting !== undefined
      ? {
          pi: {
            requested: {
              provider: request.data.model.provider,
              model: request.data.model.id,
              api: request.data.model.api,
              ...(request.data.reasoning === undefined
                ? {}
                : { reasoning: request.data.reasoning }),
            },
            ...(parsed === undefined ? {} : { outcome: parsed.state }),
            checkpoints: (index.attemptsByParent.get(call.seq) ?? []).map(
              (attempt) => ({ id: attempt.call, state: attempt.state }),
            ),
            accounting: callAccounting,
          },
        }
      : {}),
  };
}

function projectCandidate(
  reader: Reader,
  index: RecordIndex,
  candidate: CandidateEntry,
): CoreCandidateObservationV1 {
  const material = reader.material(candidate.seq);
  const utf8 = decodedUtf8(material);
  return {
    id: candidate.seq,
    requiredVerifiers: candidate.requiredVerifiers,
    material:
      utf8 === undefined
        ? {
            bytes: material.byteLength,
            encoding: "base64",
            base64: Buffer.from(material).toString("base64"),
          }
        : { bytes: material.byteLength, encoding: "utf8", text: utf8 },
    status: candidateStatus(index, candidate.seq),
    verdicts: index.verdicts.get(candidate.seq) ?? [],
  };
}

function candidateStatus(
  index: RecordIndex,
  candidate: EntryId,
): CandidateStatus {
  const status = index.statuses.get(candidate);
  if (status === undefined)
    throw new Error(`candidate not found: ${candidate}`);
  return status;
}

function decodedUtf8(material: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(material);
  } catch {
    return undefined;
  }
}
