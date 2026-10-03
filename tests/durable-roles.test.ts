import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { ask } from "../packages/core/src/solve/pi.ts";
import {
  Xean,
  openXeanStorage,
  type CampaignView,
  type EntryId,
  type JsonValue,
} from "../packages/core/src/index.ts";
import {
  createSolver,
  project,
  submitCommand,
  codexResearch,
} from "../packages/core/src/solve/index.ts";
import { fixtureRuntime, invoke } from "./fixtures/pi.ts";

test("concurrent Pi runtimes retain each other's custom models", async () => {
  const calls: string[] = [];
  const runtimes = ["first", "second"].map((id) => {
    const runtime = fixtureRuntime((_input, _options, selected) => {
      calls.push(selected.id);
      return fauxAssistantMessage(
        [fauxToolCall("submit_result", { answer: id })],
        {
          stopReason: "toolUse",
        },
      );
    });
    runtime.profiles.coordinator.model.id = id;
    return runtime;
  });
  const results = await invoke(
    (_input, execution, context) =>
      Promise.all(
        runtimes.map((runtime) =>
          ask(
            runtime,
            "coordinator",
            "Return the answer",
            {},
            Type.Object({ answer: Type.String() }),
            execution,
            context,
          ),
        ),
      ),
    null,
  );
  expect(results).toEqual([{ answer: "first" }, { answer: "second" }]);
  expect(calls.sort()).toEqual(["first", "second"]);
});

test("explicit Coordinator retry replaces a terminal conversation failure", async () => {
  let calls = 0;
  const runtime = fixtureRuntime(() =>
    ++calls === 2
      ? fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: "Invalid request",
        })
      : fauxAssistantMessage(
          [fauxToolCall("submit_result", { answer: calls === 1 ? 1 : 7 })],
          { stopReason: "toolUse" },
        ),
  );
  const storage = new MemoryStorage();
  const engine = await Xean.open(storage, {
    task: null,
    roles: [],
    coordinator: {
      name: "retry",
      async run(_signal, _view, execution, context) {
        return {
          state: await ask(
            runtime,
            "coordinator",
            "Return the answer",
            {},
            Type.Object({ answer: Type.Number() }),
            execution,
            context,
            {
              maxResponses: 2,
              submit(value, previous) {
                expect(previous).toBeUndefined();
                return {
                  done: value.answer === 7,
                  receipt: { recorded: true },
                };
              },
            },
          ),
        };
      },
    },
  });
  try {
    expect(await engine.run()).toMatchObject({
      status: "blocked",
      providerCalls: 2,
    });
    await engine.resume();
    expect(await engine.run()).toMatchObject({
      state: { answer: 7 },
      providerCalls: 3,
    });
    const conversations = await storage.scanConversations(
      {},
      10,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(
      conversations.items.filter((conversation) => conversation.owner),
    ).toHaveLength(2);
    expect(calls).toBe(3);
  } finally {
    await engine.close();
  }
});

