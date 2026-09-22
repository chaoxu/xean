import { openReader } from "./campaign";
import {
  derivePiAccounting,
  piRequest,
  piRequestCompletion,
  piResultRecord,
  readPiResult,
  summarizePiSpend,
  type PiRequestAttempt,
  type PiSpendOperation,
  type PiSpendSummary,
} from "./pi";
import type { Entry, EntryId, Json, Reader } from "./types";
import { z } from "zod";

type CallEntry = Extract<Entry, { kind: "call" }>;
type CallResultEntry = Extract<Entry, { kind: "call-result" }>;
type ToolCallEntry = Extract<Entry, { kind: "tool-call" }>;

export interface PiUsageBreakdownV2 {
  readonly freshInputTokens: number;
  readonly cachedInputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly nonReasoningOutputTokens: number;
}

export type PiObservationSpendV2 = PiSpendSummary & {
  readonly breakdown?: PiUsageBreakdownV2;
  /** Derived from accounted calls only. Later requests may be retries or ordinary tool continuations. */
  readonly requests?: {
    readonly first: PiRequestPhaseSpendV2;
    readonly continuation: PiRequestPhaseSpendV2;
  };
  /** Errors in provider requests whose enclosing Pi call ultimately succeeded. */
  readonly recoveredRequestErrors?: number;
};

export type PiRequestPhaseSpendV2 = PiSpendSummary & {
  /** cacheRead / (input + cacheRead + cacheWrite), omitted without measured input. */
  readonly cachedInputShare?: number;
};

export interface PiRecoveredErrorObservationV2 {
  /** One-based provider request position within the logical Pi call. */
  readonly request: number;
  readonly stopReason?: PiSpendOperation["stopReason"];
  readonly errorMessage?: string;
}

export interface CoreCampaignObservationV2 {
  readonly schema: "xean.core-observation/v2";
  readonly application: string;
  readonly applicationConfig: Json;
  readonly createdAtMs: number;
  readonly lastSeq: number;
  readonly lastAtMs: number;
  readonly calls: readonly CoreCallObservationV2[];
  readonly spend: PiObservationSpendV2 & {
    readonly unsupportedCalls: readonly EntryId[];
    readonly unaccountedCalls: readonly EntryId[];
  };
}

export interface CoreCampaignSummaryV2 {
  readonly schema: "xean.core-observation-summary/v2";
  readonly application: string;
  readonly createdAtMs: number;
  readonly lastSeq: number;
  readonly lastAtMs: number;
  readonly callCount: number;
  readonly callsWithoutResult?: {
    readonly count: number;
    readonly oldestStartedAtMs: number;
  };
  readonly spend: PiObservationSpendV2 & {
    readonly unsupportedCalls: number;
    readonly unaccountedCalls: number;
  };
}

export interface CoreCallObservationV2 {
  readonly call: EntryId;
  readonly label: string;
  readonly role?: string;
  readonly parent?: EntryId;
  readonly startedAtMs: number;
  readonly settledAtMs?: number;
  readonly state: "returned" | "threw" | "unsettled";
  readonly error?: string;
  /** Application-owned evidence, displayed without a kernel verification policy. */
  readonly evidence?: Json;
  readonly tools: readonly { readonly call: EntryId; readonly name: string }[];
  readonly pi?: {
    readonly requested: {
      readonly provider: string;
      readonly model: string;
      readonly api: string;
      readonly reasoning?: string;
    };
    readonly outcome?: "succeeded" | "failed" | "cancelled";
    readonly error?: string;
    readonly responseText?: string;
    readonly checkpoints: readonly {
      readonly call: EntryId;
      readonly state: "completed" | "unsettled";
    }[];
    readonly accounting: PiAccountingObservationV2;
  };
}

export type CoreCallSummaryV2 = Omit<
  CoreCallObservationV2,
  "pi" | "evidence"
> & {
  readonly pi?: Omit<NonNullable<CoreCallObservationV2["pi"]>, "responseText">;
};

export type PiAccountingObservationV2 =
  | {
      readonly state: "available";
      /** False when durable request measurements precede the enclosing call's settlement. */
      readonly complete?: false;
      readonly operations: readonly PiSpendOperation[];
      readonly spend: PiObservationSpendV2;
      readonly recoveredErrors?: readonly PiRecoveredErrorObservationV2[];
    }
  | { readonly state: "unaccounted" }
  | { readonly state: "unsupported" };

