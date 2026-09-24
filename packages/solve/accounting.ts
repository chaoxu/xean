import type { Entry } from "xean";
import { derivePiSpend, summarizePiSpend, type PiSpend } from "xean/pi";
import type { CoreCallSummaryV2 } from "xean/observe";

import { codexOutcome, codexRequest } from "./source";

/** Read-only cost completeness. Native Codex usage has no recorded price. */
export function campaignAccounting(records: Iterable<Entry>, spend?: PiSpend) {
  if (spend === undefined) {
    records = [...records];
    spend = derivePiSpend(records as readonly Entry[]);
  }
  const unpricedCalls: number[] = [];
  for (const record of records)
    if (
      record.kind === "call" &&
      codexRequest.safeParse(record.request).success
    )
      unpricedCalls.push(record.seq);
  const { unmeasuredRequests, logicalProviderRequests } = spend.summary;
  const measured =
    "measuredUsage" in spend.summary ? spend.summary.measuredUsage : undefined;
  const complete =
    unmeasuredRequests === 0 &&
    spend.unaccountedCalls.length === 0 &&
    unpricedCalls.length === 0;
  return {
    complete,
    measuredCostUsd:
      measured?.estimatedCostUsd ??
      (complete && logicalProviderRequests === 0 ? 0 : null),
    unmeasuredRequests,
    unaccountedCalls: spend.unaccountedCalls,
    potentialRequests: spend.potentialRequests,
    unpricedCalls,
  };
}

/** Model children are accounted once; the role itself makes no provider request. */
export function roleAccounting(
  records: readonly Entry[],
  role: Pick<CoreCallSummaryV2, "state">,
  models: readonly CoreCallSummaryV2[],
  campaign: ReturnType<typeof campaignAccounting>,
) {
  const ids = new Set(models.map(({ call }) => call));
  const measured = models.flatMap(({ pi }) =>
    pi?.accounting.state === "available" ? [pi.accounting] : [],
  );
  const summary = summarizePiSpend(
    measured.flatMap(({ operations }) => operations),
  );
  const unaccountedCalls = campaign.unaccountedCalls.filter((call) =>
    ids.has(call),
  );
  const unpricedCalls = campaign.unpricedCalls.filter((call) => ids.has(call));
  const recoveredErrors = models.flatMap(({ call, pi }) =>
    pi?.accounting.state === "available"
      ? (pi.accounting.recoveredErrors ?? []).map((error) => ({
          call,
          ...error,
        }))
      : [],
  );
  const complete =
    role.state !== "unsettled" &&
    summary.unmeasuredRequests === 0 &&
    unaccountedCalls.length === 0 &&
    unpricedCalls.length === 0;
  return {
    complete,
    measuredCostUsd:
      ("measuredUsage" in summary
        ? summary.measuredUsage.estimatedCostUsd
        : undefined) ??
      (complete && summary.logicalProviderRequests === 0 ? 0 : null),
    unmeasuredRequests: summary.unmeasuredRequests,
    unaccountedCalls,
    potentialRequests: campaign.potentialRequests.filter(({ call }) =>
      ids.has(call),
    ),
    unpricedCalls,
    codex: unpricedCalls.map((call) => {
      const output = codexOutcome(records, call);
      return {
        call,
        ...(output?.state === "succeeded" && "usage" in output.submission
          ? {
              usage: output.submission.usage,
              searches: output.submission.searches,
            }
          : {}),
      };
    }),
    spend: {
      ...summary,
      ...(measured.length === 0
        ? {}
        : {
            recoveredRequestErrors: recoveredErrors.length,
            requests: {
              first: summarizePiSpend(
                measured.flatMap(({ operations }) => operations.slice(0, 1)),
              ),
              continuation: summarizePiSpend(
                measured.flatMap(({ operations }) => operations.slice(1)),
              ),
            },
          }),
    },
    recoveredErrors,
  };
}
