import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  lazyStream,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  ToolResultEntry,
  type EntryId,
  type TaskId,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  getCurrentTools,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai/utils/transcript";
import { z } from "zod";
import {
  createRoleRuntime,
  roleGenerationPolicy,
} from "../src/role-runtime.ts";
import { resolveCall, type CallDescriptor } from "../src/policy/prompts.ts";
import { open, inspect } from "../src/host.ts";
import { readReport } from "../src/report.ts";
import { solveSettings } from "../src/policy/settings.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import provenance from "../vendor/pi/provenance.json";
import historical from "./fixtures/v100-contracts.json";

const context = BACKGROUND_CONTEXT;
const descriptor: CallDescriptor = {
  kind: "explorer",
  input: {
    task: { problem: "Prove 1 = 1.", completionCriteria: "Give a proof." },
    notes: [],
    support: [],
    explorerGuidance: "Prove the claim.",
  },
};
const value = { notes: [{ text: "By reflexivity, 1 = 1.", support: [] }] };
const submitted = (
  input: { notes: { text: string; support: string[] }[] } = value,
) =>
  fauxAssistantMessage([fauxToolCall("submit_notes", input)], {
    stopReason: "toolUse",
  });

function fixture(
  responses: FauxResponseStep[],
  inspectPayload?: (payload: unknown) => void,
  retry = true,
) {
  const provider = fauxProvider({
    provider: "test",
    api: inspectPayload ? "openai-responses" : undefined,
    models: [{ id: "math", reasoning: true }],
  });
  provider.setResponses(responses);
  const models = createModels();
  models.setProvider(provider.provider);
  if (inspectPayload) {
    const stream = models.streamSimple.bind(models);
    models.streamSimple = (model, transcript, options) =>
      lazyStream(model, async () => {
        inspectPayload(
          await options?.onPayload?.(
            {
              input: [{ role: "developer", content: "Exact instructions" }],
              tools: [{ name: "submit_notes" }],
              prompt_cache_key: "old",
            },
            model,
          ),
        );
        return stream(model, transcript, options);
      });
  }
  const role = createRoleRuntime();
  const Invoke = defineTask<
    { descriptor: CallDescriptor; previousTasks: TaskId[] },
    { phase: "run" },
    JsonValue,
    object
  >({
    name: "test.role",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, ctx) {
        const result = await role.run(
          runtime,
          "role",
          task.input.descriptor,
          { provider: "test", model: "math", reasoning: "max" },
          ctx,
          task.input.previousTasks,
        );
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result },
          }),
          ctx,
        );
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  return {
    provider,
    async open(directory?: string) {
      const registry = createRegistry();
      registry.install(role.extension);
      registry.install(defineExtension({ name: "test", tasks: [Invoke] }));
      const harness = await Harness.open(
        directory
          ? await openNodeJsonlStorage(directory, context, { fsync: true })
          : new MemoryStorage(),
        {
          registry,
          models,
          settings: {
            compaction: { enabled: false },
            retry: { enabled: retry, maxRetries: 8, baseDelayMs: 0 },
            generation: roleGenerationPolicy,
            toolExecution: "sequential",
          },
        },
        context,
      );
      const root = await harness.root(context);
      return {
        harness,
        async invoke(previousTasks: TaskId[] = [], input = descriptor) {
          return root.commit(
            (tx) =>
              tx.createTask(
                Invoke,
                { descriptor: input, previousTasks },
                { ownership: { kind: "conversation" } },
              ),
            context,
          );
        },
      };
    },
  };
}

