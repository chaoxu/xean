import { z } from "zod";

import {
  createCampaign,
  deriveCandidateStatus,
  openReader,
  type EntryId,
  type Verdict,
} from "xean";

const verifier = "scripted-fixture/v1";
const fixture = "Every finite tree has one fewer edge than vertices.";
const scriptedReceipt = z.strictObject({
  state: z.literal("succeeded"),
  matchesFixture: z.boolean(),
});

export interface ScriptedReport {
  readonly candidate: EntryId;
  readonly verdict: Verdict;
  readonly verified: boolean;
}

export async function runScriptedVerifier(
  path: string,
): Promise<ScriptedReport> {
  const campaign = createCampaign(path, "scripted-verifier-example", {
    revision: 1,
  });
  let verdict: Verdict;
  let candidate: EntryId;
  try {
    const material = new TextEncoder().encode(fixture);
    candidate = campaign.submitCandidate(material, [verifier]);
    const call = await campaign.call(
      {
        label: verifier,
        candidate,
        request: {
          expected: fixture,
        },
      },
      async () => ({
        state: "succeeded",
        matchesFixture:
          new TextDecoder().decode(campaign.material(candidate)) === fixture,
      }),
    );
    const receipt = scriptedReceipt.parse(call.output);
    verdict = receipt.matchesFixture ? "PASS" : "FAIL";
    campaign.recordVerdict(call.call, verdict, {
      matchesFixture: receipt.matchesFixture,
    });
  } finally {
    campaign.close();
  }

  const reader = openReader(path);
  try {
    return {
      candidate,
      verdict,
      verified: deriveCandidateStatus(reader.records(), candidate).verified,
    };
  } finally {
    reader.close();
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined)
    throw new Error("usage: bun examples/scripted-verifier.ts CAMPAIGN.db");
  console.log(JSON.stringify(await runScriptedVerifier(path), null, 2));
}
