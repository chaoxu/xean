import { resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { open, inspect, readNotes, type WorkerRequest } from "../src/index.ts";
import { cliModels } from "../apps/cli/models.ts";

const [taskPath, settingsPath, campaignPath] = process.argv.slice(2);
if (!taskPath || !settingsPath || !campaignPath)
  throw new Error(
    "Usage: bun examples/workers.ts <task.json> <settings.json> <new-campaign.sqlite>",
  );
const path = resolve(campaignPath);
if (await Bun.file(path).exists())
  throw new Error("This example requires a fresh campaign path");
const owner = await open(path, {
  create: {
    task: await Bun.file(taskPath).json(),
    settings: await Bun.file(settingsPath).json(),
  },
  startCampaign: false,
  models: await cliModels(),
});

async function run(request: WorkerRequest) {
  const id = await owner.root.commit(
    (tx) => owner.workers.create(tx, owner.root.id, request),
    context,
  );
  console.log(JSON.stringify({ worker: request.kind, taskId: id }));
  const settled = await owner.harness.waitForTask(id, context);
  const outcome = settled.state.outcome;
  if (outcome.status !== "completed")
    throw new Error(`Worker ${id}: ${JSON.stringify(outcome)}`);
  return outcome.result;
}

try {
  await run({ kind: "explorer" });
  await run({ kind: "verifier" });
  console.log(JSON.stringify(await inspect(path, readNotes), null, 2));
} finally {
  await owner.close();
}
