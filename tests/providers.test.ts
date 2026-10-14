import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createInitialSystemMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { GenerationHooks, HookApi } from "@earendil-works/pi-durable";
import {
  createRuntime,
  defaultSettings,
  readSettings,
} from "../src/roles/config.ts";
import { open } from "../src/host.ts";
import { scanTasks } from "../src/core/workflow.ts";
import { readView } from "../src/core/math/state.ts";
import { conversations } from "../src/roles/conversation.ts";

const fixtureFetch = (
  callback: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch => Object.assign(callback, { preconnect: fetch.preconnect });
const disconnected =
  "stream error: stream disconnected before completion: stream closed before response.completed";
const messages: Message[] = [];
test("an Explorer continues beyond the retry limit and publishes once in the same worker", async () => {
  const directory = await temporaryDirectory("explorer-stream-recovery-");
  const provider = fauxProvider({
    api: "openai-responses",
    provider: "openai",
    models: [{ id: "stream-recovery" }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const draft = {
    ...selection.notes[0]!,
    text: "UNCOMMITTED DRAFT",
    candidate: true,
  };
  const complete = { ...draft, text: "Completed proof of reflexivity." };
  const chunks = 5;
  const retained: string[] = [];
  let prefix = "";
  provider.setResponses([
    ...Array.from(
      { length: chunks },
      (_, index) => (input: { messages: Message[] }) => {
        if (index === 0) {
          const initial = input.messages.find(
            (message) => message.role === "user",
          )!;
          prefix = JSON.parse(initial.content as string).noteIdPrefix;
          complete.id = `${prefix}reflexivity`;
        }
        const text = JSON.stringify(input.messages);
        for (const previous of retained) expect(text).toContain(previous);
        expect(
          input.messages.some((message) => message.role === "toolResult"),
        ).toBe(false);
        expect(
          input.messages
            .flatMap((message) =>
              message.role === "assistant" ? message.content : [],
            )
            .some((part) => part.type === "toolCall"),
        ).toBe(false);
        const proof = `${draft.text}-${index}`;
        const reasoning = `completed-reasoning-${index}`;
        retained.push(proof, reasoning);
        return {
          ...fauxAssistantMessage(
            [
              {
                type: "thinking",
                thinking: reasoning,
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: `rs_${index}`,
                  encrypted_content: `encrypted-${index}`,
                  status: "completed",
                  summary: [],
                }),
              },
              fauxToolCall("submit_explorer", {
                notes: [{ ...draft, id: `${prefix}reflexivity`, text: proof }],
              }),
            ],
            { stopReason: "error", errorMessage: disconnected },
          ),
          providerError: {},
        };
      },
    ),
    (input) => {
      for (const previous of retained)
        expect(JSON.stringify(input.messages)).toContain(previous);
      expect(
        input.messages.some((message) => message.role === "toolResult"),
      ).toBe(false);
      expect(
        input.messages
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.content)
          .some((part) => part.type === "toolCall"),
      ).toBe(false);
      return fauxAssistantMessage(
        [fauxToolCall("submit_explorer", { notes: [complete] })],
        { stopReason: "toolUse" },
      );
    },
  ]);
  let decisions = 0;
  const owner = await open(join(directory, "campaign.sqlite"), {
    models,
    create: {
      task,
      settings: readSettings({
        maxExplorerResponses: 1,
        profiles: { default: { provider: "openai", model: "stream-recovery" } },
      }),
    },
    roles: () => ({
      coordinator: async () => ({
        work:
          decisions++ === 0
            ? { kind: "explorer", assignment: "Prove reflexivity" }
            : null,
      }),
    }),
  });
  try {
    await owner.root.waitForIdle(context);
    expect(provider.state.callCount).toBe(chunks + 1);
    await owner.root.commit(async (tx) => {
      const workers = await scanTasks(tx, owner.root.id, "research.worker");
      expect(workers).toHaveLength(1);
      expect(workers[0]!.state.outcome?.status).toBe("completed");
      const notes = (await readView(tx, owner.root.id)).notes;
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({
        ...complete,
        id: `${workers[0]!.id}/reflexivity`,
      });
      const children = await tx.scanConversations(
        { ownerTaskId: workers[0]!.id },
        10,
      );
      expect(children.items).toHaveLength(1);
      const entries = await tx.scanEntries(
        { conversationId: children.items[0]!.id },
        100,
      );
      const results = entries.items
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        toolName: "submit_explorer",
        isError: false,
      });
    }, context);
  } finally {
    await owner.close();
  }
}, 20000);

