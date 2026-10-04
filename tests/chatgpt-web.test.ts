import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  Type,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import {
  chatGptWebProvider,
  reportedPiUsage,
} from "../packages/core/src/pi.ts";
import { piRuntime, readSettings } from "../packages/core/src/solve/config.ts";
import {
  campaignOptions,
  declarationVersion,
} from "../packages/core/src/solve/campaign.ts";
import { createRoles } from "../packages/core/src/solve/roles.ts";
import { offlineResearch } from "../scripts/bounded-solve.ts";
import { project } from "../packages/core/src/solve/notes.ts";
import { ask, invoke } from "./fixtures/pi.ts";

const profiles = {
  default: { provider: "openai", model: "gpt-6-astra" },
  explorer: {
    provider: "codex-chatgpt-web",
    model: "chatgpt-web/gpt-6-pro",
    baseUrl: "https://bridge.invalid/v1",
  },
};
const fixtureFetch = (
  respond: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch => Object.assign(respond, { preconnect: fetch.preconnect });

const selection = (name: string, args: unknown) =>
  JSON.stringify({ text: "", calls: [{ name, arguments: args }] });

function response(
  text: string | string[],
  servedModel?: string,
  finishReason = "stop",
) {
  const item = (phase: string, text: string) => ({
    type: "message",
    role: "assistant",
    phase,
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const incomplete = finishReason === "length";
  return new Response(
    `data: ${JSON.stringify({
      type: incomplete ? "response.incomplete" : "response.completed",
      response: {
        id: "response-fixture",
        model: "chatgpt-web/gpt-6-pro",
        ...(servedModel ? { served_model: servedModel } : {}),
        status: incomplete ? "incomplete" : "completed",
        ...(incomplete
          ? { incomplete_details: { reason: "max_output_tokens" } }
          : {}),
        output: [
          item(
            "commentary",
            "Ignore this longer intermediate message. ".repeat(20),
          ),
          ...(typeof text === "string" ? [text] : text).map((answer) =>
            item("final_answer", answer),
          ),
        ],
        usage: { input_tokens: 50, output_tokens: 25, total_tokens: 75 },
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("ChatGPT Web is explicit Explorer-only and one-shot", () => {
  expect(() =>
    readSettings({
      profiles: { default: profiles.explorer },
    }),
  ).toThrow("profiles.explorer");
  expect(() =>
    readSettings({
      profiles: { ...profiles, correctness: profiles.explorer },
    }),
  ).toThrow("profiles.correctness");
  expect(() =>
    readSettings({
      profiles,
      maxExplorerResponses: 2,
    }),
  ).toThrow("maxExplorerResponses=1");
  const safe = readSettings({ profiles });
  expect(safe.maxExplorerResponses).toBe(1);
});

test("browser provider runs a quota-safe one-shot Explorer", async () => {
  const settings = readSettings({
    profiles,
    maxExplorerReads: 1,
    limits: { concurrency: 1, attempts: 1 },
  });
  const runtime = piRuntime(settings, "unrelated-gateway-key");
  expect(runtime.profiles.explorer.options?.apiKey).toBeUndefined();
  const requests: any[] = [];
  const draft = {
    notes: [
      {
        id: "n1",
        summary: "First",
        detailedSummary: "Preserve the mathematical notation.",
        text: "Preserve a_b and \\sum_i exactly.",
        support: [],
      },
    ],
    candidate: true,
  };
  runtime.profiles.explorer.options!.fetch = fixtureFetch(
    async (_url: unknown, init?: RequestInit) => {
      expect(String(_url)).toBe("https://bridge.invalid/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).not.toContain(
        "unrelated-gateway-key",
      );
      const body = await new Response(init?.body).json();
      requests.push(body);
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.max_output_tokens).toBeUndefined();
      expect(body.reasoning.effort).toBe("max");
      expect(body.text.format).toMatchObject({
        type: "json_schema",
        name: "tool_response",
        strict: true,
      });
      expect(JSON.stringify(body.input)).not.toContain("read_notes");
      const identity = JSON.parse(
        body.client_metadata["x-codex-turn-metadata"],
      );
      expect(
        body.input.findLast((item: any) => item.role === "user")
          .internal_chat_message_metadata_passthrough.turn_id,
      ).toBe(identity.turn_id);
      return response(selection("submit_result", draft));
    },
  );
  const task = {
    problem: "Fixture task",
    completionCriteria: "Fixture result",
  };
  const engine = await Xean.open(
    new MemoryStorage(),
    campaignOptions(
      {
        version: declarationVersion,
        kind: "xean.role",
        role: "explorer",
        task,
        settings,
        input: {
          notes: [
            {
              id: "given",
              summary: "Read me",
              detailedSummary: "A fixture",
              text: "FROZEN-NOTE",
              support: [],
              revision: 0,
              imported: true,
              checks: [],
              verified: true,
              dead: false,
              accepted: false,
              candidate: false,
            },
          ],
          guidance: "Explore",
        },
      },
      runtime,
    ),
  );
  try {
    await engine.run();
    const snapshot = await engine.inspectWithRecords();
    const prompt = JSON.stringify(requests[0].input);
    expect(prompt).toContain("Return results through submit_result.");
    expect(prompt).not.toContain(
      "Use an empty calls array for a final text answer.",
    );
    expect(snapshot.campaign.status).toBe("completed");
    expect(snapshot.campaign.providerCalls).toBe(1);
    const notes = project(snapshot.campaign);
    expect(notes.map((n) => n.text)).toEqual([draft.notes[0]!.text]);
    expect(
      notes.every((n) => !n.imported && !n.verified && !n.accepted),
    ).toBeTrue();
    for (const kind of [
      "xean.call.started",
      "xean.call.request",
      "xean.call.settled",
    ])
      expect(snapshot.records.filter((r) => r.kind === kind)).toHaveLength(1);
    const settled = snapshot.records
      .filter((r) => r.kind === "xean.call.settled")
      .map((r) => r.data as any);
    expect(settled.every((r) => r.usage === null)).toBeTrue();
    const assistant = snapshot.records
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "assistant")!;
    expect(assistant.usageReported).toBe(false);
    expect(assistant).toMatchObject({
      chatGptWeb: {
        text: selection("submit_result", draft),
        servedModel: null,
      },
    });
  } finally {
    await engine.close();
  }
});

test("direct browser roles cannot enable readers or repeat an invalid submission", async () => {
  const runtime = piRuntime(readSettings({ profiles }));
  let calls = 0;
  let settled = 0;
  runtime.profiles.explorer.options!.fetch = fixtureFetch(
    async (_url: unknown, init?: RequestInit) => {
      calls++;
      const body = await new Response(init?.body).json();
      expect(JSON.stringify(body.input)).not.toContain("read_notes");
      expect(JSON.stringify(body.input)).toContain('\\"reads\\":0');
      return response(
        selection("submit_result", { notes: [], candidate: true }),
      );
    },
  );
  const roles = createRoles(runtime, offlineResearch, {
    maxExplorerReads: 4,
    maxExplorerResponses: 8,
    chatGptSingleShot: false,
    literature: false,
  });
  await expect(
    invoke(
      roles.explorer,
      {
        task: { problem: "Fixture", completionCriteria: "Fixture" },
        notes: [],
        guidance: "Explore",
      },
      {
        attemptId: "direct-browser",
        attempt: 1,
        recorder: {
          begin: () => ({
            recordRequest() {},
            settle() {
              settled++;
            },
          }),
        },
      },
    ),
  ).rejects.toThrow("exhausted its responses without a valid result");
  expect(calls).toBe(1);
  expect(settled).toBe(1);
});

test("browser provider validates typed replies and preserves tool history and served identity", async () => {
  const models = createModels();
  models.setProvider(chatGptWebProvider("https://bridge.invalid/v1"));
  const model = models.getModel("codex-chatgpt-web", "chatgpt-web/gpt-6-pro")!;
  const tool = {
    name: "answer",
    description: "Return an answer",
    parameters: Type.Object(
      { count: Type.Integer() },
      { additionalProperties: false },
    ),
  };
  const input = {
    messages: [{ role: "user" as const, content: "Answer", timestamp: 0 }],
  };
  let first: AssistantMessage | undefined;
  for (const [text, valid] of [
    [selection("answer", { count: 2 }), true],
    [selection("answer", { count: "2" }), false],
    [selection("answer", { count: 2, extra: 1 }), false],
    [selection("missing", { count: 2 }), false],
    [
      JSON.stringify({
        text: "",
        calls: [
          { name: "answer", arguments: { count: 2 } },
          { name: "missing", arguments: {} },
        ],
      }),
      false,
    ],
    ['{"count":\\[\\]}', false],
  ] as const) {
    const options = {
      fetch: fixtureFetch(async () => response(text)),
    };
    const events = models.streamSimple(
      model,
      { ...input, tools: [tool] },
      options,
    );
    const types = [];
    for await (const event of events) types.push(event.type);
    const result = await events.result();
    expect(result.stopReason).toBe(valid ? "toolUse" : "error");
    expect((result as any).chatGptWeb).toEqual({ text, servedModel: null });
    expect(result.responseModel).toBeUndefined();
    expect(reportedPiUsage(result)).toBeNull();
    if (valid) {
      first = result;
      expect(result.content).toMatchObject([
        { type: "toolCall", name: "answer", arguments: { count: 2 } },
      ]);
    } else {
      expect(result.content).toEqual([]);
      expect(types).not.toContain("done");
    }
  }
  const text = "Ordinary text needs no JSON envelope.";
  const plain = await models.completeSimple(
    model,
    { ...input, tools: [tool] },
    {
      toolChoice: "none",
      fetch: fixtureFetch(async () => response(text)),
    },
  );
  expect(plain.content).toEqual([{ type: "text", text }]);
  const lookup = {
    name: "lookup",
    description: "Look up a key",
    parameters: Type.Object(
      { key: Type.String() },
      { additionalProperties: false },
    ),
  };
  for (const envelope of [
    {
      text: "Checking",
      calls: [
        { name: "lookup", arguments: { key: "x" } },
        { name: "answer", arguments: { count: 2 } },
      ],
    },
    { text: "Finished", calls: [] },
  ]) {
    const result = await models.completeSimple(
      model,
      { ...input, tools: [tool, lookup] },
      {
        fetch: fixtureFetch(async () =>
          response(JSON.stringify(envelope), "gpt-6-mini"),
        ),
      },
    );
    expect(result.stopReason).toBe(envelope.calls.length ? "toolUse" : "stop");
    expect(result.content).toMatchObject([
      { type: "text", text: envelope.text },
      ...envelope.calls.map((call) => ({ type: "toolCall", ...call })),
    ]);
  }
  const mismatched = await models.completeSimple(
    model,
    { ...input, tools: [tool, lookup] },
    {
      fetch: fixtureFetch(async () =>
        response(selection("answer", { key: "x" })),
      ),
    },
  );
  expect(mismatched.stopReason).toBe("error");
  expect(mismatched.content).toEqual([]);
  for (const answers of [[], ["first", "second"]]) {
    const result = await models.completeSimple(model, input, {
      fetch: fixtureFetch(async () => response(answers)),
    });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("no unique final answer");
    expect(result.content).toEqual([]);
    expect((result as any).chatGptWeb.text).toBe(answers.join("\n\n"));
  }
  let dispatched = false;
  const invalidPayload = await models.completeSimple(model, input, {
    onPayload: () => null,
    fetch: fixtureFetch(async () => {
      dispatched = true;
      return response("unexpected");
    }),
  });
  // Preserve a hook's replacement exactly, including an invalid null request.
  expect(invalidPayload.stopReason).toBe("error");
  expect(dispatched).toBeFalse();
  const call = first!.content.find((part) => part.type === "toolCall")!;
  for (const [text, servedModel, finishReason, success] of [
    [
      JSON.stringify({ text: "Finished", calls: [] }),
      "gpt-6-pro",
      "stop",
      true,
    ],
    [
      JSON.stringify({ text: "Different served model", calls: [] }),
      "gpt-6-mini",
      "stop",
      true,
    ],
    ['{"text":"unfinished', "gpt-6-pro", "length", false],
  ] as const) {
    let content: any[] = [];
    const result = await models.completeSimple(
      model,
      {
        ...input,
        tools: [tool, lookup],
        messages: [
          ...input.messages,
          first!,
          {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "Answer rejected" }],
            isError: true,
            timestamp: 1,
          },
        ],
      },
      {
        fetch: fixtureFetch(async (_url: unknown, init?: RequestInit) => {
          const body = await new Response(init?.body).json();
          content = body.input;
          return response(text, servedModel, finishReason);
        }),
        onProviderStreamEvent: (_event, requestModel) => {
          expect(requestModel.api).toBe("chatgpt-web");
        },
      },
    );
    expect(content.find((item) => item.type === "function_call")).toMatchObject(
      {
        call_id: call.id,
        name: "answer",
        arguments: '{"count":2}',
      },
    );
    expect(
      content.find((item) => item.type === "function_call_output"),
    ).toMatchObject({
      call_id: call.id,
      output: expect.stringContaining(
        "Tool execution failed.\nAnswer rejected",
      ),
    });
    expect(result.stopReason).toBe(success ? "stop" : "error");
    expect((result as any).chatGptWeb).toEqual({ text, servedModel });
    expect(result.responseModel).toBe(servedModel);
    expect(result.responseId).toBe("response-fixture");
    expect(result.content).toEqual(
      success ? [{ type: "text", text: JSON.parse(text).text }] : [],
    );
  }
});

test("browser provider rejects images and settles cancellation without replay", async () => {
  const models = createModels();
  models.setProvider(chatGptWebProvider());
  const model = models.getModel("codex-chatgpt-web", "chatgpt-web/gpt-6-pro")!;
  const input = {
    messages: [{ role: "user" as const, content: "Answer", timestamp: 0 }],
  };
  let calls = 0;
  const controller = new AbortController();
  const options = {
    signal: controller.signal,
    fetch: fixtureFetch(async (_url: unknown, init?: RequestInit) => {
      calls++;
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new Error("Cancellation did not reach fetch");
    }),
  };
  const tool = {
    name: "one",
    description: "Output",
    parameters: Type.Object({}),
  };
  expect(
    (
      await models.completeSimple(
        model,
        {
          messages: [
            {
              role: "user",
              content: [
                { type: "image", data: "fixture", mimeType: "image/png" },
              ],
              timestamp: 0,
            },
          ],
          tools: [tool],
        },
        options,
      )
    ).stopReason,
  ).toBe("error");
  expect(calls).toBe(0);
  expect((await models.completeSimple(model, input, options)).stopReason).toBe(
    "aborted",
  );
  expect(calls).toBe(1);
  // Pi may reject an already-aborted request during auth, before invoking the provider.
  expect(["error", "aborted"]).toContain(
    (await models.completeSimple(model, input, options)).stopReason,
  );
  expect(calls).toBe(1);
});

test("reopening an interrupted browser worker never submits a second request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-browser-recovery-"));
  const path = join(directory, "campaign.sqlite");
  const started = Promise.withResolvers<void>();
  let calls = 0;
  const task = {
    problem: "Fixture task",
    completionCriteria: "Fixture result",
  };
  const settings = readSettings({
    profiles,
    limits: { concurrency: 1, attempts: 3 },
  });
  const options = () =>
    campaignOptions(
      {
        version: declarationVersion,
        kind: "xean.role",
        role: "explorer",
        task,
        settings,
        input: { notes: [], guidance: "Explore" },
      },
      () => {
        const runtime = piRuntime(settings);
        runtime.profiles.explorer.options!.fetch = fixtureFetch(
          async (_url: unknown, init?: RequestInit) => {
            calls++;
            if (calls > 1)
              return response(
                selection("submit_result", { notes: [], candidate: false }),
              );
            const signal = init!.signal!;
            signal.throwIfAborted();
            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
              started.resolve();
            });
          },
        );
        return runtime;
      },
    );
  let engine = await Xean.open(await openXeanStorage(path), options());
  try {
    const running = engine.run();
    await started.promise;
    await engine.close();
    await running;
    expect(calls).toBe(1);
    engine = await Xean.open(await openXeanStorage(path), options());
    const campaign = await engine.run();
    expect(campaign.status).toBe("blocked");
    expect(campaign.work[0]).toMatchObject({ status: "failed", attempts: 2 });
    expect(campaign.work[0]!.error).toContain(
      "ChatGPT Web cannot repeat an interrupted worker",
    );
    expect(calls).toBe(1);
    expect(campaign.providerCalls).toBe(1);
    const records = await engine.records();
    for (const kind of ["xean.call.started", "xean.call.settled"])
      expect(records.filter((record) => record.kind === kind)).toHaveLength(1);
    expect(
      records.filter((record) => record.kind === "xean.attempt.interrupted"),
    ).toHaveLength(1);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("solver recovery never resubmits a disconnected browser request", async () => {
  const runtime = piRuntime(readSettings({ profiles }));
  let calls = 0;
  let settled = 0;
  runtime.profiles.explorer.options!.fetch = fixtureFetch(async () => {
    calls++;
    // A second request would hide the disconnect behind a successful result.
    return calls === 1
      ? new Response("upstream connection lost", { status: 502 })
      : response(selection("submit_result", { answer: true }));
  });
  await expect(
    ask(
      runtime,
      "explorer",
      "Return the answer",
      {},
      Type.Object({ answer: Type.Boolean() }),
      {
        attemptId: "browser-disconnect",
        attempt: 1,
        recorder: {
          begin: () => ({
            recordRequest() {},
            settle(_message, usage) {
              expect(usage).toBeNull();
              settled++;
            },
          }),
        },
      },
      BACKGROUND_CONTEXT,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
  expect(settled).toBe(1);
});
