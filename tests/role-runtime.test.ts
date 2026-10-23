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
  ROOT_CONVERSATION_ID,
  type EntryId,
  type TaskId,
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
import {
  coordinatorUpdate,
  resolveCall,
  type CallDescriptor,
} from "../src/policy/prompts.ts";
import { open, inspect } from "../src/host.ts";
import { readReport } from "../src/report.ts";
import { solveSettings, type PiRoleProfile } from "../src/policy/settings.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import { Notebook, project } from "../src/state.ts";
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
  const role = createRoleRuntime();
  const Invoke = defineTask<
    {
      descriptor: CallDescriptor;
      previousTasks: TaskId[];
      profile: PiRoleProfile;
    },
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
          task.input.profile,
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
            ...(headers ? { stream: { headers } } : {}),
          },
        },
        context,
      );
      const root = await harness.root(context);
      return {
        harness,
        async invoke(
          previousTasks: TaskId[] = [],
          input = descriptor,
          profile: PiRoleProfile = {
            provider: "test",
            model: "math",
            reasoning: "max",
          },
        ) {
          return root.commit(
            (tx) =>
              tx.createTask(
                Invoke,
                { descriptor: input, previousTasks, profile },
                { ownership: { kind: "conversation" } },
              ),
            context,
          );
        },
      };
    },
  };
}

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

