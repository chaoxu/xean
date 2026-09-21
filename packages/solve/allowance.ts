import type { Campaign, Entry } from "xean";
import { z } from "zod";

import { nonblank } from "./roles";

export const allowanceLabel = "xean-solve/allowance";
export const positiveTurns = z.number().int().positive();
const allowanceRequest = z.strictObject({
  schemaVersion: z.literal(1),
  id: nonblank,
  turns: positiveTurns,
  afterTurns: z.number().int().nonnegative(),
});

/** The request is the durable receipt, even without its local call-result. */
export function turnAllowances(records: readonly Entry[]) {
  let maxTurns = 0;
  const ids = new Set<string>();
  return records.flatMap((entry) => {
    if (entry.kind !== "call" || entry.label !== allowanceLabel) return [];
    const request = allowanceRequest.parse(entry.request);
    if (ids.has(request.id) || request.afterTurns !== maxTurns)
      throw new Error("invalid turn allowance sequence");
    maxTurns = positiveTurns.parse(maxTurns + request.turns);
    ids.add(request.id);
    return [{ call: entry.seq, atMs: entry.atMs, ...request, maxTurns }];
  });
}

/** Callers hold the runner lock and check that the current allowance is spent. */
export async function appendAllowance(
  campaign: Campaign,
  turns: number,
  afterTurns: number,
  id: string,
) {
  const request = allowanceRequest.parse({
    schemaVersion: 1,
    id,
    turns,
    afterTurns,
  });
  positiveTurns.parse(afterTurns + turns);
  // Validate before writing so a rejected grant never leaves an unreadable journal.
  const granted = turnAllowances(
    campaign.records({ kinds: ["call"], labels: [allowanceLabel] }),
  );
  if (
    granted.some((entry) => entry.id === request.id) ||
    (granted.at(-1)?.maxTurns ?? 0) !== afterTurns
  )
    throw new Error("invalid turn allowance sequence");
  await campaign.call({ label: allowanceLabel, request }, async () => null);
  return turnAllowances(
    campaign.records({ kinds: ["call"], labels: [allowanceLabel] }),
  ).at(-1)!;
}

export async function initializeAllowance(campaign: Campaign, turns?: number) {
  const initial = turnAllowances(
    campaign.records({ kinds: ["call"], labels: [allowanceLabel] }),
  )[0];
  if (initial === undefined)
    return appendAllowance(campaign, turns ?? 20, 0, "initial");
  if (turns !== undefined && initial.turns !== turns)
    throw new Error(
      "--turns disagrees with the initial allowance; use run --turns N --id ID to add turns",
    );
  return initial;
}
