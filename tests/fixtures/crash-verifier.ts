// Simulate a process death after the first verifier's tool submission was
// durably recorded but before its call result: the journal ends with a
// tool-result whose owning call never settled.
import { countingModel, runSession, startCampaign } from "./recovery-app";

const path = process.argv[2];
if (path === undefined) throw new Error("missing database path");
const model = countingModel();
const crashing = {
  ...model,
  async afterSubmit() {
    process.exit(0);
  },
};
await runSession(startCampaign(path), crashing);
throw new Error("crash fixture unexpectedly completed");
