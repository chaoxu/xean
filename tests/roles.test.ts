import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { watchFile, unwatchFile } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  registerSessionResourceCleanup,
  type AssistantMessage,
  type TranscriptContext,
  type Static,
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
  type Tx,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  createRoles,
  type CoordinationInput,
  type RoleOptions,
} from "../src/roles/index.ts";
import type { RoleRuntime } from "../src/core/roles.ts";
import { closedBookResearch, externalResearch } from "../src/roles/research.ts";
import type { ExternalCall, Research } from "../src/roles/backend.ts";
import { capacityError, createRuntime } from "../src/roles/config.ts";
import { ExternalLog, ExternalRequest } from "../src/roles/backend.ts";
import { codex } from "../src/plugins/role-backends/codex.ts";
import {
  explorationSchema,
  literatureResultSchema,
  type Note,
  type SolverResult,
} from "../src/core/math/contracts.ts";
import { DefinitionDoc, type Definition } from "../src/core/definition.ts";
import { createResearch, scanTasks } from "../src/core/workflow.ts";
import { readReport, readStatus, readUsage } from "../src/report.ts";
import { explorerLimit } from "../src/core/math/results.ts";
import {
  Bodies,
  Events,
  publishCommand,
  readView,
  readSnapshot,
  type SnapshotReader,
} from "../src/core/math/state.ts";
import { refresh, validateResult } from "../src/core/math/notes.ts";
import { acceptedArgument } from "../src/report.ts";
import type { TaskId } from "@earendil-works/pi-durable";

const context = BACKGROUND_CONTEXT;
async function resultOf(harness: Harness, id: TaskId<JsonValue>) {
  return (await harness.waitForTask(id, context)).state.outcome;
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
const workerDraft = (
  input: { noteIdPrefix: string },
  suffix: string,
  support: string[] = [],
) => {
  expect(input.noteIdPrefix).toBeString();
  expect(input.noteIdPrefix.endsWith("/")).toBe(true);
  return draft(`${input.noteIdPrefix}${suffix}`, support);
};
const note = (id: string, support: string[] = []): Note => ({
  ...draft(id, support),
  revision: 0,
  checks: {},
  verified: false,
  dead: false,
  accepted: false,
  candidate: false,
  retired: false,
});
const preparedNote = (id: string, support: string[] = []): Note => ({
  ...note(id, support),
  checks: {
    correctness: {
      verdict: "PASS",
      report: "Checked",
      statement: `${id} exact claim`,
      premises: [],
    },
    source: { verdict: "PASS", report: "Checked" },
    requirements: { verdict: "PASS", report: "Checked" },
  },
});
type Invocation = {
  role:
    | "coordinator"
    | "explorer"
    | "verifier"
    | "reconstruct"
    | "literature"
    | "review"
    | "implementation";
  input: JsonValue;
};

function fixture(
  respond: (name: string, input: any, transcript: TranscriptContext) => unknown,
  options: Omit<RoleOptions, "profiles"> = {},
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
  const roles = createRoles({ ...options, profiles });
  if (research) roles.external.research = research;
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
    directory?: string,
    definition?: Definition,
    retry = false,
  ) {
    const registry = createRegistry();
    registry.install(roles.extension);
    registry.install(workflow.extension);
    registry.install(defineExtension({ name: "test.roles", tasks: [Invoke] }));
    const harness = await Harness.open(
      directory === undefined
        ? new MemoryStorage()
        : await openNodeJsonlStorage(directory, context, { fsync: true }),
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
    return {
      harness,
      root,
      closeAfterEntry(predicate: (entry: EntryRecord) => boolean | undefined) {
        const closed = Promise.withResolvers<void>();
        let closing = false;
        harness.subscribeCommits(({ changes }) => {
          if (
            !closing &&
            changes.some(
              (change) => change.type === "entry" && predicate(change.value),
            )
          ) {
            closing = true;
            void harness.close(context).then(closed.resolve, closed.reject);
          }
        });
        return {
          promise: closed.promise,
          get closing() {
            return closing;
          },
        };
      },
      invoke: (input: Invocation) =>
        root.commit(
          (tx) =>
            tx.createTask(Invoke, input, {
              ownership: { kind: "conversation" },
            }),
          context,
        ),
    };
  }
  return { calls, reports, roles, workflow, open };
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

test("a repaired support is rechecked with consumers before downstream verification", async () => {
  const provider = fixture((name, input) => ({
    results: input.notes.map(({ id, text }: { id: string; text?: string }) => ({
      noteId: id,
      ...(name === "proof"
        ? { complete: true, proof: `Independent proof of ${id}` }
        : {
            verdict: "PASS",
            report: "Checked",
            ...(name === "correctness"
              ? {
                  statement: `${id}: ${text?.startsWith("Repaired") ? "new" : "old"} claim`,
                  premises: [],
                }
              : {}),
          }),
    })),
  }));
  let decision = 0;
  provider.roles.coordinator = async (input) => {
    switch (++decision) {
      case 1:
      case 3:
        return { work: { kind: "explorer", assignment: "Create or repair" } };
      case 2:
      case 4:
        return {
          work: {
            kind: "verifier",
            notes: [input.notes[1]!.id],
            through: decision === 2 ? "source" : "reconstruction",
          },
        };
      default:
        return { work: null };
    }
  };
  provider.roles.explorer = async (input, runtime) => ({
    kind: "notes",
    notes: input.notes.length
      ? []
      : [
          draft(`${runtime.taskId}/n1`),
          {
            ...draft(`${runtime.taskId}/n2`, [`${runtime.taskId}/n1`]),
            candidate: true,
          },
        ],
    ...(input.notes.length
      ? {
          edits: [
            {
              id: input.notes[0]!.id,
              revision: input.notes[0]!.revision,
              text: "Repaired theorem and proof",
            },
          ],
        }
      : {}),
  });
  const current = await provider.open(undefined, {
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
    const ids = view.notes.map(({ id }) => id);
    expect(
      provider.calls
        .filter((c) => c.name === "correctness")
        .map((c) => c.input.notes.map((n: Note) => n.id)),
    ).toEqual([ids, ids]);
    expect(view.notes[1]!.accepted).toBe(true);
    expect(provider.reports).toEqual([]);
  } finally {
    await current.harness.close(context);
  }
});

test("standalone Explorer preserves supplied trust and its conversation across publication and reopen", async () => {
  const cleaned: (string | undefined)[] = [];
  const unregister = registerSessionResourceCleanup((sessionId) =>
    cleaned.push(sessionId),
  );
  const directory = await temporaryDirectory("pi-role-explorer-");
  const inputNote = {
    ...preparedNote("prior"),
    checks: { ...preparedNote("prior").checks, external: { entry: 1 } },
    verified: true,
  };
  let suppliedRevision = 0;
  let response = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      response++;
      if (response === 1) {
        suppliedRevision = input.notes[0].revision;
        expect(suppliedRevision).toBeGreaterThan(0);
        expect(input).toMatchObject({
          task,
          notes: [{ id: inputNote.id, summary: inputNote.summary }],
        });
        expect(JSON.stringify(transcript)).not.toContain(inputNote.text);
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
        throw new Error("Expected supplied note read");
      expect(read.isError).not.toBe(true);
      expect(JSON.parse(read.content[0].text.split("\n\n")[0]!)).toEqual([
        {
          id: inputNote.id,
          revision: suppliedRevision,
          detailedSummary: inputNote.detailedSummary,
          statement: inputNote.checks.correctness!.statement,
          text: inputNote.text,
        },
      ]);
      if (response === 2)
        return { notes: [workerDraft(input, "n1", ["prior"])] };
      const receipt = transcript.messages.findLast(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "submit_explorer" &&
          !message.isError,
      );
      if (receipt?.role !== "toolResult" || receipt.content[0]?.type !== "text")
        throw new Error("Expected first note publication receipt");
      const published = JSON.parse(receipt.content[0].text.split("\n\n")[0]!);
      return {
        notes: [
          {
            ...workerDraft(input, "n2", [published.notes[0].id]),
            candidate: true,
          },
        ],
      };
    },
    { maxExplorerReads: 1, maxExplorerResponses: 4 },
  );
  let current = await provider.open(directory, {
    task,
    settings: {
      profiles: { default: { provider: "openai", model: "roles" } },
    },
    mode: {
      role: "explorer",
      input: { notes: [inputNote], assignment: "Continue." },
    },
  });
  try {
    const closed = current.closeAfterEntry((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "submit_explorer" &&
          !message.isError,
      ),
    );
    await current.root.commit(
      (tx) => provider.workflow.initialize(tx, current.root.id),
      context,
    );
    current.harness.resume();
    await closed.promise;
    expect(provider.calls).toHaveLength(2);
    expect(cleaned).toEqual([provider.calls[0]!.session]);
    current = await provider.open(directory);
    const early = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    expect(early.notes).toHaveLength(2);
    expect(early.notes[0]).toMatchObject({
      ...inputNote,
      checks: { ...inputNote.checks, external: { entry: expect.any(Number) } },
      revision: suppliedRevision,
    });
    await current.harness.waitForIdle(context);
    const [worker] = await current.root.commit(
      (tx) => scanTasks(tx, current.root.id, "research.worker"),
      context,
    );
    const expected = {
      kind: "published",
      notes: [`${worker!.id}/n1`, `${worker!.id}/n2`],
      edits: [],
    };
    const outcome = await resultOf(current.harness, worker!.id);
    expect(outcome).toEqual({ status: "completed", result: expected });
    const view = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    expect(view.notes).toHaveLength(3);
    expect(view.notes[0]).toEqual(early.notes[0]!);
    expect(view.notes[1]).toMatchObject({
      ...draft(`${worker!.id}/n1`, ["prior"]),
    });
    expect(view.notes[2]).toMatchObject({
      ...draft(`${worker!.id}/n2`, [`${worker!.id}/n1`]),
      candidate: true,
    });
    expect(cleaned).toEqual([
      provider.calls[0]!.session,
      provider.calls[0]!.session,
    ]);
    expect(new Set(provider.calls.map(({ session }) => session)).size).toBe(1);
    await current.harness.close(context);
    current = await provider.open(directory);
    expect(
      (await current.harness.waitForTask(worker!.id, context)).state.outcome,
    ).toEqual(outcome);
    expect(
      (
        await current.root.commit(
          (tx) => readView(tx, current.root.id),
          context,
        )
      ).notes,
    ).toEqual(view.notes);
    expect(provider.calls).toHaveLength(3);
  } finally {
    await current.harness.close(context);
    unregister();
  }
});

test("Explorer rejects bare IDs and preserves permanent prose references across submissions and reopen", async () => {
  const directory = await temporaryDirectory("pi-role-permanent-ids-");
  let responses = 0;
  const submitted: ReturnType<typeof draft>[] = [];
  const provider = fixture(
    (_name, input, transcript) => {
      responses++;
      if (responses === 1) {
        expect(input.noteIdPrefix).toBeString();
        return { notes: [draft("auxiliary-bound")] };
      }
      const receipt = transcript.messages.findLast(
        (message) => message.role === "toolResult",
      );
      if (receipt?.role !== "toolResult" || receipt.content[0]?.type !== "text")
        throw new Error("Expected note publication feedback");
      if (responses === 2) {
        expect(receipt.isError).toBe(true);
        expect(receipt.content[0].text).toContain(
          `New note IDs must use prefix ${input.noteIdPrefix}`,
        );
        const bound = workerDraft(input, "auxiliary-bound");
        bound.text = `Claim ${bound.id}: the bound holds. Proof: direct calculation.`;
        const consequence = workerDraft(input, "consequence", [bound.id]);
        consequence.text = `By ${bound.id}, claim ${consequence.id} follows.`;
        submitted.push(bound, consequence);
        return { notes: [bound, consequence] };
      }
      expect(responses).toBe(3);
      expect(receipt.isError).toBe(false);
      const value = JSON.parse(receipt.content[0].text.split("\n\n")[0]!);
      expect(value.notes.map(({ id }: { id: string }) => id)).toEqual(
        submitted.map(({ id }) => id),
      );
      expect(value).not.toHaveProperty("nextNoteId");
      const result = workerDraft(input, "final-result", [submitted[1]!.id]);
      result.summary = `Result from ${submitted[1]!.id}`;
      result.detailedSummary = `Use ${submitted[1]!.id} at its stated scope.`;
      result.text = `Apply ${submitted[1]!.id}, which uses ${submitted[0]!.id}.`;
      submitted.push(result);
      return { notes: [{ ...result, candidate: true }] };
    },
    { maxExplorerResponses: 4 },
  );
  let current = await provider.open(directory);
  try {
    const id = await current.invoke({
      role: "explorer",
      input: { task, notes: [], assignment: "Publish permanent references." },
    });
    const outcome = await resultOf(current.harness, id);
    expect(outcome).toEqual({
      status: "completed",
      result: {
        kind: "published",
        notes: [
          `${id}/auxiliary-bound`,
          `${id}/consequence`,
          `${id}/final-result`,
        ],
        edits: [],
      },
    });
    const before = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    expect(before.notes).toHaveLength(submitted.length);
    before.notes.forEach((saved, index) =>
      expect(saved).toMatchObject(submitted[index]!),
    );
    expect((await entries(current.harness)).filter(Events.is)).toHaveLength(2);
    await current.harness.close(context);
    current = await provider.open(directory);
    expect(await resultOf(current.harness, id)).toEqual(outcome);
    const after = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    expect(after.notes).toEqual(before.notes);
    expect(responses).toBe(3);
  } finally {
    await current.harness.close(context);
  }
});

test("assigned proof and comparison groups preserve blindness, exact IDs, and progress after reopen", async () => {
  const directory = await temporaryDirectory("pi-role-verifier-");
  const proofText = (id: string) =>
    `${id} independent complete proof. `.repeat(
      ["n1", "n2"].includes(id) ? 120 : 1,
    );
  let rejectedIds = false;
  const invalidProofIds = [[], ["n1"], ["n2"], ["n1", "n1"]];
  const invalidComparisonIds = [[], ["n3"], ["n4"], ["n3", "n3"]];
  const provider = fixture((name, input, transcript) => {
    expect(input).not.toHaveProperty("verifiedSupport");
    const tool = getCurrentTools(transcript.messages).find(
      (tool) => tool.name === `submit_${name}`,
    )!;
    expect(tool.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
    if (name === "requirements") {
      expect(input.support).toEqual(
        ["n1", "n2", "n3"].map((id, index) => ({
          id,
          statement: `${id} exact claim`,
          support: index ? [`n${index}`] : [],
        })),
      );
      expect(input.notes[0]).toMatchObject({
        statement: "n4 exact claim",
        text: draft("n4").text,
        summary: "Harmless clarification",
        detailedSummary: draft("n4").detailedSummary,
      });
      expect(
        input.sources.map((source: { noteId: string }) => source.noteId),
      ).toEqual(["n1", "n2", "n3", "n4"]);
    }
    if (name === "proof") {
      expect(JSON.stringify(input)).not.toContain("secret original proof");
      expect(JSON.stringify(input)).not.toContain("detailed claim");
      expect(JSON.stringify(input)).not.toContain("Private comparison report");
      expect(
        input.notes.every((note: object) => !Object.hasOwn(note, "summary")),
      ).toBe(true);
      expect(input.notes.map(({ id }: { id: string }) => id)).toEqual(
        input.notes[0].id === "n1" ? ["n1", "n2"] : ["n3", "n4"],
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
          result: { complete: true, proof: proofText(id) },
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
            },
          }
        : name === "proof"
          ? { complete: true }
          : {
              verdict: "PASS",
              report: "Private comparison report",
              ...(name === "reconstruction"
                ? {
                    correction: {
                      summary: null,
                      detailedSummary: "Clarified detailed summary",
                    },
                  }
                : {}),
            };
    const resultFor = (noteId: string) => ({
      noteId,
      ...value,
      ...(name === "correctness"
        ? { statement: `${noteId} exact claim` }
        : name === "proof"
          ? { proof: proofText(noteId) }
          : {}),
    });
    const invalidIds =
      name === "proof" && input.notes[0].id === "n1"
        ? invalidProofIds
        : name === "reconstruction" && input.notes[0].id === "n3"
          ? invalidComparisonIds
          : [];
    if (invalidIds.length)
      return {
        results: invalidIds.shift()!.map(resultFor),
      };
    if (name === "proof" && input.notes[0].id === "n3" && !rejectedIds) {
      rejectedIds = true;
      return { results: ["n2", "n3", "n4"].map(resultFor) };
    }
    const result = {
      results: [...input.notes]
        .reverse()
        .map(({ id }: { id: string }) => resultFor(id)),
    };
    return result;
  });
  let current = await provider.open(directory);
  try {
    const closed = current.closeAfterEntry((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "submit_reconstruction" &&
          !message.isError,
      ),
    );
    const id = await current.invoke({
      role: "verifier",
      input: {
        task,
        notes: [
          note("n1"),
          note("n2", ["n1"]),
          note("n3", ["n2"]),
          { ...note("n4", ["n3"]), candidate: true },
        ],
        targets: ["n4"],
        through: "reconstruction",
      },
    });
    current.harness.resume();
    await closed.promise;
    expect(
      provider.calls
        .filter(({ name }) => name === "reconstruction")
        .map(({ input }) => input.notes.map(({ id }: { id: string }) => id)),
    ).toEqual([["n1"]]);
    current = await provider.open(directory);
    const outcome = await resultOf(current.harness, id);
    expect(outcome.status).toBe("completed");
    if (outcome.status !== "completed")
      throw new Error(JSON.stringify(outcome));
    const result = outcome.result as Extract<
      SolverResult,
      { kind: "verification" }
    >;
    expect(result.checks).toHaveLength(4);
    expect(
      result.checks.every(
        (check) =>
          check.source?.verdict === "PASS" &&
          check.reconstruction?.verdict === "PASS",
      ),
    ).toBe(true);
    for (const check of result.checks)
      expect(check.reconstruction?.proof).toBe(proofText(check.noteId));
    expect(result.checks[0]!.requirements).toBeUndefined();
    expect(result.checks[1]!.requirements).toBeUndefined();
    expect(result.checks[2]!.requirements).toBeUndefined();
    expect(result.checks[3]!.requirements?.verdict).toBe("PASS");
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
      // The fixture model reserves output/reasoning room for two claims per call.
      ["correctness", ["n1", "n2"]],
      ["correctness", ["n3", "n4"]],
      ["requirements", ["n4"]],
      ...Array.from({ length: 5 }, () => ["proof", ["n1", "n2"]]),
      ["reconstruction", ["n1"]],
      ["reconstruction", ["n2"]],
      ["proof", ["n3", "n4"]],
      ["proof", ["n3", "n4"]],
      ...Array.from({ length: 5 }, () => ["reconstruction", ["n3", "n4"]]),
    ]);
    const proofs = provider.calls.filter(({ name }) => name === "proof");
    expect(new Set(proofs.slice(0, 5).map(({ session }) => session)).size).toBe(
      1,
    );
    expect(proofs.at(-2)!.session).toBe(proofs.at(-1)!.session);
    expect(new Set(provider.calls.map(({ session }) => session)).size).toBe(8);
    const comparisons = provider.calls.filter(
      ({ name }) => name === "reconstruction",
    );
    expect(
      new Set(comparisons.slice(2).map(({ session }) => session)).size,
    ).toBe(1);
    for (const [call, requested, received, missing, unexpected, duplicates] of [
      [proofs[4]!, ["n1", "n2"], ["n1", "n1"], ["n2"], [], ["n1"]],
      [proofs.at(-1)!, ["n3", "n4"], ["n2", "n3", "n4"], [], ["n2"], []],
      [comparisons.at(-1)!, ["n3", "n4"], ["n3", "n3"], ["n4"], [], ["n3"]],
    ] as const) {
      const error = call.transcript.messages
        .filter((message) => message.role === "toolResult")
        .findLast((message) => message.isError);
      expect(error?.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(
          JSON.stringify({
            requested,
            received,
            missing,
            unexpected,
            duplicates,
            duplicateRequests: [],
          }),
        ),
      });
    }
  } finally {
    await current.harness.close(context);
  }
});

