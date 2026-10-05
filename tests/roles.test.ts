import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { watchFile, unwatchFile } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  registerSessionResourceCleanup,
  type AssistantMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  ToolResultEntry,
  type Cursor,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  createRoles,
  type CoordinationInput,
  type RoleOptions,
} from "../src/roles/index.ts";
import type { RoleRuntime } from "../src/roles/types.ts";
import { closedBookResearch, type Research } from "../src/roles/research.ts";
import { createRuntime } from "../src/config.ts";
import { CodexLog, CodexRequest } from "../src/roles/codex.ts";
import type { Note, SolverResult } from "../src/math/contracts.ts";
import { resolveResult, type SubmissionResult } from "../src/math/results.ts";
import { DefinitionDoc, type Definition } from "../src/definition.ts";
import { createResearch } from "../src/workflow.ts";
import { readReport, readUsage } from "../src/report.ts";
import { readView } from "../src/math/state.ts";
import type { TaskId } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
async function resultOf(harness: Harness, id: TaskId<JsonValue>) {
  const outcome = (await harness.waitForTask(id, context)).state.outcome;
  return outcome.status === "completed"
    ? {
        ...outcome,
        result: await harness.commit(
          (tx) => resolveResult(tx, outcome.result),
          context,
        ),
      }
    : outcome;
}
const task = {
  problem: "Prove the exact claim",
  completionCriteria: "Give a complete proof.",
};
const draft = (id: string, support: string[] = []) => ({
  id,
  summary: `${id} claim`,
  detailedSummary: `${id} detailed claim`,
  statement: `${id} exact claim`,
  argument: `${id} secret original proof`,
  support,
});
const note = (id: string, support: string[] = []): Note => ({
  ...draft(id, support),
  revision: 0,
  imported: false,
  checks: [],
  verified: false,
  dead: false,
  accepted: false,
  candidate: false,
});
type Invocation = {
  role:
    "coordinator" | "explorer" | "verifier" | "literature" | "review" | "codex";
  input: JsonValue;
};

function fixture(
  respond: (name: string, input: any, transcript: TranscriptContext) => unknown,
  options: Omit<RoleOptions, "profiles"> = { research: false },
  contextWindow = 131072,
  research?: Research,
) {
  const provider = fauxProvider({
    provider: "openai",
    models: [{ id: "roles", reasoning: true, contextWindow, maxTokens: 8192 }],
  });
  const supplied = createModels();
  supplied.setProvider(provider.provider);
  const { models, profiles } = createRuntime(
    {
      profiles: { default: { provider: "openai", model: "roles" } },
      maxExplorerReads: options.maxExplorerReads,
      maxExplorerResponses: options.maxExplorerResponses,
    },
    { models: supplied },
  );
  const calls: {
    name: string;
    input: any;
    session?: string;
    transcript: TranscriptContext;
  }[] = [];
  const next: FauxResponseFactory = (transcript, streamOptions) => {
    provider.appendResponses([next]);
    const name = getCurrentTools(transcript.messages)
      .find((tool) => tool.name.startsWith("submit_"))!
      .name.slice("submit_".length);
    const last = transcript.messages
      .filter((message) => message.role === "user")
      .at(-1)!;
    let input: unknown;
    try {
      input = JSON.parse(last.content as string);
    } catch {
      input = last.content;
    }
    calls.push({
      name,
      input,
      session: streamOptions?.sessionId,
      transcript: structuredClone(transcript),
    });
    const value = respond(name, input, transcript);
    if (typeof value === "string") return fauxAssistantMessage(value);
    if (
      value &&
      typeof value === "object" &&
      "role" in value &&
      value.role === "assistant"
    )
      return value as AssistantMessage;
    if (value && typeof value === "object" && "tool" in value) {
      const request = value as {
        tool: string;
        arguments: Record<string, JsonValue>;
      };
      return fauxAssistantMessage(
        [fauxToolCall(request.tool, request.arguments)],
        { stopReason: "toolUse" },
      );
    }
    return fauxAssistantMessage(
      [fauxToolCall(`submit_${name}`, value as Record<string, JsonValue>)],
      { stopReason: "toolUse" },
    );
  };
  provider.setResponses([next]);
  const roles = createRoles({ ...options, profiles }, research);
  let activeHarness: Harness;
  const workflow = createResearch(roles, (id, context) =>
    activeHarness.abortTask(id, context),
  );
  const Invoke = defineTask<Invocation, { phase: "run" }, JsonValue, object>({
    name: "test.role",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(record, runtime, ctx) {
        const invoke = roles[record.input.role] as (
          input: any,
          runtime: RoleRuntime,
          context: Context,
        ) => Promise<JsonValue>;
        const result = await invoke(record.input.input, runtime, ctx);
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result },
          }),
          ctx,
        );
      },
    },
    async abort(_record, runtime, ctx) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  async function open(
    directory: string,
    definition?: Definition,
    retry = false,
  ) {
    const registry = createRegistry();
    registry.install(roles.extension);
    registry.install(workflow.extension);
    registry.install(defineExtension({ name: "test.roles", tasks: [Invoke] }));
    const harness = await Harness.open(
      await openNodeJsonlStorage(directory, context, { fsync: true }),
      {
        registry,
        models,
        settings: {
          compaction: { enabled: false },
          retry: { enabled: retry, baseDelayMs: 0 },
          toolExecution: "sequential",
        },
      },
      context,
    );
    activeHarness = harness;
    const root = await harness.root(context, {
      ...(definition
        ? {
            init: async (tx, id) => {
              Object.assign(await tx.doc(DefinitionDoc, id), definition);
            },
          }
        : {}),
    });
    return { harness, root };
  }
  return { calls, roles, Invoke, workflow, open };
}

