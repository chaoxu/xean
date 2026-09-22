import { z } from "zod";

import { createCampaign, openReader, type EntryId } from "xean";

const fixture = "Every finite tree has one fewer edge than vertices.";
const scriptedReceipt = z.strictObject({
  state: z.literal("succeeded"),
  matchesFixture: z.boolean(),
});
const evidence = z.strictObject({ verdict: z.enum(["PASS", "FAIL"]) });

export async function runScriptedVerifier(path: string): Promise<{
  readonly call: EntryId;
  readonly verdict: z.output<typeof evidence>["verdict"];
  readonly verified: boolean;
}> {
  const campaign = createCampaign(path, "scripted-verifier-example", {
    revision: 2,
  });
  let call: EntryId;
  let receipt: EntryId;
  try {
    const result = await campaign.call(
      { label: "scripted-fixture/v1", request: fixture },
      async ({ request }) => ({
        state: "succeeded",
        matchesFixture: request === fixture,
      }),
    );
    call = result.call;
    const checked = scriptedReceipt.parse(result.output);
    receipt = campaign.recordEvidence(call, {
      verdict: checked.matchesFixture ? "PASS" : "FAIL",
    });
  } finally {
    campaign.close();
  }

  const reader = openReader(path);
  try {
    const entry = reader.record(receipt);
    if (entry?.kind !== "evidence") throw new Error("missing evidence");
    const { verdict } = evidence.parse(entry.evidence);
    // This example's acceptance rule belongs to the application.
    return { call, verdict, verified: verdict === "PASS" };
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
