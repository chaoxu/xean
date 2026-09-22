import { z } from "zod";
import { createCampaign, defineTool } from "../../src";

const path = process.argv[2];
if (path === undefined) throw new Error("missing database path");
const campaign = createCampaign(path, "crash-after-tool", null);
const submit = defineTool({
  name: "submit",
  description: "Record a submission before the parent call is interrupted",
  input: z.string(),
  async run(input) {
    return input;
  },
});
await campaign.call(
  { label: "check", request: null, tools: [submit] },
  async ({ tools }) => {
    await tools[0]!.execute("durable submission");
    process.exit(0);
  },
);
