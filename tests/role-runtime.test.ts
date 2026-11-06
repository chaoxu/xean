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
  Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  getCurrentTools,
  getCurrentSystemPrompt,
  normalizeContext,
} from "@earendil-works/pi-ai/utils/transcript";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { z } from "zod";
import {
  createRoleRuntime,
  roleGenerationPolicy,
} from "../src/role-runtime.ts";
import { resolveCall, type CallDescriptor } from "../src/policy/prompts.ts";
import type { PiRoleProfile } from "../src/policy/settings.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import { project, type NotebookState } from "../src/state.ts";
import provenance from "../vendor/pi/provenance.json";
import historical from "./fixtures/v100-contracts.json";
import {
  fixture as workerFixture,
  complete,
  checks,
  note,
} from "./worker-fixture.ts";

const context = BACKGROUND_CONTEXT;
const descriptor: CallDescriptor = {
  kind: "explorer",
  input: {
    task: { problem: "Prove 1 = 1.", completionCriteria: "Give a proof." },
    notes: [],
    explorerGuidance: "Prove the claim.",
    namespace: "w1",
  },
};
const value = {
  notes: [
    {
      text: "By reflexivity, 1 = 1.",
      summary: "Equality is reflexive.",
      support: [],
    },
  ],
};
const submitted = (
  input: {
    notes: { text: string; support: string[]; summary?: string }[];
  } = value,
) =>
  fauxAssistantMessage([fauxToolCall("submit_notes", input)], {
    stopReason: "toolUse",
  });

function fixture(
  responses: FauxResponseStep[],
  inspectPayload?: (payload: unknown) => void,
  retry = true,
  headers?: Record<string, string>,
) {
  const provider = fauxProvider({
    provider: "test",
    api: inspectPayload ? "openai-responses" : undefined,
    models: [
      { id: "math", reasoning: true },
      { id: "other", reasoning: true },
    ],
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
  const book: NotebookState = {
    notes: [],
    checks: [],
    guidance: [],
    inputs: [],
  };
  const role = createRoleRuntime(() => book);
  let nextOrigin = 0;
  return {
    provider,
    book,
    async open(directory?: string) {
      const registry = createRegistry();
      registry.install(role.extension);
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
            ...(headers ? { stream: { headers } } : {}),
          },
        },
        context,
      );
      await harness.root(context);
      return {
        harness,
        invoke(
          input = descriptor,
          options: {
            origin?: string;
            attempt?: number;
            profile?: PiRoleProfile;
          } = {},
        ) {
          return role.call(
            harness,
            options.origin ?? `work-${++nextOrigin}`,
            options.attempt ?? 0,
            "role",
            input,
            options.profile ?? {
              provider: "test",
              model: "math",
              reasoning: "max",
            },
            context,
            () => {},
          );
        },
      };
    },
  };
}

/** Capture the real Responses declaration, then execute the synthetic wire arguments. */
function wireReply(
  args: Record<string, JsonValue>,
  inspect?: (tool: Record<string, any>, transcript: TranscriptContext) => void,
): FauxResponseStep {
  return async (transcript, options, _state, model) => {
    let name = "";
    const response = await responsesStream(
      {
        ...model,
        api: "openai-responses",
        compat: { supportsStrictMode: true },
      },
      normalizeContext(transcript),
      {
        ...options,
        apiKey: "fixture-not-a-credential",
        onPayload(payload) {
          const tool = (payload as { tools: Record<string, any>[] }).tools[0]!;
          name = tool.name;
          expect(tool.strict).toBe(true);
          inspect?.(tool, transcript);
          throw new Error("captured before HTTP");
        },
      },
    ).result();
    expect(response.errorMessage).toContain("captured before HTTP");
    return fauxAssistantMessage([fauxToolCall(name, args)], {
      stopReason: "toolUse",
    });
  };
}

