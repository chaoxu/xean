import { z } from "zod";

import {
  createCampaign,
  defineTool,
  openCampaign,
  returnedToolSubmission,
} from "../../src";
import type { Campaign, Entry, EntryId, Json } from "../../src";

// Reference coordinator for recovery testing. It implements the resume
// contract over the kernel: every session derives the
// next unresolved phase from the journal alone, reconciles committed work
// without new model calls, and treats calls without results as unresolved.

export const ROUNDS = 2;
export const VERIFIERS = ["audit/v1", "reconstruct/v1"] as const;
export const APPLICATION = "recovery-reference";

const exploreLabel = "explore/v1";
const exploreRequest = z.strictObject({
  protocol: z.literal("recovery/explore/v1"),
  round: z.number().int().positive(),
});
const phaseOutput = z.strictObject({
  state: z.literal("succeeded"),
  evidence: z.string().optional(),
});

const verdictSubmission = z.strictObject({
  verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  evidence: z.string(),
});
const submitVerdict = defineTool({
  name: "submit_verdict",
  description: "Submit the final verdict and its evidence",
  input: verdictSubmission,
  async run() {
    return null;
  },
});

export interface ScriptedModel {
  explore(round: number): Promise<string>;
  verify(
    verifier: string,
    material: string,
  ): Promise<z.output<typeof verdictSubmission>>;
  afterSubmit?(verifier: string): Promise<void>;
}

export function countingModel(): ScriptedModel & { calls: number } {
  return {
    calls: 0,
    async explore(round) {
      this.calls += 1;
      return `evidence for round ${round}`;
    },
    async verify(verifier, material) {
      this.calls += 1;
      return { verdict: "PASS", evidence: `${verifier} accepted: ${material}` };
    },
  };
}

export type Action =
  | { readonly kind: "explore"; readonly round: number }
  | { readonly kind: "open-verification" }
  | { readonly kind: "verify"; readonly verifier: string }
  | { readonly kind: "record-evidence"; readonly verifier: string }
  | { readonly kind: "done" };

function successfulCalls(
  records: readonly Entry[],
): ReadonlyMap<EntryId, Extract<Entry, { kind: "call" }>> {
  const calls = new Map(
    records
      .filter(
        (entry): entry is Extract<Entry, { kind: "call" }> =>
          entry.kind === "call",
      )
      .map((entry) => [entry.seq, entry]),
  );
  const successes = new Map<EntryId, Extract<Entry, { kind: "call" }>>();
  for (const entry of records) {
    if (entry.kind !== "call-result" || entry.state !== "returned") continue;
    const parsed = phaseOutput.safeParse(entry.output);
    const call = calls.get(entry.parent);
    if (parsed.success && call !== undefined) successes.set(call.seq, call);
  }
  return successes;
}

function exploredEvidence(
  records: readonly Entry[],
): ReadonlyMap<number, string> {
  const successes = successfulCalls(records);
  const evidence = new Map<number, string>();
  for (const entry of records) {
    if (entry.kind !== "call-result" || entry.state !== "returned") continue;
    const call = successes.get(entry.parent);
    if (call === undefined || call.label !== exploreLabel) continue;
    const request = exploreRequest.safeParse(call.request);
    const output = phaseOutput.safeParse(entry.output);
    if (!request.success || !output.success) continue;
    const { round } = request.data;
    if (output.data.evidence !== undefined && !evidence.has(round)) {
      evidence.set(round, output.data.evidence);
    }
  }
  return evidence;
}

function evidencedCalls(records: readonly Entry[]): ReadonlySet<EntryId> {
  return new Set(
    records.flatMap((entry) => (entry.kind === "evidence" ? [entry.call] : [])),
  );
}

