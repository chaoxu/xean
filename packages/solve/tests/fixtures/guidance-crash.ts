import { openCampaign } from "xean";

import { workflowRecords } from "../../roles";
import { deriveWorkflow } from "../../workflow";

const path = process.argv[2];
const mode = process.argv[3];
if (path === undefined || !["submit", "freeze"].includes(mode ?? ""))
  throw new Error("expected campaign and crash mode");
const campaign = openCampaign(path);

/** The journal boundary before the pending Explorer call. */
async function explorerBoundary(): Promise<number> {
  const after = (await deriveWorkflow(workflowRecords(campaign))).explorerAfter;
  if (after === undefined)
    throw new Error("the campaign is not at an Explorer boundary");
  return after;
}

await campaign.call(
  {
    label:
      mode === "submit"
        ? "xean-solve/guidance"
        : "xean-solve/explorer-guidance",
    request:
      mode === "submit"
        ? {
            schemaVersion: 1,
            id: "crash-1",
            text: "Use the direct construction.",
          }
        : {
            schemaVersion: 1,
            after: await explorerBoundary(),
            through: campaign.records().at(-1)!.seq,
          },
  },
  async () => {
    process.exit(73);
  },
);
