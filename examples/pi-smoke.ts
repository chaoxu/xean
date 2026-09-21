import {
  createCampaign,
  defineTool,
  deriveCandidateStatus,
  returnedToolSubmission,
  verdictSchema,
} from "xean";
import { builtinPi, runPi } from "xean/pi";
import { z } from "zod";

const verdictSubmission = z.strictObject({
  verdict: verdictSchema,
  evidence: z.json(),
});
const submitVerdict = defineTool({
  name: "submit_verdict",
  description: "Submit the final verdict and its evidence",
  input: verdictSubmission,
  replay: "safe",
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
const material = new TextEncoder().encode(
  "Every finite tree has one fewer edge than vertices.",
);
const campaign = createCampaign(path, "pi-hostile-audit", { revision: 1 });
try {
  const candidate = campaign.submitCandidate(material, [verifier]);
  const stored = new TextDecoder().decode(campaign.material(candidate));
  const audit = await runPi(campaign, {
    models,
    model,
    label: verifier,
    system:
      "Audit the supplied claim adversarially. Call submit_verdict exactly once with the reason in evidence, then stop.",
    prompt: stored,
    candidate,
    tools: [submitVerdict],
  });
  if (audit.state !== "succeeded") throw new Error(audit.error);
  const submitted = returnedToolSubmission(
    campaign.records(),
    audit.call,
    submitVerdict.name,
  );
  const report = verdictSubmission.parse(submitted.input);
  campaign.recordVerdict(audit.call, report.verdict, report.evidence);
  console.log(
    JSON.stringify(
      { candidate, ...deriveCandidateStatus(campaign.records(), candidate) },
      null,
      2,
    ),
  );
} finally {
  campaign.close();
}
