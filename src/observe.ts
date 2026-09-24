import { openReader } from "./campaign";
import {
  derivePiAccounting,
  piRequestAttempts,
  readPiResponseText,
  summarizePiSpend,
  type PiRequestAttempt,
  type PiSpendOperation,
  type PiSpendSummary,
} from "./pi";
import type { Entry, EntryId, Json, Reader } from "./types";

type CallEntry = Extract<Entry, { kind: "call" }>;
type ToolCallIdentity = Pick<
  Extract<Entry, { kind: "tool-call" }>,
  "seq" | "tool"
>;

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

type RecordIndex = ReturnType<typeof indexRecords>;
type CallSpend =
  | {
      readonly state: "available";
      readonly operations: readonly PiSpendOperation[];
      readonly stored?:
        { readonly state: "succeeded" | "failed" | "cancelled" } | undefined;
    }
  | { readonly state: "unsupported" | "unaccounted" };

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
  completions: ReturnType<typeof derivePiAccounting>["completions"],
): readonly PiRecoveredErrorObservationV2[] {
  return attempts.flatMap((attempt, index) => {
    const completion = completions.get(attempt.call);
    if (completion === undefined || !completion.operation.error) return [];
    const { operation, errorMessage } = completion;
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
    const captured = captureCoreCampaign(reader, true);
    const calls: CoreCallObservationV2[] = [];
    for (const { call, index } of captured.calls()) {
      const evidence = reader.records({
        kinds: ["evidence"],
        call: call.seq,
        through: captured.lastSeq,
      })[0];
      const value = {
        ...projectCall(index, call),
        ...(evidence?.kind === "evidence"
          ? { evidence: evidence.evidence }
          : {}),
      };
      const accounting = index.accounting.byCall.get(call.seq);
      const stored =
        accounting?.state === "available" ? accounting.stored : undefined;
      const responseText =
        stored === undefined ? undefined : readPiResponseText(stored, reader);
      calls.push(
        responseText && value.pi
          ? { ...value, pi: { ...value.pi, responseText } }
          : value,
      );
    }
    return {
      schema: "xean.core-observation/v2",
      application: captured.declaration.application,
      applicationConfig: captured.declaration.config,
      createdAtMs: captured.declaration.atMs,
      lastSeq: captured.lastSeq,
      lastAtMs: captured.lastAtMs,
      calls,
      spend: {
        ...observedCallsSpend(captured.spend),
        unsupportedCalls: captured.unsupportedCalls,
        unaccountedCalls: captured.unaccountedCalls,
      },
    };
  } finally {
    reader.close();
  }
}

export function inspectCoreCampaignSummary(
  path: string,
): CoreCampaignSummaryV2 {
  const reader = openReader(path);
  try {
    const captured = captureCoreCampaign(reader, false);
    let callCount = 0,
      unsettledCount = 0,
      oldestStartedAtMs = Infinity;
    for (const { call, index } of captured.calls()) {
      callCount += 1;
      if (index.results.get(call.seq) === undefined) {
        unsettledCount += 1;
        oldestStartedAtMs = Math.min(oldestStartedAtMs, call.atMs);
      }
    }
    return {
      schema: "xean.core-observation-summary/v2",
      application: captured.declaration.application,
      createdAtMs: captured.declaration.atMs,
      lastSeq: captured.lastSeq,
      lastAtMs: captured.lastAtMs,
      callCount,
      ...(unsettledCount === 0
        ? {}
        : { callsWithoutResult: { count: unsettledCount, oldestStartedAtMs } }),
      spend: {
        ...observedCallsSpend(captured.spend),
        unsupportedCalls: captured.unsupportedCalls.length,
        unaccountedCalls: captured.unaccountedCalls.length,
      },
    };
  } finally {
    reader.close();
  }
}

/** Keep checkpoint identities and accounting, releasing each call's request after projection. */
function captureCoreCampaign(reader: Reader, includeTools: boolean) {
  const through = reader.lastSequence();
  const declaration = reader.record(1);
  if (declaration?.kind !== "campaign")
    throw new Error("campaign declaration is unavailable");
  const checkpoints = new Map<EntryId, EntryId[]>();
  const checkpointIds = new Set<EntryId>();
  let lastSeq = declaration.seq,
    lastAtMs = declaration.atMs;
  for (const entry of reader.scan({ through })) {
    lastSeq = entry.seq;
    lastAtMs = entry.atMs;
    if (entry.kind !== "call" || entry.label !== "xean/pi-request") continue;
    const parent = (entry.request as { parent?: unknown } | null)?.parent;
    const owner =
      typeof parent === "number" &&
      Number.isInteger(parent) &&
      parent > 0 &&
      parent <= through
        ? reader.record(parent)
        : undefined;
    const attempt = piRequestAttempts([
      ...(owner === undefined ? [] : [owner]),
      entry,
      ...reader.records({ kinds: ["call-result"], parent: entry.seq, through }),
    ])[0];
    if (attempt === undefined) continue;
    checkpointIds.add(entry.seq);
    const children = checkpoints.get(attempt.parent) ?? [];
    children.push(entry.seq);
    checkpoints.set(attempt.parent, children);
  }
  const spend: CallSpend[] = [];
  const unsupportedCalls: EntryId[] = [];
  const unaccountedCalls: EntryId[] = [];
  return {
    declaration,
    lastSeq,
    lastAtMs,
    spend,
    unsupportedCalls,
    unaccountedCalls,
    *calls() {
      for (const call of reader.scan({ kinds: ["call"], through })) {
        if (call.kind !== "call" || checkpointIds.has(call.seq)) continue;
        const frame = [
          declaration,
          call,
          ...reader.records({
            kinds: ["call-result"],
            parent: call.seq,
            through,
          }),
          ...(checkpoints.get(call.seq) ?? []).flatMap((seq) => [
            reader.record(seq)!,
            ...reader.records({ kinds: ["call-result"], parent: seq, through }),
          ]),
        ].sort((a, b) => a.seq - b.seq);
        const index = indexRecords(frame);
        if (includeTools) {
          const tools: ToolCallIdentity[] = [];
          for (const entry of reader.scan({
            kinds: ["tool-call"],
            call: call.seq,
            through,
          })) {
            if (entry.kind === "tool-call")
              tools.push({ seq: entry.seq, tool: entry.tool });
          }
          index.tools.set(call.seq, tools);
        }
        const value = index.accounting.byCall.get(call.seq);
        if (value !== undefined) {
          if (value.state === "unsupported") unsupportedCalls.push(call.seq);
          if (!value.settled) unaccountedCalls.push(call.seq);
          if (value.state === "available")
            spend.push({
              state: "available",
              operations: value.operations,
              ...(value.stored === undefined
                ? {}
                : { stored: { state: value.stored.state } }),
            });
        }
        yield { call, index };
      }
    },
  };
}

/** Project captured entries, resolving their immutable payloads through reader. */
export function inspectCoreCampaignRecords(
  reader: Reader,
  records: readonly Entry[],
): CoreCampaignObservationV2 {
  const index = indexRecords(records);
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
        ...projectCall(index, call),
        ...(evidence.has(call.seq)
          ? { evidence: evidence.get(call.seq)! }
          : {}),
      };
      const accounting = index.accounting.byCall.get(call.seq);
      const stored =
        accounting?.state === "available" ? accounting.stored : undefined;
      const responseText =
        stored === undefined ? undefined : readPiResponseText(stored, reader);
      return responseText && value.pi
        ? { ...value, pi: { ...value.pi, responseText } }
        : value;
    }),
    spend: {
      ...observedCallsSpend(index.accounting.calls),
      unsupportedCalls: index.unsupportedCalls,
      unaccountedCalls: index.unaccountedCalls,
    },
  };
}

