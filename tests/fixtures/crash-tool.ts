import { z } from "zod";
import { writeFileSync } from "node:fs";

import { createCampaign, defineTool } from "../../src";

const path = process.argv[2];
const marker = process.argv[3];
if (path === undefined || marker === undefined) {
  throw new Error("missing database or marker path");
}
const campaign = createCampaign(path, "crash-tool-fixture", null);
const effect = defineTool({
  name: "effect",
  description: "Exit during a replay-safe effect",
  input: z.strictObject({ value: z.string() }),
  replay: "safe",
  async run(_input, context) {
    writeFileSync(
      marker,
      JSON.stringify({
        call: context.call,
        toolCall: context.toolCall,
        source: context.source,
      }),
    );
    process.exit(0);
  },
});
await campaign.call(
  { label: "effect/v1", request: null, tools: [effect] },
  ({ tools }) => tools[0]!.execute({ value: "durable" }, "provider-effect-1"),
);
