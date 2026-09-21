import { createCampaign, defineTool } from "../../src";
import { z } from "zod";

const path = process.argv[2];
if (path === undefined) throw new Error("missing database path");

const campaign = createCampaign(path, "detached-tool-rejection-fixture", null);
const fail = defineTool({
  name: "fail",
  description: "Reject after the runner returns",
  input: z.strictObject({}),
  async run() {
    await Promise.resolve();
    throw new Error("detached failure");
  },
});

await campaign.call(
  { label: "detached", request: null, tools: [fail] },
  async ({ tools }) => {
    void tools[0]!.execute({});
    return null;
  },
);
campaign.close();
