import { afterEach, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { run } from "../runner";
import { inspectCampaign } from "../role-cli";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const coordination = {
  filings: [],
  explorerGuidance: "Explore the task.",
  support: [],
  verify: [],
  action: { role: "explorer" },
};

function provider(replies: readonly AssistantMessage["content"][]) {
  const { models } = dependencies([]);
  const model = models.getModel("test", "model-v1")!;
  const contexts: Context[] = [];
  const sessions: (string | undefined)[] = [];
  return {
    contexts,
    sessions,
    models: {
      ...models,
      streamSimple: ((requestModel, context, options) => {
        const content = replies[contexts.length];
        if (content === undefined) throw new Error("unexpected provider call");
        contexts.push(structuredClone(context));
        sessions.push(options?.sessionId);
        const reply: AssistantMessage = {
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          stopReason: content.some((block) => block.type === "toolCall")
            ? "toolUse"
            : "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        void (async () => {
          await options?.onPayload?.(
            { model: model.id, context },
            requestModel,
          );
          stream.push({
            type: "done",
            reason: reply.stopReason as "stop" | "toolUse",
            message: reply,
          });
          stream.end();
        })();
        return stream;
      }) satisfies typeof models.streamSimple,
    },
    async codex(): Promise<never> {
      throw new Error("unexpected Codex call");
    },
  };
}

test("coordinator requests its missing submission once and continues the saved conversation", async () => {
  const path = campaignPath();
  const drive = provider([
    [{ type: "text", text: "I will ask Explorer to prove P." }],
    [
      {
        type: "toolCall",
        id: "coord",
        name: "submit_coordination",
        arguments: coordination,
      },
    ],
    [
      {
        type: "toolCall",
        id: "explore",
        name: "submit_notes",
        arguments: { notes: [], solution: false },
      },
    ],
  ]);
  expect(
    await run(
      { task, campaignPath: path, settings: roleSettings(), turns: 1 },
      drive,
    ),
  ).toMatchObject({ outcome: "turn-limit", turns: 1 });
  expect(drive.contexts).toHaveLength(3);
  expect(drive.sessions[1]).toBe(drive.sessions[0]);
  expect(drive.contexts[1]!.messages.slice(-2)).toMatchObject([
    {
      role: "assistant",
      content: [{ type: "text", text: "I will ask Explorer to prove P." }],
    },
    { role: "user", content: expect.stringContaining("submit_coordination") },
  ]);
  const inspection: any = await inspectCampaign(path);
  expect(inspection.calls.map((call: any) => call.role)).toEqual([
    "coordinator",
    "explorer",
  ]);
});

test("a coordinator that still omits its submission fails after one follow-up and remains resumable", async () => {
  const path = campaignPath();
  const request = {
    task,
    campaignPath: path,
    settings: roleSettings(),
    turns: 1,
  };
  const drive = provider([
    [{ type: "text", text: "A plan without a submission." }],
    [{ type: "text", text: "Still no submission." }],
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "call-failure",
    at: "coordinator",
    reason: expect.stringContaining("submit_coordination"),
  });
  expect(drive.contexts).toHaveLength(2);
  expect(await inspectCampaign(path)).toMatchObject({
    phase: "coordinator",
    notes: [],
  });
  const resumed = provider([
    [
      {
        type: "toolCall",
        id: "coord",
        name: "submit_coordination",
        arguments: coordination,
      },
    ],
    [
      {
        type: "toolCall",
        id: "explore",
        name: "submit_notes",
        arguments: { notes: [], solution: false },
      },
    ],
  ]);
  expect(await run(request, resumed)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
});
