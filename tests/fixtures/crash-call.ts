import { createCampaign } from "../../src";

const path = process.argv[2];
if (path === undefined) throw new Error("missing database path");
const campaign = createCampaign(path, "crash-fixture", null);
await campaign.call({ label: "effect/v1", request: null }, async () => {
  process.exit(0);
});