interface RecordIndex {
  readonly declaration: Extract<Entry, { kind: "campaign" }>;
  readonly last: Entry;
  readonly calls: readonly CallEntry[];
  readonly results: ReadonlyMap<EntryId, CallResultEntry>;
  readonly tools: ReadonlyMap<EntryId, readonly ToolCallEntry[]>;
  readonly accounting: ReturnType<typeof derivePiAccounting>;
}

interface AccountingIndex {
  readonly byCall: ReadonlyMap<EntryId, PiAccountingObservationV2>;
  readonly stored: ReadonlyMap<EntryId, z.output<typeof piResultRecord>>;
  readonly spend: PiObservationSpendV2;
  readonly unsupportedCalls: readonly EntryId[];
  readonly unaccountedCalls: readonly EntryId[];
}

function observedSpend(spend: PiSpendSummary): PiObservationSpendV2 {
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
  return {
    ...spend,
    breakdown: {
      freshInputTokens: usage.input + usage.cacheWrite,
      cachedInputTokens: usage.cacheRead,
      reasoningOutputTokens: reasoning,
      nonReasoningOutputTokens: usage.output - reasoning,
    },
  };
}

function requestPhaseSpend(
  operations: readonly PiSpendOperation[],
): PiRequestPhaseSpendV2 {
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
  attempts: readonly PiRequestAttempt[],
  results: ReadonlyMap<EntryId, CallResultEntry>,
): readonly PiRecoveredErrorObservationV2[] {
  return attempts.flatMap((attempt, index) => {
    const completion = results.get(attempt.call);
    if (completion?.state !== "returned") return [];
    const { operation, errorMessage } = piRequestCompletion.parse(
      completion.output,
    );
    if (!operation.error) return [];
    return [
      {
        request: index + 1,
        ...(operation.stopReason === undefined
          ? {}
          : { stopReason: operation.stopReason }),
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
    ];
  });
}

export function inspectCoreCampaign(path: string): CoreCampaignObservationV2 {
  const reader = openReader(path);
  try {
    return inspectCoreCampaignRecords(reader, reader.records());
  } finally {
    reader.close();
  }
}

export function inspectCoreCampaignSummary(
  path: string,
): CoreCampaignSummaryV2 {
  const reader = openReader(path);
  try {
    return inspectCoreCampaignSummaryRecords(reader.records());
  } finally {
    reader.close();
  }
}

/** Project captured entries, resolving their immutable payloads through reader. */
export function inspectCoreCampaignRecords(
  reader: Reader,
  records: readonly Entry[],
): CoreCampaignObservationV2 {
  const index = indexRecords(records);
  const accounting = indexAccounting(index);
  const evidence = new Map(
    records.flatMap((entry) =>
      entry.kind === "evidence" ? [[entry.call, entry.evidence] as const] : [],
    ),
  );
  return {
    schema: "xean.core-observation/v2",
    application: index.declaration.application,
    applicationConfig: index.declaration.config,
    createdAtMs: index.declaration.atMs,
    lastSeq: index.last.seq,
    lastAtMs: index.last.atMs,
    calls: index.calls.map((call) => {
      const value = {
        ...projectCall(index, accounting, call),
        ...(evidence.has(call.seq)
          ? { evidence: evidence.get(call.seq)! }
          : {}),
      };
      const stored = accounting.stored.get(call.seq);
      const full =
        stored === undefined ? undefined : readPiResult(stored, reader);
      return full?.text && value.pi
        ? { ...value, pi: { ...value.pi, responseText: full.text } }
        : value;
    }),
    spend: {
      ...accounting.spend,
      unsupportedCalls: accounting.unsupportedCalls,
      unaccountedCalls: accounting.unaccountedCalls,
    },
  };
}

/** Project call metadata and accounting without reading result payloads. */
export function inspectCoreCallSummaries(
  records: readonly Entry[],
): readonly CoreCallSummaryV2[] {
  const index = indexRecords(records);
  const accounting = indexAccounting(index);
  return index.calls.map((call) => projectCall(index, accounting, call));
}

/** Summarize a caller's captured journal boundary without loading payloads. */
export function inspectCoreCampaignSummaryRecords(
  records: readonly Entry[],
): CoreCampaignSummaryV2 {
  const index = indexRecords(records);
  const accounting = indexAccounting(index);
  const unsettled = index.calls.filter(
    (call) => index.results.get(call.seq) === undefined,
  );
  return {
    schema: "xean.core-observation-summary/v2",
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
  for (const entry of records) {
    if (entry.kind === "call") callsById.set(entry.seq, entry);
    else if (entry.kind === "call-result") results.set(entry.parent, entry);
    else if (entry.kind === "tool-call") {
      const values = tools.get(entry.call) ?? [];
      values.push(entry);
      tools.set(entry.call, values);
    }
  }
  const accounting = derivePiAccounting(records);
  const attemptIds = new Set(accounting.attempts.map(({ call }) => call));
  return {
    declaration,
    last: records.at(-1) ?? declaration,
    calls: [...callsById.values()].filter(({ seq }) => !attemptIds.has(seq)),
    results,
    tools,
    accounting,
  };
}

function indexAccounting(index: RecordIndex): AccountingIndex {
  const byCall = new Map<EntryId, PiAccountingObservationV2>();
  const storedResults = new Map<EntryId, z.output<typeof piResultRecord>>();
  const understoodOperations: PiSpendOperation[] = [];
  const firstOperations: PiSpendOperation[] = [];
  const continuationOperations: PiSpendOperation[] = [];
  let recoveredRequestErrors = 0;
  let availableCalls = 0;
  const unsupportedCalls: EntryId[] = [];
  const unaccountedCalls: EntryId[] = [];
  for (const value of index.accounting.calls) {
    const call = value.call.seq;
    if (!value.settled) unaccountedCalls.push(call);
    if (value.state !== "available") {
      byCall.set(call, { state: value.state });
      if (value.state === "unsupported") unsupportedCalls.push(call);
      continue;
    }
    const { stored, operations, spend, attempts } = value;
    if (stored !== undefined) storedResults.set(call, stored);
    const recovered =
      stored?.state === "succeeded"
        ? recoveredErrors(attempts, index.results)
        : [];
    const first = operations.slice(0, 1);
    const continuation = operations.slice(1);
    understoodOperations.push(...operations);
    firstOperations.push(...first);
    continuationOperations.push(...continuation);
    recoveredRequestErrors += recovered.length;
    availableCalls += 1;
    byCall.set(call, {
      state: "available",
      ...(stored === undefined ? { complete: false as const } : {}),
      operations,
      spend: {
        ...observedSpend(spend),
        recoveredRequestErrors: recovered.length,
        requests: {
          first: requestPhaseSpend(first),
          continuation: requestPhaseSpend(continuation),
        },
      },
      ...(recovered.length === 0 ? {} : { recoveredErrors: recovered }),
    });
  }
  return {
    byCall,
    stored: storedResults,
    spend: {
      ...observedSpend(summarizePiSpend(understoodOperations)),
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
): CoreCallSummaryV2 {
  const result = index.results.get(call.seq);
  const request = piRequest.safeParse(call.request);
  const parsed = accounting.stored.get(call.seq);
  const callAccounting = accounting.byCall.get(call.seq);
  return {
    call: call.seq,
    label: call.label,
    ...(call.role === undefined ? {} : { role: call.role }),
    ...(call.parent === undefined ? {} : { parent: call.parent }),
    startedAtMs: call.atMs,
    ...(result === undefined ? {} : { settledAtMs: result.atMs }),
    state: result?.state ?? "unsettled",
    ...(result?.state === "threw" ? { error: result.error } : {}),
    tools: (index.tools.get(call.seq) ?? []).map(({ seq, tool }) => ({
      call: seq,
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
            ...(parsed !== undefined && parsed.state !== "succeeded"
              ? { error: parsed.error }
              : {}),
            checkpoints: (
              index.accounting.byCall.get(call.seq)?.attempts ?? []
            ).map((attempt) => ({ call: attempt.call, state: attempt.state })),
            accounting: callAccounting,
          },
        }
      : {}),
  };
}