test.each(["correctness", "requirements"] as const)(
  "%s splits oversized assignments, scopes support and evidence, and resumes completed groups",
  async (stage) => {
    const directory = await temporaryDirectory("pi-role-assessment-");
    const notes = ["n1", "n2"].map((id) => ({
      ...(stage === "correctness" ? note(id) : preparedNote(id)),
      text: "Detailed argument. ".repeat(2400),
      support: [`${id}-support`],
      candidate: true,
    }));
    for (const item of notes) delete item.checks.requirements;
    const supports = notes.map(({ support: [id] }) => ({
      ...preparedNote(id!),
      checks: { ...preparedNote(id!).checks, external: { entry: 1 } },
    }));
    const provider = fixture(
      (name, input) => {
        expect(name).toBe(stage);
        expect(input.notes).toHaveLength(1);
        const id = input.notes[0].id;
        expect(input.support.map((item: { id: string }) => item.id)).toEqual([
          `${id}-support`,
        ]);
        if (stage === "requirements")
          expect(
            input.sources.map((item: { noteId: string }) => item.noteId),
          ).toEqual([`${id}-support`, id]);
        return {
          results: [
            {
              noteId: id,
              verdict: "PASS",
              report: "Checked",
              ...(stage === "correctness"
                ? { statement: `${id} exact claim`, premises: [] }
                : {}),
            },
          ],
        };
      },
      {},
      32768,
    );
    let current = await provider.open(directory);
    try {
      const closed = current.closeAfterEntry((entry) =>
        entry.model?.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === `submit_${stage}` &&
            !message.isError,
        ),
      );
      const id = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes: [...notes, ...supports],
          targets: ["n1", "n2"],
          through: stage,
        },
      });
      current.harness.resume();
      await closed.promise;
      expect(provider.calls).toHaveLength(1);
      current = await provider.open(directory);
      expect(await resultOf(current.harness, id)).toMatchObject({
        status: "completed",
        result: {
          checks: ["n1", "n2"].map((noteId) => ({
            noteId,
            [stage]: { verdict: "PASS" },
          })),
        },
      });
      expect(
        provider.calls.map(({ input }) =>
          input.notes.map(({ id }: { id: string }) => id),
        ),
      ).toEqual([["n1"], ["n2"]]);
    } finally {
      await current.harness.close(context);
    }
  },
);

test.each(["PASS", "FAIL", "INCONCLUSIVE"] as const)(
  "later correctness groups use earlier %s assessments without checking refuted consumers",
  async (verdict) => {
    const provider = fixture(
      (name, input) => {
        expect(name).toBe("correctness");
        const ids = input.notes.map(({ id }: { id: string }) => id);
        if (ids.includes("n1")) expect(ids).toEqual(["n1"]);
        if (ids.includes("n2")) {
          expect(verdict).not.toBe("FAIL");
          expect(input.support).toMatchObject([
            {
              id: "n1",
              statement: "n1 newly extracted claim",
              summary: verdict === "PASS" ? "Clarified summary" : "n1 claim",
            },
          ]);
        }
        return {
          results: ids.map((noteId: string) => ({
            noteId,
            verdict: noteId === "n1" ? verdict : "PASS",
            statement: `${noteId} newly extracted claim`,
            premises: [],
            report: "Checked",
            ...(noteId === "n1" && verdict === "PASS"
              ? {
                  correction: {
                    summary: "Clarified summary",
                    detailedSummary: null,
                  },
                }
              : {}),
          })),
        };
      },
      {},
      32768,
    );
    const current = await provider.open();
    try {
      const id = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes: [note("n1"), note("n2", ["n1"]), note("n3")].map((item) => ({
            ...item,
            text:
              item.id === "n3" ? item.text : "Detailed argument. ".repeat(1350),
          })),
          targets: ["n2", "n3"],
          through: "correctness",
        },
      });
      const outcome = await resultOf(current.harness, id);
      expect(outcome.status).toBe("completed");
      expect(
        provider.calls.flatMap(({ input }) =>
          input.notes.map(({ id }: { id: string }) => id),
        ),
      ).toEqual(verdict === "FAIL" ? ["n1", "n3"] : ["n1", "n2", "n3"]);
    } finally {
      await current.harness.close(context);
    }
  },
);

test.each(["oversized writing", "limited context", "native reserve"] as const)(
  "reconstruction attempts singleton groups for %s and respects Pi's input guard",
  async (limit) => {
    const notes = [preparedNote("n1"), preparedNote("n2")];
    if (limit === "oversized writing")
      notes[0]!.text += "Original proof detail. ".repeat(1500);
    else
      for (const note of notes.slice()) {
        const support = preparedNote(`${note.id}-support`);
        support.checks.external = { entry: 1 };
        support.checks.reconstruction = {
          verdict: "PASS",
          report: "Previously reconstructed",
          proof: "Prior independent proof",
        };
        support.checks.correctness!.statement += "Condition. ".repeat(
          limit === "native reserve" ? 500 : 4000,
        );
        note.support = [support.id];
        notes.push(support);
      }
    const provider = fixture(
      (name, input) => ({
        results: input.notes.map(({ id }: { id: string }) => ({
          noteId: id,
          ...(name === "proof"
            ? { complete: true, proof: "Independent complete proof" }
            : { verdict: "PASS", report: "Checked" }),
        })),
      }),
      {},
      limit === "native reserve" ? 16384 : 32768,
    );
    const current = await provider.open();
    const invoke = () =>
      current.invoke({
        role: "verifier",
        input: {
          task,
          notes,
          targets: ["n1", "n2"],
          through: "reconstruction",
        },
      });
    try {
      expect(await resultOf(current.harness, await invoke())).toMatchObject({
        status: "completed",
        result: {
          checks: ["n1", "n2"].map((noteId) => ({
            noteId,
            reconstruction: { verdict: "PASS" },
          })),
        },
      });
      expect(
        provider.calls.map(({ name, input }) => [
          name,
          input.notes.map(({ id }: { id: string }) => id),
        ]),
      ).toEqual([
        ["proof", ["n1"]],
        ["reconstruction", ["n1"]],
        ["proof", ["n2"]],
        ["reconstruction", ["n2"]],
      ]);
      notes[0]!.checks.correctness!.statement += "Condition. ".repeat(20000);
      expect(await resultOf(current.harness, await invoke())).toMatchObject({
        status: "faulted",
        error: { message: capacityError },
      });
      expect(provider.calls).toHaveLength(4);
    } finally {
      await current.harness.close(context);
    }
  },
);