test("Explorer resumes private native work before one complete shared publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-durable-role-"));
  const path = join(directory, "campaign.sqlite");
  const pending = Promise.withResolvers<void>();
  const transcripts: string[] = [];
  let resuming = false;
  const content = (text: string) => ({
    summary: text,
    detailedSummary: text,
    text,
  });
  const draft = (id: string, support: string[]) => ({
    id,
    ...content(`Private ${id}`),
    support,
  });
  const setup = () => {
    const runtime = fixtureRuntime((input, _options, selected) => {
      expect(selected.id).toBe("explorer");
      transcripts.push(JSON.stringify(input.messages));
      const response = transcripts.length;
      const tools = input.messages.filter(
        (message) => message.role === "toolResult",
      );
      if (response > 1) {
        expect(transcripts.at(-1)).toContain("ORIGINAL-FROZEN-PROOF");
        expect(transcripts.at(-1)).not.toContain("COPYEDITED-AFTER-CLOSE");
      }
      if (response === 2 || response === 3)
        expect(tools.at(-1)?.isError).not.toBe(true);
      if (response === 4) expect(tools.at(-1)?.isError).toBe(true);
      if (response > 4)
        throw new Error("Explorer reset its response allowance");
      const call =
        response === 1 || response === 3
          ? fauxToolCall("read_notes", {
              ids: ["input/seed/n1"],
              level: "full",
            })
          : fauxToolCall("submit_result", {
              notes: [
                response === 2
                  ? draft("n1", ["input/seed/n1"])
                  : draft("n2", ["n1"]),
              ],
              candidate: false,
            });
      return fauxAssistantMessage([call], { stopReason: "toolUse" });
    });
    const solver = createSolver(
      { problem: "Prove the exact task", completionCriteria: "Complete proof" },
      runtime,
      { maxExplorerReads: 1, maxExplorerResponses: 4 },
    );
    solver.functions.coordinator = async ({ failures, notes }) => {
      if (failures.length)
        throw new Error(failures[0]!.error ?? "Explorer failed");
      return {
        work: notes.some((note) => !note.imported)
          ? []
          : [{ kind: "explorer", guidance: "Explore" }],
      };
    };
    const explorer = solver.functions.explorer;
    solver.functions.explorer = (input, execution, context) =>
      explorer(
        input,
        {
          ...execution,
          recorder: {
            ...execution.recorder,
            async begin(identity) {
              if (!resuming && transcripts.length === 2) {
                const signal = context.abortSignal!;
                signal.throwIfAborted();
                pending.resolve();
                await new Promise<void>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => reject(signal.reason),
                    { once: true },
                  );
                });
              }
              return execution.recorder.begin(identity);
            },
          },
        },
        context,
      );
    return solver;
  };
  const nativeTasks = async () => {
    const storage = await openXeanStorage(path, { readOnly: true });
    try {
      const page = await storage.scanTasks(
        {},
        32,
        undefined,
        BACKGROUND_CONTEXT,
      );
      expect(page.next).toBeUndefined();
      return page.items;
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  };
  let storage = await openXeanStorage(path);
  let engine = await Xean.open(storage, setup());
  let running: ReturnType<Xean["run"]> | undefined;
  try {
    await submitCommand(engine, {
      kind: "submit",
      id: "seed",
      candidate: false,
      notes: [{ id: "n1", ...content("ORIGINAL-FROZEN-PROOF"), support: [] }],
    });
    running = engine.run();
    await Promise.race([
      pending.promise,
      running.then((result) => {
        throw new Error(
          result.error ?? "Explorer stopped before the interruption point",
        );
      }),
    ]);
    const privateView = await engine.inspect();
    expect(project(privateView).filter((note) => !note.imported)).toEqual([]);
    expect(privateView.work[0]).toMatchObject({
      status: "active",
      result: null,
      publicationId: null,
    });
    const progressQuery = {
      kind: "xean.role",
      scope: { kind: "task" as const, taskId: privateView.work[0]!.taskId },
      at: "current" as const,
    };
    const progress = await storage.scanDocuments(
      progressQuery,
      10,
      undefined,
      BACKGROUND_CONTEXT,
    );
    expect(progress.items).toHaveLength(1);
    const progressId = progress.items[0]!.id;
    const savedProgress = await storage.document(
      progressId,
      "current",
      BACKGROUND_CONTEXT,
    );
    expect(savedProgress?.value).toMatchObject({
      value: { notes: [{ id: "n1" }] },
    });
    expect(savedProgress?.value.reads).toHaveLength(1);
    await engine.close();
    await running;
    expect(transcripts).toHaveLength(2);
    const completed = (await nativeTasks()).filter(
      (task) =>
        (task.kind === "pi.generation" || task.kind === "pi.tool") &&
        task.state.status === "terminal",
    );
    expect(completed.map(({ kind }) => kind).sort()).toEqual([
      "pi.generation",
      "pi.generation",
      "pi.tool",
      "pi.tool",
    ]);

    resuming = true;
    storage = await openXeanStorage(path);
    engine = await Xean.open(storage, setup());
    expect(
      await storage.document(progressId, "current", BACKGROUND_CONTEXT),
    ).toEqual(savedProgress);
    await submitCommand(engine, {
      kind: "correct",
      id: "copyedit",
      note: "input/seed/n1",
      revision: 0,
      ...content("COPYEDITED-AFTER-CLOSE"),
    });
    expect(
      project(await engine.inspect()).filter((note) => !note.imported),
    ).toEqual([]);
    const result = await engine.run();
    expect(transcripts).toHaveLength(4);
    expect(result.providerCalls).toBe(4);
    expect(result.work).toHaveLength(1);
    const work = result.work[0]!;
    expect(work.status).toBe("completed");
    expect(
      (
        await storage.scanDocuments(
          progressQuery,
          10,
          undefined,
          BACKGROUND_CONTEXT,
        )
      ).items,
    ).toEqual([]);
    expect(
      await storage.document(progressId, "current", BACKGROUND_CONTEXT),
    ).toBeUndefined();
    const { view: inputId } = work.input as { view: EntryId };
    const frozen = (await engine.attemptInput(inputId)) as {
      view: CampaignView;
    };
    expect(project(frozen.view)).toMatchObject([
      { id: "input/seed/n1", text: "ORIGINAL-FROZEN-PROOF" },
    ]);
    expect(project(result).find((note) => note.imported)?.text).toBe(
      "COPYEDITED-AFTER-CLOSE",
    );
    const published = project(result).filter((note) => !note.imported);
    expect(published.map(({ id, support }) => ({ id, support }))).toEqual([
      { id: `${work.id}/n1`, support: ["input/seed/n1"] },
      { id: `${work.id}/n2`, support: [`${work.id}/n1`] },
    ]);
    expect(
      (await engine.records()).filter(
        (entry) =>
          entry.kind === "xean.attempt.completed" &&
          entry.byTaskId === work.taskId,
      ),
    ).toHaveLength(1);
    await engine.close();
    const finalTasks = await nativeTasks();
    for (const task of completed)
      expect(finalTasks.find(({ id }) => id === task.id)).toEqual(task);
    expect(finalTasks.filter(({ kind }) => kind === "pi.tool")).toHaveLength(4);
    expect(
      finalTasks.filter(({ kind }) => kind === "pi.generation"),
    ).toHaveLength(4);
    expect(
      finalTasks.find(({ id }) => id === work.publicationId)?.input,
    ).toMatchObject({
      kind: "completed",
      value: { workId: work.id, taskId: work.taskId },
    });
  } finally {
    await engine.close();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("Verifier reuses completed source evidence and Pi stages after interruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-verifier-recovery-"));
  const path = join(directory, "campaign.sqlite");
  const pending = Promise.withResolvers<void>();
  const calls: string[] = [];
  const pass = { verdict: "PASS" as const, report: "Checked." };
  let sourceCalls = 0;
  let resuming = false;
  const setup = () => {
    const runtime = fixtureRuntime((input, _options, selected) => {
      calls.push(selected.id);
      const packet = JSON.parse(
        String(
          input.messages.find((message) => message.role === "user")!.content,
        ),
      );
      const result: JsonValue =
        selected.id === "correctness"
          ? { ...pass, premises: ["External theorem"] }
          : selected.id === "statement"
            ? { statement: "Exact claim" }
            : selected.id === "proof"
              ? { proof: "Independent proof", complete: true }
              : pass;
      return fauxAssistantMessage(
        [
          fauxToolCall("submit_result", {
            results: [{ noteId: packet.notes[0].id, result }],
          }),
        ],
        { stopReason: "toolUse" },
      );
    });
    const solver = createSolver(
      { problem: "Exact claim", completionCriteria: "Complete proof" },
      runtime,
      {},
      {
        ...codexResearch(),
        async source({ notes }) {
          const operationId = `source-${++sourceCalls}`;
          return notes.map(({ id, premises }) => ({
            noteId: id,
            result: {
              ...pass,
              kind: "codex-report" as const,
              operationId,
              reportedAt: new Date().toISOString(),
              premises,
              passages: [],
            },
          }));
        },
      },
    );
    solver.functions.explorer = async () => ({
      kind: "notes",
      candidate: true,
      notes: [
        {
          id: "n1",
          summary: "Claim",
          detailedSummary: "Exact claim",
          text: "Original proof",
          support: [],
        },
      ],
    });
    solver.functions.coordinator = async ({ notes, failures }) => {
      if (failures.length)
        throw new Error(failures[0]!.error ?? "Verifier failed");
      return {
        work: notes.length
          ? [
              {
                kind: "verifier",
                notes: [notes[0]!.id],
                through: "reconstruction",
              },
            ]
          : [{ kind: "explorer", guidance: "Explore" }],
      };
    };
    const verifier = solver.functions.verifier;
    solver.functions.verifier = (input, execution, context) =>
      verifier(
        input,
        {
          ...execution,
          recorder: {
            ...execution.recorder,
            async begin(identity) {
              if (!resuming && identity.id === "proof") {
                const signal = context.abortSignal!;
                signal.throwIfAborted();
                pending.resolve();
                await once(signal, "abort");
                signal.throwIfAborted();
              }
              return execution.recorder.begin(identity);
            },
          },
        },
        context,
      );
    return solver;
  };
  let engine = await Xean.open(await openXeanStorage(path), setup());
  let running: ReturnType<Xean["run"]> | undefined;
  try {
    running = engine.run();
    await Promise.race([pending.promise, running]);
    const before = await engine.inspect();
    expect(project(before)[0]).toMatchObject({
      checks: [],
      verified: false,
      accepted: false,
    });
    await engine.close();
    await running;
    expect(calls).toEqual(["correctness", "requirements", "statement"]);

    resuming = true;
    engine = await Xean.open(await openXeanStorage(path), setup());
    const completed = await engine.run();
    expect(completed.status).toBe("completed");
    expect({ sourceCalls, calls }).toEqual({
      sourceCalls: 1,
      calls: [
        "correctness",
        "requirements",
        "statement",
        "proof",
        "reconstruction",
      ],
    });
    const note = project(completed)[0]!;
    expect(note.checks[0]!.source).toMatchObject({ operationId: "source-1" });
  } finally {
    await engine.close();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
});