/** Project call metadata and accounting without reading result payloads. */
export function inspectCoreCallSummaries(
  records: readonly Entry[],
  accounting?: ReturnType<typeof derivePiAccounting>,
): readonly CoreCallSummaryV2[] {
  const index = indexRecords(records, accounting);
  return index.calls.map((call) => projectCall(index, call));
}

/** Summarize a caller's captured journal boundary without loading payloads. */
export function inspectCoreCampaignSummaryRecords(
  records: readonly Entry[],
): CoreCampaignSummaryV2 {
  const index = indexRecords(records);
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
            oldestStartedAtMs: unsettled.reduce(
              (oldest, { atMs }) => Math.min(oldest, atMs),
              Infinity,
            ),
          },
        }),
    spend: {
      ...observedCallsSpend(index.accounting.calls),
      unsupportedCalls: index.unsupportedCalls.length,
      unaccountedCalls: index.unaccountedCalls.length,
    },
  };
}

function indexRecords(
  records: readonly Entry[],
  capturedAccounting?: ReturnType<typeof derivePiAccounting>,
) {
  const declaration = records[0];
  if (declaration?.kind !== "campaign") {
    throw new Error("campaign declaration is unavailable");
  }
  const callsById = new Map<EntryId, CallEntry>();
  const tools = new Map<EntryId, ToolCallIdentity[]>();
  for (const entry of records) {
    if (entry.kind === "call") callsById.set(entry.seq, entry);
    else if (entry.kind === "tool-call") {
      const values = tools.get(entry.call) ?? [];
      values.push(entry);
      tools.set(entry.call, values);
    }
  }
  const accounting = capturedAccounting ?? derivePiAccounting(records);
  const attemptIds = new Set(accounting.attempts.map(({ call }) => call));
  return {
    declaration,
    last: records.at(-1) ?? declaration,
    calls: [...callsById.values()].filter(({ seq }) => !attemptIds.has(seq)),
    results: accounting.results,
    tools,
    accounting,
    unsupportedCalls: accounting.calls
      .filter(({ state }) => state === "unsupported")
      .map(({ call }) => call.seq),
    unaccountedCalls: accounting.calls
      .filter(({ settled }) => !settled)
      .map(({ call }) => call.seq),
  };
}