test.each(["refuted", "dependent", "unrelated", "imported"] as const)(
  "reconstruction finishes produced proofs before handling %s pending support",
  async (boundary) => {
    const refuted = boundary === "refuted";
    const dependent = boundary === "dependent" || boundary === "imported";
    const proof = "Independent proof. ".repeat(180);
    const notes = [
      {
        ...preparedNote("n1"),
        checks: {
          ...preparedNote("n1").checks,
          ...(boundary === "imported" ? { external: { entry: 1 } } : {}),
        },
      },
      preparedNote("n2", ["n1"]),
      preparedNote("n3", boundary === "unrelated" ? [] : ["n2"]),
      preparedNote("n4"),
    ];
    const provider = fixture(
      (name, input) => ({
        results: input.notes.map(({ id }: { id: string }) => ({
          noteId: id,
          ...(name === "proof"
            ? {
                complete: id !== "n1" || refuted,
                proof,
              }
            : {
                verdict: id === "n1" && refuted ? "FAIL" : "PASS",
                report: "Checked",
              }),
        })),
      }),
      {},
    );
    const current = await provider.open();
    const invoke = async () => {
      const id = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes,
          targets: ["n1", "n2", "n3", "n4"],
          through: "reconstruction",
        },
      });
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
        ["n2", refuted ? "INCONCLUSIVE" : "PASS"],
        ...(dependent
          ? []
          : [
              ["n3", refuted ? "INCONCLUSIVE" : "PASS"],
              ["n4", "PASS"],
            ]),
      ]);
      if (refuted)
        for (const check of result.checks.slice(1, 3))
          expect(check.reconstruction?.report).toContain(
            "A declared dependency was refuted",
          );
      expect(
        provider.calls.map(({ name, input }) => [
          name,
          input.notes.map(({ id }: { id: string }) => id),
        ]),
      ).toEqual([
        ["proof", ["n1", "n2"]],
        ["reconstruction", ["n1"]],
        ...(refuted ? [] : [["reconstruction", ["n2"]]]),
        ...(dependent
          ? []
          : [
              ["proof", refuted ? ["n4"] : ["n3", "n4"]],
              ...(refuted ? [] : [["reconstruction", ["n3"]]]),
              ["reconstruction", ["n4"]],
            ]),
      ]);
      if (dependent) {
        for (const {
          noteId,
          correction: _correction,
          ...checks
        } of result.checks)
          Object.assign(notes.find(({ id }) => id === noteId)!.checks, checks);
        const before = provider.calls.length;
        expect(await invoke()).toMatchObject({
          checks: ["n4"].map((noteId) => ({
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
          ["proof", ["n4"]],
          ["reconstruction", ["n4"]],
        ]);
      }
    } finally {
      await current.harness.close(context);
    }
  },
);

test("standalone reconstruction retains completed checks and corrections after a later failure", async () => {
  const notes = [preparedNote("n1"), preparedNote("n2", ["n1"])];
  const proof = "Independent complete proof. ".repeat(120);
  const provider = fixture((name, input) => {
    if (name === "proof")
      return {
        results: input.notes.map(({ id }: { id: string }) => ({
          noteId: id,
          proof,
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
          },
        },
      ],
    };
  });
  const current = await provider.open(undefined, {
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
    const workers = await current.root.commit(
      (tx) => scanTasks(tx, current.root.id, "research.worker"),
      context,
    );
    expect(await resultOf(current.harness, workers[0]!.id)).toMatchObject({
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
              proof,
            },
          },
        ],
      },
    });
    expect(
      provider.calls.map(({ name, input }) => [
        name,
        input.notes.map(({ id }: { id: string }) => id),
      ]),
    ).toEqual([
      ["proof", ["n1", "n2"]],
      ["reconstruction", ["n1"]],
      ["reconstruction", ["n2"]],
    ]);
  } finally {
    await current.harness.close(context);
  }
});

test.each(["imported", "reconstructed"] as const)(
  "reconstruction checks ancestors of %s support without repeating its proof",
  async (middle) => {
    const support = preparedNote("n2", ["n1"]);
    if (middle === "imported") support.checks.external = { entry: 1 };
    else
      support.checks.reconstruction = {
        verdict: "PASS",
        report: "Previously checked",
        proof: "Earlier proof",
      };
    const provider = fixture((name, input) => {
      const ids = input.notes.map(({ id }: { id: string }) => id);
      const expectedSupport = (
        ids.includes("n3") ? ["n1", "n2"] : ids.includes("n2") ? ["n1"] : []
      ).filter((id) => !ids.includes(id));
      expect(input.support.map(({ id }: { id: string }) => id)).toEqual(
        expectedSupport,
      );
      const middleInput = input.support.find(
        ({ id }: { id: string }) => id === "n2",
      );
      expect(middleInput?.text).toBe(
        name === "reconstruction" && middle === "imported" && middleInput
          ? support.text
          : undefined,
      );
      if (name === "proof")
        expect(JSON.stringify(input)).not.toContain("secret original proof");
      return {
        results: input.notes.map(({ id }: { id: string }) => ({
          noteId: id,
          ...(name === "proof"
            ? { complete: true, proof: "Independent proof" }
            : { verdict: "PASS", report: "Checked" }),
        })),
      };
    });
    const current = await provider.open();
    try {
      const id = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes: [preparedNote("n3", ["n2"]), support, preparedNote("n1")],
          targets: ["n3"],
          through: "reconstruction",
        },
      });
      expect(await resultOf(current.harness, id)).toMatchObject({
        status: "completed",
        result: {
          checks: (middle === "imported"
            ? ["n1", "n2", "n3"]
            : ["n1", "n3"]
          ).map((noteId) => ({
            noteId,
            reconstruction: { verdict: "PASS" },
          })),
        },
      });
      for (const phase of ["proof", "reconstruction"])
        expect(
          provider.calls
            .filter(({ name }) => name === phase)
            .flatMap(({ input }) =>
              input.notes.map(({ id }: { id: string }) => id),
            ),
        ).toEqual(middle === "imported" ? ["n1", "n2", "n3"] : ["n1", "n3"]);
    } finally {
      await current.harness.close(context);
    }
  },
);

test.each([false, true])(
  "rejected Coordinator submissions stop at the response allowance (vary=%s)",
  async (vary) => {
    let attempt = 0;
    const provider = fixture(() => ({
      work: {
        kind: "verifier",
        notes: [vary ? `missing-${++attempt}` : "missing"],
        through: "source",
      },
    }));
    const current = await provider.open();
    try {
      const id = await current.invoke({
        role: "coordinator",
        input: {
          task,
          notes: [],
          failures: [],
          guidance: [],
          literatureUsed: false,
        },
      });
      const result = await resultOf(current.harness, id);
      expect(result.status).toBe("faulted");
      expect(JSON.stringify(result)).toContain("Role exhausted its responses");
      expect(provider.calls).toHaveLength(16);
    } finally {
      await current.harness.close(context);
    }
  },
);

test("late terminal Explorer error retains earlier public batches and failure across reopen", async () => {
  const directory = await temporaryDirectory("pi-explorer-failure-");
  const error = "invalid_request_error: fixture request rejected";
  let calls = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      const { id, revision } = input.notes[0];
      switch (++calls) {
        case 1:
          return {
            notes: [workerDraft(input, "n1", [id])],
            edits: [
              { id, revision, text: "Repaired proof", summary: "Repair" },
            ],
          };
        case 2:
          return { notes: [workerDraft(input, "n2", ["missing"])] };
        case 3:
          return {
            tool: "read_notes",
            arguments: { ids: [id], level: "full" },
          };
        case 4: {
          const read = transcript.messages.findLast(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "read_notes",
          );
          if (read?.role !== "toolResult" || read.content[0]?.type !== "text")
            throw new Error("Expected current note revision");
          const [current] = JSON.parse(read.content[0].text.split("\n\n")[0]!);
          return {
            notes: [],
            edits: [
              {
                id,
                revision: current.revision,
                detailedSummary: "Final repair detail",
              },
            ],
          };
        }
        default:
          return fauxAssistantMessage(
            [
              {
                type: "toolCall",
                id: "failed-response-submission",
                name: "submit_explorer",
                arguments: {
                  notes: [{ ...workerDraft(input, "n3"), candidate: true }],
                },
              },
            ],
            { stopReason: "error", errorMessage: error },
          );
      }
    },
    { maxExplorerResponses: 6 },
  );
  const decisions: CoordinationInput[] = [];
  provider.roles.coordinator = async (input) => {
    decisions.push(input);
    return {
      work: input.failures.length
        ? null
        : { kind: "explorer", assignment: "Repair and extend the argument" },
    };
  };
  let current = await provider.open(directory, {
    task,
    settings: { profiles: { default: { provider: "openai", model: "roles" } } },
  });
  try {
    await current.root.commit(
      (tx) =>
        provider.workflow.input(tx, current.root.id, {
          kind: "submit",
          id: "seed",
          notes: [draft("input/seed/n1")],
        }),
      context,
    );
    await current.root.waitForIdle(context);
    const view = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    const [worker] = await current.root.commit(
      (tx) => scanTasks(tx, current.root.id, "research.worker"),
      context,
    );
    expect(worker!.state.outcome).toMatchObject({
      status: "failed",
      error: { message: error },
    });
    expect(view.notes).toHaveLength(2);
    expect(view.notes[0]).toMatchObject({
      id: "input/seed/n1",
      text: "Repaired proof",
      summary: "Repair",
      detailedSummary: "Final repair detail",
      verified: false,
      accepted: false,
    });
    expect(view.notes[0]!.revision).toBeGreaterThan(
      decisions[0]!.notes[0]!.revision,
    );
    expect(view.notes[1]).toMatchObject({
      ...draft(`${worker!.id}/n1`, ["input/seed/n1"]),
      candidate: false,
      verified: false,
      accepted: false,
    });
    expect(decisions).toHaveLength(2);
    expect(decisions[1]!.notes).toEqual(
      view.notes.map((note) => ({ ...note, text: "", detailedSummary: "" })),
    );
    expect(decisions[1]!.failures).toEqual([
      { id: String(worker!.id), role: "explorer", error },
    ]);
    const records = await entries(current.harness);
    const submissions = records.filter(
      (entry) =>
        ToolResultEntry.is(entry) &&
        entry.model?.some(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "submit_explorer" &&
            !message.isError,
        ),
    );
    expect(submissions).toHaveLength(2);
    expect(worker!.state.outcome!.result).toEqual({
      kind: "published",
      notes: [`${worker!.id}/n1`],
      edits: ["input/seed/n1"],
    });
    expect(
      records.filter(
        (entry) => Events.is(entry) && entry.data.type === "result",
      ),
    ).toHaveLength(2);
    expect(calls).toBe(5);
    expect(provider.reports).toEqual([]);
    await current.harness.close(context);
    current = await provider.open(directory);
    await current.root.waitForIdle(context);
    expect(
      (
        await current.root.commit(
          (tx) => readView(tx, current.root.id),
          context,
        )
      ).notes,
    ).toEqual(view.notes);
    expect(
      (await current.harness.getTask(worker!.id, context))!.state.outcome,
    ).toEqual(worker!.state.outcome);
    expect(
      (await entries(current.harness)).filter(
        (entry) => Events.is(entry) && entry.data.type === "result",
      ),
    ).toHaveLength(2);
    expect(calls).toBe(5);
  } finally {
    await current.harness.close(context);
  }
});

