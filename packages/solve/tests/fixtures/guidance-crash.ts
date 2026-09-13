import { openCampaign } from "xean";

const path = process.argv[2];
const mode = process.argv[3];
if (path === undefined || !["submit", "freeze"].includes(mode ?? ""))
  throw new Error("expected campaign and crash mode");
const campaign = openCampaign(path);
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
            after: 1,
            through: campaign.records().at(-1)!.seq,
          },
  },
  async () => {
    process.exit(73);
  },
);