test("Responses Explorer nulls normalize, invalid summaries and support fail, and raw evidence survives", async () => {
  const supplied = {
    text: "Thus 1 squared = 1.",
    support: ["w1.1"],
    summary: "The square of 1 is 1.",
    detailedSummary: "In the real numbers, 1 squared = 1.",
  };
  const raw = {
    notes: [
      {
        text: "Reflexivity gives 1 = 1.",
        support: [],
        summary: "Equality is reflexive.",
        detailedSummary: null,
      },
      supplied,
    ],
  };
  const expected = {
    notes: [
      { text: raw.notes[0]!.text, summary: raw.notes[0]!.summary, support: [] },
      supplied,
    ],
  };
  const rejected = [
    { notes: [{ ...raw.notes[0]!, summary: " " }] },
    { notes: [{ ...raw.notes[0]!, support: ["n99"] }] },
  ];
  const fixture_ = fixture([
    ...rejected.map((value) => wireReply(value)),
    wireReply(raw, (tool, transcript) => {
      const item = tool.parameters.properties.notes.items;
      expect(item.required).toContain("summary");
      expect(item.properties.summary.type).toBe("string");
      for (const field of ["detailedSummary"]) {
        expect(item.required).toContain(field);
        expect(item.properties[field].anyOf).toContainEqual({ type: "null" });
      }
      const errors = transcript.messages.filter((m) => m.role === "toolResult");
      expect(errors).toHaveLength(2);
      expect(errors.every((m) => m.isError)).toBe(true);
      expect(JSON.stringify(errors[0])).toContain(
        "must contain non-whitespace text",
      );
      expect(JSON.stringify(errors[1])).toContain(
        "Note w1.1 must name distinct support IDs",
      );
    }),
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    expect(await invoke()).toMatchObject({ value: expected });
    expect(fixture_.provider.state.callCount).toBe(3);
    await harness.commit(async (tx) => {
      const conversations = await tx.scanConversations({}, 128);
      const entries = (
        await Promise.all(
          conversations.items.map((c) =>
            tx.scanEntries({ conversationId: c.id, order: "ascending" }, 128),
          ),
        )
      ).flatMap((page) => page.items);
      expect(
        entries
          .flatMap((entry) => entry.model ?? [])
          .filter((m) => m.role === "assistant")
          .flatMap((message) => message.content)
          .filter((part) => part.type === "toolCall")
          .map((part) => part.arguments),
      ).toEqual([...rejected, raw]);
      const receipt = entries
        .filter((entry) => ToolResultEntry.is(entry))
        .at(-1);
      expect(receipt?.model?.[0]).toMatchObject({
        role: "toolResult",
        details: expected,
        isError: false,
      });
    }, context);
  } finally {
    await harness.close(context);
  }
});

test("Explorer prompt, submission contract and notebook reader reach Pi; the first submission hands off", async () => {
  let input: TranscriptContext | undefined;
  const fixture_ = fixture([
    (transcript) => {
      input = structuredClone(transcript);
      return submitted();
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    const outcome = await invoke();
    expect(outcome).toMatchObject({ value });
    expect(fixture_.provider.state.callCount).toBe(1);
    const call = await resolveCall(descriptor);
    expect(getCurrentSystemPrompt(input!.messages)).toBe(call.system);
    expect(
      input!.messages.filter((message) => message.role === "user")[0]?.content,
    ).toBe(call.prompt);
    const tools = getCurrentTools(input!.messages);
    expect(tools.map(({ name }) => name)).toEqual([call.tool, "read_notes"]);
    expect<unknown>(tools.filter(({ name }) => name === call.tool)).toEqual([
      {
        name: call.tool,
        description: call.description,
        parameters: z.toJSONSchema(call.schema),
        constrainedSampling: historical.contracts.explorer.constrainedSampling,
      },
    ]);
    const receipt = await harness.commit(
      (tx) => tx.entry(outcome.call),
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

test("Explorer reads existing unindexed notes, repairs unknown IDs and preserves large batched texts", async () => {
  const sources = [
    {
      id: "n1",
      summary: "First claim.",
      detailedSummary: "First exact conditions.",
      text: "A".repeat(60_000) + " FIRST_END_α",
      support: [],
      verification: {
        source: "Given premise",
        report: "External attestation.",
      },
    },
    {
      id: "n2",
      summary: "Second claim.",
      text: "B".repeat(60_000) + " SECOND_END_β",
      support: [],
    },
  ];
  const checks = (["PASS", "FAIL", "INCONCLUSIVE"] as const).map((verdict) => ({
    candidate: "reader",
    call: 1,
    values: [
      {
        verifier: "requirements" as const,
        note: "n2",
        verdict,
        report: `${verdict} report`,
      },
    ],
  }));
  const notes = project({
    notes: sources,
    checks,
    guidance: [],
    inputs: [],
  }).notes;
  const input: CallDescriptor = {
    kind: "explorer",
    input: {
      ...descriptor.input,
      notes: notes.map(({ text, detailedSummary, ...index }) => index),
    },
  };
  const read = (ids: string[], level: "detailed" | "full") =>
    fauxAssistantMessage([fauxToolCall("read_notes", { ids, level })], {
      stopReason: "toolUse",
    });
  const resultText = (transcript: TranscriptContext) => {
    const result = transcript.messages
      .filter((message) => message.role === "toolResult")
      .at(-1)!;
    expect(result.toolName).toBe("read_notes");
    return result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
  };
  const result = {
    notes: [
      {
        text: "Combined proof.",
        summary: "Combined claim.",
        detailedSummary: "Both conditions apply.",
        support: ["n1", "n2"],
      },
    ],
  };
  const fixture_ = fixture([
    (transcript) => {
      const prompt = transcript.messages.find(
        (message) => message.role === "user",
      )!.content;
      expect(prompt).toContain("Second claim.");
      expect(prompt).not.toContain("First exact conditions.");
      expect(prompt).not.toContain(sources[0]!.text);
      return read(["n99"], "full");
    },
    (transcript) => {
      expect(resultText(transcript)).toContain(
        "Unknown or unavailable note: n99",
      );
      expect(
        transcript.messages
          .filter((message) => message.role === "toolResult")
          .at(-1)!.isError,
      ).toBe(true);
      return read(["n3"], "full");
    },
    (transcript) => {
      expect(JSON.parse(resultText(transcript))).toEqual(["UNINDEXED_BODY"]);
      expect(
        transcript.messages.findLast(
          (message) => message.role === "toolResult",
        )!.isError,
      ).toBe(false);
      return read(["n1", "n2"], "detailed");
    },
    (transcript) => {
      const readNotes = JSON.parse(resultText(transcript));
      expect(
        readNotes.map(
          (entry: { detailedSummary: unknown }) => entry.detailedSummary,
        ),
      ).toEqual(["First exact conditions.", null]);
      expect(readNotes.every((entry: object) => !("text" in entry))).toBe(true);
      expect(readNotes[0].verification).toEqual(sources[0]!.verification);
      expect(readNotes[1].verdicts[0]).toEqual({
        verifier: "requirements",
        note: "n2",
        verdict: "PASS",
      });
      expect(readNotes[1].verdicts).toHaveLength(3);
      expect(resultText(transcript)).toContain("FAIL report");
      expect(resultText(transcript)).toContain("INCONCLUSIVE report");
      return read(["n2", "n1"], "full");
    },
    (transcript) => {
      expect(JSON.parse(resultText(transcript))).toEqual([
        sources[1]!.text,
        sources[0]!.text,
      ]);
      expect(
        transcript.messages.filter((message) => message.role === "toolResult"),
      ).toHaveLength(4);
      expect(
        transcript.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      return submitted(result);
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    fixture_.book.checks = checks;
    fixture_.book.notes = [
      ...sources,
      { id: "n3", text: "UNINDEXED_BODY", support: [] },
    ];
    expect(await invoke(input)).toMatchObject({ value: result });
    expect(fixture_.provider.state.callCount).toBe(5);
  } finally {
    await harness.close(context);
  }
});

test("Selection disables provider constraints while retaining its prompt, schema and contextual validation", async () => {
  const input: CallDescriptor = {
    kind: "selection",
    input: {
      task: descriptor.input.task,
      claimed: [],
      notes: [
        {
          id: "n1",
          text: "Given P. ".repeat(50),
          summary: "P holds.",
          support: [],
          verdicts: [],
          checked: true,
          verified: true,
          dead: false,
          verification: { source: "Given premise", report: "Assumed correct." },
        },
      ],
    },
  };
  const call = await resolveCall(input);
  const coordination = {
    verify: [],
  };
  const assignmentMessages = [call.prompt];
  const fixture_ = fixture([
    (transcript) => {
      const tools = getCurrentTools(transcript.messages);
      expect(getCurrentSystemPrompt(transcript.messages)).toBe(call.system);
      expect(
        transcript.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual(assignmentMessages);
      expect(tools[0]?.parameters).toEqual(z.toJSONSchema(call.schema));
      expect(tools[0]?.constrainedSampling).toBe(false);
      expect(convertResponsesTools(tools)[0]).toMatchObject({
        name: "select_verification",
        parameters: z.toJSONSchema(call.schema),
        strict: false,
      });
      return fauxAssistantMessage(
        [
          fauxToolCall(call.tool, {
            ...coordination,
            verify: [{ note: "n99", verifiers: ["source"] }],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (transcript) => {
      expect(
        transcript.messages.filter(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toHaveLength(1);
      expect(
        transcript.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual(assignmentMessages);
      return fauxAssistantMessage([fauxToolCall(call.tool, coordination)], {
        stopReason: "toolUse",
      });
    },
    (transcript) => {
      expect(
        transcript.messages
          .filter((message) => message.role !== "system")
          .map((message) => [message.role, message.content]),
      ).toEqual([["user", call.prompt]]);
      return fauxAssistantMessage([fauxToolCall(call.tool, coordination)], {
        stopReason: "toolUse",
      });
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    expect(await invoke(input)).toMatchObject({ value: coordination });
    expect(fixture_.provider.state.callCount).toBe(2);
    expect(await invoke(input)).toMatchObject({ value: coordination });
    expect(fixture_.provider.state.callCount).toBe(3);
  } finally {
    await harness.close(context);
  }
});

test("selection reads a busy dependency outside its offer but cannot select it", async () => {
  const source = { id: "given.1", text: "Exact supplied proof.", support: [] };
  const target = {
    id: "candidate.1",
    text: "Use the supplied proof.",
    support: [source.id],
  };
  const input: CallDescriptor = {
    kind: "selection",
    input: {
      task: descriptor.input.task,
      notes: [
        {
          ...target,
          verdicts: [],
          checked: false,
          verified: false,
          dead: false,
        },
      ],
      claimed: [source.id],
    },
  };
  const selected = { verify: [{ note: target.id, verifiers: ["source"] }] };
  const driver = fixture([
    (transcript) => {
      expect(
        getCurrentTools(transcript.messages).map((tool) => tool.name),
      ).toEqual(["select_verification", "read_notes"]);
      return fauxAssistantMessage(
        [
          fauxToolCall("read_notes", {
            ids: [source.id],
            level: "full",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (transcript) => {
      const answer = transcript.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(answer).toMatchObject({
        toolName: "read_notes",
        isError: false,
        content: [{ type: "text", text: JSON.stringify([source.text]) }],
      });
      return fauxAssistantMessage(
        [
          fauxToolCall("select_verification", {
            verify: [{ note: source.id, verifiers: ["source"] }],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    (transcript) => {
      expect(
        transcript.messages.findLast(
          (message) => message.role === "toolResult",
        ),
      ).toMatchObject({ toolName: "select_verification", isError: true });
      return fauxAssistantMessage(
        [fauxToolCall("select_verification", selected)],
        { stopReason: "toolUse" },
      );
    },
  ]);
  const { harness, invoke } = await driver.open();
  try {
    driver.book.notes = [source, target];
    expect(await invoke(input)).toMatchObject({ value: selected });
  } finally {
    await harness.close(context);
  }
});

test("a blind proof cannot invoke the notebook reader", async () => {
  const hidden = { id: "n1", text: "PRIVATE_NOTE_ARGUMENT", support: [] };
  const input: CallDescriptor = {
    kind: "proof",
    input: {
      task: descriptor.input.task,
      notes: project({ notes: [hidden], checks: [], inputs: [], guidance: [] })
        .notes,
      support: [],
    },
    statement: { statements: [{ note: hidden.id, statement: "1 = 1." }] },
  };
  const driver = fixture([
    fauxAssistantMessage(
      [fauxToolCall("read_notes", { ids: [hidden.id], level: "full" })],
      { stopReason: "toolUse" },
    ),
    (transcript) => {
      expect(
        getCurrentTools(transcript.messages).map(({ name }) => name),
      ).toEqual(["submit_proof"]);
      expect(
        transcript.messages.findLast(
          (message) => message.role === "toolResult",
        ),
      ).toMatchObject({ toolName: "read_notes", isError: true });
      expect(JSON.stringify(transcript.messages)).not.toContain(hidden.text);
      return fauxAssistantMessage(
        [fauxToolCall("submit_proof", { proof: "Reflexivity." })],
        { stopReason: "toolUse" },
      );
    },
  ]);
  driver.book.notes = [hidden];
  const { harness, invoke } = await driver.open();
  try {
    expect(await invoke(input)).toMatchObject({
      value: { proof: "Reflexivity." },
    });
  } finally {
    await harness.close(context);
  }
});

test("message-limit recovery permits reading and admits only an explicit valid submission", async () => {
  const source = { id: "n1", text: "Equality is reflexive.", support: [] };
  const input: CallDescriptor = {
    ...descriptor,
    input: {
      ...descriptor.input,
      notes: project({ notes: [source], checks: [], guidance: [], inputs: [] })
        .notes,
    },
  };
  const interrupted = fauxAssistantMessage(
    JSON.stringify({
      notes: [
        { text: "UNSUBMITTED_DRAFT", summary: "Partial result.", support: [] },
      ],
    }),
    { stopReason: "length" },
  );
  interrupted.rawStopReason = "incomplete.max_messages";
  const corrected = { notes: [{ ...value.notes[0]!, support: [source.id] }] };
  const driver = fixture([
    interrupted,
    (transcript) => {
      const reminder = transcript.messages
        .filter((message) => message.role === "user")
        .at(-1)!.content;
      expect(reminder).toContain(roleGenerationPolicy.continuationPrompt);
      expect(reminder).toContain(
        "Ordinary assistant text does not submit the result.",
      );
      expect(reminder).toContain("call submit_notes with complete arguments");
      expect(
        getCurrentTools(transcript.messages).map(({ name }) => name),
      ).toEqual(["submit_notes", "read_notes"]);
      return fauxAssistantMessage(
        [fauxToolCall("read_notes", { ids: [source.id], level: "full" })],
        { stopReason: "toolUse" },
      );
    },
    (transcript) => {
      expect(
        transcript.messages.findLast(
          (message) => message.role === "toolResult",
        ),
      ).toMatchObject({
        toolName: "read_notes",
        isError: false,
        content: [{ type: "text", text: JSON.stringify([source.text]) }],
      });
      return submitted({
        notes: [{ ...corrected.notes[0]!, support: ["w1.1"] }],
      });
    },
    (transcript) => {
      const error = transcript.messages.findLast(
        (message) => message.role === "toolResult",
      );
      expect(error).toMatchObject({ toolName: "submit_notes", isError: true });
      expect(JSON.stringify(error)).toContain(
        "Note w1.1 must name distinct support IDs from: n1.",
      );
      return submitted(corrected);
    },
  ]);
  driver.book.notes = [source];
  const { harness, invoke } = await driver.open();
  try {
    const receipt = await invoke(input, { origin: "length-recovery" });
    expect(receipt.value).toEqual(corrected);
    expect(await invoke(input, { origin: "length-recovery" })).toEqual(receipt);
    expect(driver.provider.state.callCount).toBe(4);
    const entries = await harness.commit(async (tx) => {
      const conversations = await tx.scanConversations({}, 128);
      return (
        await Promise.all(
          conversations.items.map(({ id }) =>
            tx.scanEntries({ conversationId: id }, 128),
          ),
        )
      ).flatMap(({ items }) => items);
    }, context);
    const submissions = entries.filter(
      (entry) =>
        ToolResultEntry.is(entry) &&
        entry.model?.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "submit_notes" &&
            !message.isError,
        ),
    );
    expect(submissions.map(({ id }) => id)).toEqual([receipt.call]);
    expect(entries.flatMap((entry) => entry.model ?? [])).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        rawStopReason: "incomplete.max_messages",
        content: interrupted.content,
      }),
    );
  } finally {
    await harness.close(context);
  }
});

test.each(["stop", "length"] as const)(
  "plain %s responses cannot admit JSON or run an unbounded reminder loop",
  async (stopReason) => {
    const response = fauxAssistantMessage(JSON.stringify(value), {
      stopReason,
    });
    if (stopReason === "length")
      response.rawStopReason = "incomplete.max_messages";
    const count = stopReason === "stop" ? 1 : 9;
    const driver = fixture([
      ...Array.from({ length: count }, () => response),
      submitted(),
    ]);
    const { harness, invoke } = await driver.open();
    try {
      await expect(invoke()).rejects.toThrow(
        stopReason === "stop"
          ? "returned no submit_notes submission"
          : "exhausted 8 output-length continuations",
      );
      expect(driver.provider.state.callCount).toBe(count);
    } finally {
      await harness.close(context);
    }
  },
);

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
    expect(await invoke()).toMatchObject({ value });
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
    expect(await invoke()).toMatchObject({ value });
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
      const completed = await invoke().then(
        () => true,
        () => false,
      );
      expect(completed, failure).toBe(!fatal);
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
      expect(await invoke(), kind).toMatchObject({ value });
      expect(fixture_.provider.state.callCount, kind).toBe(2);
    } finally {
      await harness.close(context);
    }
  }
});

test.each(provenance.patches)(
  "installed $package patch matches the retained provenance",
  async (patch) => {
    const hash = async (path: string) =>
      createHash("sha256")
        .update(await readFile(join(import.meta.dir, "..", path)))
        .digest("hex");
    expect(await hash(patch.path)).toBe(patch.sha256);
    for (const [file, expected] of Object.entries(patch.files))
      expect(await hash(`node_modules/${patch.package}/${file}`), file).toBe(
        expected!,
      );
  },
);

test("two successful submissions fail closed and a replacement starts a fresh conversation", async () => {
  const driver = fixture([
    fauxAssistantMessage(
      [
        fauxToolCall("submit_notes", value),
        fauxToolCall("submit_notes", value),
      ],
      { stopReason: "toolUse" },
    ),
    submitted(),
  ]);
  const { harness, invoke } = await driver.open();
  try {
    await expect(invoke(descriptor, { origin: "ambiguous" })).rejects.toThrow(
      "submit_notes requires exactly one submission",
    );
    await expect(invoke(descriptor, { origin: "ambiguous" })).rejects.toThrow(
      "submit_notes requires exactly one submission",
    );
    expect(driver.provider.state.callCount).toBe(1);
    expect(
      await invoke(descriptor, { origin: "ambiguous", attempt: 1 }),
    ).toMatchObject({ value });
    expect(driver.provider.state.callCount).toBe(2);
  } finally {
    await harness.close(context);
  }
});

test("schema repairs allow response thirty-two and block the next request", async () => {
  const invalid = () =>
    submitted({ notes: [{ text: "Unjustified claim", support: ["n99"] }] });
  for (const count of [31, 32]) {
    const fixture_ = fixture([
      ...Array.from({ length: count }, invalid),
      submitted(),
    ]);
    const { harness, invoke } = await fixture_.open();
    try {
      const completed = await invoke().then(
        () => true,
        () => false,
      );
      expect(completed).toBe(count < 32);
      expect(fixture_.provider.state.callCount).toBe(Math.min(count + 1, 32));
    } finally {
      await harness.close(context);
    }
  }
});

test.each(["explorer", "selection"] as const)(
  "restart after %s receipt publication reuses the native conversation",
  async (role) => {
    const directory = await mkdtemp(join(tmpdir(), "xean-role-recovery-"));
    const input: CallDescriptor =
      role === "explorer"
        ? descriptor
        : {
            kind: "selection",
            input: { task: descriptor.input.task, notes: [], claimed: [] },
          };
    const result = role === "explorer" ? value : { verify: [] };
    const driver = fixture([
      fauxAssistantMessage([fauxToolCall(resolveCall(input).tool, result)], {
        stopReason: "toolUse",
      }),
    ]);
    let harness: Harness | undefined;
    try {
      const first = await driver.open(directory);
      harness = first.harness;
      const closed = Promise.withResolvers<void>();
      let closing = false;
      harness.observeCommits({
        advance: ({ changes }) => {
          if (
            !closing &&
            changes.some(
              (change) =>
                change.type === "entry" && ToolResultEntry.is(change.value),
            )
          ) {
            closing = true;
            void Promise.resolve()
              .then(() => first.harness.close(context))
              .then(closed.resolve, closed.reject);
          }
        },
        end: (end) => {
          if (end.kind === "listener_error") closed.reject(end.error);
        },
      });
      void first.invoke(input, { origin: "recovery" }).catch(() => {});
      await closed.promise;
      const second = await driver.open(directory);
      harness = second.harness;
      expect(await second.invoke(input, { origin: "recovery" })).toMatchObject({
        value: result,
      });
      const conversations = await harness.commit(
        (tx) => tx.scanConversations({}, 128),
        context,
      );
      expect(conversations.items).toHaveLength(2);
      expect(driver.provider.state.callCount).toBe(1);
    } finally {
      await harness?.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("a logical origin reuses its completed receipt and rejects changed Explorer input or profile", async () => {
  const fixture_ = fixture([submitted(), submitted()]);
  const { harness, invoke } = await fixture_.open();
  try {
    const original = await invoke(descriptor, { origin: "original" });
    const replayed = await invoke(descriptor, {
      origin: "original",
      attempt: 1,
    });
    expect(replayed).toEqual(original);
    expect(fixture_.provider.state.callCount).toBe(1);
    const changed: CallDescriptor = {
      ...descriptor,
      input: { ...descriptor.input, explorerGuidance: "Try another proof." },
    };
    await expect(
      invoke(changed, { origin: "original", attempt: 1 }),
    ).rejects.toThrow("Recovered role arguments do not match");
    await expect(
      invoke(descriptor, {
        origin: "original",
        profile: { provider: "test", model: "other", reasoning: "max" },
      }),
    ).rejects.toThrow("Recovered role arguments do not match");
    expect(await invoke(changed)).toMatchObject({ value });
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
    expect(await invoke()).toMatchObject({ value });
  } finally {
    await harness.close(context);
  }
});

test("frozen verification reuses its original assignment and receipt after later dependency evidence", async () => {
  const input: CallDescriptor = {
    kind: "verifier",
    name: "correctness",
    judged: ["n1"],
    input: {
      task: descriptor.input.task,
      verify: [{ note: "n1", verifiers: ["source", "correctness"] }],
      notes: [
        {
          id: "n1",
          text: "Equality is reflexive.",
          support: ["n0"],
          verdicts: [],
          checked: false,
          verified: false,
          dead: false,
        },
      ],
      support: [
        {
          id: "n0",
          text: "Declared prerequisite.",
          support: [],
          verdicts: [],
          checked: false,
          verified: false,
          dead: false,
        },
      ],
    },
  };
  const result = {
    verdicts: [{ note: "n1", verdict: "PASS", report: "Reflexivity." }],
  };
  const driver = fixture(
    [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Disconnected",
      }),
      (transcript) => {
        expect(JSON.stringify(transcript.messages)).not.toContain(
          "Later dependency evidence.",
        );
        return fauxAssistantMessage([fauxToolCall("submit_verdict", result)], {
          stopReason: "toolUse",
        });
      },
    ],
    undefined,
    false,
  );
  const { harness, invoke } = await driver.open();
  try {
    await expect(invoke(input, { origin: "verification" })).rejects.toThrow();
    const changed: CallDescriptor = {
      ...input,
      input: {
        ...input.input,
        support: input.input.support.map((note) => ({
          ...note,
          dead: true,
          verdicts: [
            {
              note: note.id,
              verifier: "source",
              verdict: "FAIL",
              report: "Later dependency evidence.",
            },
          ],
        })),
      },
    };
    await expect(invoke(changed, { origin: "verification" })).rejects.toThrow();
    expect(driver.provider.state.callCount).toBe(1);
    const completed = await invoke(changed, {
      origin: "verification",
      attempt: 1,
    });
    expect(completed).toMatchObject({ value: result });
    const recovered = await invoke(changed, {
      origin: "verification",
      attempt: 2,
    });
    expect(recovered).toEqual(completed);
    expect(driver.provider.state.callCount).toBe(2);
  } finally {
    await harness.close(context);
  }
});

test.each([
  "comparison failure",
  "comparison receipt",
  "dead after comparison receipt",
] as const)(
  "verification preserves frozen stages and complete atomic evidence after %s",
  async (interruption) => {
    let disconnected = false;
    const run = await workerFixture(
      ({ descriptor, transcript }): ReturnType<typeof complete> => {
        if (descriptor.kind === "explorer")
          return {
            notes: [
              note("ORIGINAL_LEMMA: equality is reflexive."),
              note("ORIGINAL_SOLUTION: hence P.", [
                `${descriptor.input.namespace}.1`,
              ]),
            ],
          };
        if (descriptor.kind === "selection")
          return {
            verify: descriptor.input.notes.map((note) => ({
              note: note.id,
              verifiers: [...verifierNames],
            })),
          };
        if (descriptor.kind === "proof") {
          expect(JSON.stringify(transcript.messages)).not.toContain(
            "ORIGINAL_",
          );
          expect(
            getCurrentTools(transcript.messages).map((tool) => tool.name),
          ).toEqual(["submit_proof"]);
        }
        if (descriptor.kind === "reconstruction") {
          if (interruption === "comparison failure" && !disconnected) {
            disconnected = true;
            return new Error("Comparison disconnected");
          }
          const values = checks(descriptor.input.notes.map((note) => note.id));
          if (interruption === "dead after comparison receipt")
            values.verdicts[1]!.verdict = "FAIL";
          return { statements: [], ...values };
        }
        return complete({ descriptor, transcript, signal: undefined });
      },
    );
    expect((await run.run({ kind: "explorer" })).outcome.kind).toBe("done");
    const closed = Promise.withResolvers<void>();
    let closing = false;
    if (interruption !== "comparison failure")
      run.owner.harness.observeCommits({
        advance: ({ changes }) => {
          if (
            !closing &&
            changes.some((change) => {
              if (change.type !== "entry" || !ToolResultEntry.is(change.value))
                return false;
              const message = change.value.model?.[0];
              return (
                message?.role === "toolResult" &&
                message.toolName === "submit_verdict" &&
                !message.isError &&
                message.details !== null &&
                typeof message.details === "object" &&
                !Array.isArray(message.details) &&
                "statements" in message.details
              );
            })
          ) {
            closing = true;
            void Promise.resolve()
              .then(() => run.owner.close())
              .then(closed.resolve, closed.reject);
          }
        },
        end: (end) => {
          if (end.kind === "listener_error") closed.reject(end.error);
        },
      });
    const first = await run.start({ kind: "verifier" });
    const pending = run.wait(first).catch(() => undefined);
    if (interruption === "comparison failure")
      expect((await pending)?.kind).toBe("failed");
    else {
      await closed.promise;
      await pending;
    }
    const before = await run.book();
    expect(before.checks.map((check) => check.values.length)).toEqual([
      2, 2, 2,
    ]);
    const candidate = before.checks[0]!.candidate;
    const originalComparison = run.requests.find(
      (request) => request.descriptor.kind === "reconstruction",
    )!.descriptor;
    const count = run.provider.state.callCount;
    await run.reopen(false);
    await run.owner.change((draft) => {
      draft.notebook.checks.push({
        candidate: "another-attempt",
        call: "another-call",
        values: [
          {
            note: before.notes[0]!.id,
            verifier:
              interruption === "dead after comparison receipt"
                ? "source"
                : "requirements",
            verdict:
              interruption === "dead after comparison receipt"
                ? "FAIL"
                : "INCONCLUSIVE",
            report: "Evidence committed by another verification attempt.",
          },
        ],
      });
    });
    await run.reopen(true);
    if (interruption === "comparison failure")
      expect(
        (await run.run({ kind: "retry", job: first.id })).outcome.kind,
      ).toBe("done");
    else expect((await run.finished(first.id)).status).toBe("completed");
    const final = await run.book();
    const own = final.checks.filter((check) => check.candidate === candidate);
    expect(own).toHaveLength(4);
    expect(own.slice(0, 3)).toEqual(before.checks);
    expect(
      own.at(-1)!.values.map((value) => [value.note, value.verdict]),
    ).toEqual([
      [before.notes[0]!.id, "PASS"],
      [
        before.notes[1]!.id,
        interruption === "dead after comparison receipt" ? "FAIL" : "PASS",
      ],
    ]);
    expect(
      run.requests.filter((request) => request.descriptor.kind === "statement"),
    ).toHaveLength(1);
    expect(
      run.requests.filter((request) => request.descriptor.kind === "proof"),
    ).toHaveLength(1);
    expect(
      run.requests.findLast(
        (request) => request.descriptor.kind === "reconstruction",
      )!.descriptor,
    ).toEqual(originalComparison);
    expect(run.provider.state.callCount).toBe(
      count + (interruption === "comparison failure" ? 1 : 0),
    );
    expect(project(final).accepted).toEqual(
      interruption === "dead after comparison receipt"
        ? []
        : before.notes.map((note) => note.id),
    );
  },
);