test("v1 prompt and contextual schema reach Pi; the first submission hands off", async () => {
  let input: TranscriptContext | undefined;
  const fixture_ = fixture([
    (transcript) => {
      input = structuredClone(transcript);
      return submitted();
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    const id = await invoke();
    const outcome = (await harness.waitForTask(id, context)).state.outcome;
    expect(outcome).toMatchObject({
      status: "completed",
      result: { value, fresh: true },
    });
    expect(fixture_.provider.state.callCount).toBe(1);
    const call = await resolveCall(descriptor);
    expect(getCurrentSystemPrompt(input!.messages)).toBe(call.system);
    expect(
      input!.messages.filter((message) => message.role === "user")[0]?.content,
    ).toBe(call.prompt);
    expect<unknown>(getCurrentTools(input!.messages)).toEqual([
      {
        name: call.tool,
        description: call.description,
        parameters: z.toJSONSchema(call.schema),
        constrainedSampling: historical.contracts.explorer.constrainedSampling,
      },
    ]);
    if (outcome.status !== "completed") throw new Error("Role failed");
    const receipt = await harness.commit(
      (tx) => tx.entry((outcome.result as { call: EntryId }).call),
      context,
    );
    expect(ToolResultEntry.is(receipt!)).toBe(true);
    expect(receipt?.model?.[0]).toMatchObject({
      role: "toolResult",
      isError: false,
      details: value,
    });
  } finally {
    await harness.close(context);
  }
});

test("a syntactically valid unknown support is rejected before a successful receipt", async () => {
  const fixture_ = fixture([
    submitted({ notes: [{ text: "Unjustified claim", support: ["n99"] }] }),
    (transcript) => {
      expect(
        transcript.messages.some(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toBe(true);
      return submitted();
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    const result = (await harness.waitForTask(await invoke(), context)).state
      .outcome;
    expect(result).toMatchObject({ status: "completed", result: { value } });
    expect(fixture_.provider.state.callCount).toBe(2);
  } finally {
    await harness.close(context);
  }
});

test("terminal provider failure never becomes a completed role", async () => {
  const fixture_ = fixture([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Invalid API key",
    }),
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    const result = (await harness.waitForTask(await invoke(), context)).state
      .outcome;
    expect(result.status).not.toBe("completed");
    expect(fixture_.provider.state.callCount).toBe(1);
  } finally {
    await harness.close(context);
  }
});

test("output-length recovery preserves the exact v1 continuation message", async () => {
  const fixture_ = fixture([
    fauxAssistantMessage("A partial argument.", { stopReason: "length" }),
    (transcript) => {
      expect(
        transcript.messages.filter((message) => message.role === "user").at(-1)
          ?.content,
      ).toBe(
        "The previous response was interrupted before completion. Continue exactly where you left off; do not restart or repeat completed work.",
      );
      return submitted();
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    expect(
      (await harness.waitForTask(await invoke(), context)).state.outcome.status,
    ).toBe("completed");
    expect(fixture_.provider.state.callCount).toBe(2);
  } finally {
    await harness.close(context);
  }
});

test("provider-error recovery adds no user instruction and retains the raw failure", async () => {
  const failure =
    "stream disconnected before completion: stream closed before response.completed";
  const fixture_ = fixture([
    fauxAssistantMessage("Unfinished response.", {
      stopReason: "error",
      errorMessage: failure,
    }),
    (transcript) => {
      expect(
        transcript.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      expect(JSON.stringify(transcript.messages)).not.toContain(
        "Unfinished response.",
      );
      return submitted();
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    expect(
      (await harness.waitForTask(await invoke(), context)).state.outcome.status,
    ).toBe("completed");
    const failures = await harness.commit(async (tx) => {
      const conversations = await tx.scanConversations({}, 128);
      const entries = await Promise.all(
        conversations.items.map(({ id }) =>
          tx.scanEntries({ conversationId: id }, 128),
        ),
      );
      return entries
        .flatMap(({ items }) => items.flatMap((entry) => entry.model ?? []))
        .filter(
          (message) =>
            message.role === "assistant" && message.stopReason === "error",
        );
    }, context);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stopReason: "error",
      errorMessage: failure,
      content: [{ type: "text", text: "Unfinished response." }],
    });
    if (failures[0]?.role !== "assistant")
      throw new Error("Missing saved provider failure");
    expect(failures[0].usage).toBeDefined();
  } finally {
    await harness.close(context);
  }
});

test("failed text and tool drafts are excluded while completed signed reasoning is deduplicated", async () => {
  const thinking = (id: string) => ({
    type: "thinking" as const,
    thinking: `Completed ${id}`,
    thinkingSignature: JSON.stringify({
      type: "reasoning",
      id,
      encrypted_content: `encrypted-${id}`,
      status: "completed",
      summary: [],
    }),
  });
  const fixture_ = fixture(
    [
      fauxAssistantMessage([thinking("r1")], { stopReason: "length" }),
      fauxAssistantMessage(
        [
          thinking("r1"),
          thinking("r2"),
          { type: "text", text: "Discard this failed text" },
          fauxToolCall("submit_notes", {
            notes: [{ text: "Unexecuted draft", support: [] }],
          }),
        ],
        { stopReason: "error", errorMessage: "upstream_error" },
      ),
      (transcript) => {
        const text = JSON.stringify(transcript.messages);
        expect(text).not.toContain("Discard this failed text");
        expect(text).not.toContain("Unexecuted draft");
        const ids = transcript.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content
                .filter((part) => part.type === "thinking")
                .map((part) => JSON.parse(part.thinkingSignature!).id)
            : [],
        );
        expect(ids).toEqual(["r1", "r2"]);
        expect(
          transcript.messages.filter((message) => message.role === "user"),
        ).toHaveLength(2);
        return submitted();
      },
    ],
    () => {},
  );
  const { harness, invoke } = await fixture_.open();
  try {
    expect(
      (await harness.waitForTask(await invoke(), context)).state.outcome.status,
    ).toBe("completed");
    expect(fixture_.provider.state.callCount).toBe(3);
  } finally {
    await harness.close(context);
  }
});

test("native retry classification retains v1 gateway codes and terminal authentication failures", async () => {
  for (const failure of [
    "upstream_unavailable",
    "upstream_error",
    "proxy_unavailable",
    "ClientPayloadError",
    "upstream_eof_before_terminal_event",
    "401 upstream_unavailable",
    "403 proxy_unavailable",
    "schema validation upstream_error",
    "tool submission upstream_error",
  ]) {
    const fatal = /401|403|schema validation|tool submission/.test(failure);
    const fixture_ = fixture(
      [
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: failure,
        }),
        submitted(),
      ],
      undefined,
      true,
    );
    const { harness, invoke } = await fixture_.open();
    try {
      const result = (await harness.waitForTask(await invoke(), context)).state
        .outcome;
      expect(result.status === "completed", failure).toBe(!fatal);
      expect(fixture_.provider.state.callCount, failure).toBe(fatal ? 1 : 2);
    } finally {
      await harness.close(context);
    }
  }
});

test("native retry recognizes v1 diagnostic-only and Responses message-limit failures", async () => {
  for (const kind of [
    "code",
    "failure_detail",
    "failureDetail",
    "message-limit",
  ]) {
    const failure = fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Upstream request interrupted",
    });
    if (kind === "message-limit")
      failure.rawStopReason = "incomplete.max_messages";
    else
      failure.diagnostics = [
        {
          type: "provider",
          timestamp: 0,
          ...(kind === "code"
            ? { error: { message: "relay stopped", code: "stream_incomplete" } }
            : { details: { [kind]: "upstream_eof_before_terminal_event" } }),
        },
      ];
    const fixture_ = fixture(
      [failure, submitted()],
      kind === "message-limit" ? () => {} : undefined,
      true,
    );
    const { harness, invoke } = await fixture_.open();
    try {
      expect(
        (await harness.waitForTask(await invoke(), context)).state.outcome
          .status,
        kind,
      ).toBe("completed");
      expect(fixture_.provider.state.callCount, kind).toBe(2);
    } finally {
      await harness.close(context);
    }
  }
});

test("installed provider patch matches the retained provenance", async () => {
  const patch = provenance.patches.find(
    (patch) => patch.package === "@earendil-works/pi-ai",
  )!;
  const hash = async (path: string) =>
    createHash("sha256")
      .update(await readFile(join(import.meta.dir, "..", path)))
      .digest("hex");
  expect(await hash(patch.path)).toBe(patch.sha256);
  for (const [file, expected] of Object.entries(patch.files))
    expect(await hash(`node_modules/${patch.package}/${file}`), file).toBe(
      expected!,
    );
});

test("two successful submissions cannot silently select only the first", async () => {
  const fixture_ = fixture([
    fauxAssistantMessage(
      [
        fauxToolCall("submit_notes", value),
        fauxToolCall("submit_notes", value),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    const result = (await harness.waitForTask(await invoke(), context)).state
      .outcome;
    expect(result).toMatchObject({
      status: "faulted",
      error: { message: "submit_notes requires exactly one submission" },
    });
  } finally {
    await harness.close(context);
  }
});

test("schema repairs may pass sixteen responses but stop at v1's limit of thirty-two", async () => {
  const invalid = () =>
    submitted({ notes: [{ text: "Unjustified claim", support: ["n99"] }] });
  for (const count of [16, 32]) {
    const fixture_ = fixture([
      ...Array.from({ length: count }, invalid),
      submitted(),
    ]);
    const { harness, invoke } = await fixture_.open();
    try {
      const result = (await harness.waitForTask(await invoke(), context)).state
        .outcome;
      expect(result.status === "completed").toBe(count === 16);
      expect(fixture_.provider.state.callCount).toBe(count === 16 ? 17 : 32);
    } finally {
      await harness.close(context);
    }
  }
});

test("restart after the tool receipt reuses the native conversation without a model call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-role-recovery-"));
  const fixture_ = fixture([submitted()]);
  let harness: Harness | undefined;
  try {
    const first = await fixture_.open(directory);
    harness = first.harness;
    const closed = Promise.withResolvers<void>();
    let closing = false;
    harness.subscribeCommits(({ changes }) => {
      if (
        !closing &&
        changes.some(
          (change) =>
            change.type === "entry" && ToolResultEntry.is(change.value),
        )
      ) {
        closing = true;
        void first.harness.close(context).then(closed.resolve, closed.reject);
      }
    });
    const id = await first.invoke();
    void harness.waitForTask(id, context).catch(() => {});
    await closed.promise;
    harness = (await fixture_.open(directory)).harness;
    const result = (await harness.waitForTask(id, context)).state.outcome;
    expect(result).toMatchObject({
      status: "completed",
      result: { value, fresh: false },
    });
    expect(fixture_.provider.state.callCount).toBe(1);
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a replacement worker reuses only matching completed native role receipts", async () => {
  const fixture_ = fixture([submitted(), submitted()]);
  const { harness, invoke } = await fixture_.open();
  try {
    const first = await invoke();
    const original = (await harness.waitForTask(first, context)).state.outcome;
    const second = (await harness.waitForTask(await invoke([first]), context))
      .state.outcome;
    expect(second).toMatchObject({
      status: "completed",
      result: { value, fresh: false },
    });
    expect(
      original.status === "completed" &&
        second.status === "completed" &&
        (original.result as { call: number }).call ===
          (second.result as { call: number }).call,
    ).toBe(true);
    expect(fixture_.provider.state.callCount).toBe(1);
    const changed: CallDescriptor = {
      ...descriptor,
      input: { ...descriptor.input, explorerGuidance: "Try another proof." },
    };
    expect(
      (await harness.waitForTask(await invoke([first], changed), context)).state
        .outcome,
    ).toMatchObject({ status: "completed", result: { fresh: true } });
    expect(fixture_.provider.state.callCount).toBe(2);
  } finally {
    await harness.close(context);
  }
});

test("OpenAI payload retains required serial tools and the v1 instructions placement", async () => {
  const fixture_ = fixture([submitted()], (payload) => {
    expect(payload).toMatchObject({
      input: [],
      instructions: "Exact instructions",
      tool_choice: "required",
      parallel_tool_calls: false,
    });
    expect((payload as { prompt_cache_key: string }).prompt_cache_key).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
  const { harness, invoke } = await fixture_.open();
  try {
    expect(
      (await harness.waitForTask(await invoke(), context)).state.outcome.status,
    ).toBe("completed");
  } finally {
    await harness.close(context);
  }
});

test("one native verification worker completes all six distinct role calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-native-workflow-"));
  const path = join(directory, "campaign.sqlite");
  const provider = fauxProvider({
    provider: "test",
    models: [{ id: "math", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const pass = {
    verdicts: [
      { note: "n1", verdict: "PASS", report: "The claim is established." },
    ],
  };
  const responses: Record<string, JsonValue>[] = [
    value,
    {
      filings: [{ note: "n1", summary: "A complete reflexivity proof." }],
      explorerGuidance: "Verify the proof.",
      support: [],
      verify: [{ note: "n1", verifiers: [...verifierNames] }],
    },
    pass,
    pass,
    pass,
    { statement: "1 = 1." },
    { proof: "Equality is reflexive." },
    { statement: null, ...pass },
  ];
  const tools: string[] = [];
  provider.setResponses(
    responses.map((response) => (transcript) => {
      const declaration = getCurrentTools(transcript.messages)[0]!;
      const name = declaration.name;
      const expected = Object.values(historical.contracts).find(
        (contract) => contract.name === name,
      );
      expect<unknown>(declaration.constrainedSampling).toEqual(
        expected?.constrainedSampling,
      );
      tools.push(name);
      return fauxAssistantMessage([fauxToolCall(name, response)], {
        stopReason: "toolUse",
      });
    }),
  );
  const settings = solveSettings.parse({
    ...Object.fromEntries(
      ["explorer", "coordinator", ...verifierNames].map((name) => [
        name,
        { provider: "test", model: "math", reasoning: "max" },
      ]),
    ),
    maxExplorerTurns: 1,
  });
  const owner = await open(path, {
    models,
    create: { task: descriptor.input.task, settings },
  });
  try {
    await owner.root.waitForIdle(context);
    const report = await inspect(path, readReport);
    expect(report.status).toMatchObject({
      outcome: "accepted",
      accepted: "n1",
    });
    expect(
      report.notes[0]?.verdicts.map((verdict) => verdict.verifier),
    ).toEqual([...verifierNames]);
    expect(tools).toEqual([
      "submit_notes",
      "submit_coordination",
      "submit_verdict",
      "submit_verdict",
      "submit_verdict",
      "submit_statement",
      "submit_proof",
      "submit_verdict",
    ]);
    expect(provider.state.callCount).toBe(8);
  } finally {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});
