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
import { capacityError, createRuntime } from "../src/config.ts";
import { CodexLog, CodexRequest } from "../src/roles/codex.ts";
import type { Note, SolverResult } from "../src/math/contracts.ts";
import { resolveResult, type SubmissionResult } from "../src/math/results.ts";
import { DefinitionDoc, type Definition } from "../src/definition.ts";
import { createResearch, scanTasks } from "../src/workflow.ts";
import { readReport, readUsage } from "../src/report.ts";
import { readView } from "../src/math/state.ts";
import { refresh, validateResult } from "../src/math/notes.ts";
import { acceptedArgument } from "../src/math/argument.ts";
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
  text: `${id} exact claim\n\n${id} secret original proof`,
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
const preparedNote = (id: string, support: string[] = []): Note => ({
  ...note(id, support),
  checks: [
    {
      correctness: {
        verdict: "PASS",
        report: "Checked",
        statement: `${id} exact claim`,
        premises: [],
      },
      source: { verdict: "PASS", report: "Checked" },
      requirements: { verdict: "PASS", report: "Checked" },
    },
  ],
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
  api?: string,
) {
  const provider = fauxProvider({
    api,
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
  const reports: unknown[] = [];
  const workflow = createResearch(roles);
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
        onReport: (error) => reports.push(error),
        settings: {
          compaction: { enabled: false },
          retry: { enabled: retry, baseDelayMs: 0 },
          toolExecution: "sequential",
        },
      },
      context,
    );
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
  return { calls, reports, roles, Invoke, workflow, open };
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
  const inputNote = {
    ...preparedNote("prior"),
    imported: true,
    verified: true,
  };
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
        expect(JSON.stringify(transcript)).not.toContain(inputNote.text);
        expect(JSON.stringify(transcript)).not.toContain(
          inputNote.detailedSummary,
        );
        return {
          tool: "read_notes",
          arguments: { ids: ["prior"], level: "full" },
        };
      }
      const read = transcript.messages.find(
        (message) =>
          message.role === "toolResult" && message.toolName === "read_notes",
      );
      if (read?.role !== "toolResult" || read.content[0]?.type !== "text")
        throw new Error("Expected frozen note read");
      expect(JSON.parse(read.content[0].text.split("\n\n")[0]!)).toEqual([
        {
          id: inputNote.id,
          detailedSummary: inputNote.detailedSummary,
          statement: inputNote.checks[0]!.correctness!.statement,
          text: inputNote.text,
        },
      ]);
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
    await current.root.commit(
      (tx) => provider.workflow.initialize(tx, current.root.id),
      context,
    );
    current.harness.resume();
    await Promise.race([
      closed.promise,
      current.harness.waitForIdle(context).then(
        () => {
          throw new Error(
            "Worker settled before the private submission interruption",
          );
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
    await current.harness.waitForIdle(context);
    const id = (
      await current.root.commit(
        (tx) => scanTasks(tx, current.root.id, "research.worker"),
        context,
      )
    )[0]!.id;
    const raw = (await current.harness.waitForTask(id, context)).state.outcome;
    expect(raw).toMatchObject({ status: "completed" });
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

test("model-selected proof and comparison batches preserve blindness, IDs, and progress after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-verifier-"));
  let rejectedIds = false;
  const schemaChecks: boolean[] = [];
  const invalidPrefixes = [[], ["n2"], ["n1", "n1"]];
  const provider = fixture((name, input, transcript) => {
    const tool = getCurrentTools(transcript.messages).find(
      (tool) => tool.name === `submit_${name}`,
    )!;
    expect(tool.parameters).toHaveProperty(
      "properties.results.items.properties.noteId.enum",
      input.notes.map(({ id }: { id: string }) => id),
    );
    if (name === "proof") {
      expect(JSON.stringify(input)).not.toContain("secret original proof");
      expect(JSON.stringify(input)).not.toContain("detailed claim");
      expect(JSON.stringify(input)).not.toContain("Private comparison report");
      expect(
        input.notes.every((note: object) => !Object.hasOwn(note, "summary")),
      ).toBe(true);
      expect(input.notes.map(({ id }: { id: string }) => id)).toEqual(
        input.notes[0].id === "n1" ? ["n1", "n2", "n3"] : ["n3"],
      );
      expect(input.support.map(({ id }: { id: string }) => id)).toEqual(
        input.notes[0].id === "n1" ? [] : ["n1", "n2"],
      );
    }
    if (name === "reconstruction") {
      for (const note of input.notes)
        expect(note.text).toBe(draft(note.id).text);
      expect(input.independent).toEqual(
        input.notes.map(({ id }: { id: string }) => ({
          noteId: id,
          result: { complete: true, proof: "Independent complete proof." },
        })),
      );
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
              text: null,
            },
          }
        : name === "proof"
          ? { proof: "Independent complete proof.", complete: true }
          : {
              verdict: "PASS",
              report: "Private comparison report",
              ...(name === "reconstruction"
                ? {
                    correction: {
                      summary: null,
                      detailedSummary: "Clarified detailed summary",
                      text: null,
                    },
                  }
                : {}),
            };
    if (
      name === "proof" &&
      input.notes[0].id === "n1" &&
      invalidPrefixes.length
    )
      return {
        results: invalidPrefixes
          .shift()!
          .map((noteId) => ({ noteId, ...value })),
      };
    if (name === "proof" && input.notes[0].id === "n3" && !rejectedIds) {
      rejectedIds = true;
      return { results: ["n2", "n3"].map((noteId) => ({ noteId, ...value })) };
    }
    const selected =
      name === "proof"
        ? input.notes.slice(0, 2)
        : name === "reconstruction"
          ? input.notes.slice(0, 1)
          : input.notes;
    const result = {
      results: [...selected].reverse().map((note: { id: string }) => ({
        noteId: note.id,
        ...value,
        ...(name === "correctness"
          ? { statement: `${note.id} exact claim` }
          : {}),
      })),
    };
    schemaChecks.push(Check(tool.parameters, result));
    return result;
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
                message.toolName === "submit_reconstruction" &&
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
              notes: [
                note("n1"),
                note("n2", ["n1"]),
                { ...note("n3", ["n2"]), candidate: true },
              ],
              targets: [{ id: "n3", through: "reconstruction" }],
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
    expect(result.checks).toHaveLength(3);
    expect(
      result.checks.every(
        (check) =>
          check.source?.verdict === "PASS" &&
          check.reconstruction?.verdict === "PASS",
      ),
    ).toBe(true);
    expect(result.checks[0]!.requirements).toBeUndefined();
    expect(result.checks[1]!.requirements).toBeUndefined();
    expect(result.checks[2]!.requirements?.verdict).toBe("PASS");
    expect(result.checks[0]!.correction).toEqual({
      revision: 0,
      summary: "Harmless clarification",
      detailedSummary: "Clarified detailed summary",
    });
    expect(
      provider.calls.map(({ name, input }) => [
        name,
        input.notes.map(({ id }: { id: string }) => id),
      ]),
    ).toEqual([
      ["correctness", ["n1", "n2", "n3"]],
      ["requirements", ["n3"]],
      ...Array.from({ length: 4 }, () => ["proof", ["n1", "n2", "n3"]]),
      ["reconstruction", ["n1", "n2"]],
      ["reconstruction", ["n2"]],
      ["proof", ["n3"]],
      ["proof", ["n3"]],
      ["reconstruction", ["n3"]],
    ]);
    const proofs = provider.calls.filter(({ name }) => name === "proof");
    expect(new Set(proofs.slice(0, 4).map(({ session }) => session)).size).toBe(
      1,
    );
    expect(proofs.at(-2)!.session).toBe(proofs.at(-1)!.session);
    expect(new Set(provider.calls.map(({ session }) => session)).size).toBe(7);
    expect(JSON.stringify(proofs[3]!.transcript)).toContain(
      "Submit at least one requested note",
    );
    expect(JSON.stringify(proofs.at(-1)!.transcript)).toContain(
      "Batch results must contain exactly one result per requested note",
    );
    expect(schemaChecks.every(Boolean)).toBe(true);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["refuted", "dependent", "unrelated", "imported"] as const)(
  "reconstruction finishes produced proofs before handling %s pending support",
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-role-support-"));
    const refuted = boundary === "refuted";
    const dependent = boundary === "dependent";
    const notes = [
      { ...preparedNote("n1"), imported: boundary === "imported" },
      preparedNote("n2", ["n1"]),
      preparedNote("n3", ["n2"]),
      preparedNote("n4"),
      preparedNote("n5", dependent || boundary === "imported" ? ["n3"] : []),
    ];
    let retry = false;
    const provider = fixture((name, input) => ({
      results: input.notes
        .slice(0, name === "proof" ? 4 : 1)
        .map(({ id }: { id: string }) => ({
          noteId: id,
          ...(name === "proof"
            ? {
                complete: id !== "n1" || refuted || retry,
                proof: "Independent proof",
              }
            : {
                verdict: id === "n1" && refuted ? "FAIL" : "PASS",
                report: "Checked",
              }),
        })),
    }));
    const current = await provider.open(directory);
    const invoke = async () => {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            {
              role: "verifier",
              input: {
                task,
                notes,
                targets: ["n1", "n3", "n4", "n5"].map((id) => ({
                  id,
                  through: "reconstruction",
                })),
              },
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      const outcome = await resultOf(current.harness, id);
      if (outcome.status !== "completed")
        throw new Error(JSON.stringify(outcome));
      return outcome.result as Extract<SolverResult, { kind: "verification" }>;
    };
    try {
      const result = await invoke();
      expect(
        result.checks.map((check) => [
          check.noteId,
          check.reconstruction?.verdict,
        ]),
      ).toEqual([
        ["n1", refuted ? "FAIL" : "INCONCLUSIVE"],
        ...["n2", "n3"].map((id) => [id, refuted ? "INCONCLUSIVE" : "PASS"]),
        ["n4", "PASS"],
        ...(dependent ? [] : [["n5", "PASS"]]),
      ]);
      expect(
        provider.calls.map(({ name, input }) => [
          name,
          input.notes.map(({ id }: { id: string }) => id),
        ]),
      ).toEqual([
        ["proof", ["n1", "n2", "n3", "n4", "n5"]],
        ["reconstruction", ["n1", "n2", "n3", "n4"]],
        ...(refuted
          ? []
          : [
              ["reconstruction", ["n2", "n3", "n4"]],
              ["reconstruction", ["n3", "n4"]],
            ]),
        ["reconstruction", ["n4"]],
        ...(dependent
          ? []
          : [
              ["proof", ["n5"]],
              ["reconstruction", ["n5"]],
            ]),
      ]);
      if (dependent) {
        for (const check of result.checks)
          notes.find(({ id }) => id === check.noteId)!.checks.push(check);
        retry = true;
        const before = provider.calls.length;
        expect(await invoke()).toMatchObject({
          checks: ["n1", "n5"].map((noteId) => ({
            noteId,
            reconstruction: { verdict: "PASS" },
          })),
        });
        expect(
          provider.calls
            .slice(before)
            .map(({ name, input }) => [
              name,
              input.notes.map(({ id }: { id: string }) => id),
            ]),
        ).toEqual([
          ["proof", ["n1", "n5"]],
          ["reconstruction", ["n1", "n5"]],
          ["reconstruction", ["n5"]],
        ]);
      }
    } finally {
      await current.harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("standalone reconstruction retains completed checks and corrections after a later failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-reconstruct-failure-"));
  const notes = [preparedNote("n1"), preparedNote("n2", ["n1"])];
  const provider = fixture((name, input) => {
    if (name === "proof")
      return {
        results: input.notes.map(({ id }: { id: string }) => ({
          noteId: id,
          proof: "Independent complete proof",
          complete: true,
        })),
      };
    expect(name).toBe("reconstruction");
    if (input.notes[0].id === "n2")
      return fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "Comparison unavailable",
      });
    return {
      results: [
        {
          noteId: "n1",
          verdict: "PASS",
          report: "Checked",
          correction: {
            summary: "Clarified summary",
            detailedSummary: null,
            text: null,
          },
        },
      ],
    };
  });
  const current = await provider.open(directory, {
    task,
    settings: { profiles: { default: { provider: "openai", model: "roles" } } },
    mode: { role: "reconstruct", input: { task, notes, targets: ["n2"] } },
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
    expect(view.results[0]!.outcome).toMatchObject({
      status: "failed",
      error: { message: "Comparison unavailable" },
      result: {
        kind: "verification",
        checks: [
          {
            noteId: "n1",
            correction: { revision: 0, summary: "Clarified summary" },
            reconstruction: {
              verdict: "PASS",
              proof: "Independent complete proof",
            },
          },
        ],
      },
    });
    expect(provider.calls.map(({ name }) => name)).toEqual([
      "proof",
      "reconstruction",
      "reconstruction",
    ]);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["imported", "reconstructed"] as const)(
  "reconstruction checks ancestors of %s support without repeating its proof",
  async (middle) => {
    const directory = await mkdtemp(
      join(tmpdir(), "pi-role-transitive-support-"),
    );
    const support = preparedNote("n2", ["n1"]);
    if (middle === "imported") support.imported = true;
    else
      support.checks.push({
        reconstruction: {
          verdict: "PASS",
          report: "Previously checked",
          proof: "Earlier proof",
        },
      });
    const provider = fixture((name, input) => {
      const id = input.notes[0].id;
      expect(input.support.map(({ id }: { id: string }) => id)).toEqual(
        id === "n3" ? ["n1", "n2"] : name === "proof" ? ["n2"] : [],
      );
      const middleInput = input.support.find(
        ({ id }: { id: string }) => id === "n2",
      );
      expect(middleInput?.text).toBe(
        name === "reconstruction" && middle === "imported" && id === "n3"
          ? support.text
          : undefined,
      );
      if (name === "proof")
        expect(JSON.stringify(input)).not.toContain("secret original proof");
      return {
        results: [
          {
            noteId: id,
            ...(name === "proof"
              ? { complete: true, proof: "Independent proof" }
              : { verdict: "PASS", report: "Checked" }),
          },
        ],
      };
    });
    const current = await provider.open(directory);
    try {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            {
              role: "verifier",
              input: {
                task,
                notes: [
                  preparedNote("n3", ["n2"]),
                  support,
                  preparedNote("n1"),
                ],
                targets: [{ id: "n3", through: "reconstruction" }],
              },
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      expect(await resultOf(current.harness, id)).toMatchObject({
        status: "completed",
        result: {
          checks: ["n1", "n3"].map((noteId) => ({
            noteId,
            reconstruction: { verdict: "PASS" },
          })),
        },
      });
      expect(
        provider.calls.map(({ name, input }) => [name, input.notes[0].id]),
      ).toEqual([
        ["proof", "n1"],
        ["reconstruction", "n1"],
        ["proof", "n3"],
        ["reconstruction", "n3"],
      ]);
    } finally {
      await current.harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  "malformed",
  "source IDs",
  "source premises",
  "cleanup",
  "continuation",
] as const)(
  "late %s failure preserves completed verification and a fresh worker reuses it",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-verifier-failure-"));
    const invalidSource =
      failure === "source IDs" || failure === "source premises";
    let proofs = 0,
      sources = 0,
      retry = false,
      cleanupFailed = false;
    const provider = fixture(
      (name, input) => {
        if (name === "explorer")
          return { notes: [draft("n1"), draft("n2", ["n1"])], candidate: true };
        if (name === "proof" && ++proofs > 1 && !retry) {
          if (failure === "continuation")
            return "Unsubmitted proof: " + "x".repeat(80000);
          if (failure === "cleanup")
            return fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: "Response incomplete: max_messages",
            });
          if (failure === "malformed" && proofs === 2)
            return {
              results: [
                { noteId: input.notes[0].id, proof: "Missing completeness" },
              ],
            };
          return "No structured proof submitted.";
        }
        const value =
          name === "correctness"
            ? {
                verdict: "PASS",
                report: "Checked",
                premises: ["External theorem"],
                correction: {
                  summary: "Corrected summary",
                  detailedSummary: null,
                  text: null,
                },
              }
            : name === "proof"
              ? { complete: true, proof: "Independent proof" }
              : { verdict: "PASS", report: "Checked" };
        return {
          results: (name === "proof"
            ? input.notes.slice(0, 1)
            : input.notes
          ).map(({ id }: { id: string }) => ({
            noteId: id,
            ...value,
            ...(name === "correctness"
              ? { statement: `${id} exact claim` }
              : {}),
          })),
        };
      },
      { research: false },
      failure === "continuation" ? 32768 : 131072,
      {
        ...closedBookResearch,
        retrieval: true,
        async source(input) {
          sources++;
          return input.notes.map(({ id }) => ({
            noteId: failure === "source IDs" && !retry ? "unrequested" : id,
            verdict: "PASS",
            report: "Source established",
            ...(failure === "source premises" && !retry
              ? {
                  kind: "codex-report" as const,
                  operationId: "mismatched-source",
                  reportedAt: "2026-10-05T00:00:00Z",
                  premises: ["Different external theorem"],
                  passages: [],
                  correction: {
                    summary: "Invalid source correction",
                    detailedSummary: null,
                    text: null,
                  },
                }
              : {}),
          }));
        },
      },
    );
    provider.roles.coordinator = async (input) => {
      if (!input.notes.length)
        return { work: { kind: "explorer", guidance: "Prove" } };
      if (input.failures.length) {
        expect(input.failures[0]!.error).toEqual(
          failure === "continuation"
            ? capacityError
            : failure === "cleanup"
              ? "Response incomplete: max_messages"
              : failure === "source IDs"
                ? "Batch results must contain exactly one result per requested note"
                : failure === "source premises"
                  ? `Source-checked premises do not match correctness for ${input.notes[0]!.id}`
                  : "proof did not submit a structured result",
        );
        expect(input.notes[0]!.verified).toBe(!invalidSource);
        if (!retry) return { work: null };
      }
      return {
        work: {
          kind: "verifier",
          notes: [input.notes.at(-1)!.id],
          through: "reconstruction",
        },
      };
    };
    let current = await provider.open(directory, {
      task,
      settings: {
        profiles: { default: { provider: "openai", model: "roles" } },
      },
    });
    const unregister = registerSessionResourceCleanup((sessionId) => {
      if (
        failure === "cleanup" &&
        !cleanupFailed &&
        sessionId !== undefined &&
        sessionId ===
          provider.calls.filter(({ name }) => name === "proof")[1]?.session
      ) {
        cleanupFailed = true;
        throw new Error("Fixture session cleanup failure");
      }
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
          checks: ["reconstruction", "requirements"].map((stage) => ({
            correctness: { verdict: "PASS", premises: ["External theorem"] },
            ...(!invalidSource
              ? { source: { verdict: "PASS" }, [stage]: { verdict: "PASS" } }
              : {}),
          })),
        },
      });
      if (invalidSource) {
        expect(view.notes.map((note) => note.checks[0]!.source)).toEqual([
          undefined,
          undefined,
        ]);
        expect(provider.calls.map(({ name }) => name)).toEqual([
          "explorer",
          "correctness",
        ]);
      }
      if (failure === "cleanup")
        expect(provider.reports.map(String)).toContain(
          "AggregateError: Failed to cleanup session resources",
        );
      expect(view.notes[0]).toMatchObject({
        verified: !invalidSource,
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
      ).toMatchObject({ status: "failed", checkCount: 2 });
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
      expect(sources).toBe(invalidSource ? 2 : 1);
      if (failure === "malformed")
        expect(
          (await entries(current.harness)).some((entry) =>
            entry.model?.some(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "submit_proof" &&
                message.isError,
            ),
          ),
        ).toBe(true);
      expect(provider.calls.map(({ name }) => name)).toEqual([
        "explorer",
        "correctness",
        "requirements",
        "proof",
        "reconstruction",
        ...Array(
          failure === "cleanup" || failure === "continuation"
            ? 1
            : failure === "malformed"
              ? 3
              : 0,
        ).fill("proof"),
        "proof",
        "reconstruction",
      ]);
    } finally {
      unregister();
      await current.harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([true, false])(
  "an imported candidate needs independent reconstruction, complete=%s, despite cleanup failure",
  async (complete) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-imported-candidate-"));
    const imported = {
      ...note("n1"),
      imported: true,
      candidate: true,
      text: "For every real x >= 1, x squared is at least x.",
    };
    const provider = fixture(
      (name, input, transcript) => {
        if (name === "reconstruction") {
          expect(JSON.stringify(transcript)).toContain(
            "For an imported target, caller trust grants the original result and sources; no original proof is required.",
          );
          expect(input.notes[0]).toMatchObject({
            imported: true,
            text: imported.text,
          });
          expect(input.premises[0].source).toEqual({ kind: "caller-import" });
        }
        return {
          results: [
            {
              noteId: "n1",
              ...(name === "proof"
                ? {
                    complete,
                    proof: complete
                      ? "x(x-1) >= 0 proves the claim."
                      : "The proof remains incomplete.",
                  }
                : {
                    verdict: "PASS",
                    report: "Checked",
                    ...(name === "correctness"
                      ? { statement: imported.text, premises: [] }
                      : {}),
                  }),
            },
          ],
        };
      },
      { research: false },
      131072,
      {
        ...closedBookResearch,
        async source() {
          throw new Error("Caller imports already grant source trust");
        },
      },
    );
    const current = await provider.open(directory);
    let cleanupFailed = false;
    const unregister = registerSessionResourceCleanup((sessionId) => {
      if (
        !cleanupFailed &&
        sessionId !== undefined &&
        sessionId ===
          provider.calls.find(({ name }) => name === "reconstruction")?.session
      ) {
        cleanupFailed = true;
        throw new Error("Successful comparison cleanup failed");
      }
    });
    try {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            {
              role: "verifier",
              input: {
                task,
                notes: [imported],
                targets: [{ id: "n1", through: "reconstruction" }],
              },
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      const result = await resultOf(current.harness, id);
      expect(result.status).toBe("completed");
      if (result.status !== "completed")
        throw new Error("Missing imported verification result");
      const verification = validateResult(result.result, [imported]);
      if (verification.kind !== "verification")
        throw new Error("Missing imported verification checks");
      expect(verification.checks).toHaveLength(1);
      expect(verification.checks[0]!.source).toBeUndefined();
      expect(verification.checks[0]!.reconstruction?.verdict).toBe(
        complete ? "PASS" : "INCONCLUSIVE",
      );
      imported.checks.push(...verification.checks);
      expect(refresh([imported])[0]!.accepted).toBe(complete);
      if (complete) {
        expect(acceptedArgument([imported], imported.id)).toContain(
          "x(x-1) >= 0 proves the claim.",
        );
        expect(imported.text).toBe(
          "For every real x >= 1, x squared is at least x.",
        );
      } else
        expect(() => acceptedArgument([imported], imported.id)).toThrow(
          "No accepted argument",
        );
      expect(cleanupFailed).toBe(true);
      expect(provider.reports.map(String)).toContain(
        "AggregateError: Failed to cleanup session resources",
      );
      expect(provider.calls.map(({ name }) => name)).toEqual([
        "correctness",
        "requirements",
        "proof",
        "reconstruction",
      ]);
    } finally {
      unregister();
      await current.harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("notes without a mathematical claim skip source and reconstruction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-context-note-"));
  const provider = fixture((name, input) => {
    expect(name).toBe("correctness");
    expect(input.notes[0].text).toBe("Would a different construction help?");
    return {
      results: [
        {
          noteId: "n1",
          verdict: "PASS",
          statement: null,
          premises: [],
          report: "The note records a question without asserting a result.",
        },
      ],
    };
  });
  const current = await provider.open(directory);
  try {
    const id = await current.root.commit(
      (tx) =>
        tx.createTask(
          provider.Invoke,
          {
            role: "verifier",
            input: {
              task,
              notes: [
                { ...note("n1"), text: "Would a different construction help?" },
              ],
              targets: [{ id: "n1", through: "reconstruction" }],
            },
          },
          { ownership: { kind: "conversation" } },
        ),
      context,
    );
    expect(await resultOf(current.harness, id)).toEqual({
      status: "completed",
      result: {
        kind: "verification",
        checks: [
          {
            noteId: "n1",
            correctness: {
              verdict: "INCONCLUSIVE",
              statement: null,
              premises: [],
              report: expect.any(String),
            },
          },
        ],
      },
    });
    expect(provider.calls.map(({ name }) => name)).toEqual(["correctness"]);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["request", "incomplete.max_messages", "length"] as const)(
  "source recovery preserves checks and rejects incomplete proofs after %s",
  async (reason) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-role-custom-source-"));
    let sourceCalls = 0;
    let proofs = 0;
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
      (name, input, transcript) => {
        input = JSON.parse(
          String(
            transcript.messages.find((message) => message.role === "user")!
              .content,
          ),
        );
        if (name === "proof" && reason !== "request" && ++proofs === 1)
          return {
            ...fauxAssistantMessage(
              [
                {
                  type: "thinking",
                  thinking: "Completed preliminary lemma",
                  thinkingSignature: JSON.stringify({
                    type: "reasoning",
                    id: "rs_complete",
                    status: "completed",
                    encrypted_content: "encrypted-complete",
                    summary: [],
                  }),
                },
                { type: "text", text: "Interrupted proof text" },
                fauxToolCall("submit_proof", {
                  results: [
                    {
                      noteId: "n1",
                      proof: "PARTIAL_TOOL_PROOF",
                      complete: true,
                    },
                  ],
                }),
              ],
              { stopReason: reason === "length" ? "length" : "error" },
            ),
            rawStopReason:
              reason === "length" ? "incomplete.max_output_tokens" : reason,
            errorMessage:
              reason === "length"
                ? undefined
                : "Response incomplete: max_messages",
          };
        if (name === "proof" && proofs > 1) {
          const body = JSON.stringify(transcript);
          expect(body).toContain("Completed preliminary lemma");
          expect(body).not.toContain("PARTIAL_TOOL_PROOF");
          expect(body).not.toContain("missing_result");
          if (reason !== "length")
            expect(body).not.toContain("Interrupted proof text");
        }
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
          const tool = getCurrentTools(transcript.messages).find(
            (tool) => tool.name === "submit_proof",
          )!;
          expect(JSON.stringify(tool.parameters)).toContain(
            "lack of a fresh source search does not make this proof incomplete",
          );
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
                statement: "n1 exact claim",
                premises: [premise],
              }
            : name === "proof"
              ? {
                  proof: "Argument using the permitted theorem.",
                  complete: reason === "incomplete.max_messages",
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
                text: null,
              },
            },
          ];
        },
      },
      "openai-responses",
    );
    let current = await provider.open(directory, undefined, true);
    try {
      const closed = Promise.withResolvers<void>();
      let closing = false;
      current.harness.subscribeCommits(({ changes }) => {
        if (
          !closing &&
          changes.some(
            (change) =>
              change.type === "entry" &&
              change.value.model?.some((message) =>
                reason === "request"
                  ? message.role === "toolResult" &&
                    message.toolName === "submit_requirements" &&
                    !message.isError
                  : message.role === "assistant" &&
                    message.rawStopReason ===
                      (reason === "length"
                        ? "incomplete.max_output_tokens"
                        : reason),
              ),
          )
        ) {
          closing = true;
          void current.harness
            .close(context)
            .then(closed.resolve, closed.reject);
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
      current = await provider.open(directory, undefined, true);
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
              reconstruction: {
                verdict:
                  reason === "incomplete.max_messages"
                    ? "PASS"
                    : "INCONCLUSIVE",
              },
            },
          ],
        },
      });
      expect(sourceCalls).toBe(1);
      expect(provider.calls.map(({ name }) => name)).toEqual([
        "correctness",
        "requirements",
        ...(reason === "request" ? [] : ["proof"]),
        "proof",
        "reconstruction",
      ]);
      const proofCalls = provider.calls.filter(({ name }) => name === "proof");
      if (proofCalls.length > 1) {
        expect(proofCalls[1]!.session).toBe(proofCalls[0]!.session);
        expect(
          proofCalls[1]!.transcript.messages.find(
            (message) => message.role === "user",
          ),
        ).toEqual(
          proofCalls[0]!.transcript.messages.find(
            (message) => message.role === "user",
          ),
        );
      }
      expect(
        (await entries(current.harness)).filter(
          (entry) =>
            ToolResultEntry.is(entry) &&
            entry.model?.some(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "submit_proof",
            ),
        ),
      ).toHaveLength(1);
      const mismatched = preparedNote("n1");
      mismatched.checks[0]!.source = source;
      const rejected = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            {
              role: "verifier",
              input: {
                task,
                notes: [mismatched],
                targets: [{ id: "n1", through: "reconstruction" }],
              },
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      expect(await resultOf(current.harness, rejected)).toMatchObject({
        status: "faulted",
        error: {
          message: "Source-checked premises do not match correctness for n1",
        },
      });
      expect(provider.calls).toHaveLength(reason === "request" ? 4 : 5);
    } finally {
      await current.harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

async function fakeCodex(directory: string) {
  const executable = join(directory, "codex-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst input = await Bun.stdin.json();\nif (input.assignment && !process.argv.includes('web_search="disabled"')) throw new Error("Worker enabled web search");\nif (process.env.TEST_INTERRUPTION && !(await Bun.file(process.env.TEST_INTERRUPTION).exists())) { await Bun.write(process.env.TEST_INTERRUPTION, "attempted"); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Partial opaque work"}})); await Bun.write(input.workspace + "/started", "partial artifact"); await new Promise(() => setInterval(() => {}, 1000)); }\nlet value;\nif (input.query || input.assignment) value = {notes:[{id:"n1",summary:"Finding",detailedSummary:"Exact finding",text:"Finding. Evidence.",support:[]}],...(input.assignment?{candidate:false}:{})};\nelse if(input.argument) value = {verdict:input.argument === "malformed" ? "INVALID" : "PASS",report:"Independent review",premises:["External premise"],passages:[{premise:0,url:"https://example.org/theorem",quote:"Exact theorem"}]};\nelse value = {results:input.facts.map(fact=>({noteId:fact.id,verdict:"PASS",report:"Sources checked",passages:[{premise:0,url:"https://example.org/theorem",quote:"Exact theorem"}]}))};\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"web_search"}}));\nconsole.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(value)}}));\nconsole.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:17,output_tokens:5,cached_input_tokens:0}}));\n`,
  );
  await chmod(executable, 0o700);
  return executable;
}

test("Coordinator capabilities survive retry and reopen; fresh decisions get fresh conversations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-role-coordinator-"));
  let count = 0;
  let retried = false;
  const provider = fixture(
    (_name, input, transcript) => {
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
        expect(Check(tool.parameters, { work: request })).toBe(
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
          work: { kind: "explorer", guidance: "Unavailable Explorer" },
        };
      if (count === 2)
        expect(
          transcript.messages.some(
            (message) => message.role === "toolResult" && message.isError,
          ),
        ).toBe(true);
      return count >= 4
        ? {
            work: {
              kind: "codex",
              assignment:
                "Implement the specified construction and check its constraints",
              notes: [],
            },
          }
        : { work: null };
    },
    {
      research: false,
      chatgpt: {
        baseUrl: "http://127.0.0.1:17841/v1",
        model: "chatgpt-web/gpt-6-pro",
      },
    },
  );
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
      explorerUsed: true,
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
        result: { work: null },
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
      result: { work: { kind: "codex" } },
    });
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Coordinator rejects used literature and multiple workers", async () => {
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
          work: { kind: "literature", query: "Repeat a completed search" },
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
      return { work: { kind: "explorer", guidance: "Continue" } };
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
  };
  try {
    for (const literatureUsed of [true, false]) {
      const id = await current.root.commit(
        (tx) =>
          tx.createTask(
            provider.Invoke,
            {
              role: "coordinator" as const,
              input: { ...input, literatureUsed } as JsonValue,
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result: {
          work: { kind: "explorer", guidance: "Continue" },
        },
      });
    }
    expect(provider.calls).toHaveLength(4);
  } finally {
    await current.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  [false, 2, 2],
  [true, 2, 2],
  [false, 16, 9],
] as const)(
  "truncated Explorer responses retain only prior complete submissions (saved=%s, allowance=%s, calls=%s)",
  async (submitted, allowance, expectedCalls) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-role-truncated-"));
    const cleaned: (string | undefined)[] = [];
    const unregister = registerSessionResourceCleanup((sessionId) =>
      cleaned.push(sessionId),
    );
    let response = 0;
    const provider = fixture(
      () => {
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
      },
      { research: false, maxExplorerResponses: allowance },
    );
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
      await current.root.commit(
        (tx) => provider.workflow.initialize(tx, current.root.id),
        context,
      );
      await current.harness.waitForIdle(context);
      const id = (
        await current.root.commit(
          (tx) => scanTasks(tx, current.root.id, "research.worker"),
          context,
        )
      )[0]!.id;
      const outcome = await resultOf(current.harness, id);
      expect(outcome).toMatchObject(
        submitted
          ? {
              status: "completed",
              result: {
                kind: "notes",
                candidate: false,
                notes: [{ id: "n1" }],
              },
            }
          : {
              status: "failed",
              error: {
                message: "explorer did not submit a structured result",
              },
            },
      );
      expect(provider.calls).toHaveLength(expectedCalls);
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
      if (!submitted) expect(report.result).toBeUndefined();
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
      text: "exact mathematical text ".repeat(20000),
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
              notes: [{ ...note("prior"), text: "sensitive full argument" }],
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
        ...(name === "correctness"
          ? {
              statement: `${note.id} exact claim`,
              premises: ["External premise"],
            }
          : {}),
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
      notes: [{ text: expect.stringContaining(`Artifacts: ${workspace}`) }],
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
      const submit = fauxToolCall("submit_coordinator", {
        work: { kind: "explorer", guidance: "Continue" },
      });
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
              },
            },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result: { work: { kind: "explorer", guidance: "Continue" } },
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
