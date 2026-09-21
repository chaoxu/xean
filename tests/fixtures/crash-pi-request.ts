import {
  createAssistantMessageEventStream,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";

import { createCampaign, defineTool } from "../../src";
import { z } from "zod";
import { runPi } from "../../src/pi";

const path = process.argv[2];
if (path === undefined) throw new Error("missing database path");
const model: Model<Api> = {
  id: "crash-test",
  name: "Crash test",
  api: "openai-responses",
  provider: "fake",
  baseUrl: "https://invalid.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1_000,
};
let requests = 0;
const afterFirst = process.argv[3] === "after-first";
const models = {
  streamSimple(requestModel, _context, options) {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await options?.onPayload?.({ input: "durable request" }, requestModel);
      if (afterFirst && requests++ === 0) {
        stream.push({
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [
              { type: "toolCall", id: "ping-1", name: "ping", arguments: {} },
            ],
            stopReason: "toolUse",
            timestamp: Date.now(),
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            },
          },
        });
        stream.end();
        return;
      }
      process.exit(0);
    })();
    return stream;
  },
} satisfies Pick<Models, "streamSimple">;
const campaign = createCampaign(path, "crash-pi-request-fixture", null);
await runPi(campaign, {
  models,
  model,
  label: "crash/v1",
  prompt: "Crash after checkpoint",
  ...(afterFirst
    ? {
        tools: [
          defineTool({
            name: "ping",
            description: "Ping",
            input: z.strictObject({}),
            async run() {
              throw new Error("ping failed");
            },
          }),
        ],
      }
    : {}),
});
