import type { Entry, EntryId, Json } from "xean";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { recordSource, type RecordSource } from "./history";

import {
  coordinatorResult,
  correctnessVerdicts,
  explorerResult,
  jsonSnapshot,
  literatureReport,
  proof,
  reconstructionCalls,
  reconstructionResult,
  returnedOutput,
  roleRequest,
  roleOutput,
  roleFromLabel,
  savedExplorerSubmission,
  sourceVerdict,
  statement,
  verdicts,
  verifierFromLabel,
  type LiteratureReport,
} from "./roles";

export type CallEntry = Extract<Entry, { readonly kind: "call" }>;

export const callsConfig = z.strictObject({
  kind: z.literal("calls"),
  schemaVersion: z.literal(1),
});

export function assertRoleInput(call: CallEntry, input: unknown): void {
  if (
    !isDeepStrictEqual(
      roleRequest.parse(call.request).input,
      jsonSnapshot(input),
    )
  )
    throw new Error("frozen role input does not match its dispatch");
}

/** Calls belong to a durable dispatch; provider requests are provenance. */
export function* callsAfter(
  records: readonly Entry[] | RecordSource,
  after: EntryId,
  label: string,
  parent?: EntryId,
  role = roleFromLabel(label),
): Generator<CallEntry> {
  for (const call of recordSource(records).scan({
    kinds: ["call"],
    labels: [label],
    after,
  })) {
    if (call.kind !== "call" || call.seq <= after || call.label !== label)
      continue;
    if (call.parent !== parent || call.role !== role)
      throw new Error("call does not belong to its dispatch");
    yield call;
  }
}

/** Logical results are the role contract, independent of its model transport. */
export function readRoleResult(
  records: readonly Entry[],
  call: EntryId,
): { readonly settled: EntryId; readonly value: Json } | undefined {
  const owner = records.find((entry) => entry.seq === call);
  if (owner?.kind !== "call") return undefined;
  roleRequest.parse(owner.request);
  const returned = returnedOutput(records, call);
  if (returned === undefined) return undefined;
  return {
    settled: returned.settled,
    value: roleOutput.parse(returned.output).value,
  };
}

/** Explorer's audited submissions survive failure; completed roles use their return value. */
export function readRoleSubmission<S extends z.ZodType>(
  records: readonly Entry[],
  call: EntryId,
  contract: { readonly schema: S },
  partialExplorer = false,
):
  | {
      readonly settled: EntryId;
      readonly value: z.output<S>;
      readonly emptySubmission?: boolean;
      readonly completed?: EntryId;
    }
  | undefined {
  const completed = readRoleResult(records, call);
  const saved = partialExplorer
    ? savedExplorerSubmission(records, call)
    : undefined;
  const value = completed === undefined ? saved?.input : completed.value;
  return value === undefined
    ? undefined
    : {
        settled: saved?.settled ?? completed!.settled,
        value: contract.schema.parse(value),
        ...(saved === undefined
          ? {}
          : { emptySubmission: saved.emptySubmission }),
        ...(completed === undefined ? {} : { completed: completed.settled }),
      };
}

/** Null records a completed attempt without a usable literature report. */
export function literatureOutcome(
  records: readonly Entry[],
  call: EntryId,
):
  | { readonly settled: EntryId; readonly report: LiteratureReport | undefined }
  | undefined {
  const result = readRoleResult(records, call);
  return result === undefined
    ? undefined
    : {
        settled: result.settled,
        report:
          result.value === null
            ? undefined
            : literatureReport.parse(result.value),
      };
}

/** Inspection decodes the same canonical values consumed by replay. */
export function roleSubmission(
  records: readonly Entry[],
  call: CallEntry,
): Json | undefined {
  const role = roleFromLabel(call.label);
  if (role === undefined) return undefined;
  if (call.role !== role)
    throw new Error(`call ${call.seq} role disagrees with its label`);
  if (role === "literature")
    return literatureOutcome(records, call.seq)?.report;
  const verifier = verifierFromLabel(call.label);
  const reconstruction = Object.entries(reconstructionCalls).find(
    ([, value]) => value.label === call.label,
  )?.[0];
  const schema =
    reconstruction === "statement"
      ? statement
      : reconstruction === "proof"
        ? proof
        : role === "explorer"
          ? explorerResult
          : role === "coordinator"
            ? coordinatorResult
            : verifier === "correctness"
              ? correctnessVerdicts
              : verifier === "source"
                ? z.strictObject({ verdicts: z.array(sourceVerdict) })
                : verifier === "reconstruction"
                  ? reconstructionResult
                  : verdicts;
  const value = readRoleSubmission(
    records,
    call.seq,
    { schema },
    role === "explorer",
  )?.value;
  return value === undefined
    ? undefined
    : jsonSnapshot({
        ...(verifier === undefined || reconstruction !== undefined
          ? {}
          : { verifier }),
        ...value,
      });
}