function observedCallsSpend(calls: readonly CallSpend[]): PiObservationSpendV2 {
  const available = calls.filter((value) => value.state === "available");
  return {
    ...observedSpend(
      summarizePiSpend(available.flatMap(({ operations }) => operations)),
    ),
    ...(available.length === 0
      ? {}
      : {
          recoveredRequestErrors: available.reduce(
            (count, { stored, operations }) =>
              count +
              (stored?.state === "succeeded"
                ? operations.filter(({ error }) => error).length
                : 0),
            0,
          ),
          requests: {
            first: requestPhaseSpend(
              available.flatMap(({ operations }) => operations.slice(0, 1)),
            ),
            continuation: requestPhaseSpend(
              available.flatMap(({ operations }) => operations.slice(1)),
            ),
          },
        }),
  };
}

function projectCall(index: RecordIndex, call: CallEntry): CoreCallSummaryV2 {
  const result = index.results.get(call.seq);
  const value = index.accounting.byCall.get(call.seq);
  const parsed = value?.state === "available" ? value.stored : undefined;
  const recovered =
    parsed?.state === "succeeded"
      ? recoveredErrors(value!.attempts, index.accounting.completions)
      : [];
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
    ...(value !== undefined
      ? {
          pi: {
            requested: {
              provider: value.request.model.provider,
              model: value.request.model.id,
              api: value.request.model.api,
              ...(value.request.reasoning === undefined
                ? {}
                : { reasoning: value.request.reasoning }),
            },
            ...(parsed === undefined ? {} : { outcome: parsed.state }),
            ...(parsed !== undefined && parsed.state !== "succeeded"
              ? { error: parsed.error }
              : {}),
            checkpoints: value.attempts.map((attempt) => ({
              call: attempt.call,
              state: attempt.state,
            })),
            accounting:
              value.state === "available"
                ? {
                    state: "available",
                    ...(parsed === undefined
                      ? { complete: false as const }
                      : {}),
                    operations: value.operations,
                    spend: observedCallsSpend([value]),
                    ...(recovered.length === 0
                      ? {}
                      : { recoveredErrors: recovered }),
                  }
                : { state: value.state },
          },
        }
      : {}),
  };
}