test("failed assignment reads stop requests before provider dispatch", async () => {
  const runtime = createRuntime(defaultSettings, { key: "fixture" });
  const before = conversations(runtime.profiles).extension.hooks![0]!
    .handlers as GenerationHooks;
  const model = runtime.models.getModel("openai", "gpt-6-astra")!;
  let calls = 0;
  const stream = () => {
    calls++;
    throw new Error("Unexpected provider call");
  };
  const api = {
    snapshot: async () => {
      throw new Error("Assignment unavailable");
    },
  } as unknown as HookApi;
  const selected = await before.beforeRequest(
    { messages, stream, entries: [] },
    api,
    context,
  );
  const result = await selected!.stream!(model, { messages }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("Assignment unavailable");
  expect(calls).toBe(0);
});

test.each([false, true])(
  "response allowance counts accepted and rejected submissions after recovery: %s",
  async (recoveredSuccess) => {
    const runtime = createRuntime(defaultSettings, { key: "fixture" });
    const before = conversations(runtime.profiles).extension.hooks![0]!
      .handlers as GenerationHooks;
    const model = runtime.models.getModel("openai", "gpt-6-astra")!;
    let calls = 0;
    const stream = () => {
      calls++;
      throw new Error("Provider dispatch sentinel");
    };
    runtime.profiles.explorer.stream = stream;
    const history: Message[] = [];
    for (let index = 0; index < (recoveredSuccess ? 3 : 2); index++) {
      const accepted = index === 2;
      const call = fauxToolCall("submit_explorer", {
        notes: accepted ? [] : [{ candidate: true }],
      });
      history.push(fauxAssistantMessage([call], { stopReason: "toolUse" }), {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [
          {
            type: "text",
            text: accepted ? "Recorded" : "A note needs its full content",
          },
        ],
        isError: !accepted,
        timestamp: index,
      });
    }
    const selected = await before.beforeRequest(
      {
        messages: history,
        stream,
        entries: history.map((message) => ({
          kind: "fixture",
          model: [message],
        })) as any,
      },
      {
        snapshot: async () => ({ profile: "explorer", maxResponses: 3 }),
      } as unknown as HookApi,
      context,
    );
    const result = await selected!.stream!(model, {
      messages: history,
    }).result();
    expect(result.errorMessage).toContain(
      recoveredSuccess
        ? "Role exhausted its responses"
        : "Provider dispatch sentinel",
    );
    expect(calls).toBe(recoveredSuccess ? 0 : 1);
  },
);

const task = {
  problem: "Prove 1 = 1.",
  completionCriteria: "An elementary proof.",
};
const selection = {
  notes: [
    {
      id: "n1",
      summary: "Reflexivity",
      detailedSummary: "Equality is reflexive.",
      text: "1 = 1\n\nBy reflexivity, 1 = 1.",
      support: [],
    },
  ],
};
function response(answers: string[], status = "completed") {
  return Response.json({
    id: "fixture-response",
    model: "gpt-6-astra",
    status,
    output: [
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          { type: "output_text", text: "Still thinking; not a result." },
        ],
      },
      ...answers.map((text) => ({
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text }],
      })),
    ],
    usage: { input_tokens: 99, output_tokens: 99, total_tokens: 198 },
  });
}
test("custom gateways use native OpenAI Responses and API-key authentication", async () => {
  const runtime = createRuntime(
    readSettings({
      profiles: {
        default: {
          provider: "openai",
          model: "gpt-6-astra",
          baseUrl: "https://gateway.invalid/v1",
          samplingParams: {
            parallel_tool_calls: false,
            tool_choice: "required",
          },
        },
      },
    }),
    { key: "opaque-fixture" },
  );
  const ref = runtime.profiles.coordinator.model;
  const model = runtime.models.getModel(ref.provider, ref.modelId)!;
  const tools = conversations(runtime.profiles).extension.tools!.filter(
    (tool) => ["submit_correctness", "submit_explorer"].includes(tool.name),
  );
  let headers: Headers | undefined;
  const answer = await runtime.profiles.coordinator.stream!(
    model,
    {
      messages: [
        createInitialSystemMessage("Submit", tools)!,
        { role: "user", content: "x", timestamp: 0 },
      ],
    },
    {
      fetch: fixtureFetch(async (_url, options) => {
        headers = new Headers(options?.headers);
        const body = await new Response(options?.body).json();
        expect(body).toMatchObject({
          parallel_tool_calls: false,
          tool_choice: "required",
        });
        const correctness = body.tools.find(
          (tool: { name: string }) => tool.name === "submit_correctness",
        );
        const explorer = body.tools.find(
          (tool: { name: string }) => tool.name === "submit_explorer",
        );
        expect(correctness.strict).toBe(true);
        expect(
          correctness.parameters.properties.results.items.required,
        ).toContain("noteId");
        expect(explorer.parameters.properties.edits).toBeDefined();
        // Responses rejects uniqueItems, including inside optional-field anyOf.
        expect(JSON.stringify(explorer.parameters)).not.toContain(
          '"uniqueItems"',
        );
        return new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: await response(["ok"]).json(),
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    },
  ).result();
  expect(answer.stopReason).toBe("stop");
  expect(headers!.get("authorization")).toBe("Bearer opaque-fixture");
  expect(headers!.has("chatgpt-account-id")).toBe(false);
});
