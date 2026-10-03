import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getDeclaredTools } from "@earendil-works/pi-ai/utils/transcript";
import type { Execution } from "../packages/core/src/types.ts";
import type { Note } from "../packages/core/src/solve/contracts.ts";
import { createSolver } from "../packages/core/src/solve/solver.ts";
import { readSettings } from "../packages/core/src/solve/config.ts";
import { invoke, fixtureRuntime } from "./fixtures/pi.ts";

const task = { problem: "Exact task", completionCriteria: "Complete proof" };
const execution: Execution = {
  attemptId: "retrieval-fixture",
  attempt: 1,
  recorder: { begin: () => ({ recordRequest() {}, settle() {} }) },
};
const note = (id: string, summary: string): Note => ({
  id,
  summary,
  detailedSummary: `DETAIL-${id}`,
  text: `FULL-${id}`,
  support: [],
  revision: 0,
  imported: true,
  checks: [],
  verified: true,
  dead: false,
  accepted: false,
  candidate: false,
});
const draft = {
  id: "n1",
  summary: "New result",
  detailedSummary: "New result under the live lemma's hypotheses.",
  text: "Apply the live lemma with its hypotheses checked.",
  support: ["live"],
};
const reply = (...calls: ReturnType<typeof fauxToolCall>[]) =>
  fauxAssistantMessage(calls, { stopReason: "toolUse" });

test("Explorer receives automatic summaries and keeps its prefix stable across read allowances", async () => {
  const prefixes: string[][] = [];
  for (const maxExplorerReads of [1, 2, 4]) {
    const notes = [note("live", "Live lemma")];
    const runtime = fixtureRuntime((context) => {
      const inputs = context.messages
        .filter((message) => message.role === "user")
        .map((message) => JSON.parse(String(message.content)));
      expect(inputs[0]).toEqual({ task });
      expect(inputs[1]).toEqual({ id: "live", summary: "Live lemma" });
      expect(inputs[2].notes[0]).not.toHaveProperty("summary");
      expect(inputs[2].notes[0]).not.toHaveProperty("text");
      expect(inputs[2].notes[0]).not.toHaveProperty("detailedSummary");
      expect(inputs[2]).not.toHaveProperty("support");
      expect(inputs[2].allowance).toEqual({
        reads: maxExplorerReads,
        responses: maxExplorerReads + 4,
      });
      expect(
        getDeclaredTools(context.messages).map(({ name }) => name),
      ).toEqual(["submit_result", "read_notes"]);
      prefixes.push(
        context.messages.slice(0, 3).map((message) => String(message.content)),
      );
      return reply(
        fauxToolCall("submit_result", { notes: [draft], candidate: true }),
      );
    });
    const solver = createSolver(task, runtime, { maxExplorerReads });
    expect(solver.options.maxExplorerResponses).toBe(maxExplorerReads + 4);
    expect(
      await invoke(
        solver.functions.explorer,
        { task, notes, guidance: "Continue" },
        execution,
      ),
    ).toEqual({ kind: "notes", notes: [draft], candidate: true });
  }
  expect(prefixes[1]).toEqual(prefixes[0]);
  expect(prefixes[2]).toEqual(prefixes[0]);
  const runtime = fixtureRuntime(() => {
    throw new Error("No model call");
  });
  for (const maxExplorerReads of [
    0,
    -1,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER,
  ])
    expect(() => createSolver(task, runtime, { maxExplorerReads })).toThrow();
  expect(() =>
    readSettings({
      profiles: { default: { provider: "openai", model: "gpt-6-astra" } },
      maxExplorerReads: 0,
    }),
  ).toThrow();
});

