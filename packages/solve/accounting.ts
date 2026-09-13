import type { Entry } from "xean";
import { derivePiSpend, type PiSpend } from "xean/pi";

import { codexRequest } from "./source";

/** Read-only cost completeness. Native Codex usage has no recorded price. */
export function campaignAccounting(
  records: readonly Entry[],
  spend: PiSpend = derivePiSpend(records),
) {
  const unpricedCalls = records.flatMap((record) =>
    record.kind === "call" && codexRequest.safeParse(record.request).success
      ? [record.seq]
      : [],
  );
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