test("Explorer reads indexed notes at both levels, repairs an unknown ID and preserves large batched texts", async () => {
  const sources = [
    {
      id: "n1",
      summary: "First claim.",
      detailedSummary: "First exact conditions.",
      text: "A".repeat(60_000) + " FIRST_END_α",
      support: [],
    },
    {
      id: "n2",
      summary: "Second claim.",
      text: "B".repeat(60_000) + " SECOND_END_β",
      support: [],
    },
  ];
  const notes = project({
    notes: sources,
    checks: [],
    guidance: [],
    inputs: [],
  }).notes;
  const input: CallDescriptor = {
    kind: "explorer",
    input: {
      ...descriptor.input,
      notes: notes.map(({ text, detailedSummary, ...index }) => index),
      support: [notes[0]!],
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
      return read(["n1", "n2"], "full");
    },
    (transcript) => {
      expect(
        JSON.parse(resultText(transcript)).map(
          (entry: { text: string }) => entry.text,
        ),
      ).toEqual(sources.map(({ text }) => text));
      expect(
        transcript.messages.filter((message) => message.role === "toolResult"),
      ).toHaveLength(3);
      expect(
        transcript.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1);
      return submitted(result);
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    const root = await harness.root(context);
    await root.commit(async (tx) => {
      (await tx.doc(Notebook, ROOT_CONVERSATION_ID)).notes = sources;
    }, context);
    expect(
      (await harness.waitForTask(await invoke([], input), context)).state
        .outcome,
    ).toMatchObject({
      status: "completed",
      result: { value: result, fresh: true },
    });
    expect(fixture_.provider.state.callCount).toBe(4);
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

test("Coordinator disables provider constraints while retaining its prompt, schema and contextual validation", async () => {
  const input: CallDescriptor = {
    kind: "coordinator",
    input: {
      task: descriptor.input.task,
      notes: [
        {
          id: "n1",
          text: "Given P. ".repeat(50),
          summary: "P holds.",
          support: [],
          verdicts: [],
          verified: true,
          dead: false,
          verification: { source: "Given premise", report: "Assumed correct." },
        },
      ],
    },
  };
  const call = await resolveCall(input);
  const coordination = {
    filings: [],
    explorerGuidance: "Prove the claim.",
    support: [],
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
        name: "submit_coordination",
        parameters: z.toJSONSchema(call.schema),
        strict: false,
      });
      return fauxAssistantMessage(
        [fauxToolCall(call.tool, { ...coordination, support: ["n99"] })],
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
      ).toEqual([
        ["user", call.prompt],
        ["user", coordinatorUpdate(input.input, input.input)!],
      ]);
      return fauxAssistantMessage([fauxToolCall(call.tool, coordination)], {
        stopReason: "toolUse",
      });
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    expect(
      (await harness.waitForTask(await invoke([], input), context)).state
        .outcome,
    ).toMatchObject({ status: "completed", result: { value: coordination } });
    expect(fixture_.provider.state.callCount).toBe(2);
    expect(
      (await harness.waitForTask(await invoke([], input), context)).state
        .outcome.status,
    ).toBe("completed");
    expect(fixture_.provider.state.callCount).toBe(3);
  } finally {
    await harness.close(context);
  }
});

test("Coordinator rewinds whole input messages for corrections and size while preserving exact notebook state", async () => {
  const initial: Extract<CallDescriptor, { kind: "coordinator" }> = {
    kind: "coordinator",
    input: {
      task: { ...descriptor.input.task, problem: "Prove 1 = 1. ".repeat(50) },
      notes: [
        {
          id: "n1",
          text: "Reflexivity: x = x.",
          support: [],
          verdicts: [],
          verified: true,
          dead: false,
          verification: { source: "Given premise", report: "Assumed correct." },
        },
      ],
    },
  };
  const updated: typeof initial = {
    ...initial,
    input: {
      ...initial.input,
      notes: [
        { ...initial.input.notes[0]!, summary: "Reflexivity holds." },
        {
          id: "n2",
          text: "New partial argument.",
          support: ["n1"],
          verdicts: [],
          verified: false,
          dead: false,
        },
      ],
    },
  };
  const dead: typeof initial = {
    ...updated,
    input: {
      ...updated.input,
      notes: updated.input.notes.map((note) => ({
        ...note,
        summary: note.summary ?? "New claim.",
        dead: true,
        verified: false,
      })),
    },
  };
  const corrected: typeof initial = {
    ...dead,
    input: {
      ...dead.input,
      notes: dead.input.notes.map((note) => ({
        ...note,
        summary:
          note.id === "n1" ? "Corrected reflexivity claim." : note.summary,
      })),
    },
  };
  const incompatible: typeof initial = {
    ...corrected,
    input: {
      ...corrected.input,
      notes: corrected.input.notes.map((note) => ({
        ...note,
        text: "Changed base proof.",
      })),
    },
  };
  const differentTask: typeof initial = {
    ...incompatible,
    input: {
      ...incompatible.input,
      task: { problem: "Prove Q.", completionCriteria: "Prove Q fully." },
    },
  };
  const assignments: CallDescriptor[] = [
    initial,
    updated,
    dead,
    corrected,
    ...Array(12).fill(corrected),
    incompatible,
    differentTask,
    differentTask,
    descriptor,
    updated,
  ];
  const fullSnapshotStart = 16;
  const modelChangeIndex = assignments.length - 3;
  const calls = await Promise.all(assignments.map(resolveCall));
  const inputs = [
    [calls[0]!.prompt],
    [calls[0]!.prompt, coordinatorUpdate(initial.input, updated.input)!],
    [
      calls[0]!.prompt,
      coordinatorUpdate(initial.input, updated.input)!,
      coordinatorUpdate(updated.input, dead.input)!,
    ],
    [calls[0]!.prompt, coordinatorUpdate(initial.input, corrected.input)!],
  ];
  const headers = { "x-existing-header": "preserved" };
  const requests: {
    sessionId?: string;
    headers?: Record<string, string | null>;
    body: Record<string, unknown>;
  }[] = [];
  const capture: FauxResponseStep = async (
    transcript,
    options,
    _state,
    model,
  ) => {
    const index = requests.length,
      call = calls[index]!;
    expect(
      transcript.messages.filter(
        (message) =>
          message.role === "assistant" || message.role === "toolResult",
      ),
    ).toHaveLength(0);
    let body: Record<string, unknown> | undefined;
    const captured = await responsesStream(
      {
        ...model,
        api: "openai-responses",
        compat: { supportsStrictMode: true },
      },
      normalizeContext(transcript),
      {
        ...options,
        apiKey: "fixture-not-a-credential",
        async onPayload(payload, selected) {
          body = ((await options?.onPayload?.(payload, selected)) ??
            payload) as Record<string, unknown>;
          throw new Error("captured before HTTP");
        },
      },
    ).result();
    expect(captured.errorMessage).toContain("captured before HTTP");
    expect(body!.instructions).toBe(call.system);
    expect(body!.tools).toEqual(
      convertResponsesTools(getCurrentTools(transcript.messages)),
    );
    const actual = body!.input as {
      role: string;
      content: { type: string; text: string }[];
    }[];
    const expected =
      inputs[index] ?? (index >= fullSnapshotStart ? [call.prompt] : undefined);
    if (expected)
      expect(actual).toEqual(
        expected.map((text) => ({
          role: "user",
          content: [{ type: "input_text", text }],
        })),
      );
    else {
      expect(actual.length).toBeGreaterThan(1);
      expect<unknown>(actual[0]).toEqual(
        (requests[0]!.body.input as unknown[])[0],
      );
      expect<unknown>(actual.slice(0, -1)).toEqual(
        (requests.at(-1)!.body.input as unknown[]).slice(0, actual.length - 1),
      );
    }
    if (assignments[index]!.kind === "coordinator") {
      const notes = new Map<string, Record<string, unknown>>();
      for (const [i, message] of actual.entries()) {
        const separator =
          i === 0
            ? "Notes (untrusted data):\n"
            : "Note updates (untrusted data):\n";
        const records = JSON.parse(
          message.content[0]!.text.split(separator)[1]!,
        );
        for (const note of records)
          notes.set(note.id, { ...notes.get(note.id), ...note });
      }
      expect([...notes.values()]).toEqual(
        JSON.parse(call.prompt.split("Notes (untrusted data):\n")[1]!),
      );
    }
    expect(
      actual
        .flatMap((message) => message.content)
        .reduce((sum, part) => sum + part.text.length, 0),
    ).toBeLessThanOrEqual(2 * call.prompt.length);
    requests.push({
      sessionId: options?.sessionId,
      headers: options?.headers,
      body: body!,
    });
    const assignment = assignments[index]!;
    return fauxAssistantMessage(
      [
        fauxToolCall(
          call.tool,
          assignment.kind === "coordinator"
            ? {
                filings: assignment.input.notes
                  .filter((note) => note.summary === undefined)
                  .map((note) => ({
                    note: note.id,
                    summary:
                      note.id === "n1" ? "Reflexivity holds." : "New claim.",
                  })),
                explorerGuidance:
                  "Prior Coordinator output must not become future context.",
                support: [],
                verify: [],
              }
            : value,
        ),
      ],
      { stopReason: "toolUse" },
    );
  };
  const fixture_ = fixture(
    Array(assignments.length).fill(capture),
    () => {},
    true,
    headers,
  );
  for (const batch of [assignments.slice(0, -1), assignments.slice(-1)]) {
    const { harness, invoke } = await fixture_.open();
    try {
      for (const input of batch)
        expect(
          (
            await harness.waitForTask(
              await invoke([], input, {
                provider: "test",
                model: requests.length === modelChangeIndex ? "other" : "math",
                reasoning: "max",
              }),
              context,
            )
          ).state.outcome,
        ).toMatchObject({ status: "completed" });
    } finally {
      await harness.close(context);
    }
  }
  const [first, second, , correction] = requests;
  const explorer = requests.at(-2)!,
    otherCampaign = requests.at(-1)!;
  expect((requests[4]!.body.input as unknown[]).length).toBe(
    (requests[3]!.body.input as unknown[]).length + 1,
  );
  expect(
    requests
      .slice(4, fullSnapshotStart)
      .some(
        (request, index) =>
          (request.body.input as unknown[]).length <=
          (requests[index + 3]!.body.input as unknown[]).length,
      ),
  ).toBe(true);
  expect(requests.map((request) => request.sessionId)).toEqual(
    Array(assignments.length).fill(expect.any(String)),
  );
  expect(new Set(requests.map((request) => request.sessionId)).size).toBe(
    assignments.length,
  );
  expect<unknown>(first!.headers).toEqual({
    ...headers,
    session_id: expect.any(String),
    "x-client-request-id": first!.headers!.session_id,
  });
  expect(second!.headers).toEqual(first!.headers);
  expect(correction!.headers).toEqual(first!.headers);
  expect(otherCampaign!.headers!.session_id).not.toBe(
    first!.headers!.session_id,
  );
  expect(otherCampaign!.headers!["x-client-request-id"]).toBe(
    otherCampaign!.headers!.session_id,
  );
  expect(explorer!.headers).toEqual(headers);
  expect((second!.body.input as unknown[])[0]).toEqual(
    (first!.body.input as unknown[])[0],
  );
  const { input: _firstInput, ...settings } = first!.body;
  for (const request of [second!, correction!, otherCampaign!]) {
    const { input: _input, ...currentSettings } = request.body;
    expect(currentSettings).toEqual(settings);
  }
});

test("a failed Coordinator call never advances the notebook input boundary", async () => {
  const input: CallDescriptor = {
    kind: "coordinator",
    input: {
      task: descriptor.input.task,
      notes: [
        {
          id: "n1",
          text: "Uncommitted notebook input. ".repeat(30),
          summary: "A claim.",
          support: [],
          verdicts: [],
          verified: false,
          dead: false,
        },
      ],
    },
  };
  const call = await resolveCall(input);
  const fixture_ = fixture([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "Invalid API key",
    }),
    (transcript) => {
      expect(
        transcript.messages
          .filter((message) => message.role !== "system")
          .map((message) => [message.role, message.content]),
      ).toEqual([["user", call.prompt]]);
      return fauxAssistantMessage(
        [
          fauxToolCall(call.tool, {
            filings: [],
            explorerGuidance: "Try the proof.",
            support: [],
            verify: [],
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
  ]);
  const { harness, invoke } = await fixture_.open();
  try {
    expect(
      (await harness.waitForTask(await invoke([], input), context)).state
        .outcome.status,
    ).not.toBe("completed");
    expect(
      (await harness.waitForTask(await invoke([], input), context)).state
        .outcome,
    ).toMatchObject({ status: "completed" });
    expect(fixture_.provider.state.callCount).toBe(2);
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

test.each(["explorer", "coordinator"] as const)(
  "restart after %s receipt publication reuses the native conversation",
  async (role) => {
    const directory = await mkdtemp(join(tmpdir(), "xean-role-recovery-"));
    const initial: Extract<CallDescriptor, { kind: "coordinator" }> = {
      kind: "coordinator",
      input: {
        task: { ...descriptor.input.task, problem: "Prove 1 = 1. ".repeat(50) },
        notes: [
          {
            id: "n1",
            text: "Reflexivity: x = x.",
            support: [],
            verdicts: [],
            verified: false,
            dead: false,
          },
        ],
      },
    };
    const updated: typeof initial = {
      ...initial,
      input: {
        ...initial.input,
        notes: [{ ...initial.input.notes[0]!, summary: "P holds." }],
      },
    };
    const corrected: typeof initial = {
      ...updated,
      input: {
        ...updated.input,
        notes: [{ ...updated.input.notes[0]!, summary: "Corrected claim." }],
      },
    };
    const coordination = {
      filings: [],
      explorerGuidance: "Try the proof.",
      support: [],
      verify: [],
    };
    const answer = (filings: { note: string; summary: string }[]) =>
      fauxAssistantMessage(
        [fauxToolCall("submit_coordination", { ...coordination, filings })],
        { stopReason: "toolUse" },
      );
    const fixture_ = fixture(
      role === "coordinator"
        ? [
            answer([{ note: "n1", summary: "P holds." }]),
            answer([]),
            async (transcript) => {
              expect(
                transcript.messages
                  .filter((message) => message.role !== "system")
                  .map((message) => [message.role, message.content]),
              ).toEqual([
                ["user", (await resolveCall(initial)).prompt],
                ["user", coordinatorUpdate(initial.input, corrected.input)!],
              ]);
              return answer([]);
            },
          ]
        : [submitted()],
    );
    let harness: Harness | undefined;
    try {
      const first = await fixture_.open(directory);
      harness = first.harness;
      if (role === "coordinator")
        for (const input of [initial, updated])
          expect(
            (await harness.waitForTask(await first.invoke([], input), context))
              .state.outcome.status,
          ).toBe("completed");
      const closed = Promise.withResolvers<void>();
      let closing = false;
      harness.subscribeCommits(({ changes }) => {
        if (
          !closing &&
          changes.some((change) =>
            role === "coordinator"
              ? change.type === "document" &&
                change.record.kind === "xean.coordinator.prefix" &&
                change.value?.latest !== undefined
              : change.type === "entry" && ToolResultEntry.is(change.value),
          )
        ) {
          closing = true;
          void first.harness.close(context).then(closed.resolve, closed.reject);
        }
      });
      const id = await first.invoke(
        [],
        role === "coordinator" ? corrected : descriptor,
      );
      void harness.waitForTask(id, context).catch(() => {});
      await closed.promise;
      harness = (await fixture_.open(directory)).harness;
      expect(
        (await harness.waitForTask(id, context)).state.outcome,
      ).toMatchObject({
        status: "completed",
        result: {
          value: role === "coordinator" ? coordination : value,
          fresh: false,
        },
      });
      expect(fixture_.provider.state.callCount).toBe(
        role === "coordinator" ? 3 : 1,
      );
    } finally {
      await harness?.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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

test.each(["comparison failure", "comparison receipt"] as const)(
  "native reconstruction batch recovers after %s without partial verdicts or repeated proof stages",
  async (interruption) => {
    const directory = await mkdtemp(join(tmpdir(), "xean-native-workflow-"));
    const path = join(directory, "campaign.sqlite");
    const provider = fauxProvider({
      provider: "test",
      models: [{ id: "math", reasoning: true }],
    });
    const models = createModels();
    models.setProvider(provider.provider);
    const pass = (ids: string[]) => ({
      verdicts: ids.map((note) => ({
        note,
        verdict: "PASS" as const,
        report: "The claim is established.",
      })),
    });
    const batch = ["n1", "n2"];
    const comparison = { statements: [], ...pass(batch) };
    const responses: Record<string, JsonValue>[] = [
      {
        notes: [
          { text: "ORIGINAL_LEMMA: equality is reflexive.", support: [] },
          { text: "ORIGINAL_SOLUTION: hence 1 = 1.", support: ["n1"] },
        ],
      },
      {
        filings: batch.map((note) => ({ note, summary: `Claim ${note}.` })),
        explorerGuidance: "Verify the proof.",
        support: [],
        verify: [
          { note: "n1", verifiers: ["source", "correctness"] },
          { note: "n2", verifiers: [...verifierNames] },
        ],
      },
      pass(batch),
      pass(batch),
      pass(["n2"]),
      {
        statements: batch.map((note) => ({
          note,
          statement: note === "n1" ? "Equality is reflexive." : "1 = 1.",
        })),
      },
      { proof: "Equality is reflexive." },
      comparison,
    ];
    const tools: string[] = [];
    provider.setResponses([
      ...responses.map((response, index) => (transcript: TranscriptContext) => {
        const declaration = getCurrentTools(transcript.messages)[0]!;
        const name = declaration.name;
        const expected = Object.values(historical.contracts).find(
          (contract) => contract.name === name,
        );
        expect<unknown>(declaration.constrainedSampling).toEqual(
          name === "submit_coordination"
            ? false
            : expected?.constrainedSampling,
        );
        expect(convertResponsesTools([declaration])[0]).toMatchObject({
          strict: name !== "submit_coordination",
        });
        tools.push(name);
        if (name === "submit_proof") {
          expect(JSON.stringify(transcript.messages)).not.toContain(
            "ORIGINAL_",
          );
          expect(JSON.stringify(transcript.messages)).toContain(
            "Equality is reflexive.",
          );
          expect(JSON.stringify(transcript.messages)).toContain("1 = 1.");
        }
        if (
          interruption === "comparison failure" &&
          index === responses.length - 1
        )
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "provider disconnected",
          });
        return fauxAssistantMessage([fauxToolCall(name, response)], {
          stopReason: "toolUse",
        });
      }),
      (transcript) => {
        const name = getCurrentTools(transcript.messages)[0]!.name;
        tools.push(name);
        expect(name).toBe("submit_verdict");
        return fauxAssistantMessage([fauxToolCall(name, comparison)], {
          stopReason: "toolUse",
        });
      },
    ]);
    const settings = solveSettings.parse({
      ...Object.fromEntries(
        ["explorer", "coordinator", ...verifierNames].map((name) => [
          name,
          { provider: "test", model: "math", reasoning: "max" },
        ]),
      ),
      maxExplorerTurns: 1,
    });
    let owner = await open(path, {
      models,
      create: { task: descriptor.input.task, settings },
    });
    try {
      if (interruption === "comparison receipt") {
        const closed = Promise.withResolvers<void>();
        let closing = false;
        owner.harness.subscribeCommits(({ changes }) => {
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
                typeof message.details === "object" &&
                message.details !== null &&
                !Array.isArray(message.details) &&
                "statements" in message.details &&
                Array.isArray(message.details.statements) &&
                message.details.statements.length === 0
              );
            })
          ) {
            closing = true;
            void owner.close().then(closed.resolve, closed.reject);
          }
        });
        void owner.root.waitForIdle(context).catch(() => {});
        await closed.promise;
      } else {
        await owner.root.waitForIdle(context);
      }
      const before = await inspect(path, readReport);
      if (interruption === "comparison failure")
        expect(before.status).toMatchObject({
          outcome: "call-failure",
          error: "verifier failed: provider disconnected",
        });
      expect(before.accepted).toEqual([]);
      expect(before.checks.map((check) => check.values.length)).toEqual([
        2, 2, 1,
      ]);
      expect(
        before.notes
          .flatMap((note) => note.verdicts)
          .every((verdict) => verdict.verifier !== "reconstruction"),
      ).toBe(true);
      expect(provider.state.callCount).toBe(8);
      await owner.close();
      owner = await open(path, { models });
      if (interruption === "comparison failure") {
        await owner.root.waitForIdle(context);
        expect(provider.state.callCount).toBe(8);
        await owner.resume();
      }
      await owner.root.waitForIdle(context);
      const report = await inspect(path, readReport);
      expect(report.status).toMatchObject({
        outcome: "accepted",
        accepted: "n2",
      });
      expect(
        report.notes[1]?.verdicts.map((verdict) => verdict.verifier),
      ).toEqual([...verifierNames]);
      expect(
        report.notes[0]?.verdicts.map((verdict) => verdict.verifier),
      ).toEqual(["source", "correctness", "reconstruction"]);
      expect(report.checks).toHaveLength(4);
      expect(report.checks.at(-1)?.values).toEqual(
        comparison.verdicts.map((verdict) => ({
          ...verdict,
          verifier: "reconstruction",
        })),
      );
      expect(new Set(report.checks.map((check) => check.call)).size).toBe(4);
      expect(new Set(report.checks.map((check) => check.candidate))).toEqual(
        new Set(before.checks.map((check) => check.candidate)),
      );
      expect(tools).toEqual([
        "submit_notes",
        "submit_coordination",
        "submit_verdict",
        "submit_verdict",
        "submit_verdict",
        "submit_statement",
        "submit_proof",
        "submit_verdict",
        ...(interruption === "comparison failure" ? ["submit_verdict"] : []),
      ]);
      expect(provider.state.callCount).toBe(
        interruption === "comparison failure" ? 9 : 8,
      );
    } finally {
      await owner.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