export function deriveNextAction(records: readonly Entry[]): Action {
  const opening = records.find(
    (entry) => entry.kind === "call" && entry.label === "verification/v1",
  );
  if (opening === undefined) {
    const evidence = exploredEvidence(records);
    for (let round = 1; round <= ROUNDS; round += 1) {
      if (!evidence.has(round)) return { kind: "explore", round };
    }
    return { kind: "open-verification" };
  }
  const completed = new Set(
    records.flatMap((entry) => {
      if (entry.kind !== "evidence") return [];
      const call = records.find((value) => value.seq === entry.call);
      return call?.kind === "call" &&
        call.parent === opening.seq &&
        verdictSubmission.parse(entry.evidence).verdict === "PASS"
        ? [call.label]
        : [];
    }),
  );
  if (VERIFIERS.every((verifier) => completed.has(verifier)))
    return { kind: "done" };
  const successes = successfulCalls(records);
  const evidenced = evidencedCalls(records);
  for (const verifier of VERIFIERS) {
    if (completed.has(verifier)) continue;
    const unreconciled = [...successes.values()].find(
      (call) =>
        call.label === verifier &&
        call.parent === opening.seq &&
        !evidenced.has(call.seq),
    );
    if (unreconciled !== undefined) {
      return { kind: "record-evidence", verifier };
    }
    return { kind: "verify", verifier };
  }
  throw new Error("opening is unverified with no missing verifier");
}

async function performAction(
  campaign: Campaign,
  action: Action,
  model: ScriptedModel,
): Promise<void> {
  switch (action.kind) {
    case "explore": {
      await campaign.call(
        {
          label: exploreLabel,
          request: { protocol: "recovery/explore/v1", round: action.round },
        },
        async () => ({
          state: "succeeded",
          evidence: await model.explore(action.round),
        }),
      );
      return;
    }
    case "open-verification": {
      const evidence = exploredEvidence(campaign.records());
      const lines = Array.from({ length: ROUNDS }, (_, index) => {
        const value = evidence.get(index + 1);
        if (value === undefined) throw new Error("missing committed evidence");
        return value;
      });
      await campaign.call(
        { label: "verification/v1", request: lines.join("\n") },
        async () => ({ state: "succeeded" }),
      );
      return;
    }
    case "verify": {
      const opening = campaign
        .records()
        .find(
          (entry) => entry.kind === "call" && entry.label === "verification/v1",
        );
      if (opening?.kind !== "call") throw new Error("verify without opening");
      const material = z.string().parse(opening.request);
      await campaign.call(
        {
          label: action.verifier,
          parent: opening.seq,
          request: {
            protocol: "recovery/verify/v1",
            verifier: action.verifier,
          },
          tools: [submitVerdict],
        },
        async ({ tools }) => {
          const report = await model.verify(action.verifier, material);
          await tools[0]!.execute(report);
          await model.afterSubmit?.(action.verifier);
          return { state: "succeeded" };
        },
      );
      return;
    }
    case "record-evidence": {
      const records = campaign.records();
      const opening = records.find(
        (entry) => entry.kind === "call" && entry.label === "verification/v1",
      );
      if (opening === undefined) throw new Error("verdict without opening");
      const successes = successfulCalls(records);
      const evidenced = evidencedCalls(records);
      const call = [...successes.values()].find(
        (value) =>
          value.label === action.verifier &&
          value.parent === opening.seq &&
          !evidenced.has(value.seq),
      );
      if (call === undefined) throw new Error("no verifier call to reconcile");
      const submission = returnedToolSubmission(
        records,
        call.seq,
        submitVerdict.name,
      );
      const report = verdictSubmission.parse(submission.input);
      campaign.recordEvidence(call.seq, report);
      return;
    }
    case "done":
      return;
  }
}

export class InterruptError extends Error {
  constructor() {
    super("simulated coordinator interruption");
  }
}

export interface SessionReport {
  readonly actions: readonly Action[];
  readonly interrupted: boolean;
}

// Drive one coordinator session to completion or until the action budget is
// exhausted. The campaign handle is always closed before returning.
export async function runSession(
  campaign: Campaign,
  model: ScriptedModel,
  budget = Number.POSITIVE_INFINITY,
): Promise<SessionReport> {
  const actions: Action[] = [];
  try {
    for (;;) {
      const action = deriveNextAction(campaign.records());
      if (action.kind === "done") return { actions, interrupted: false };
      if (actions.length >= budget) throw new InterruptError();
      actions.push(action);
      await performAction(campaign, action, model);
    }
  } catch (error) {
    if (error instanceof InterruptError) return { actions, interrupted: true };
    throw error;
  } finally {
    campaign.close();
  }
}

export function startCampaign(path: string, config: Json = null): Campaign {
  return createCampaign(path, APPLICATION, config);
}

export function resumeCampaign(path: string): Campaign {
  return openCampaign(path);
}
