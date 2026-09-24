import { openCampaign } from "xean";

import { deriveWorkflow } from "../../workflow";

const path = process.argv[2];
const mode = process.argv[3];
if (path === undefined || !["submit", "freeze"].includes(mode ?? ""))
  throw new Error("expected campaign and crash mode");
const campaign = openCampaign(path);

/** The journal boundary before the pending Explorer call. */
function explorerBoundary(): number {
  const after = deriveWorkflow(campaign).after;
  if (after === undefined)
    throw new Error("the campaign is not at an Explorer boundary");
  return after;
}

await campaign.call(
  {
    label:
      mode === "submit" ? "xean-solve/guidance" : "xean-solve/inbox-boundary",
    request:
      mode === "submit"
        ? {
            schemaVersion: 1,
            id: "crash-1",
            text: "Use the direct construction.",
          }
        : {
            schemaVersion: 2,
            channel: "guidance",
            after: explorerBoundary(),
            through: campaign.records().at(-1)!.seq,
          },
  },
  async () => {
    process.exit(73);
  },
);
