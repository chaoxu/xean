// Simulate a process death inside the second explorer call: the call row is
// durable but no call-result ever lands.
import { countingModel, runSession, startCampaign } from "./recovery-app";

const path = process.argv[2];
if (path === undefined) throw new Error("missing database path");
const model = countingModel();
const crashing = {
  ...model,
  async explore(round: number) {
    if (round === 2) process.exit(0);
    return model.explore(round);
  },
};
await runSession(startCampaign(path), crashing);
throw new Error("crash fixture unexpectedly completed");