test.each([
  "malformed",
  "source IDs",
  "source premises",
  "source capacity",
  "cleanup",
  "continuation",
] as const)(
  "late %s failure preserves completed verification and a fresh worker reuses it",
  async (failure) => {
    const directory = await temporaryDirectory("pi-verifier-failure-");
    const invalidSource =
      failure === "source IDs" ||
      failure === "source premises" ||
      failure === "source capacity";
    let proofs = 0,
      sources = 0,
      retry = false,
      cleanupFailed = false;
    const provider = fixture(
      (name, input) => {
        if (name === "explorer")
          return {
            notes: [
              workerDraft(input, "n1"),
              {
                ...workerDraft(input, "n2", [`${input.noteIdPrefix}n1`]),
                text: `${workerDraft(input, "n2").text}\n\n${"Original proof detail. ".repeat(75)}`,
                candidate: true,
              },
            ],
          };
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
                },
              }
            : name === "proof"
              ? { complete: true, proof: "Independent proof" }
              : { verdict: "PASS", report: "Checked" };
        return {
          results: input.notes.map(({ id }: { id: string }) => ({
            noteId: id,
            ...value,
            ...(name === "correctness"
              ? { statement: `${id} exact claim` }
              : {}),
          })),
        };
      },
      {},
      failure === "continuation" ? 32768 : 131072,
      {
        ...closedBookResearch,
        retrieval: true,
        async source(input) {
          sources++;
          if (failure === "source capacity" && !retry)
            throw new Error(
              "Selected model is at capacity. Please try a different model.",
            );
          return input.notes.map(({ id }) => ({
            noteId: failure === "source IDs" && !retry ? "unrequested" : id,
            verdict: "PASS",
            report: "Source established",
            ...(failure === "source premises" && !retry
              ? {
                  kind: "external-report" as const,
                  operationId: "mismatched-source",
                  reportedAt: "2026-10-05T00:00:00Z",
                  premises: ["Different external theorem"],
                  passages: [],
                  correction: {
                    summary: "Invalid source correction",
                    detailedSummary: null,
                  },
                }
              : {}),
          }));
        },
      },
    );
    provider.roles.coordinator = async (input) => {
      if (!input.notes.length)
        return { work: { kind: "explorer", assignment: "Prove" } };
      if (input.failures.length) {
        expect(input.failures[0]!.error).toEqual(
          failure === "continuation"
            ? capacityError
            : failure === "cleanup"
              ? "Response incomplete: max_messages"
              : failure === "source IDs"
                ? `Batch results must contain exactly one result per requested note. ${JSON.stringify(
                    {
                      requested: input.notes.map((note) => note.id),
                      received: input.notes.map(() => "unrequested"),
                      missing: input.notes.map((note) => note.id),
                      unexpected: ["unrequested"],
                      duplicates: ["unrequested"],
                      duplicateRequests: [],
                    },
                  )}`
                : failure === "source premises"
                  ? `Source-checked premises do not match correctness for ${input.notes[0]!.id}`
                  : failure === "source capacity"
                    ? "Source checking failed: Selected model is at capacity. Please try a different model."
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
      const report = await current.root.commit(
        (tx) => readReport(tx, current.root.id, { records: true }),
        context,
      );
      const failed = report.tasks!.find(
        (task) =>
          task.kind === "research.worker" &&
          task.state.outcome?.status === "failed",
      )!;
      expect(await resultOf(current.harness, failed.id)).toMatchObject({
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
        expect(view.notes.map((note) => note.checks.source)).toEqual([
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
        summary: "Corrected summary",
      });
      expect(Number.isSafeInteger(view.notes[0]!.revision)).toBe(true);
      expect(view.notes[0]!.revision).toBeGreaterThan(0);
      const published = report.records!.find(
        (entry) => Events.is(entry) && entry.data.type === "result",
      )!;
      const snapshotReader: SnapshotReader = {
        snapshotAsOf: current.harness.snapshotAsOf.bind(current.harness),
        getTask: current.harness.getTask.bind(current.harness),
        entry: (id, context) =>
          current.harness.commit((tx) => tx.entry(id), context),
      };
      const before = await readSnapshot(
        snapshotReader,
        current.root.id,
        published.id,
        context,
      );
      expect(before.notes[0]!.checks).toEqual({});
      expect(
        report.work.find(({ id }) => id === String(failed.id)),
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
      expect(finished.notes[0]!.revision).toBe(view.notes[0]!.revision);
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
    }
  },
);

test.each([true, false])(
  "an imported candidate needs independent reconstruction, complete=%s, despite cleanup failure",
  async (complete) => {
    const imported = {
      ...note("n1"),
      checks: { external: { entry: 1 } },
      candidate: true,
      text: "For every real x >= 1, x squared is at least x.",
    };
    const provider = fixture(
      (name, input) => {
        if (name === "reconstruction") {
          expect(input.notes[0]).toMatchObject({
            external: { entry: 1 },
            text: imported.text,
          });
          expect(input.premises[0].source).toEqual({
            kind: "external-trust",
            entry: 1,
          });
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
      {},
      131072,
      {
        ...closedBookResearch,
        async source() {
          throw new Error("Caller imports already grant source trust");
        },
      },
    );
    const current = await provider.open();
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
      const id = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes: [imported],
          targets: ["n1"],
          through: "reconstruction",
        },
      });
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
      const {
        noteId: _noteId,
        correction: _correction,
        ...recorded
      } = verification.checks[0]!;
      Object.assign(imported.checks, recorded);
      expect(refresh([imported])[0]!.accepted).toBe(complete);
      if (complete) {
        expect(acceptedArgument([imported], imported.id)).toContain(
          "x(x-1) >= 0 proves the claim.",
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
    }
  },
);

test.each([null, "Every graph in the family has property P."])(
  "unresolved claims skip source and reconstruction: %s",
  async (statement) => {
    const text = statement
      ? `${statement} Earlier campaign notes give the construction.`
      : "Would a different construction help?";
    const provider = fixture(
      (name, input) => {
        expect(name).toBe("correctness");
        expect(input.notes[0].text).toBe(text);
        return {
          results: [
            {
              noteId: "n1",
              verdict: statement ? "INCONCLUSIVE" : "PASS",
              statement,
              premises: [],
              report: statement
                ? "The claimed construction relies on undeclared campaign support."
                : "The note records a question without asserting a result.",
            },
          ],
        };
      },
      {},
      131072,
      {
        ...closedBookResearch,
        retrieval: true,
        async source() {
          throw new Error(
            "Unresolved correctness must not dispatch source checking",
          );
        },
      },
    );
    const current = await provider.open();
    try {
      const id = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes: [{ ...note("n1"), text }],
          targets: ["n1"],
          through: "reconstruction",
        },
      });
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result: {
          kind: "verification",
          checks: [
            {
              noteId: "n1",
              correctness: {
                verdict: "INCONCLUSIVE",
                statement,
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
    }
  },
);

test.each(["request", "incomplete.max_messages", "length"] as const)(
  "source recovery preserves checks and rejects incomplete proofs after %s",
  async (reason) => {
    const directory = await temporaryDirectory("pi-role-custom-source-");
    let sourceCalls = 0;
    let proofs = 0;
    const premise = "Every finite example satisfies the external theorem.";
    const source = {
      verdict: "PASS" as const,
      report: "SOURCE_REPORT_SENTINEL: stronger unrelated target theorem.",
      kind: "external-report" as const,
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
              { stopReason: "length" },
            ),
            rawStopReason:
              reason === "length" ? "incomplete.max_output_tokens" : reason,
          };
        if (name === "proof" && proofs > 1) {
          const body = JSON.stringify(transcript);
          expect(body).toContain("Completed preliminary lemma");
          expect(body).toContain("PARTIAL_TOOL_PROOF");
          expect(
            transcript.messages
              .flatMap((message) =>
                message.role === "assistant" ? message.content : [],
              )
              .some((part) => part.type === "toolCall"),
          ).toBe(false);
          expect(body).not.toContain("missing_result");
          expect(body).toContain("Interrupted proof text");
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
      {},
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
              },
            },
          ];
        },
      },
      "openai-responses",
    );
    let current = await provider.open(directory, undefined, true);
    try {
      const closed = current.closeAfterEntry((entry) =>
        entry.model?.some((message) =>
          reason === "request"
            ? message.role === "toolResult" &&
              message.toolName === "submit_requirements" &&
              !message.isError
            : message.role === "assistant" &&
              message.rawStopReason ===
                (reason === "length" ? "incomplete.max_output_tokens" : reason),
        ),
      );
      const id = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes: [{ ...note("n1"), candidate: true }],
          targets: ["n1"],
          through: "reconstruction",
        },
      });
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
      mismatched.checks.source = source;
      const rejected = await current.invoke({
        role: "verifier",
        input: {
          task,
          notes: [mismatched],
          targets: ["n1"],
          through: "reconstruction",
        },
      });
      expect(await resultOf(current.harness, rejected)).toMatchObject({
        status: "faulted",
        error: {
          message: "Source-checked premises do not match correctness for n1",
        },
      });
      expect(provider.calls).toHaveLength(reason === "request" ? 4 : 5);
    } finally {
      await current.harness.close(context);
    }
  },
);

async function fakeCodex(directory: string, candidate = false) {
  const executable = join(directory, "codex-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}
import assert from "node:assert/strict";
const input = await Bun.stdin.json();
const worker = process.argv.includes('web_search="disabled"');
if (!worker && !process.argv.includes('web_search="live"')) throw new Error("Research disabled web search");
if (worker && !input.assignment) throw new Error("Worker has no assignment");
function strict(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") { assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort()); assert.equal(schema.additionalProperties, false); }
  Object.values(schema).forEach(strict);
}
if (worker) strict(await Bun.file(process.argv[process.argv.indexOf("--output-schema") + 1]).json());
if (process.env.TEST_INTERRUPTION && !(await Bun.file(process.env.TEST_INTERRUPTION).exists())) { await Bun.write(process.env.TEST_INTERRUPTION, "attempted"); console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Partial opaque work"}})); await Bun.write(input.workspace + "/started", "partial artifact"); await new Promise(() => setInterval(() => {}, 1000)); }
let value;
if (input.assignment) value = {notes:[{id:input.noteIdPrefix + "finding",summary:"Finding",detailedSummary:"Exact finding",text:"Finding. Evidence.",support:[],...(${candidate}?{candidate:true}:{})}]};
else if(input.argument) value = {verdict:input.argument === "malformed" ? "INVALID" : "PASS",report:"Independent review",premises:["External premise"],passages:[{premise:0,url:"https://example.org/theorem",quote:"Exact theorem"}]};
else value = {results:input.facts.map(fact=>({noteId:fact.id,verdict:"PASS",report:"Sources checked",passages:[{premise:0,url:"https://example.org/theorem",quote:"Exact theorem"}]}))};
if (worker) { value.edits = null; for (const note of value.notes) note.candidate ??= null; }
if (!worker) console.log(JSON.stringify({type:"item.completed",item:{type:"web_search"}}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(value)}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:17,output_tokens:5,cached_input_tokens:0}}));
`,
  );
  await chmod(executable, 0o700);
  return executable;
}

async function externalVerifierFixture({
  complete = true,
  failComparison = false,
} = {}) {
  const directory = await temporaryDirectory("pi-codex-verifier-");
  const executable = join(directory, "codex-verifier-fixture");
  await writeFile(
    executable,
    `#!${process.execPath}
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
const input = await Bun.stdin.json();
const argv = process.argv;
assert.equal(argv[argv.indexOf("--sandbox") + 1], "workspace-write");
assert(argv.includes("features.shell_tool=true"));
assert(argv.includes('web_search="disabled"'));
assert.equal(realpathSync(process.cwd()), realpathSync(input.workspace));
const schema = await Bun.file(argv[argv.indexOf("--output-schema") + 1]).json();
function strict(value) {
  if (!value || typeof value !== "object") return;
  if (value.type === "object") {
    assert.deepEqual([...value.required].sort(), Object.keys(value.properties).sort());
    assert.equal(value.additionalProperties, false);
  }
  Object.values(value).forEach(strict);
}
strict(schema);
const fields = schema.properties.results.items.properties;
const stage = fields.statement ? "correctness" : fields.complete ? "proof" : input.independent ? "reconstruction" : "requirements";
await Bun.write("invocation.json", JSON.stringify({stage, input}));
const value = {results: input.notes.toReversed().map(note => ({
  noteId: note.id,
  ...(stage === "proof" ? {complete:${complete}, proof: "Independent proof of " + note.id} : {
    verdict:"PASS", report:"Checked " + stage, correction:null,
    ...(stage === "correctness" ? {statement:note.id + " exact claim",premises:[]} : {})
  })
}))};
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(value)}}));
console.log(JSON.stringify(${failComparison} && stage === "reconstruction"
  ? {type:"turn.failed",error:{message:"Checker process failed"}}
  : {type:"turn.completed",usage:{input_tokens:17,output_tokens:5,cached_input_tokens:0}}));