async function entries(harness: Harness): Promise<EntryRecord[]> {
  return harness.commit(async (tx) => {
    const result: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({}, 128, cursor);
      for (const conversation of page.items) {
        let at: Cursor | undefined;
        do {
          const records = await tx.scanEntries(
            { conversationId: conversation.id },
            128,
            at,
          );
          result.push(...records.items);
          at = records.next;
        } while (at);
      }
      cursor = page.next;
    } while (cursor);
    return result;
  }, context);
}

test("Explorer retains frozen reads and private submissions across native reopen", async () => {
  const cleaned: (string | undefined)[] = [];
  const unregister = registerSessionResourceCleanup((sessionId) =>
    cleaned.push(sessionId),
  );
  const directory = await mkdtemp(join(tmpdir(), "pi-role-explorer-"));
  const inputNote = { ...note("prior"), imported: true, verified: true };
  let response = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      response++;
      const failure = transcript.messages.find(
        (message) => message.role === "toolResult" && message.isError,
      );
      if (failure) throw new Error(JSON.stringify(failure));
      if (response === 1) {
        expect(input).toMatchObject({
          task,
          notes: [{ id: inputNote.id, summary: inputNote.summary }],
        });
        expect(JSON.stringify(transcript)).not.toContain(inputNote.argument);
        expect(JSON.stringify(transcript)).not.toContain(
          inputNote.detailedSummary,
        );
        return {
          tool: "read_notes",
          arguments: { ids: ["prior"], level: "full" },
        };
      }
      if (response === 2)
        return { notes: [draft("n1", ["prior"])], candidate: false };
      expect(JSON.stringify(transcript)).toContain(
        "prior secret original proof",
      );
      return { notes: [draft("n2", ["n1"])], candidate: true };
    },
    { research: false, maxExplorerReads: 1, maxExplorerResponses: 4 },
  );
  let current = await provider.open(directory, {
    task,
    settings: {
      profiles: { default: { provider: "openai", model: "roles" } },
      research: false,
      maxExplorerReads: 1,
      maxExplorerResponses: 4,
    },
    mode: {
      role: "explorer",
      input: { notes: [inputNote], guidance: "Continue." },
    },
  });
  try {
    const closed = Promise.withResolvers<void>();
    let closing = false;
    current.harness.subscribeCommits(({ changes }) => {
      if (
        !closing &&
        changes.some(
          (change) =>
            change.type === "entry" &&
            ToolResultEntry.is(change.value) &&
            change.value.model?.some(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "submit_explorer" &&
                !message.isError,
            ),
        )
      ) {
        closing = true;
        void current.harness.close(context).then(closed.resolve, closed.reject);
      }
    });
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.workflow.Worker,
          { standalone: true },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    current.harness.resume();
    await Promise.race([
      closed.promise,
      current.harness.waitForTask(id, context).then(
        (record) => {
          throw new Error(JSON.stringify(record.state.outcome));
        },
        (error) => {
          if (!closing) throw error;
          return closed.promise;
        },
      ),
    ]);
    expect(provider.calls).toHaveLength(2);
    expect(cleaned).toEqual([provider.calls[0]!.session]);
    current = await provider.open(directory);
    const raw = (await current.harness.waitForTask(id, context)).state.outcome;
    expect(raw.status).toBe("completed");
    if (raw.status !== "completed") throw new Error(JSON.stringify(raw));
    const reference = raw.result as SubmissionResult;
    const outcome = await resultOf(current.harness, id);
    const expected = {
      kind: "notes",
      candidate: true,
      notes: [draft("n1", ["prior"]), draft("n2", ["n1"])],
    };
    expect(outcome).toEqual({
      status: "completed",
      result: expected,
    });
    expect(provider.calls).toHaveLength(3);
    expect(cleaned).toEqual([
      provider.calls[0]!.session,
      provider.calls[0]!.session,
    ]);
    expect(new Set(provider.calls.map(({ session }) => session)).size).toBe(1);
    const retained = await entries(current.harness);
    const submitted = retained
      .filter(
        (entry) =>
          ToolResultEntry.is(entry) &&
          entry.model?.some(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "submit_explorer" &&
              !message.isError,
          ),
      )
      .sort((a, b) => a.id - b.id);
    expect(reference).toEqual({
      kind: "submissions",
      entries: submitted.map(({ id }) => id),
    });
    expect(submitted).toHaveLength(2);
    expect(
      submitted.map((entry) => {
        const message = entry.model![0]!;
        if (message.role !== "toolResult")
          throw new Error("Expected native tool result");
        return message.details;
      }),
    ).toEqual([
      { notes: [draft("n1", ["prior"])], candidate: false },
      { notes: [draft("n2", ["n1"])], candidate: true },
    ]);
    expect(
      retained.filter(
        (entry) =>
          ToolResultEntry.is(entry) &&
          entry.model?.some(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "read_notes",
          ),
      ),
    ).toHaveLength(1);
    await current.harness.close(context);
    current = await provider.open(directory);
    expect(
      (await current.harness.waitForTask(id, context)).state.outcome,
    ).toEqual(raw);
    const report = await current.root.commit(
      (tx) => readReport(tx, current.root.id),
      context,
    );
    expect(report.status.status).toBe("completed");
    expect(report.result).toEqual(expected);
    expect(provider.calls).toHaveLength(3);
  } finally {
    await current.harness.close(context);
    unregister();
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification reuses completed stages and blinds reconstruction across the dependency chain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-verifier-"));
  const provider = fixture((name, input) => {
    if (name === "proof") {
      expect(JSON.stringify(input)).not.toContain("secret original proof");
      expect(JSON.stringify(input)).not.toContain("detailed claim");
      expect(
        input.notes.every((note: object) => !Object.hasOwn(note, "summary")),
      ).toBe(true);
      expect(input.notes.map((value: { id: string }) => value.id)).toEqual([
        "n1",
        "n2",
      ]);
    }
    const value =
      name === "correctness"
        ? {
            verdict: "PASS",
            report: "Checked exact statements.",
            premises: [],
            correction: {
              summary: "Harmless clarification",
              detailedSummary: null,
              statement: null,
              argument: null,
            },
          }
        : name === "proof"
          ? { proof: "Independent complete proof.", complete: true }
          : { verdict: "PASS", report: "Checked." };
    return {
      results: [...input.notes]
        .reverse()
        .map((note: { id: string }) => ({ noteId: note.id, ...value })),
    };
  });
  let current = await provider.open(directory);
  try {
    const closed = Promise.withResolvers<void>();
    let closing = false;
    current.harness.subscribeCommits(({ changes }) => {
      if (
        !closing &&
        changes.some(
          (change) =>
            change.type === "entry" &&
            change.value.model?.some(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "submit_proof" &&
                !message.isError,
            ),
        )
      ) {
        closing = true;
        void current.harness.close(context).then(closed.resolve, closed.reject);
      }
    });
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "verifier",
            input: {
              task,
              notes: [note("n1"), { ...note("n2", ["n1"]), candidate: true }],
              targets: [{ id: "n2", through: "reconstruction" }],
            },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    current.harness.resume();
    await closed.promise;
    current = await provider.open(directory);
    const outcome = await resultOf(current.harness, id);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed")
      throw new Error(JSON.stringify(outcome));
    const result = outcome.result as Extract<
      SolverResult,
      { kind: "verification" }
    >;
    expect(result.checks).toHaveLength(2);
    expect(
      result.checks.every(
        (check) =>
          check.source?.verdict === "PASS" &&
          check.reconstruction?.verdict === "PASS",
      ),
    ).toBe(true);
    expect(result.checks[0]!.requirements).toBeUndefined();
    expect(result.checks[1]!.requirements?.verdict).toBe("PASS");
    expect(result.checks[0]!.correction).toEqual({
      revision: 0,
      summary: "Harmless clarification",
    });
    expect(provider.calls.map(({ name }) => name)).toEqual([
      "correctness",
      "requirements",
      "proof",
      "reconstruction",
    ]);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed verification publishes completed checks once and a fresh worker reuses them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-verifier-failure-"));
  let proofs = 0,
    sources = 0,
    retry = false;
  const provider = fixture(
    (name, input) => {
      if (name === "explorer") return { notes: [draft("n1")], candidate: true };
      if (name === "proof" && ++proofs === 1)
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "Response incomplete: max_messages",
        });
      const value =
        name === "correctness"
          ? {
              verdict: "PASS",
              report: "Checked",
              premises: ["External theorem"],
              correction: {
                summary: "Corrected summary",
                detailedSummary: null,
                statement: null,
                argument: null,
              },
            }
          : name === "proof"
            ? { complete: true, proof: "Independent proof" }
            : { verdict: "PASS", report: "Checked" };
      return {
        results: input.notes.map(({ id }: { id: string }) => ({
          noteId: id,
          ...value,
        })),
      };
    },
    { research: false },
    131072,
    {
      ...closedBookResearch,
      retrieval: true,
      async source(input) {
        sources++;
        return input.notes.map(({ id }) => ({
          noteId: id,
          verdict: "PASS",
          report: "Source established",
        }));
      },
    },
  );
  provider.roles.coordinator = async (input) => {
    if (!input.notes.length)
      return { work: [{ kind: "explorer", guidance: "Prove" }] };
    if (input.failures.length) {
      expect(input.failures[0]!.error).toBe(
        "Response incomplete: max_messages",
      );
      expect(input.notes[0]!.verified).toBe(true);
      if (!retry) return { work: [] };
    }
    return {
      work: [
        {
          kind: "verifier",
          notes: [input.notes[0]!.id],
          through: "reconstruction",
        },
      ],
    };
  };
  let current = await provider.open(directory, {
    task,
    settings: { profiles: { default: { provider: "openai", model: "roles" } } },
  });
  try {
    await current.root.commit(
      (tx) => provider.workflow.initialize(tx, current.root.id),
      context,
    );
    await current.root.waitForIdle(context);
    const view = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    const failed = view.results.find(
      ({ outcome }) => outcome.status === "failed",
    )!;
    expect(failed.outcome).toMatchObject({
      status: "failed",
      result: {
        checks: [
          {
            correctness: { verdict: "PASS" },
            source: { verdict: "PASS" },
            requirements: { verdict: "PASS" },
          },
        ],
      },
    });
    expect(view.notes[0]).toMatchObject({
      verified: true,
      accepted: false,
      revision: 1,
      summary: "Corrected summary",
    });
    const before = await current.root.commit(
      (tx) => readView(tx, current.root.id, view.results[0]!.id),
      context,
    );
    expect(before.notes[0]!.checks).toEqual([]);
    const report = await current.root.commit(
      (tx) => readReport(tx, current.root.id),
      context,
    );
    expect(
      report.work.find(({ id }) => id === String(failed.task)),
    ).toMatchObject({ status: "failed", checkCount: 1 });
    await current.harness.close(context);
    current = await provider.open(directory);
    expect(
      (
        await current.root.commit(
          (tx) => readView(tx, current.root.id),
          context,
        )
      ).notes,
    ).toEqual(view.notes);
    retry = true;
    await current.root.commit(
      (tx) =>
        provider.workflow.input(tx, current.root.id, {
          kind: "guide",
          id: "retry",
          text: "Retry the incomplete stage",
        }),
      context,
    );
    await current.root.waitForIdle(context);
    const finished = await current.root.commit(
      (tx) => readReport(tx, current.root.id),
      context,
    );
    expect(finished.status.status).toBe("completed");
    expect(finished.status.work.failed).toBe(1);
    expect(finished.notes[0]!.revision).toBe(1);
    expect(sources).toBe(1);
    expect(provider.calls.map(({ name }) => name)).toEqual([
      "explorer",
      "correctness",
      "requirements",
      "proof",
      "proof",
      "reconstruction",
    ]);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("source recovery retains evidence and corrections while incomplete reconstruction cannot pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-custom-source-"));
  let sourceCalls = 0;
  const premise = "Every finite example satisfies the external theorem.";
  const source = {
    verdict: "PASS" as const,
    report: "SOURCE_REPORT_SENTINEL: stronger unrelated target theorem.",
    kind: "codex-report" as const,
    operationId: "custom-source",
    reportedAt: "2026-10-04T00:00:00Z",
    premises: [premise],
    passages: [
      {
        premise: 0,
        id: "external/0",
        statement: premise,
        url: "https://example.org/theorem",
        quote: "SOURCE_QUOTATION_SENTINEL",
      },
    ],
  };
  const provider = fixture(
    (name, input) => {
      if (name === "requirements") {
        expect(input.notes[0].summary).toBe("Source-checked clarification");
        expect(input.sources).toEqual([
          {
            noteId: "n1",
            premises: [premise],
            source: {
              kind: "source-check",
              verdict: "PASS",
              operationId: "custom-source",
              passages: [
                {
                  id: "external/0",
                  url: "https://example.org/theorem",
                  premise: 0,
                },
              ],
            },
          },
        ]);
        expect(JSON.stringify(input)).not.toContain(source.report);
        expect(JSON.stringify(input)).not.toContain(
          "SOURCE_QUOTATION_SENTINEL",
        );
      }
      if (name === "proof") {
        expect(input.notes[0].premises).toEqual([premise]);
        expect(JSON.stringify(input)).not.toContain("secret original proof");
        expect(JSON.stringify(input)).not.toContain(source.report);
        expect(JSON.stringify(input)).not.toContain(
          "SOURCE_QUOTATION_SENTINEL",
        );
        expect(input.notes[0].statement).toBe("n1 exact claim");
      }
      if (name === "reconstruction")
        expect(input.premises).toEqual([
          {
            noteId: "n1",
            premises: [premise],
            source: {
              kind: "source-check",
              verdict: "PASS",
              operationId: "custom-source",
              passages: [
                {
                  id: "external/0",
                  url: "https://example.org/theorem",
                  premise: 0,
                },
              ],
            },
          },
        ]);
      const result =
        name === "correctness"
          ? {
              verdict: "PASS",
              report: "Conditional on the exact theorem.",
              premises: [premise],
            }
          : name === "proof"
            ? {
                proof: "Incomplete argument using the permitted theorem.",
                complete: false,
              }
            : { verdict: "PASS", report: "Checked." };
      return { results: [{ noteId: "n1", ...result }] };
    },
    { research: false },
    131072,
    {
      ...closedBookResearch,
      retrieval: true,
      async source(input) {
        sourceCalls++;
        expect(
          input.notes.map(({ id, premises }) => ({ id, premises })),
        ).toEqual([{ id: "n1", premises: [premise] }]);
        return [
          {
            noteId: "n1",
            ...source,
            correction: {
              summary: "Source-checked clarification",
              detailedSummary: null,
              statement: null,
              argument: null,
            },
          },
        ];
      },
    },
  );
  let current = await provider.open(directory);
  try {
    const closed = Promise.withResolvers<void>();
    let closing = false;
    current.harness.subscribeCommits(({ changes }) => {
      if (
        !closing &&
        changes.some(
          (change) =>
            change.type === "entry" &&
            change.value.model?.some(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "submit_requirements" &&
                !message.isError,
            ),
        )
      ) {
        closing = true;
        void current.harness.close(context).then(closed.resolve, closed.reject);
      }
    });
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "verifier",
            input: {
              task,
              notes: [{ ...note("n1"), candidate: true }],
              targets: [{ id: "n1", through: "reconstruction" }],
            },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    current.harness.resume();
    await closed.promise;
    expect(sourceCalls).toBe(1);
    current = await provider.open(directory);
    const result = await resultOf(current.harness, id);
    expect(result).toMatchObject({
      status: "completed",
      result: {
        checks: [
          {
            source,
            correction: {
              revision: 0,
              summary: "Source-checked clarification",
            },
            reconstruction: { verdict: "INCONCLUSIVE" },
          },
        ],
      },
    });
    expect(sourceCalls).toBe(1);
    expect(provider.calls.map(({ name }) => name)).toEqual([
      "correctness",
      "requirements",
      "proof",
      "reconstruction",
    ]);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

async function fakeCodex(directory: string) {
  const executable = join(directory, "codex-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst input = await Bun.stdin.json();\nif (input.assignment && !process.argv.includes('web_search="disabled"')) throw new Error("Worker enabled web search");\nif (process.env.TEST_INTERRUPTION && !(await Bun.file(process.env.TEST_INTERRUPTION).exists())) { await Bun.write(process.env.TEST_INTERRUPTION, "attempted"); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Partial opaque work"}})); await Bun.write(input.workspace + "/started", "partial artifact"); await new Promise(() => setInterval(() => {}, 1000)); }\nlet value;\nif (input.query || input.assignment) value = {notes:[{id:"n1",summary:"Finding",detailedSummary:"Exact finding",statement:"Finding",argument:"Evidence",support:[]}],...(input.assignment?{candidate:false}:{})};\nelse if(input.argument) value = {verdict:input.argument === "malformed" ? "INVALID" : "PASS",report:"Independent review",premises:["External premise"],passages:[{premise:0,url:"https://example.org/theorem",quote:"Exact theorem"}]};\nelse value = {results:input.facts.map(fact=>({noteId:fact.id,verdict:"PASS",report:"Sources checked",passages:[{premise:0,url:"https://example.org/theorem",quote:"Exact theorem"}]}))};\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"web_search"}}));\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(value)}}));\nconsole.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:17,output_tokens:5,cached_input_tokens:0}}));\n`,
  );
  await chmod(executable, 0o700);
  return executable;
}

test("Coordinator capabilities survive retry and reopen; fresh decisions get fresh conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-coordinator-"));
  let count = 0;
  let retried = false;
  const provider = fixture((_name, input, transcript) => {
    expect(input.capabilities).toMatchObject({
      explorer: false,
      literature: false,
      codex: count >= 3,
    });
    const tool = getCurrentTools(transcript.messages).find(
      (tool) => tool.name === "submit_coordinator",
    )!;
    for (const request of [
      { kind: "explorer", guidance: "Explore." },
      { kind: "literature", query: "Find the theorem." },
      { kind: "codex", assignment: "Check the construction.", notes: [] },
    ])
      expect(Check(tool.parameters, { work: [request] })).toBe(
        input.capabilities[request.kind],
      );
    if (!retried) {
      retried = true;
      return {
        ...fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Temporary provider failure",
        }),
        providerError: { status: 503 },
      };
    }
    count++;
    if (count === 1)
      return {
        work: [{ kind: "explorer", guidance: "Duplicate active work" }],
      };
    if (count === 2)
      expect(
        transcript.messages.some(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toBe(true);
    return count >= 4
      ? {
          work: [
            {
              kind: "codex",
              assignment:
                "Implement the specified construction and check its constraints",
              notes: [],
            },
          ],
        }
      : { work: [] };
  });
  let current = await provider.open(directory, undefined, true);
  try {
    const stopped = Promise.withResolvers<void>();
    let closing = false;
    current.harness.subscribeCommits(({ changes }) => {
      if (
        !closing &&
        changes.some(
          (change) =>
            change.type === "entry" &&
            ToolResultEntry.is(change.value) &&
            change.value.model?.some(
              (message) => message.role === "toolResult" && message.isError,
            ),
        )
      ) {
        closing = true;
        void current.harness
          .close(context)
          .then(stopped.resolve, stopped.reject);
      }
    });
    const input = {
      task,
      notes: [],
      failures: [],
      guidance: [],
      literatureUsed: false,
      explorerUsed: false,
      active: [
        {
          id: 5,
          input: { request: { kind: "explorer", guidance: "Continue" } },
        },
      ],
    };
    for (let i = 0; i < 2; i++) {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            { role: "coordinator", input },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      if (i === 0) {
        current.harness.resume();
        await stopped.promise;
        current = await provider.open(directory, undefined, true);
      }
      expect(await resultOf(current.harness, id)).toMatchObject({
        status: "completed",
        result: { work: [] },
      });
    }
    expect(provider.calls).toHaveLength(4);
    expect(
      new Set(provider.calls.slice(0, 3).map((call) => call.session)).size,
    ).toBe(1);
    expect(provider.calls[3]!.session).not.toBe(provider.calls[2]!.session);
    provider.roles.codex = async () => ({
      kind: "notes",
      notes: [],
      candidate: false,
    });
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          { role: "coordinator", input },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    expect(await resultOf(current.harness, id)).toMatchObject({
      status: "completed",
      result: { work: [{ kind: "codex" }] },
    });
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("built-in Coordinator excludes active literature and rejects multiple Explorers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-policy-"));
  let response = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      response++;
      expect(input.capabilities).toMatchObject({
        explorer: true,
        literature: response > 2,
      });
      if (response === 1)
        return {
          work: [{ kind: "literature", query: "Duplicate active search" }],
        };
      if (response === 3)
        return {
          work: [
            { kind: "explorer", guidance: "First" },
            { kind: "explorer", guidance: "Second" },
          ],
        };
      expect(
        transcript.messages.some(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toBe(true);
      return response === 4
        ? { work: [{ kind: "explorer", guidance: "Continue" }] }
        : { work: [] };
    },
    { research: false, literature: true },
    131072,
    { ...closedBookResearch, retrieval: true },
  );
  const current = await provider.open(directory);
  const input: CoordinationInput = {
    task,
    notes: [],
    failures: [],
    guidance: [],
    literatureUsed: false,
    explorerUsed: false,
    active: [
      {
        id: 5,
        input: { request: { kind: "literature", query: "A source gap" } },
      },
    ],
  };
  try {
    for (const active of [input.active, []]) {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            {
              role: "coordinator" as const,
              input: { ...input, active } as JsonValue,
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result: {
          work: active?.length
            ? []
            : [{ kind: "explorer", guidance: "Continue" }],
        },
      });
    }
    expect(provider.calls).toHaveLength(4);
    expect(
      provider.roles.capabilities({
        ...input,
        active: [{ id: 6, input: { request: { kind: "explorer" } } }],
      }).explorer,
    ).toBe(true);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "truncated Explorer responses fail atomically after prior submission=%s",
  async (submitted) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-role-truncated-"));
    const cleaned: (string | undefined)[] = [];
    const unregister = registerSessionResourceCleanup((sessionId) =>
      cleaned.push(sessionId),
    );
    let response = 0;
    const provider = fixture(() => {
      response++;
      if (submitted && response === 1)
        return { notes: [draft("n1")], candidate: false };
      return fauxAssistantMessage(
        [
          fauxToolCall("submit_explorer", {
            notes: [draft("n2")],
            candidate: true,
          }),
        ],
        { stopReason: "length" },
      );
    });
    const current = await provider.open(directory, {
      task,
      settings: {
        profiles: { default: { provider: "openai", model: "roles" } },
        research: false,
      },
      mode: {
        role: "explorer",
        input: { notes: [], guidance: "Continue" },
      },
    });
    try {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.workflow.Worker,
            { standalone: true },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      const outcome = (await current.harness.waitForTask(id, context)).state
        .outcome;
      expect(outcome).toMatchObject({
        status: "failed",
        error: {
          message:
            "explorer response was truncated; the worker result was not published",
        },
      });
      expect(provider.calls).toHaveLength(submitted ? 2 : 1);
      expect(cleaned).toEqual([provider.calls[0]!.session]);
      const retained = await entries(current.harness);
      expect(retained.filter(ToolResultEntry.is)).toHaveLength(
        submitted ? 1 : 0,
      );
      const report = await current.root.commit(
        (tx) => readReport(tx, current.root.id),
        context,
      );
      expect(report.notes).toEqual([]);
      expect(report.result).toBeUndefined();
    } finally {
      await current.harness.close(context);
      unregister();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("capacity after a frozen read hands off valid private notes without another provider call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-capacity-"));
  let count = 0;
  const provider = fixture(
    () =>
      ++count === 1
        ? { notes: [draft("n1")], candidate: false }
        : { tool: "read_notes", arguments: { ids: ["large"], level: "full" } },
    { research: false, maxExplorerReads: 1, maxExplorerResponses: 4 },
    32768,
  );
  const current = await provider.open(directory);
  try {
    const large = {
      ...note("large"),
      argument: "exact mathematical text ".repeat(20000),
      imported: true,
      verified: true,
    };
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "explorer",
            input: { task, notes: [large], guidance: "Continue" },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    const outcome = await resultOf(current.harness, id);
    expect(outcome).toMatchObject({
      status: "completed",
      result: { kind: "notes", candidate: false, notes: [{ id: "n1" }] },
    });
    expect(provider.calls).toHaveLength(2);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid submissions consume the response allowance and cannot publish partial results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-allowance-"));
  const provider = fixture(
    () => ({ notes: [draft("n1", ["unknown"])], candidate: false }),
    { research: false, maxExplorerReads: 1, maxExplorerResponses: 2 },
  );
  const current = await provider.open(directory);
  try {
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "explorer",
            input: { task, notes: [], guidance: "Continue" },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    const outcome = await resultOf(current.harness, id);
    expect(outcome).toMatchObject({
      status: "faulted",
      error: { message: "Explorer exhausted its responses" },
    });
    expect(provider.calls).toHaveLength(2);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an admitted failed read consumes its allowance, while schema-invalid reads do not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-read-allowance-"));
  let count = 0;
  const provider = fixture(
    (_name, _input, transcript) => {
      count++;
      if (count === 1)
        return { tool: "read_notes", arguments: { ids: [], level: "full" } };
      if (count === 2)
        return {
          tool: "read_notes",
          arguments: { ids: ["missing"], level: "full" },
        };
      if (count === 3)
        return {
          tool: "read_notes",
          arguments: { ids: ["prior"], level: "full" },
        };
      const text = JSON.stringify(transcript);
      expect(text).toContain("Unknown note: missing");
      expect(text).toContain("0 reads and 3 responses remain");
      expect(text).toContain("Reading is disabled");
      expect(text).not.toContain("sensitive full argument");
      return { notes: [draft("n1")], candidate: true };
    },
    { research: false, maxExplorerReads: 1, maxExplorerResponses: 5 },
  );
  const current = await provider.open(directory);
  try {
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "explorer",
            input: {
              task,
              notes: [
                { ...note("prior"), argument: "sensitive full argument" },
              ],
              guidance: "Continue",
            },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    expect((await resultOf(current.harness, id)).status).toBe("completed");
    expect(provider.calls).toHaveLength(4);
    const retained = (await entries(current.harness)).flatMap(
      (entry) => entry.model ?? [],
    );
    expect(
      retained.filter(
        (message) =>
          message.role === "toolResult" &&
          (message.details as { read?: boolean } | undefined)?.read,
      ),
    ).toHaveLength(1);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted Codex workers retain old artifacts and replay in a fresh workspace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-codex-replay-"));
  const command = await fakeCodex(directory);
  const provider = fixture(
    () => {
      throw new Error("Unexpected Pi model call");
    },
    {
      research: false,
      codex: {
        model: "gpt-6-astra",
        command,
        workspace: join(directory, "artifacts"),
        environment: {
          ...process.env,
          TEST_INTERRUPTION: join(directory, "attempted"),
        },
      },
    },
  );
  let current = await provider.open(join(directory, "storage"));
  let watched: string | undefined;
  let firstWorkspace: string | undefined;
  try {
    const entered = Promise.withResolvers<void>();
    current.harness.subscribeCommits(({ changes }) => {
      for (const change of changes)
        if (
          !watched &&
          change.type === "entry" &&
          CodexRequest.is(change.value)
        ) {
          firstWorkspace = change.value.data.workspace;
          watched = join(firstWorkspace, "started");
          watchFile(watched, { interval: 10 }, (stat) => {
            if (stat.size > 0) entered.resolve();
          });
        }
    });
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "codex",
            input: {
              task,
              assignment: "Implement the concrete construction",
              notes: [],
            },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    current.harness.resume();
    await entered.promise;
    await current.harness.close(context);
    unwatchFile(watched!);
    expect(await readFile(join(firstWorkspace!, "started"), "utf8")).toBe(
      "partial artifact",
    );
    current = await provider.open(join(directory, "storage"));
    const outcome = await resultOf(current.harness, id);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed")
      throw new Error(JSON.stringify(outcome));
    const requests = (await entries(current.harness)).filter(CodexRequest.is);
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((entry) => entry.data.workspace)).size).toBe(2);
    expect(requests.map((entry) => entry.byTaskId)).toEqual([id, id]);
  } finally {
    if (watched) unwatchFile(watched);
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex preparation failures retain a task failure without admitting or recording an invocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-codex-prepare-"));
  const workspace = join(directory, "not-a-directory");
  await writeFile(workspace, "Fixture");
  const provider = fixture(
    () => {
      throw new Error("Unexpected Pi model call");
    },
    { codex: { model: "gpt-6-astra", workspace } },
  );
  const current = await provider.open(join(directory, "storage"));
  try {
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "codex",
            input: {
              task,
              assignment: "Implement the construction",
              notes: [],
            },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    current.harness.resume();
    expect(
      (await current.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("faulted");
    const records = await entries(current.harness);
    expect(records.filter(CodexRequest.is)).toEqual([]);
    expect(records.filter(CodexLog.is)).toEqual([]);
    expect(
      await current.root.commit((tx) => readUsage(tx), context),
    ).toMatchObject({ calls: { codexInvocations: 0, unknownUsage: 0 } });
    expect(provider.calls).toHaveLength(0);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex source memos survive later Verifier recovery and other calls retain evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-codex-"));
  const command = await fakeCodex(directory);
  const provider = fixture(
    (name, input) => ({
      results: input.notes.map((note: { id: string }) => ({
        noteId: note.id,
        verdict: "PASS",
        report: "Conditional on the exact premise",
        ...(name === "correctness" ? { premises: ["External premise"] } : {}),
      })),
    }),
    {
      research: { model: "gpt-6-astra", command },
      codex: {
        model: "gpt-6-astra",
        command,
        workspace: join(directory, "artifacts"),
      },
      literature: true,
    },
  );
  let current = await provider.open(join(directory, "storage"));
  try {
    const closed = Promise.withResolvers<void>();
    let closing = false;
    current.harness.subscribeCommits(({ changes }) => {
      if (
        !closing &&
        changes.some(
          (change) =>
            change.type === "entry" &&
            change.value.model?.some(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "submit_requirements" &&
                !message.isError,
            ),
        )
      ) {
        closing = true;
        void current.harness.close(context).then(closed.resolve, closed.reject);
      }
    });
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "verifier",
            input: {
              task,
              notes: [{ ...note("n1"), candidate: true }],
              targets: [{ id: "n1", through: "requirements" }],
            },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    current.harness.resume();
    await closed.promise;
    current = await provider.open(join(directory, "storage"));
    expect(await resultOf(current.harness, id)).toMatchObject({
      status: "completed",
      result: {
        checks: [
          {
            source: {
              verdict: "PASS",
              kind: "codex-report",
              premises: ["External premise"],
            },
          },
        ],
      },
    });
    const sourceRecords = (await entries(current.harness)).filter((entry) =>
      CodexLog.is(entry),
    );
    expect(sourceRecords).toHaveLength(1);
    expect(sourceRecords[0]!.data).toMatchObject({
      usage: { input_tokens: 17, output_tokens: 5, cached_input_tokens: 0 },
    });
    const run = async (role: Invocation["role"], input: JsonValue) => {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            { role, input },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      return await resultOf(current.harness, id);
    };
    expect(
      await run("literature", {
        task,
        query: "Find the precise theorem",
        notes: [],
      }),
    ).toMatchObject({
      status: "completed",
      result: { kind: "notes", candidate: false },
    });
    expect(
      await run("review", {
        task,
        argument: "Independent argument without solver verdicts",
      }),
    ).toMatchObject({
      status: "completed",
      result: { verdict: "PASS", kind: "codex-report" },
    });
    const worker = await run("codex", {
      task,
      assignment: "Implement and check the finite construction",
      notes: [],
    });
    expect(worker).toMatchObject({
      status: "completed",
      result: { kind: "notes" },
    });
    if (worker.status !== "completed") throw new Error(JSON.stringify(worker));
    const { workspace } = (await entries(current.harness))
      .filter(CodexRequest.is)
      .find((entry) =>
        entry.data.workspace.startsWith(join(directory, "artifacts")),
      )!.data;
    expect(worker.result).toMatchObject({
      notes: [{ argument: expect.stringContaining(`Artifacts: ${workspace}`) }],
    });
    expect(await readFile(join(workspace, "input.json"), "utf8")).toContain(
      "finite construction",
    );
    const malformed = await run("review", { task, argument: "malformed" });
    expect(malformed).toMatchObject({ status: "faulted" });
    const logs = (await entries(current.harness)).filter(CodexLog.is);
    expect(logs).toHaveLength(5);
    expect(logs.every((entry) => entry.data.usage?.input_tokens === 17)).toBe(
      true,
    );
    const requests = (await entries(current.harness)).filter(CodexRequest.is);
    expect(requests).toHaveLength(5);
    expect(
      logs.every((entry) =>
        ["request", "task", "model"].every((field) => !(field in entry.data)),
      ),
    ).toBe(true);
    expect(
      logs.every((entry) =>
        requests.some(
          (request) => request.data.operationId === entry.data.operationId,
        ),
      ),
    ).toBe(true);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [false, true],
  [true, true],
  [false, false],
  [true, false],
])(
  "mixed read/submission completes without another response (read first: %s, valid read: %s)",
  async (readFirst, validRead) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-role-mixed-"));
    let calls = 0;
    const provider = fixture(() => {
      if (++calls > 1)
        return fauxAssistantMessage("Unnecessary truncated response", {
          stopReason: "length",
        });
      const submit = fauxToolCall("submit_coordinator", { work: [] });
      const read = fauxToolCall("read_notes", {
        ids: validRead ? ["prior"] : [],
        level: "full",
      });
      return fauxAssistantMessage(readFirst ? [read, submit] : [submit, read], {
        stopReason: "toolUse",
      });
    });
    const current = await provider.open(directory);
    try {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            {
              role: "coordinator",
              input: {
                task,
                notes: [note("prior")],
                guidance: [],
                failures: [],
                explorerUsed: false,
                literatureUsed: false,
                active: [
                  {
                    id: 1,
                    input: {
                      request: { kind: "explorer", guidance: "Continue" },
                    },
                  },
                ],
              },
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result: { work: [] },
      });
      expect(calls).toBe(1);
      const retained = await entries(current.harness);
      expect(
        retained.filter(
          (entry) =>
            ToolResultEntry.is(entry) &&
            entry.model?.some(
              (message) => message.role === "toolResult" && !message.isError,
            ),
        ),
      ).toHaveLength(validRead ? 2 : 1);
    } finally {
      await current.harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("native mixed-round controls preserve read-only, partial, and invalid-submission continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-mixed-continue-"));
  let calls = 0;
  const provider = fixture(
    () => {
      const read = fauxToolCall("read_notes", {
        ids: ["prior"],
        level: "detailed",
      });
      switch (++calls) {
        case 1:
          return fauxAssistantMessage([read], { stopReason: "toolUse" });
        case 2:
          return fauxAssistantMessage(
            [
              fauxToolCall("submit_explorer", {
                notes: [draft("n1", ["prior"])],
                candidate: false,
              }),
              read,
            ],
            { stopReason: "toolUse" },
          );
        case 3:
          return fauxAssistantMessage(
            [
              read,
              fauxToolCall("submit_explorer", {
                notes: [draft("bad", ["missing"])],
                candidate: true,
              }),
            ],
            { stopReason: "toolUse" },
          );
        default:
          return { notes: [draft("n2", ["n1"])], candidate: true };
      }
    },
    { research: false, maxExplorerReads: 4, maxExplorerResponses: 5 },
  );
  const current = await provider.open(directory);
  try {
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "explorer",
            input: { task, notes: [note("prior")], guidance: "Continue" },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    expect(await resultOf(current.harness, id)).toEqual({
      status: "completed",
      result: {
        kind: "notes",
        notes: [draft("n1", ["prior"]), draft("n2", ["n1"])],
        candidate: true,
      },
    });
    expect(calls).toBe(4);
    expect(
      provider.calls[3]!.transcript.messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "submit_explorer" &&
          message.isError,
      ),
    ).toBe(true);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