test("an empty published index omits reads while retaining private submissions", async () => {
  const notes: Note[] = [];
  const first = { ...draft, text: "A self-contained lemma.", support: [] };
  const second = {
    ...draft,
    id: "n2",
    text: "The new lemma proves the task.",
    support: ["n1"],
  };
  let responses = 0;
  const runtime = fixtureRuntime((context) => {
    responses++;
    expect(getDeclaredTools(context.messages).map(({ name }) => name)).toEqual([
      "submit_result",
    ]);
    const inputs = context.messages
      .filter((message) => message.role === "user")
      .slice(0, 2)
      .map((message) => JSON.parse(String(message.content)));
    expect(inputs).toEqual([
      { task },
      {
        notes: [],
        guidance: "Continue",
        allowance: { reads: 0, responses: 3 },
      },
    ]);
    if (responses === 1) {
      notes.push(note("late", "Published after the frozen invocation"));
      return reply(
        fauxToolCall("submit_result", { notes: [first], candidate: false }),
      );
    }
    expect(responses).toBe(2);
    expect(JSON.stringify(context.messages)).toContain(first.text);
    return reply(
      fauxToolCall("submit_result", { notes: [second], candidate: true }),
    );
  });
  const result = await invoke(
    createSolver(task, runtime, {
      maxExplorerReads: 4,
      maxExplorerResponses: 3,
    }).functions.explorer,
    { task, notes, guidance: "Continue" },
    execution,
  );
  expect(result).toEqual({
    kind: "notes",
    notes: [first, second],
    candidate: true,
  });
  expect(responses).toBe(2);
});

test("Coordinator keeps task and summaries ahead of changing states and guidance", async () => {
  const notes = [note("live", "Live lemma")];
  const runtime = fixtureRuntime((context) => {
    const messages = context.messages.filter(
      (message) => message.role === "user",
    );
    expect(
      messages.slice(0, -1).map((message) => String(message.content)),
    ).toEqual([
      JSON.stringify({ task }),
      JSON.stringify({ id: "live", summary: "Live lemma" }),
    ]);
    const input = JSON.parse(String(messages.at(-1)!.content));
    expect(input.notes[0]).not.toHaveProperty("summary");
    expect(input).not.toHaveProperty("task");
    expect(input.notes[0].verified).toBe(notes[0]!.verified);
    expect(input.guidance).toEqual([String(notes[0]!.verified)]);
    return reply(
      fauxToolCall("submit_result", {
        work: [{ kind: "explorer", guidance: "Continue" }],
      }),
    );
  });
  for (const verified of [true, false]) {
    notes[0]!.verified = verified;
    await invoke(createSolver(task, runtime).functions.coordinator, {
      task,
      notes,
      guidance: [String(verified)],
      failures: [],
      literatureUsed: false,
      explorerUsed: false,
    });
  }
});

