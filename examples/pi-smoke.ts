import { createCampaign, defineTool, returnedToolSubmission } from "xean";
import { builtinPi, runPi } from "xean/pi";
import { z } from "zod";

const verdictSubmission = z.strictObject({
  verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  evidence: z.json(),
});
const submitVerdict = defineTool({
  name: "submit_verdict",
  description: "Submit the final verdict and its evidence",
  input: verdictSubmission,
  async run() {
    return null;
  },
});

const [path, provider, modelId] = process.argv.slice(2);
if (path === undefined || provider === undefined || modelId === undefined) {
  throw new Error(
    "usage: bun examples/pi-smoke.ts CAMPAIGN.db PROVIDER MODEL_ID",
  );
}

const models = builtinPi();
const model = models.getModel(provider, modelId);
if (model === undefined)
  throw new Error(`unknown Pi model: ${provider}/${modelId}`);

const verifier = "hostile-audit/v1";
const claim = "Every finite tree has one fewer edge than vertices.";
const campaign = createCampaign(path, "pi-hostile-audit", { revision: 1 });
try {
  const audit = await runPi(campaign, {
    models,
    model,
    label: verifier,
    system:
      "Audit the supplied claim adversarially. Call submit_verdict exactly once with the reason in evidence, then stop.",
    prompt: claim,
    tools: [submitVerdict],
  });
  if (audit.state !== "succeeded") throw new Error(audit.error);
  const submitted = returnedToolSubmission(
    campaign.records(),
    audit.call,
    submitVerdict.name,
  );
  const report = verdictSubmission.parse(submitted.input);
  campaign.recordEvidence(audit.call, report);
  console.log(JSON.stringify({ call: audit.call, ...report }, null, 2));
} finally {
  campaign.close();
}
