import { temporaryDirectory } from "./directory.ts";
import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  createInitialSystemMessage,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
  type Message,
} from "@earendil-works/pi-ai";
import type { GenerationHooks, HookApi } from "@earendil-works/pi-durable";
import { createRuntime, defaultSettings, readSettings } from "../src/config.ts";
import { open } from "../src/host.ts";
import { scanTasks } from "../src/workflow.ts";
import { explorationSchema, type Note } from "../src/math/contracts.ts";
import { conversations, modelMessages } from "../src/roles/conversation.ts";
import { createRoles } from "../src/roles/index.ts";
import { chatgpt } from "../src/roles/chatgpt.ts";
import type { RoleRuntime } from "../src/roles/types.ts";

const fixtureFetch = (
  callback: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch => Object.assign(callback, { preconnect: fetch.preconnect });
const submission = {
  name: "submit",
  description: "Submit",
  parameters: Type.Object(
    { value: Type.String() },
    { additionalProperties: false },
  ),
};
const messages = [
  createInitialSystemMessage("Submit a result", [submission])!,
  { role: "user" as const, content: "Solve", timestamp: 0 },
];
test("role input preserves only valid same-model reasoning and complete tool calls", () => {
  const runtime = createRuntime(defaultSettings, { key: "fixture" });
  const model = runtime.models.getModel("openai", "gpt-6-astra")!;
  const thought = (id: string, status: string | null = "completed") => ({
    type: "thinking" as const,
    thinking: id,
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id,
      encrypted_content: `encrypted-${id}`,
      status,
      summary: [],
    }),
  });
  const failed = {
    ...fauxAssistantMessage(
      [
        thought("completed"),
        thought("completed"),
        thought("unfinished", "in_progress"),
        { type: "thinking", thinking: "unsigned" },
        {
          type: "thinking",
          thinking: "malformed",
          thinkingSignature: "not JSON",
        },
        { type: "text", text: "Failed text" },
        fauxToolCall("submit_proof", { proof: "FAILED_TOOL" }),
      ],
      { stopReason: "error" },
    ),
    api: model.api,
    provider: model.provider,
    model: model.id,
  };
  const partial = fauxToolCall("submit_proof", { proof: "PARTIAL_TOOL" });
  const history: Message[] = [
    ...messages,
    failed,
    ...[
      { api: "other" },
      { provider: "other" },
      { model: "other" },
      { responseModel: "other" },
    ].map((identity) => ({
      ...failed,
      content: [thought("wrong identity")],
      ...identity,
    })),
    {
      ...failed,
      stopReason: "length",
      content: [
        thought("completed"),
        thought("continued", null),
        { type: "text", text: "Preserved text" },
        partial,
      ],
    },
  ];
  const original = structuredClone(history);
  const replay = modelMessages(history, model)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content);
  expect(replay).toEqual([
    thought("completed"),
    thought("continued", null),
    { type: "text", text: "Preserved text" },
  ]);
  expect(history).toEqual(original);
});

test("failed assignment reads and reminder writes stop requests before provider dispatch", async () => {
  const runtime = createRuntime(defaultSettings, { key: "fixture" });
  const before = conversations(runtime.profiles).extension.hooks![0]!
    .handlers as GenerationHooks;
  const model = runtime.models.getModel("openai", "gpt-6-astra")!;
  let calls = 0;
  const stream = () => {
    calls++;
    throw new Error("Unexpected provider call");
  };
  for (const failure of ["snapshot", "memo"]) {
    const api = {
      snapshot: async () => {
        if (failure === "snapshot") throw new Error("Assignment unavailable");
        return { profile: "explorer" };
      },
      memo: async () => {
        throw new Error("Reminder write failed");
      },
    } as unknown as HookApi;
    const selected = await before.beforeRequest(
      { messages, stream, entries: [] },
      api,
      context,
    );
    const result = await selected!.stream!(model, { messages }).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      failure === "snapshot"
        ? "Assignment unavailable"
        : "Reminder write failed",
    );
  }
  expect(calls).toBe(0);
});