`,
  );
  await chmod(executable, 0o700);
  const sources: string[][] = [];
  const provider = fixture(
    () => {
      throw new Error("Codex verification called a native model");
    },
    {},
    undefined,
    {
      ...closedBookResearch,
      async source(input) {
        sources.push(input.notes.map(({ id }) => id));
        return input.notes.map(({ id }) => ({
          noteId: id,
          verdict: "PASS",
          report: "Existing source backend checked the premises",
        }));
      },
    },
  );
  Object.assign(
    provider.roles,
    codex({
      verifier: {
        model: "fixture",
        command: executable,
        workspace: join(directory, "artifacts"),
      },
    })(provider.roles),
  );
  return { ...provider, directory, sources };
}

async function externalVerifierReceipts(harness: Harness) {
  const records = await entries(harness);
  const requests = records.filter(ExternalRequest.is).reverse();
  const logs = records.filter(ExternalLog.is).reverse();
  const calls = await Promise.all(
    logs.map(async ({ data }) => {
      const request = requests.find(
        ({ data: request }) => request.operationId === data.operationId,
      )!;
      return JSON.parse(
        await readFile(join(request.data.workspace, "invocation.json"), "utf8"),
      );
    }),
  );
  return { requests, logs, calls };
}

test("Codex verification groups assessments but reconstructs each note independently", async () => {
  const provider = await externalVerifierFixture();
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "verifier",
      input: {
        task,
        notes: ["n1", "n2"].map((id) => ({ ...note(id), candidate: true })),
        targets: ["n1", "n2"],
        through: "reconstruction",
        backend: "external",
      },
    });
    expect(await resultOf(current.harness, id)).toMatchObject({
      status: "completed",
      result: {
        kind: "verification",
        checks: ["n1", "n2"].map((noteId) => ({
          noteId,
          correctness: { verdict: "PASS", statement: `${noteId} exact claim` },
          requirements: { verdict: "PASS" },
          reconstruction: {
            verdict: "PASS",
            proof: expect.stringContaining(`Independent proof of ${noteId}`),
          },
        })),
      },
    });
    const { calls } = await externalVerifierReceipts(current.harness);
    expect(
      calls.map(({ stage, input }) => [
        stage,
        input.notes.map(({ id }: { id: string }) => id),
      ]),
    ).toEqual([
      ["correctness", ["n1", "n2"]],
      ["requirements", ["n1", "n2"]],
      ["proof", ["n1"]],
      ["reconstruction", ["n1"]],
      ["proof", ["n2"]],
      ["reconstruction", ["n2"]],
    ]);
  } finally {
    await current.harness.close(context);
  }
});

test.each([false, true])(
  "Codex verification preserves stage evidence and blindness (interrupted comparison failure=%s)",
  async (failComparison) => {
    const provider = await externalVerifierFixture({ failComparison });
    const storage = join(provider.directory, "storage");
    const original = {
      ...note("n1"),
      candidate: true,
      checks: {
        correctness: {
          verdict: "INCONCLUSIVE" as const,
          report: "The finite checks need execution",
          statement: "n1 exact claim",
          premises: [],
        },
      },
    };
    let current = await provider.open(storage, {
      task,
      settings: {
        profiles: { default: { provider: "openai", model: "roles" } },
      },
      mode: {
        role: "verifier",
        input: {
          task,
          notes: [original],
          targets: ["n1"],
          through: "reconstruction",
          backend: "external",
        },
      },
    });
    try {
      let admitted = 0;
      const closed = failComparison
        ? current.closeAfterEntry(
            (entry) => ExternalRequest.is(entry) && ++admitted === 3,
          )
        : undefined;
      await current.root.commit(
        (tx) => provider.workflow.initialize(tx, current.root.id),
        context,
      );
      if (closed) {
        current.harness.resume();
        await closed.promise;
        current = await provider.open(storage);
      }
      await current.root.waitForIdle(context);
      const workers = await current.root.commit(
        (tx) => scanTasks(tx, current.root.id, "research.worker"),
        context,
      );
      const outcome = await resultOf(current.harness, workers[0]!.id);
      expect(outcome).toMatchObject({
        status: failComparison ? "failed" : "completed",
        ...(failComparison
          ? {
              error: {
                message: expect.stringContaining("Checker process failed"),
              },
            }
          : {}),
        result: {
          kind: "verification",
          checks: [
            {
              noteId: "n1",
              correctness: { verdict: "PASS", statement: "n1 exact claim" },
              source: { verdict: "PASS" },
              requirements: { verdict: "PASS" },
              ...(!failComparison
                ? {
                    reconstruction: {
                      verdict: "PASS",
                      proof: expect.stringContaining("Independent proof of n1"),
                    },
                  }
                : {}),
            },
          ],
        },
      });
      if (failComparison)
        expect(outcome).not.toHaveProperty("result.checks.0.reconstruction");
      expect(provider.sources).toEqual([["n1"]]);
      const { requests, logs, calls } = await externalVerifierReceipts(
        current.harness,
      );
      expect(requests).toHaveLength(failComparison ? 5 : 4);
      expect(new Set(requests.map(({ data }) => data.workspace)).size).toBe(
        requests.length,
      );
      expect(logs).toHaveLength(4);
      expect(calls.map(({ stage }) => stage)).toEqual([
        "correctness",
        "requirements",
        "proof",
        "reconstruction",
      ]);
      expect(logs.at(-1)!.data.stdout).toContain(
        failComparison ? '"turn.failed"' : '"turn.completed"',
      );
      const proof = calls[2]!.input;
      expect(proof.notes).toEqual([
        { id: "n1", statement: "n1 exact claim", premises: [], support: [] },
      ]);
      expect(JSON.stringify(proof)).not.toContain("secret original proof");
      expect(JSON.stringify(proof)).not.toContain("detailed claim");
      expect(calls[3]!.input).toMatchObject({
        notes: [{ text: original.text }],
        independent: [
          {
            noteId: "n1",
            result: {
              complete: true,
              proof: expect.stringContaining("Independent proof of n1"),
            },
          },
        ],
      });
      expect(original.checks.correctness.verdict).toBe("INCONCLUSIVE");
    } finally {
      await current.harness.close(context);
    }
  },
);

test("Codex standalone reconstruction cannot PASS an incomplete independent proof", async () => {
  const provider = await externalVerifierFixture({ complete: false });
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "reconstruct",
      input: {
        task,
        notes: [preparedNote("n1")],
        targets: ["n1"],
        backend: "external",
      },
    });
    expect(await resultOf(current.harness, id)).toMatchObject({
      status: "completed",
      result: {
        checks: [
          {
            noteId: "n1",
            reconstruction: {
              verdict: "INCONCLUSIVE",
              report: expect.stringContaining(
                "Independent proof was incomplete",
              ),
            },
          },
        ],
      },
    });
    expect(
      (await entries(current.harness)).filter(ExternalLog.is),
    ).toHaveLength(2);
  } finally {
    await current.harness.close(context);
  }
});

test.each(["explorer", "implementation", "literature"] as const)(
  "external %s constrains permanent names before generation and validates returned names",
  async (role) => {
    const shared = [explorationSchema, literatureResultSchema];
    const original = structuredClone(shared);
    const provider = fixture(
      () => {
        throw new Error("External role called a native model");
      },
      { literature: true },
    );
    let returned: "valid" | "bare" | "foreign" = "valid";
    let calls = 0;
    const call: ExternalCall = async (
      _mode,
      schema,
      _instructions,
      input,
      runtime,
    ) => {
      calls++;
      const { noteIdPrefix: prefix } = input as { noteIdPrefix: string };
      expect(prefix).toBe(`${runtime.taskId}/`);
      expect(Check(schema, { notes: [draft(prefix + "finding")] })).toBe(true);
      for (const id of [
        "finding",
        "999999/finding",
        prefix,
        prefix + "nested/finding",
      ])
        expect(Check(schema, { notes: [draft(id)] })).toBe(false);
      const id =
        returned === "valid"
          ? prefix + "finding"
          : returned === "bare"
            ? "finding"
            : "999999/finding";
      return {
        value: { notes: [draft(id)] } as Static<typeof schema>,
        workspace: "/external-fixture",
        operationId: `call-${calls}`,
        searches: 1,
        reportedAt: "now",
      };
    };
    provider.roles.external.explorer = call;
    provider.roles.external.implementation = call;
    provider.roles.external.research = externalResearch(call);
    const current = await provider.open();
    try {
      for (returned of ["valid", "bare", "foreign"] as const) {
        const id = await current.invoke({
          role,
          input: { task, assignment: "Produce a useful finding", notes: [] },
        });
        const outcome = await resultOf(current.harness, id);
        if (returned === "valid")
          expect(outcome).toMatchObject({
            status: "completed",
            result: { kind: "notes", notes: [{ id: `${id}/finding` }] },
          });
        else {
          expect(outcome.status).toBe("faulted");
          expect(outcome).not.toHaveProperty("result");
        }
      }
      expect(calls).toBe(3);
      expect(provider.calls).toEqual([]);
      expect(shared).toEqual(original);
    } finally {
      await current.harness.close(context);
    }
  },
);

test.each(["codex", "custom"] as const)(
  "Literature rejects candidate notes from %s research",
  async (backend) => {
    const directory = await temporaryDirectory("pi-literature-candidate-");
    const assignment = "Find the precise theorem";
    const command =
      backend === "codex" ? await fakeCodex(directory, true) : undefined;
    let customCalls = 0;
    const research: Research | undefined =
      backend === "custom"
        ? {
            ...closedBookResearch,
            retrieval: true,
            async literature(input, runtime) {
              customCalls++;
              expect(input.assignment).toBe(assignment);
              return {
                notes: [
                  { ...draft(`${runtime.taskId}/finding`), candidate: true },
                ],
              };
            },
          }
        : undefined;
    const provider = fixture(
      () => {
        throw new Error("Literature called a native model");
      },
      {
        literature: true,
      },
      undefined,
      research,
    );
    if (command)
      Object.assign(
        provider.roles,
        codex({ research: { model: "fixture", command } })(provider.roles),
      );
    const current = await provider.open(join(directory, "storage"));
    try {
      const id = await current.invoke({
        role: "literature",
        input: { task, assignment, notes: [] },
      });
      const outcome = await resultOf(current.harness, id);
      expect(outcome.status).toBe("faulted");
      if (backend === "codex")
        expect(JSON.stringify(outcome)).toContain("candidate");
      expect(outcome).not.toHaveProperty("result");
      expect(provider.calls).toHaveLength(0);
      expect(customCalls).toBe(backend === "custom" ? 1 : 0);
      const view = await current.root.commit(
        (tx) => readView(tx, current.root.id),
        context,
      );
      expect(view.notes).toEqual([]);
    } finally {
      await current.harness.close(context);
    }
  },
);

test("Coordinator capabilities survive retry and reopen; fresh decisions get fresh conversations", async () => {
  const directory = await temporaryDirectory("pi-role-coordinator-");
  let count = 0;
  let retried = false;
  const provider = fixture((_name, input, transcript) => {
    expect(input.capabilities).toMatchObject({
      literature: false,
      implementation: count >= 3,
      externalVerifier: false,
    });
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
        work: {
          kind: "implementation",
          assignment: "Unavailable implementation",
          notes: [],
        },
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
            kind: "implementation",
            assignment:
              "Implement the specified construction and check its constraints",
            notes: [],
          },
        }
      : {
          work: {
            kind: "verifier",
            notes: ["n1"],
            through: "reconstruction",
          },
        };
  }, {});
  let current = await provider.open(directory, undefined, true);
  try {
    const stopped = current.closeAfterEntry(
      (entry) =>
        ToolResultEntry.is(entry) &&
        entry.model?.some(
          (message) => message.role === "toolResult" && message.isError,
        ),
    );
    const input = {
      task,
      notes: [{ ...note("n1"), candidate: true }],
      failures: [],
      guidance: [],
      literatureUsed: false,
    };
    for (let i = 0; i < 2; i++) {
      const id = await current.invoke({ role: "coordinator", input });
      if (i === 0) {
        current.harness.resume();
        await stopped.promise;
        current = await provider.open(directory, undefined, true);
      }
      expect(await resultOf(current.harness, id)).toMatchObject({
        status: "completed",
        result: {
          work: { kind: "verifier", notes: ["n1"], through: "reconstruction" },
        },
      });
    }
    expect(provider.calls).toHaveLength(4);
    expect(
      new Set(provider.calls.slice(0, 3).map((call) => call.session)).size,
    ).toBe(1);
    expect(provider.calls[3]!.session).not.toBe(provider.calls[2]!.session);
    provider.roles.implementation = async () => ({
      kind: "notes",
      notes: [],
    });
    const id = await current.invoke({ role: "coordinator", input });
    expect(await resultOf(current.harness, id)).toMatchObject({
      status: "completed",
      result: { work: { kind: "implementation" } },
    });
  } finally {
    await current.harness.close(context);
  }
});

test("Coordinator rejects used literature and multiple workers", async () => {
  let response = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      response++;
      expect(input.capabilities).toMatchObject({
        literature: response > 2,
      });
      if (response === 1)
        return {
          work: { kind: "literature", assignment: "Repeat a completed search" },
        };
      if (response === 3)
        return {
          work: [
            { kind: "explorer", assignment: "First" },
            { kind: "explorer", assignment: "Second" },
          ],
        };
      expect(
        transcript.messages.some(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toBe(true);
      return { work: { kind: "explorer", assignment: "Continue" } };
    },
    { literature: true },
    131072,
    { ...closedBookResearch, retrieval: true },
  );
  const current = await provider.open();
  const input: CoordinationInput = {
    task,
    notes: [],
    failures: [],
    guidance: [],
    literatureUsed: false,
  };
  try {
    for (const literatureUsed of [true, false]) {
      const id = await current.invoke({
        role: "coordinator" as const,
        input: { ...input, literatureUsed } as JsonValue,
      });
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result: {
          work: { kind: "explorer", assignment: "Continue" },
        },
      });
    }
    expect(provider.calls).toHaveLength(4);
  } finally {
    await current.harness.close(context);
  }
});

test.each([false, true])(
  "provider-limit continuations preserve work without consuming Explorer responses (saved=%s)",
  async (submitted) => {
    let response = 0;
    let prompt: { noteIdPrefix: string };
    const provider = fixture(
      (_name, input) => {
        if (response === 0) prompt = input;
        response++;
        if (submitted && response === 1)
          return { notes: [workerDraft(prompt, "n1")] };
        if (response > 9 + Number(submitted))
          return { notes: [{ ...workerDraft(prompt, "n3"), candidate: true }] };
        return fauxAssistantMessage(
          [
            { type: "text", text: `Preserved fragment ${response}` },
            fauxToolCall("submit_explorer", {
              notes: [{ ...workerDraft(prompt, "n2"), candidate: true }],
            }),
          ],
          { stopReason: "length" },
        );
      },
      { maxExplorerResponses: submitted ? 2 : 1 },
    );
    const current = await provider.open();
    try {
      const id = await current.invoke({
        role: "explorer",
        input: { task, notes: [], assignment: "Continue" },
      });
      const outcome = await resultOf(current.harness, id);
      expect(outcome).toMatchObject({
        status: "completed",
        result: {
          kind: "published",
          notes: submitted ? [`${id}/n1`, `${id}/n3`] : [`${id}/n3`],
          edits: [],
        },
      });
      expect(provider.calls).toHaveLength(10 + Number(submitted));
      const last = JSON.stringify(provider.calls.at(-1)!.transcript);
      expect(last).toContain(`Preserved fragment ${1 + Number(submitted)}`);
      expect(last).toContain(`Preserved fragment ${9 + Number(submitted)}`);
      expect(last).toContain("n2 secret original proof");
      expect(
        provider.calls
          .at(-1)!
          .transcript.messages.flatMap((message) =>
            message.role === "assistant" && message.stopReason === "length"
              ? message.content
              : [],
          )
          .some((part) => part.type === "toolCall"),
      ).toBe(false);
      expect(last).not.toContain("missing_result");
      expect(
        (await entries(current.harness)).filter(ToolResultEntry.is),
      ).toHaveLength(submitted ? 2 : 1);
      expect(
        explorerLimit((await resultOf(current.harness, id)).result),
      ).toBeUndefined();
    } finally {
      await current.harness.close(context);
    }
  },
);

test("capacity after a note read retains published notes without another provider call", async () => {
  let count = 0;
  const provider = fixture(
    (_name, input) =>
      ++count === 1
        ? { notes: [workerDraft(input, "n1")] }
        : { tool: "read_notes", arguments: { ids: ["large"], level: "full" } },
    { maxExplorerReads: 1, maxExplorerResponses: 4 },
    32768,
  );
  const current = await provider.open();
  try {
    const large = {
      ...note("large"),
      text: "exact mathematical text ".repeat(20000),
      imported: true,
      verified: true,
    };
    const id = await current.invoke({
      role: "explorer",
      input: { task, notes: [large], assignment: "Continue" },
    });
    const outcome = await resultOf(current.harness, id);
    expect(outcome).toMatchObject({
      status: "completed",
      result: { kind: "published", notes: [`${id}/n1`], edits: [] },
    });
    expect(provider.calls).toHaveLength(2);
    expect(explorerLimit((await resultOf(current.harness, id)).result)).toBe(
      "context_capacity",
    );
  } finally {
    await current.harness.close(context);
  }
});

test.each([
  [1, false],
  [2, true],
] as const)(
  "Explorer handoff reasons survive publication and reopen (allowance=%s, edit=%s)",
  async (allowance, edit) => {
    const directory = await temporaryDirectory("pi-role-limit-report-");
    let responses = 0;
    const provider = fixture(
      (_name, input) => {
        if (++responses > 1)
          return fauxAssistantMessage("No additional result.");
        return edit
          ? {
              notes: [],
              edits: [
                {
                  id: input.notes[0].id,
                  revision: input.notes[0].revision,
                  text: "Retained partial repair",
                },
              ],
            }
          : { notes: [workerDraft(input, "n1")] };
      },
      { maxExplorerResponses: allowance },
    );
    let decisions = 0;
    provider.roles.coordinator = async (input) => {
      if (++decisions === 1)
        return { work: { kind: "explorer", assignment: "Explore." } };
      expect(input.failures).toEqual([]);
      expect(input.limits).toEqual([
        { id: expect.any(String), reason: "response_limit" },
      ]);
      return { work: null };
    };
    let current = await provider.open(directory, {
      task,
      settings: {
        profiles: { default: { provider: "openai", model: "roles" } },
      },
    });
    try {
      await current.root.commit(async (tx) => {
        if (edit)
          await provider.workflow.input(tx, current.root.id, {
            kind: "submit",
            id: "seed",
            notes: [draft("input/seed/n1")],
          });
        else await provider.workflow.initialize(tx, current.root.id);
      }, context);
      await current.harness.waitForIdle(context);
      expect(decisions).toBe(2);
      const before = await current.root.commit(
        (tx) => readReport(tx, current.root.id),
        context,
      );
      expect(before.status.work).toMatchObject({ completed: 1, failed: 0 });
      expect(before.status.limits.items).toEqual([
        {
          id: expect.any(String),
          role: "explorer",
          status: "completed",
          reason: "response_limit",
        },
      ]);
      expect(before.notes).toHaveLength(1);
      expect(before.notes[0]!.text).toBe(
        edit ? "Retained partial repair" : draft(before.notes[0]!.id).text,
      );
      await current.harness.close(context);
      current = await provider.open(directory);
      const after = await current.root.commit(
        (tx) => readReport(tx, current.root.id),
        context,
      );
      const compact = await current.root.commit((tx) => {
        const reader = new Proxy(tx, {
          get(target, key) {
            if (["entry", "scanEntries"].includes(String(key)))
              throw new Error(`Unexpected history read: ${String(key)}`);
            const value = Reflect.get(target, key);
            return typeof value === "function"
              ? (...args: unknown[]) => {
                  if (key === "doc" && args[0] === Bodies)
                    throw new Error("Unexpected notebook body read");
                  if (
                    key === "scanConversations" &&
                    (args[0] as Parameters<Tx["scanConversations"]>[0])
                      ?.ownerTaskId === undefined
                  )
                    throw new Error("Unexpected campaign conversation scan");
                  return Reflect.apply(value, target, args);
                }
              : value;
          },
        });
        return readStatus(reader, current.root.id);
      }, context);
      expect(after.status.limits).toEqual(before.status.limits);
      expect(after.notes).toEqual(before.notes);
      expect(compact.limits).toEqual(after.status.limits);
      expect(compact.work).toEqual(after.status.work);
      expect(compact).not.toHaveProperty("calls");
      expect(provider.calls).toHaveLength(allowance === 1 ? 1 : 2);
    } finally {
      await current.harness.close(context);
    }
  },
);

test.each([
  ["immediate edit limit", 1, true, "response_limit"],
  ["plain-text note limit", 2, false, "response_limit"],
  ["voluntary note handoff", 3, false, undefined],
  ["voluntary edit handoff", 3, true, undefined],
  ["empty batch at the limit", 1, null, undefined],
] as const)(
  "Explorer distinguishes %s",
  async (_name, allowance, edit, reason) => {
    const partial = {
      notes: [] as ReturnType<typeof draft>[],
      edits: edit ? [{ id: "prior", revision: 0, text: "Partial repair" }] : [],
    };
    let responses = 0;
    const provider = fixture(
      (_name, input) => {
        if (++responses !== 1) return "No additional result.";
        if (edit === false) partial.notes = [workerDraft(input, "n1")];
        if (partial.edits.length)
          partial.edits[0]!.revision = input.notes[0].revision;
        return partial;
      },
      { maxExplorerResponses: allowance },
    );
    const current = await provider.open();
    try {
      const id = await current.invoke({
        role: "explorer",
        input: { task, notes: [note("prior")], assignment: "Explore." },
      });
      expect(await resultOf(current.harness, id)).toMatchObject({
        status: "completed",
        result: {
          kind: "published",
          notes: edit === false ? [`${id}/n1`] : [],
          edits: edit ? ["prior"] : [],
        },
      });
      expect(explorerLimit((await resultOf(current.harness, id)).result)).toBe(
        reason,
      );
      expect(provider.calls).toHaveLength(Math.min(allowance, 2));
    } finally {
      await current.harness.close(context);
    }
  },
);

test("invalid submissions consume the response allowance and cannot publish partial results", async () => {
  const provider = fixture(
    (_name, input) => ({ notes: [workerDraft(input, "n1", ["unknown"])] }),
    {
      maxExplorerReads: 1,
      maxExplorerResponses: 2,
    },
  );
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "explorer",
      input: { task, notes: [], assignment: "Continue" },
    });
    const outcome = await resultOf(current.harness, id);
    expect(outcome).toMatchObject({
      status: "faulted",
      error: { message: "Role exhausted its responses" },
    });
    expect(provider.calls).toHaveLength(2);
  } finally {
    await current.harness.close(context);
  }
});

test("an admitted failed read consumes its allowance, while schema-invalid reads do not", async () => {
  let count = 0;
  const provider = fixture(
    (_name, input, transcript) => {
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
      return { notes: [{ ...workerDraft(input, "n1"), candidate: true }] };
    },
    { maxExplorerReads: 1, maxExplorerResponses: 5 },
  );
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "explorer",
      input: {
        task,
        notes: [{ ...note("prior"), text: "sensitive full argument" }],
        assignment: "Continue",
      },
    });
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
  }
});

test("Coordinator admits four reads by default and can hand off after a denied fifth read", async () => {
  let calls = 0;
  const provider = fixture(() =>
    ++calls <= 5
      ? {
          tool: "read_notes",
          arguments: { ids: ["prior"], level: "full" },
        }
      : { work: { kind: "explorer", assignment: "Continue" } },
  );
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "coordinator",
      input: {
        task,
        notes: [note("prior")],
        failures: [],
        guidance: [],
        literatureUsed: false,
      },
    });
    expect(await resultOf(current.harness, id)).toEqual({
      status: "completed",
      result: { work: { kind: "explorer", assignment: "Continue" } },
    });
    expect(calls).toBe(6);
    const reads = provider.calls
      .at(-1)!
      .transcript.messages.flatMap((message) =>
        message.role === "toolResult" && message.toolName === "read_notes"
          ? [message]
          : [],
      );
    expect(reads.map((message) => message.details)).toEqual([
      { read: true },
      { read: true },
      { read: true },
      { read: true },
      { read: false },
    ]);
    expect(reads.slice(0, 4).every((message) => !message.isError)).toBe(true);
    expect(reads[4]!.isError).toBe(true);
    expect(JSON.stringify(reads[4]!.content)).toContain("Reading is disabled");
    expect(JSON.stringify(reads[4]!.content)).not.toContain(note("prior").text);
  } finally {
    await current.harness.close(context);
  }
});

test("interrupted Codex workers retain old artifacts and replay in a fresh workspace", async () => {
  const directory = await temporaryDirectory("pi-role-codex-replay-");
  const command = await fakeCodex(directory);
  const provider = fixture(() => {
    throw new Error("Unexpected Pi model call");
  }, {});
  Object.assign(
    provider.roles,
    codex({
      implementation: {
        model: "gpt-6-astra",
        command,
        workspace: join(directory, "artifacts"),
        environment: {
          ...process.env,
          TEST_INTERRUPTION: join(directory, "attempted"),
        },
      },
    })(provider.roles),
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
          ExternalRequest.is(change.value)
        ) {
          firstWorkspace = change.value.data.workspace;
          watched = join(firstWorkspace, "started");
          watchFile(watched, { interval: 10 }, (stat) => {
            if (stat.size > 0) entered.resolve();
          });
        }
    });
    const id = await current.invoke({
      role: "implementation",
      input: {
        task,
        assignment: "Implement the concrete construction",
        notes: [],
      },
    });
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
    const requests = (await entries(current.harness)).filter(
      ExternalRequest.is,
    );
    expect(requests).toHaveLength(2);
    expect(new Set(requests.map((entry) => entry.data.workspace)).size).toBe(2);
    expect(requests.map((entry) => entry.byTaskId)).toEqual([id, id]);
  } finally {
    if (watched) unwatchFile(watched);
    await current.harness.close(context);
  }
});

test("Codex preparation failures retain a task failure without admitting or recording an invocation", async () => {
  const directory = await temporaryDirectory("pi-role-codex-prepare-");
  const workspace = join(directory, "not-a-directory");
  await writeFile(workspace, "Fixture");
  const provider = fixture(() => {
    throw new Error("Unexpected Pi model call");
  }, {});
  Object.assign(
    provider.roles,
    codex({ implementation: { model: "gpt-6-astra", workspace } })(
      provider.roles,
    ),
  );
  const current = await provider.open(join(directory, "storage"));
  try {
    const id = await current.invoke({
      role: "implementation",
      input: {
        task,
        assignment: "Implement the construction",
        notes: [],
      },
    });
    current.harness.resume();
    expect(
      (await current.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("faulted");
    const records = await entries(current.harness);
    expect(records.filter(ExternalRequest.is)).toEqual([]);
    expect(records.filter(ExternalLog.is)).toEqual([]);
    expect(
      await current.root.commit((tx) => readUsage(tx), context),
    ).toMatchObject({ calls: { externalInvocations: 0, unknownUsage: 0 } });
    expect(provider.calls).toHaveLength(0);
  } finally {
    await current.harness.close(context);
  }
});

test("Codex source memos survive later Verifier recovery and other calls retain evidence", async () => {
  const directory = await temporaryDirectory("pi-role-codex-");
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
      literature: true,
    },
  );
  Object.assign(
    provider.roles,
    codex({
      research: { model: "gpt-6-astra", command },
      implementation: {
        model: "gpt-6-astra",
        command,
        workspace: join(directory, "artifacts"),
      },
    })(provider.roles),
  );
  let current = await provider.open(join(directory, "storage"));
  try {
    const closed = current.closeAfterEntry((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "submit_requirements" &&
          !message.isError,
      ),
    );
    const id = await current.invoke({
      role: "verifier",
      input: {
        task,
        notes: [{ ...note("n1"), candidate: true }],
        targets: ["n1"],
        through: "requirements",
      },
    });
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
              kind: "external-report",
              premises: ["External premise"],
            },
          },
        ],
      },
    });
    const sourceRecords = (await entries(current.harness)).filter((entry) =>
      ExternalLog.is(entry),
    );
    expect(sourceRecords).toHaveLength(1);
    expect(sourceRecords[0]!.data).toMatchObject({
      usage: { input_tokens: 17, output_tokens: 5, cached_input_tokens: 0 },
    });
    const run = async (role: Invocation["role"], input: JsonValue) => {
      const id = await current.invoke({ role, input });
      return await resultOf(current.harness, id);
    };
    expect(
      await run("literature", {
        task,
        assignment: "Find the precise theorem",
        notes: [],
      }),
    ).toMatchObject({
      status: "completed",
      result: { kind: "notes" },
    });
    expect(
      await run("review", {
        task,
        argument: "Independent argument without solver verdicts",
      }),
    ).toMatchObject({
      status: "completed",
      result: { verdict: "PASS", kind: "external-report" },
    });
    const worker = await run("implementation", {
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
      .filter(ExternalRequest.is)
      .find((entry) =>
        entry.data.workspace.startsWith(join(directory, "artifacts")),
      )!.data;
    expect(worker.result).toMatchObject({
      notes: [{ text: expect.stringContaining(`Artifacts: ${workspace}`) }],
    });
    expect(worker.result).not.toHaveProperty("edits");
    expect(await readFile(join(workspace, "input.json"), "utf8")).toContain(
      "finite construction",
    );
    const malformed = await run("review", { task, argument: "malformed" });
    expect(malformed).toMatchObject({ status: "faulted" });
    const logs = (await entries(current.harness)).filter(ExternalLog.is);
    expect(logs).toHaveLength(5);
    expect(logs.every((entry) => entry.data.usage?.input_tokens === 17)).toBe(
      true,
    );
    const requests = (await entries(current.harness)).filter(
      ExternalRequest.is,
    );
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
  }
});

test.each([
  ["coordinator", false, true],
  ["coordinator", true, true],
  ["coordinator", false, false],
  ["coordinator", true, false],
  ["explorer", false, true],
  ["explorer", true, true],
] as const)(
  "mixed %s read/submission completes without another response (read first: %s, valid read: %s)",
  async (role, readFirst, validRead) => {
    const coordination = { work: { kind: "explorer", assignment: "Continue" } };
    let calls = 0;
    const provider = fixture(
      (_name, input) => {
        if (++calls > 1)
          return fauxAssistantMessage("Unnecessary truncated response", {
            stopReason: "length",
          });
        const submission =
          role === "explorer"
            ? { notes: [workerDraft(input, "n1")] }
            : coordination;
        const submit = fauxToolCall(`submit_${role}`, submission);
        const read = fauxToolCall("read_notes", {
          ids: validRead ? ["prior"] : [],
          level: "full",
        });
        return fauxAssistantMessage(
          readFirst ? [read, submit] : [submit, read],
          {
            stopReason: "toolUse",
          },
        );
      },
      { maxExplorerResponses: 1, maxExplorerReads: 4 },
    );
    const current = await provider.open();
    try {
      const id = await current.invoke({
        role,
        input: {
          task,
          notes: [note("prior")],
          ...(role === "explorer"
            ? { assignment: "Continue" }
            : {
                guidance: [],
                failures: [],
                literatureUsed: false,
              }),
        },
      });
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result:
          role === "explorer"
            ? {
                kind: "published",
                notes: [`${id}/n1`],
                edits: [],
                limit: "response_limit",
              }
            : coordination,
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
      ).toHaveLength(validRead && role === "coordinator" ? 2 : 1);
      if (role === "explorer") {
        const reads = retained
          .flatMap((entry) => entry.model ?? [])
          .filter(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "read_notes",
          );
        expect(reads).toMatchObject([
          { isError: true, details: { read: false } },
        ]);
        expect(JSON.stringify(reads)).not.toContain(note("prior").text);
      }
    } finally {
      await current.harness.close(context);
    }
  },
);

test("Explorer preserves dependencies and response limits across transcript pages", async () => {
  let calls = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      calls++;
      const receipt = transcript.messages.findLast(
        (message) => message.role === "toolResult",
      );
      const previous =
        receipt?.role === "toolResult" && receipt.content[0]?.type === "text"
          ? JSON.parse(receipt.content[0].text.split("\n\n")[0]!).notes[0].id
          : undefined;
      return {
        notes: [workerDraft(input, `n${calls}`, previous ? [previous] : [])],
      };
    },
    { maxExplorerResponses: 70 },
  );
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "explorer",
      input: { task, notes: [], assignment: "Continue" },
    });
    const completed = await resultOf(current.harness, id);
    expect(calls).toBe(70);
    expect(completed).toEqual({
      status: "completed",
      result: {
        kind: "published",
        notes: Array.from({ length: 70 }, (_, i) => `${id}/n${i + 1}`),
        edits: [],
        limit: "response_limit",
      },
    });
    const view = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    expect(view.notes.map(({ id, support }) => ({ id, support }))).toEqual(
      Array.from({ length: 70 }, (_, i) => ({
        id: `${id}/n${i + 1}`,
        support: i > 0 ? [`${id}/n${i}`] : [],
      })),
    );
  } finally {
    await current.harness.close(context);
  }
});

test.each([false, undefined])(
  "Explorer hands off when a non-last new note is a candidate (last candidate=%s)",
  async (lastCandidate) => {
    const provider = fixture(
      (_name, input) => ({
        notes: [
          { ...workerDraft(input, "n1"), candidate: true },
          {
            ...workerDraft(input, "n2", [`${input.noteIdPrefix}n1`]),
            ...(lastCandidate === undefined
              ? {}
              : { candidate: lastCandidate }),
          },
        ],
      }),
      { maxExplorerResponses: 1 },
    );
    provider.roles.coordinator = async (input) => {
      expect(input.limits).toEqual([]);
      return {
        work: input.notes.length
          ? null
          : { kind: "explorer", assignment: "Prove the exact claim" },
      };
    };
    const current = await provider.open(undefined, {
      task,
      settings: {
        profiles: { default: { provider: "openai", model: "roles" } },
      },
    });
    try {
      await current.root.commit(
        (tx) => provider.workflow.initialize(tx, current.root.id),
        context,
      );
      await current.root.waitForIdle(context);
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]!.input.assignment).toBe("Prove the exact claim");
      const view = await current.root.commit(
        (tx) => readView(tx, current.root.id),
        context,
      );
      expect(view.notes).toHaveLength(2);
      const status = await current.root.commit(
        (tx) => readStatus(tx, current.root.id),
        context,
      );
      expect(status.limits.items).toEqual([]);
      expect(view.notes.map(({ candidate }) => candidate)).toEqual([
        true,
        false,
      ]);
      for (const saved of view.notes) {
        expect(saved.checks).toEqual({});
        expect(saved.checks.external).toBeUndefined();
        expect(saved.verified).toBe(false);
        expect(saved.accepted).toBe(false);
      }
    } finally {
      await current.harness.close(context);
    }
  },
);

test("Explorer continues after publication and invalid submissions until an empty handoff", async () => {
  let calls = 0;
  const provider = fixture(
    (_name, input, transcript) => {
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
                notes: [workerDraft(input, "n1", ["prior"])],
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
                notes: [
                  { ...workerDraft(input, "n2", ["missing"]), candidate: true },
                ],
              }),
            ],
            { stopReason: "toolUse" },
          );
        case 4: {
          const receipt = transcript.messages.findLast(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "submit_explorer" &&
              !message.isError,
          );
          if (
            receipt?.role !== "toolResult" ||
            receipt.content[0]?.type !== "text"
          )
            throw new Error("Expected first note publication receipt");
          const value = JSON.parse(receipt.content[0].text.split("\n\n")[0]!);
          return {
            notes: [workerDraft(input, "n2", [value.notes[0].id])],
          };
        }
        default:
          return { notes: [] };
      }
    },
    { maxExplorerReads: 4, maxExplorerResponses: 6 },
  );
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "explorer",
      input: { task, notes: [note("prior")], assignment: "Continue" },
    });
    const completed = await resultOf(current.harness, id);
    expect(completed).toEqual({
      status: "completed",
      result: {
        kind: "published",
        notes: [`${id}/n1`, `${id}/n2`],
        edits: [],
      },
    });
    expect(calls).toBe(5);
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
  }
});

test.each([false, true])(
  "Explorer publication survives interruption before acknowledgement (cancel=%s)",
  async (cancel) => {
    const directory = await temporaryDirectory("pi-role-publication-");
    let initial!: ReturnType<typeof draft>;
    let canonical = "";
    let revision = 0;
    let response = 0;
    const provider = fixture(
      (_name, input, transcript) => {
        response++;
        if (response === 1) {
          initial = workerDraft(input, "n7");
          return { notes: [initial] };
        }
        const last = transcript.messages.findLast(
          (message) => message.role === "toolResult",
        );
        if (last?.role !== "toolResult" || last.content[0]?.type !== "text")
          throw new Error("Expected publication or read receipt");
        if (last.isError)
          throw new Error(`${last.toolName}: ${last.content[0].text}`);
        const value = JSON.parse(last.content[0].text.split("\n\n")[0]!);
        if (response === 2) {
          expect(last.toolName).toBe("submit_explorer");
          expect(value).toMatchObject({
            recorded: true,
            done: false,
            notes: [{ id: canonical, revision }],
          });
          return {
            tool: "read_notes",
            arguments: { ids: [canonical], level: "full" },
          };
        }
        if (response === 3) {
          expect(value).toEqual([
            {
              id: canonical,
              revision,
              text: initial.text,
              detailedSummary: initial.detailedSummary,
            },
          ]);
          return {
            notes: [],
            edits: [
              {
                id: canonical,
                revision,
                text: "Repaired public argument",
                detailedSummary: "Repaired public detail",
              },
            ],
          };
        }
        if (response === 4) {
          expect(last.toolName).toBe("submit_explorer");
          expect(value.done).toBe(false);
          expect(value.edits).toHaveLength(1);
          expect(value.edits[0].id).toBe(canonical);
          expect(value.edits[0].revision).toBeGreaterThan(revision);
          revision = value.edits[0].revision;
          return {
            tool: "read_notes",
            arguments: { ids: [canonical], level: "full" },
          };
        }
        expect(response).toBe(5);
        expect(value).toEqual([
          {
            id: canonical,
            revision,
            text: "Repaired public argument",
            detailedSummary: "Repaired public detail",
          },
        ]);
        return { notes: [] };
      },
      { maxExplorerReads: 2, maxExplorerResponses: 6 },
    );
    let decisions = 0;
    provider.roles.coordinator = async () =>
      ++decisions === 1
        ? {
            work: {
              kind: "explorer",
              assignment: "Publish findings and continue reasoning.",
            },
          }
        : { work: null };
    let current = await provider.open(directory, {
      task,
      settings: {
        profiles: { default: { provider: "openai", model: "roles" } },
      },
    });
    try {
      const closed = current.closeAfterEntry(
        (entry) => Events.is(entry) && entry.data.type === "result",
      );
      await current.root.commit(
        (tx) => provider.workflow.initialize(tx, current.root.id),
        context,
      );
      current.harness.resume();
      await closed.promise;
      expect(response).toBe(1);
      expect(decisions).toBe(1);
      current = await provider.open(directory);
      const [worker] = await current.root.commit(
        (tx) => scanTasks(tx, current.root.id, "research.worker"),
        context,
      );
      expect(worker!.state.outcome).toBeUndefined();
      const before = await current.root.commit(
        (tx) => readView(tx, current.root.id),
        context,
      );
      expect(before.notes).toHaveLength(1);
      canonical = `${worker!.id}/n7`;
      revision = before.notes[0]!.revision;
      expect(revision).toBeGreaterThan(0);
      expect(before.notes[0]).toMatchObject({ ...initial, id: canonical });
      const interrupted = await entries(current.harness);
      expect(interrupted.filter(Events.is)).toHaveLength(1);
      expect(
        interrupted
          .flatMap((entry) => entry.model ?? [])
          .filter(
            (message) =>
              message.role === "toolResult" &&
              message.toolName === "submit_explorer" &&
              !message.isError,
          ),
      ).toEqual([]);
      if (cancel) await current.harness.abortTask(worker!.id, context);
      await current.harness.waitForIdle(context);
      const outcome = await resultOf(current.harness, worker!.id);
      if (cancel) expect(outcome).toMatchObject({ status: "aborted" });
      else
        expect(outcome).toEqual({
          status: "completed",
          result: { kind: "published", notes: [canonical], edits: [canonical] },
        });
      const after = await current.root.commit(
        (tx) => readView(tx, current.root.id),
        context,
      );
      expect(after.notes).toHaveLength(1);
      if (cancel) expect(after.notes).toEqual(before.notes);
      else
        expect(after.notes[0]).toMatchObject({
          id: canonical,
          revision,
          text: "Repaired public argument",
          detailedSummary: "Repaired public detail",
        });
      expect((await entries(current.harness)).filter(Events.is)).toHaveLength(
        cancel ? 1 : 2,
      );
      expect(response).toBe(cancel ? 1 : 5);
      expect(decisions).toBe(2);
      expect(new Set(provider.calls.map(({ session }) => session)).size).toBe(
        1,
      );
    } finally {
      await current.harness.close(context);
    }
  },
);

test.each([false, true])(
  "Explorer uses dependent revision feedback without another read (reopen=%s)",
  async (reopen) => {
    const directory = reopen
      ? await temporaryDirectory("pi-role-dependent-revisions-")
      : undefined;
    let responses = 0;
    const provider = fixture(
      (_name, input, transcript) => {
        if (++responses === 1)
          return {
            notes: [],
            edits: [
              {
                id: "base",
                revision: input.notes.find((note: Note) => note.id === "base")
                  .revision,
                text: "Repaired base argument",
              },
            ],
          };
        const receipt = transcript.messages.findLast(
          (message) => message.role === "toolResult",
        );
        if (
          receipt?.role !== "toolResult" ||
          receipt.content[0]?.type !== "text"
        )
          throw new Error("Expected dependent revision feedback");
        expect(receipt.isError).toBe(false);
        const value = JSON.parse(receipt.content[0].text.split("\n\n")[0]!);
        expect(value.invalidated).toEqual([
          { id: "consumer", revision: expect.any(Number), readRequired: false },
          { id: "leaf", revision: expect.any(Number), readRequired: false },
        ]);
        return {
          notes: [workerDraft(input, "n1", ["leaf"])],
          edits: [
            {
              id: "consumer",
              revision: value.invalidated[0].revision,
              text: "Consumer repaired after its base",
            },
          ],
        };
      },
      { maxExplorerReads: 1, maxExplorerResponses: 2 },
    );
    let current = await provider.open(directory);
    try {
      const interrupted = reopen
        ? current.closeAfterEntry(
            (entry) => Events.is(entry) && entry.data.type === "result",
          )
        : undefined;
      const id = await current.invoke({
        role: "explorer",
        input: {
          task,
          notes: [
            preparedNote("base"),
            preparedNote("consumer", ["base"]),
            preparedNote("leaf", ["consumer"]),
          ],
          assignment: "Repair the base, then its consumer.",
        },
      });
      if (interrupted) {
        current.harness.resume();
        await interrupted.promise;
        expect(responses).toBe(1);
        current = await provider.open(directory);
        const records = await entries(current.harness);
        expect(records.filter(Events.is)).toHaveLength(1);
        expect(records.some(ToolResultEntry.is)).toBe(false);
      }
      expect(await resultOf(current.harness, id)).toEqual({
        status: "completed",
        result: {
          kind: "published",
          notes: [`${id}/n1`],
          edits: ["base", "consumer"],
          limit: "response_limit",
        },
      });
      const view = await current.root.commit(
        (tx) => readView(tx, current.root.id),
        context,
      );
      expect(view.notes.find((note) => note.id === "consumer")).toMatchObject({
        text: "Consumer repaired after its base",
        checks: {},
        verified: false,
      });
      const leaf = view.notes.find((note) => note.id === "leaf")!;
      expect(leaf.text).toBe(preparedNote("leaf").text);
      expect(leaf.checks).toEqual({});
      const records = await entries(current.harness);
      expect(records.filter(Events.is)).toHaveLength(2);
      const results = records
        .sort((left, right) => left.id - right.id)
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "toolResult");
      expect(results).toHaveLength(2);
      expect(
        results.every((message) => message.toolName === "submit_explorer"),
      ).toBe(true);
      const last = results.at(-1)!;
      if (last.content[0]?.type !== "text")
        throw new Error("Expected final publication receipt");
      expect(JSON.parse(last.content[0].text.split("\n\n")[0]!)).toMatchObject({
        done: true,
        invalidated: [
          { id: "leaf", revision: leaf.revision, readRequired: false },
        ],
      });
      expect(responses).toBe(2);
    } finally {
      await current.harness.close(context);
    }
  },
);

test("Explorer invalidation feedback cannot observe an intervening consumer edit", async () => {
  const directory = await temporaryDirectory("pi-role-unseen-consumer-");
  let responses = 0;
  let baseRevision = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      if (++responses === 1) {
        baseRevision = input.notes.find(
          (note: Note) => note.id === "base",
        ).revision;
        return {
          tool: "read_notes",
          arguments: { ids: ["base", "consumer"], level: "full" },
        };
      }
      if (responses === 2)
        return {
          notes: [],
          edits: [
            { id: "base", revision: baseRevision, text: "Repaired base" },
          ],
        };
      const result = transcript.messages.findLast(
        (message) => message.role === "toolResult",
      );
      if (result?.role !== "toolResult" || result.content[0]?.type !== "text")
        throw new Error("Expected publication or read result");
      if (responses === 3) {
        const value = JSON.parse(result.content[0].text.split("\n\n")[0]!);
        expect(value.invalidated).toEqual([
          { id: "consumer", revision: expect.any(Number), readRequired: true },
        ]);
        expect(result.content[0].text).not.toContain(
          "Unseen external argument",
        );
        return { notes: [workerDraft(input, "n1", ["consumer"])] };
      }
      if (responses === 4) {
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          "Stale note revision: consumer",
        );
        return {
          tool: "read_notes",
          arguments: { ids: ["consumer"], level: "full" },
        };
      }
      if (responses === 5) {
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("Unseen external argument");
        return { notes: [workerDraft(input, "n1", ["consumer"])] };
      }
      return { notes: [] };
    },
    { maxExplorerReads: 2, maxExplorerResponses: 6 },
  );
  let current = await provider.open(directory);
  try {
    const interrupted = current.closeAfterEntry((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "toolResult" && message.toolName === "read_notes",
      ),
    );
    const id = await current.invoke({
      role: "explorer",
      input: {
        task,
        notes: [preparedNote("base"), preparedNote("consumer", ["base"])],
        assignment: "Repair the base and use its consumer.",
      },
    });
    current.harness.resume();
    await interrupted.promise;
    expect(responses).toBe(1);
    current = await provider.open(directory);
    await current.root.commit(async (tx) => {
      const view = await readView(tx, current.root.id);
      const consumer = view.notes.find((note) => note.id === "consumer")!;
      await publishCommand(tx, current.root.id, {
        kind: "submit",
        id: "external-consumer-edit",
        notes: [],
        edits: [
          {
            id: consumer.id,
            revision: consumer.revision,
            text: "Unseen external argument",
          },
        ],
      });
    }, context);
    expect(await resultOf(current.harness, id)).toEqual({
      status: "completed",
      result: { kind: "published", notes: [`${id}/n1`], edits: ["base"] },
    });
    const view = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    expect(view.notes.find((note) => note.id === "consumer")!.text).toBe(
      "Unseen external argument",
    );
    expect(view.notes.filter((note) => note.id === `${id}/n1`)).toHaveLength(1);
    expect((await entries(current.harness)).filter(Events.is)).toHaveLength(3);
    expect(responses).toBe(6);
  } finally {
    await current.harness.close(context);
  }
});

test("Explorer rejects a stale public revision and retains its earlier published edit", async () => {
  let calls = 0;
  let staleRevision = 0;
  let currentRevision = 0;
  const provider = fixture(
    (_name, input, transcript) => {
      if (++calls === 1) {
        staleRevision = input.notes[0].revision;
        return {
          notes: [],
          edits: [
            {
              id: "prior",
              revision: staleRevision,
              summary: "Published summary",
            },
          ],
        };
      }
      if (calls === 2) {
        const receipt = transcript.messages.findLast(
          (message) => message.role === "toolResult",
        );
        if (
          receipt?.role !== "toolResult" ||
          receipt.content[0]?.type !== "text"
        )
          throw new Error("Expected publication receipt");
        currentRevision = JSON.parse(receipt.content[0].text.split("\n\n")[0]!)
          .edits[0].revision;
        return {
          notes: [],
          edits: [
            { id: "prior", revision: staleRevision, text: "Stale repair" },
          ],
        };
      }
      if (calls === 4) return { notes: [] };
      const last = transcript.messages.findLast(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "submit_explorer",
      );
      expect(last).toMatchObject({ isError: true });
      expect(JSON.stringify(last)).toContain("Stale note revision: prior");
      return {
        notes: [],
        edits: [
          { id: "prior", revision: currentRevision, text: "Current repair" },
        ],
      };
    },
    { maxExplorerResponses: 5 },
  );
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "explorer",
      input: {
        task,
        notes: [{ ...note("prior"), revision: 3 }],
        assignment: "Repair.",
      },
    });
    expect(await resultOf(current.harness, id)).toEqual({
      status: "completed",
      result: { kind: "published", notes: [], edits: ["prior"] },
    });
    const view = await current.root.commit(
      (tx) => readView(tx, current.root.id),
      context,
    );
    expect(view.notes).toHaveLength(1);
    expect(view.notes[0]).toMatchObject({
      id: "prior",
      summary: "Published summary",
      text: "Current repair",
    });
    expect(view.notes[0]!.revision).toBeGreaterThan(staleRevision);
    expect((await entries(current.harness)).filter(Events.is)).toHaveLength(2);
    expect(calls).toBe(4);
  } finally {
    await current.harness.close(context);
  }
});

test("Coordinator can idle with Explorer available", async () => {
  const recent = [
    {
      id: "earlier",
      role: "explorer",
      completed: true,
      failed: false,
      error: null,
      request: { kind: "explorer", assignment: "Investigate" },
    },
  ];
  const provider = fixture((_name, input) => {
    expect(input).toMatchObject({
      recent,
    });
    return { work: null };
  }, {});
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "coordinator",
      input: {
        task,
        notes: [],
        failures: [],
        guidance: [],
        literatureUsed: false,
        recent,
      },
    });
    expect(await resultOf(current.harness, id)).toEqual({
      status: "completed",
      result: { work: null },
    });
    expect(provider.calls).toHaveLength(1);
  } finally {
    await current.harness.close(context);
  }
});

test("Verifier rejects proof-text corrections and accepts a summary-only correction", async () => {
  let calls = 0;
  const provider = fixture((_name, input, transcript) => {
    calls++;
    if (calls > 1)
      expect(
        transcript.messages.some(
          (message) => message.role === "toolResult" && message.isError,
        ),
      ).toBe(true);
    return {
      results: input.notes.map(({ id }: { id: string }) => ({
        noteId: id,
        verdict: "PASS",
        report: "Checked original proof",
        statement: "Exact claim",
        premises: [],
        correction: {
          summary: "Faithful summary",
          detailedSummary: null,
          ...(calls === 1
            ? { text: "A replacement proof the verifier must not install" }
            : {}),
        },
      })),
    };
  });
  const current = await provider.open();
  try {
    const id = await current.invoke({
      role: "verifier",
      input: {
        task,
        notes: [note("n1")],
        targets: ["n1"],
        through: "correctness",
      },
    });
    expect(await resultOf(current.harness, id)).toMatchObject({
      status: "completed",
      result: {
        checks: [
          {
            noteId: "n1",
            correction: { revision: 0, summary: "Faithful summary" },
          },
        ],
      },
    });
    expect(calls).toBe(2);
  } finally {
    await current.harness.close(context);
  }
});