test("retrieval freezes batched reads and rejects invalid IDs and dead dependencies", async () => {
  const notes = [note("live", "Live lemma"), note("dead", "Rejected lemma")];
  const fullText = "FULL-live\n".repeat(6000);
  notes[0]!.text = fullText;
  notes[1]!.dead = true;
  notes[1]!.verified = false;
  notes[1]!.checks = [
    {
      noteId: "dead",
      correctness: {
        verdict: "FAIL",
        report: "Counterexample at zero.",
        premises: [],
      },
    },
  ];
  let responses = 0;
  const runtime = fixtureRuntime((context) => {
    responses++;
    const result = (id: string) => {
      const message = context.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === id,
      );
      if (message?.role !== "toolResult")
        throw new Error(`Missing tool result: ${id}`);
      return message;
    };
    const value = (id: string) => {
      const message = result(id);
      expect(message.isError).toBe(false);
      const content = message.content[0];
      if (content?.type !== "text")
        throw new Error("Expected text tool result");
      return JSON.parse(content.text);
    };
    const call = (
      id: string,
      name: string,
      args: Parameters<typeof fauxToolCall>[1],
    ) => fauxToolCall(name, args, { id });
    switch (responses) {
      case 1:
        expect(JSON.stringify(context.messages)).not.toContain("DETAIL-live");
        expect(JSON.stringify(context.messages)).not.toContain("FULL-live");
        notes[0]!.text = "CHANGED-AFTER-START";
        notes[0]!.detailedSummary = "CHANGED-AFTER-START";
        notes[0]!.dead = true;
        notes.push(note("late", "Lemma published after invocation"));
        return reply(
          call("detail", "read_notes", {
            ids: ["live", "dead"],
            level: "detailed",
          }),
        );
      case 2: {
        const details = value("detail");
        expect(
          details.map(({ detailedSummary }: Note) => detailedSummary),
        ).toEqual(["DETAIL-live", "DETAIL-dead"]);
        expect(details[0]).not.toHaveProperty("text");
        expect(details).toEqual([
          { id: "live", detailedSummary: "DETAIL-live" },
          { id: "dead", detailedSummary: "DETAIL-dead" },
        ]);
        const states = JSON.parse(
          String(
            context.messages.find(
              (message) =>
                message.role === "user" &&
                String(message.content).includes('"allowance":'),
            )!.content,
          ),
        ).notes;
        expect(states[0]).toMatchObject({ verified: true, dead: false });
        expect(states[1]).toMatchObject({ verified: false, dead: true });
        expect(JSON.stringify(states[1].feedback)).toContain(
          "Counterexample at zero.",
        );
        return reply(
          call("full", "read_notes", { ids: ["live", "dead"], level: "full" }),
          call("unknown", "read_notes", { ids: ["missing"], level: "full" }),
          call("late", "read_notes", { ids: ["late"], level: "full" }),
          call("tooManyIds", "read_notes", {
            ids: Array.from({ length: 21 }, (_, index) => `id-${index}`),
            level: "full",
          }),
        );
      }
      case 3:
        expect(value("full").map(({ text }: Note) => text)).toEqual([
          fullText,
          "FULL-dead",
        ]);
        for (const id of ["unknown", "late", "tooManyIds"])
          expect(result(id).isError).toBe(true);
        expect(JSON.stringify(result("unknown"))).toContain(
          "Unknown note: missing",
        );
        expect(JSON.stringify(result("late"))).toContain("Unknown note: late");
        expect(JSON.stringify(result("tooManyIds"))).not.toContain(
          "Unknown note",
        );
        expect(JSON.stringify(context.messages)).not.toContain(
          "CHANGED-AFTER-START",
        );
        return reply(
          call("deadSupport", "submit_result", {
            notes: [{ ...draft, support: ["dead"] }],
            candidate: false,
          }),
        );
      case 4:
        expect(result("deadSupport").isError).toBe(true);
        expect(JSON.stringify(result("deadSupport"))).toContain(
          "Unknown, dead, or forward support: dead",
        );
        return reply(
          fauxToolCall("submit_result", { notes: [draft], candidate: false }),
        );
      default:
        throw new Error("Retrieval exceeded the four-response allowance");
    }
  });
  runtime.profiles.explorer.model.contextWindow = 100_000;
  const result = await invoke(
    createSolver(task, runtime, {
      maxExplorerReads: 4,
      maxExplorerResponses: 4,
    }).functions.explorer,
    { task, notes, guidance: "Continue" },
    execution,
  );
  expect(result).toEqual({ kind: "notes", notes: [draft], candidate: false });
  expect(responses).toBe(4);
});

test("read limits cover batched calls and the final response without changing tools", async () => {
  for (const { reads, responses: maximum, admitted } of [
    { reads: 1, responses: 4, admitted: 1 },
    { reads: 2, responses: 6, admitted: 2 },
    { reads: 9, responses: 2, admitted: 3 },
  ]) {
    let responses = 0;
    const runtime = fixtureRuntime((context) => {
      responses++;
      expect(
        getDeclaredTools(context.messages).map(({ name }) => name),
      ).toEqual(["submit_result", "read_notes"]);
      const results = context.messages.filter(
        (message) => message.role === "toolResult",
      );
      if (responses === 1)
        return reply(
          ...Array.from({ length: 3 }, (_, i) =>
            fauxToolCall(
              "read_notes",
              { ids: ["live"], level: "full" },
              { id: "read-" + i },
            ),
          ),
        );
      expect(responses).toBe(2);
      expect(results.filter((result) => !result.isError)).toHaveLength(
        admitted,
      );
      expect(results.filter((result) => result.isError)).toHaveLength(
        3 - admitted,
      );
      expect(JSON.stringify(context.messages.at(-1))).toContain(
        "Reading is disabled",
      );
      return reply(
        fauxToolCall(
          "read_notes",
          { ids: ["live"], level: "full" },
          { id: "over-limit" },
        ),
        fauxToolCall("submit_result", { notes: [draft], candidate: true }),
      );
    });
    const solver = createSolver(task, runtime, {
      maxExplorerReads: reads,
      maxExplorerResponses: maximum,
    });
    expect(
      await invoke(
        solver.functions.explorer,
        { task, notes: [note("live", "Live lemma")], guidance: "Continue" },
        execution,
      ),
    ).toEqual({ kind: "notes", notes: [draft], candidate: true });
    expect(responses).toBe(2);
  }
});