const settings = readSettings({
  ...defaultSettings,
  research: false,
  chatgpt: {
    baseUrl: "http://browser.invalid/v1",
    model: "chatgpt-web/gpt-6-pro",
  },
});
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
  candidate: false,
};
function response(answers: string[], status = "completed") {
  return Response.json({
    id: "fixture-response",
    model: settings.chatgpt!.model,
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
const runtime = () =>
  ({
    memo: async (_name: string, candidate: string) => candidate,
  }) as unknown as RoleRuntime;

test("direct ChatGPT Explorer sends the index once and accepts only its final answer", async () => {
  const note: Note = {
    ...selection.notes[0]!,
    id: "prior/n1",
    summary: "Index description",
    detailedSummary: "UNREAD DETAIL",
    text: "UNREAD CLAIM\n\nUNREAD FULL PROOF",
    revision: 0,
    imported: true,
    verified: true,
    dead: false,
    accepted: false,
    candidate: false,
    checks: [],
  };
  const claimed: string[] = [];
  const invocation = {
    memo: async (_name: string, candidate: string) => {
      claimed.push(candidate);
      return candidate;
    },
  } as unknown as RoleRuntime;
  const request = spyOn(globalThis, "fetch").mockImplementation(
    fixtureFetch(async (url, options) => {
      expect(claimed).toHaveLength(1);
      expect(String(url)).toBe("http://browser.invalid/v1/responses");
      const payload = await new Response(options?.body).json();
      expect(payload.stream).toBe(false);
      expect(payload.tools).toBeUndefined();
      expect(payload.text.format).toMatchObject({
        type: "json_schema",
        strict: true,
        schema: explorationSchema,
      });
      const identity = payload.client_metadata["x-codex-turn-metadata"];
      expect(identity).toEqual({ thread_id: claimed[0], turn_id: claimed[0] });
      expect(
        payload.input[0].internal_chat_message_metadata_passthrough.turn_id,
      ).toBe(claimed[0]);
      const input = payload.input[0].content;
      expect(input).toContain("Index description");
      expect(input).not.toContain("UNREAD");
      expect(payload.instructions).toContain(
        "Do not read notes or request continuation",
      );
      return response([JSON.stringify(selection)]);
    }),
  );
  try {
    const roles = createRoles({
      ...settings,
      profiles: createRuntime(settings).profiles,
    });
    const result = await roles.explorer(
      { task, notes: [note], guidance: "Continue" },
      invocation,
      context,
    );
    expect(result).toEqual({ kind: "notes", ...selection });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    request.mockRestore();
  }
});

test("direct ChatGPT rejects incomplete, ambiguous, and invalid results without retrying", async () => {
  const valid = JSON.stringify(selection);
  for (const returned of [
    response([]),
    response([valid, valid]),
    response(["malformed"]),
    response(["null"]),
    response(["[]"]),
    response(['{"notes":[],"candidate":"yes"}']),
    response([valid], "incomplete"),
    response([valid], "failed"),
    new Response("Service unavailable", { status: 503 }),
  ]) {
    const request = spyOn(globalThis, "fetch").mockResolvedValue(returned);
    try {
      await expect(
        chatgpt(settings.chatgpt!, "Solve", [], runtime(), context),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  }
});

test("native worker recovery refuses to resend an interrupted ChatGPT request", async () => {
  const directory = await temporaryDirectory("chatgpt-recovery-");
  const path = join(directory, "campaign.sqlite");
  const started = Promise.withResolvers<void>();
  let calls = 0;
  let aborted = false;
  const request = spyOn(globalThis, "fetch").mockImplementation(
    fixtureFetch(async (_url, options) => {
      calls++;
      started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          aborted = true;
          reject(new DOMException("Interrupted", "AbortError"));
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      });
    }),
  );
  let owner: Awaited<ReturnType<typeof open>> | undefined;
  try {
    owner = await open(path, {
      create: {
        task,
        settings,
        mode: { role: "explorer", input: { notes: [], guidance: "Solve" } },
      },
    });
    await Promise.race([
      started.promise,
      owner.root.waitForIdle(context).then(async () => {
        const root = owner!.root;
        const tasks = await root.commit(
          (tx) => scanTasks(tx, root.id),
          context,
        );
        throw new Error(
          `Worker settled before dispatch: ${JSON.stringify(tasks)}`,
        );
      }),
    ]);
    await owner.close();
    owner = undefined;
    expect(aborted).toBe(true);
    owner = await open(path);
    await owner.root.waitForIdle(context);
    const root = owner.root;
    const workers = await root.commit(
      (tx) => scanTasks(tx, root.id, "research.worker"),
      context,
    );
    expect(workers).toHaveLength(1);
    expect(workers[0]!.state).toMatchObject({
      status: "terminal",
      outcome: { status: "faulted" },
    });
    expect(JSON.stringify(workers[0]!.state)).toContain(
      "refusing an ambiguous replay",
    );
    expect(calls).toBe(1);
  } finally {
    await owner?.close();
    request.mockRestore();
  }
});

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
  const tool = conversations(runtime.profiles).extension.tools!.find(
    (tool) => tool.name === "submit_correctness",
  )!;
  let headers: Headers | undefined;
  const answer = await runtime.profiles.coordinator.stream!(
    model,
    {
      messages: [
        createInitialSystemMessage("Submit", [tool])!,
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
        expect(body.tools[0].strict).toBe(true);
        expect(
          body.tools[0].parameters.properties.results.items.required,
        ).toContain("noteId");
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
