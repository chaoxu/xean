import { expect, test } from "bun:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, Type } from "@earendil-works/pi-ai";
import { Xean } from "../packages/core/src/index.ts";
import {
  chatGptWebProvider,
  reportedPiUsage,
} from "../packages/core/src/pi.ts";
import { piRuntime, readSettings } from "../packages/core/src/solve/config.ts";
import {
  campaignOptions,
  declarationVersion,
} from "../packages/core/src/solve/campaign.ts";
import { project } from "../packages/core/src/solve/projection.ts";
import { ask } from "../packages/core/src/solve/pi.ts";

const selection = (name: string, args: unknown) =>
  JSON.stringify({ text: "", calls: [{ name, arguments: args }] });

function response(text: string) {
  const item = (phase: string, text: string) => ({
    type: "message",
    role: "assistant",
    phase,
    content: [{ type: "output_text", text, annotations: [] }],
  });
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "response-fixture",
        status: "completed",
        output: [
          item("commentary", "Local tools unavailable"),
          item("final_answer", text),
        ],
        usage: { input_tokens: 50, output_tokens: 25, total_tokens: 75 },
      },
    })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("browser provider runs the ordinary Explorer with private continuation and dependency repair", async () => {
  const settings = readSettings({
    profiles: {
      default: { provider: "openai", model: "gpt-6-astra" },
      explorer: {
        provider: "codex-chatgpt-web",
        model: "chatgpt-web/gpt-6-pro",
        baseUrl: "https://bridge.invalid/v1",
      },
    },
    maxExplorerResponses: 4,
    maxExplorerReads: 1,
    limits: { concurrency: 1, attempts: 1, providerCalls: 4 },
  });
  const runtime = piRuntime(settings, "unrelated-gateway-key");
  expect(runtime.profiles.explorer.options?.apiKey).toBeUndefined();
  const requests: any[] = [];
  const drafts = [
    {
      notes: [
        {
          id: "n1",
          summary: "First",
          detailedSummary: "Preserve the mathematical notation.",
          text: "Preserve a_b and \\sum_i exactly.",
          support: [],
        },
      ],
      candidate: false,
    },
    {
      notes: [
        {
          id: "n2",
          summary: "Invalid",
          detailedSummary: "This claim has unknown support.",
          text: "Unknown support",
          support: ["missing"],
        },
      ],
      candidate: true,
    },
    {
      notes: [
        {
          id: "n2",
          summary: "Final",
          detailedSummary: "The final claim uses the first note.",
          text: "Use the first note.",
          support: ["n1"],
        },
      ],
      candidate: true,
    },
  ];
  runtime.profiles.explorer.options!.fetch = Object.assign(
    async (_url: unknown, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).not.toContain(
        "unrelated-gateway-key",
      );
      const body = await new Response(init?.body).json();
      requests.push(body);
      expect(body.tools).toBeUndefined();
      expect(body.max_output_tokens).toBeUndefined();
      expect(body.reasoning.effort).toBe("max");
      expect(body.text.format).toMatchObject({
        type: "json_schema",
        name: "tool_response",
        strict: true,
      });
      if (requests.length > 2) {
        expect(JSON.stringify(body.input)).toContain("n1");
        expect(JSON.stringify(body.input)).toContain("function_call_output");
      }
      if (requests.length === 4)
        expect(JSON.stringify(body.input)).toContain(
          "Unknown, dead, or forward support",
        );
      if (requests.length === 1)
        return response(
          selection("read_notes", { ids: ["given"], level: "full" }),
        );
      expect(JSON.stringify(body.input)).toContain("FROZEN-NOTE");
      return response(selection("submit_result", drafts[requests.length - 2]));
    },
    { preconnect: fetch.preconnect },
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
          task,
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
    expect(snapshot.campaign.status).toBe("completed");
    expect(snapshot.campaign.providerCalls).toBe(4);
    const notes = project(snapshot.campaign);
    expect(notes.map((n) => n.text)).toEqual([
      drafts[0]!.notes[0]!.text,
      drafts[2]!.notes[0]!.text,
    ]);
    expect(notes[1]!.support).toEqual([notes[0]!.id]);
    expect(
      notes.every((n) => !n.imported && !n.verified && !n.accepted),
    ).toBeTrue();
    for (const kind of [
      "xean.call.started",
      "xean.call.request",
      "xean.call.settled",
    ])
      expect(snapshot.records.filter((r) => r.kind === kind)).toHaveLength(4);
    const settled = snapshot.records
      .filter((r) => r.kind === "xean.call.settled")
      .map((r) => r.data as any);
    expect(
      settled.every(
        (r) => r.usage === null && r.message.usageReported === false,
      ),
    ).toBeTrue();
    const identities = requests.map((r) =>
      JSON.parse(r.client_metadata["x-codex-turn-metadata"]),
    );
    expect(new Set(identities.map((i) => i.thread_id)).size).toBe(1);
    expect(new Set(identities.map((i) => i.turn_id)).size).toBe(4);
  } finally {
    await engine.close();
  }
});

test("browser provider returns final text and validates a generic typed output without coercion", async () => {
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
      fetch: Object.assign(async () => response(text), {
        preconnect: fetch.preconnect,
      }),
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
    expect(reportedPiUsage(result)).toBeNull();
    if (valid)
      expect(result.content).toMatchObject([
        { type: "toolCall", name: "answer", arguments: { count: 2 } },
      ]);
    else {
      expect(result.content).toEqual([]);
      expect(types).not.toContain("done");
    }
    const plain = await models.completeSimple(
      model,
      { ...input, tools: [tool] },
      { ...options, toolChoice: "none" },
    );
    expect(plain.content).toEqual([{ type: "text", text }]);
  }
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
        fetch: Object.assign(async () => response(JSON.stringify(envelope)), {
          preconnect: fetch.preconnect,
        }),
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
      fetch: Object.assign(
        async () => response(selection("answer", { key: "x" })),
        { preconnect: fetch.preconnect },
      ),
    },
  );
  expect(mismatched.stopReason).toBe("error");
  expect(mismatched.content).toEqual([]);
  let dispatched = false;
  const invalidPayload = await models.completeSimple(model, input, {
    onPayload: () => null,
    fetch: Object.assign(
      async () => {
        dispatched = true;
        return response("unexpected");
      },
      { preconnect: fetch.preconnect },
    ),
  });
  // Preserve a hook's replacement exactly, including an invalid null request.
  expect(invalidPayload.stopReason).toBe("error");
  expect(dispatched).toBeFalse();
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
    fetch: Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        calls++;
        controller.abort();
        init?.signal?.throwIfAborted();
        throw new Error("Cancellation did not reach fetch");
      },
      { preconnect: fetch.preconnect },
    ),
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

test("solver recovery never resubmits a disconnected browser request", async () => {
  const runtime = piRuntime(
    readSettings({
      profiles: {
        default: {
          provider: "codex-chatgpt-web",
          model: "chatgpt-web/gpt-6-pro",
        },
      },
    }),
  );
  let calls = 0;
  let settled = 0;
  runtime.profiles.explorer.options!.fetch = Object.assign(
    async () => {
      calls++;
      // A second request would hide the disconnect behind a successful result.
      return calls === 1
        ? new Response("upstream connection lost", { status: 502 })
        : response(selection("submit_result", { answer: true }));
    },
    { preconnect: fetch.preconnect },
  );
  await expect(
    ask(
      runtime,
      "explorer",
      "Return the answer",
      {},
      Type.Object({ answer: Type.Boolean() }),
      {
        attemptId: "browser-disconnect",
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
