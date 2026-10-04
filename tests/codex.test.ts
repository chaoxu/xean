import { expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  Type,
  fauxAssistantMessage,
  fauxToolCall,
  type Static,
} from "@earendil-works/pi-ai";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
} from "@earendil-works/chord/context";
import {
  Xean,
  openXeanStorage,
  type XeanOptions,
} from "../packages/core/src/index.ts";
import {
  bindCodex,
  codexResearch,
} from "../packages/core/src/solve/research.ts";
import {
  askCodex,
  type CodexOptions,
} from "../packages/core/src/solve/codex.ts";
import {
  sourceSchema,
  codexPlan,
  reviewSchema,
  decode,
  type ResearchReport,
} from "../packages/core/src/solve/contracts.ts";
import {
  campaignOptions,
  createSolver,
  declarationVersion,
  project,
  readDeclaration,
  submitCommand,
  type CodexInput,
  type Declaration,
} from "../packages/core/src/solve/index.ts";
import { fixtureRuntime } from "./fixtures/pi.ts";

async function fixture(directory: string): Promise<CodexOptions> {
  const command = join(directory, "codex");
  await writeFile(
    command,
    `#!${process.execPath}\nimport ${JSON.stringify(join(import.meta.dir, "fixtures/codex.ts"))};\n`,
    { mode: 0o700 },
  );
  return {
    model: "xean-fixture",
    profile: "fixture-profile",
    command,
    environment: {
      HOME: directory,
      CODEX_HOME: join(directory, "native-codex-home"),
      PATH: process.env.PATH,
      XEAN_FIXTURE: "unchanged",
      XEAN_CODEX_USAGE_TAG: "caller-tag",
    },
  };
}

const schema = Type.Object(
  { answer: Type.Number() },
  { additionalProperties: false },
);
test.each(["research", "workspace"])(
  "Codex %s results and invalid-answer usage survive completed SQLite reopen",
  codexLifecycle,
  15_000,
);

test("Codex source bindings require exact premises and independent evidence", () => {
  for (const wireSchema of [
    sourceSchema,
    reviewSchema,
    sourceSchema.properties.correction.anyOf[0],
  ])
    expect(new Set(Object.keys(wireSchema.properties))).toEqual(
      new Set(wireSchema.required),
    );
  const source = {
    value: {
      verdict: "PASS" as const,
      report: "Reported passage",
      correction: null,
      passages: [
        { premise: 0, url: "https://example.com/paper", quote: "P holds" },
      ],
    },
    operationId: "fixture",
    searches: 1,
  };
  const withPassages = (
    passages: Static<typeof sourceSchema>["passages"],
    searches = 0,
  ) => ({ ...source, searches, value: { ...source.value, passages } });
  expect(bindCodex({ ...source, searches: 0 }, ["P"]).verdict).toBe(
    "INCONCLUSIVE",
  );
  const task = { problem: "Assume P holds.", completionCriteria: "Prove Q" };
  const taskSource = withPassages([
    { premise: 0, url: "urn:xean:task", quote: task.problem },
  ]);
  const taskReport = bindCodex(taskSource, ["P"], [], "fixture", task);
  expect(taskReport.verdict).toBe("PASS");
  expect(bindCodex(taskSource, ["P"]).verdict).toBe("INCONCLUSIVE");
  expect(
    bindCodex(taskSource, ["P"], [], "fixture", {
      ...task,
      problem: "Prove P.",
    }).verdict,
  ).toBe("INCONCLUSIVE");
  const taskReuse = withPassages([
    { premise: 0, passageId: taskReport.passages[0]!.id },
  ]);
  expect(
    bindCodex(taskReuse, ["P"], taskReport.passages, "reuse", task).verdict,
  ).toBe("PASS");
  expect(bindCodex(taskReuse, ["P"], taskReport.passages).verdict).toBe(
    "INCONCLUSIVE",
  );
  expect(bindCodex(source, ["P", "Q"]).verdict).toBe("INCONCLUSIVE");
  const verified = bindCodex(source, ["P"]);
  expect(verified.verdict).toBe("PASS");
  expect(verified).not.toHaveProperty("correction");
  expect(
    bindCodex(
      {
        ...source,
        value: decode(sourceSchema, {
          ...source.value,
          correction: {
            summary: "Edited",
            detailedSummary: null,
            text: null,
          },
        }),
      },
      ["P"],
    ).correction,
  ).toEqual({
    summary: "Edited",
    detailedSummary: null,
    text: null,
  });
  expect(verified).toMatchObject({
    kind: "codex-report",
    operationId: "fixture",
  });
  expect(verified.passages).toEqual([
    { ...source.value.passages[0]!, id: "fixture/0", statement: "P" },
  ]);
  const partial = bindCodex(
    withPassages(
      [{ premise: 0, passageId: "missing" }, ...source.value.passages],
      1,
    ),
    ["P"],
  );
  expect(partial.verdict).toBe("INCONCLUSIVE");
  expect(partial.passages).toEqual([
    { ...verified.passages[0]!, id: "fixture/1" },
  ]);
  const reused = {
    ...withPassages([{ premise: 0, passageId: "fixture/0" }]),
    operationId: "reuse",
  };
  const reuse = bindCodex(
    reused,
    ["P applied to this note"],
    verified.passages,
  );
  expect(reuse).toMatchObject({
    verdict: "PASS",
    operationId: "reuse",
    premises: ["P applied to this note"],
    passages: verified.passages,
  });
  expect(bindCodex(reused, ["P"]).verdict).toBe("INCONCLUSIVE");
  expect(bindCodex(reused, ["P", "Q"], verified.passages).verdict).toBe(
    "INCONCLUSIVE",
  );
  expect(
    bindCodex(
      { ...reused, value: { ...reused.value, verdict: "FAIL" } },
      ["Q"],
      verified.passages,
    ).verdict,
  ).toBe("FAIL");
  expect(
    bindCodex(
      withPassages([
        ...reused.value.passages,
        { premise: 1, url: "https://example.com/q", quote: "Q" },
      ]),
      ["P", "Q"],
      verified.passages,
    ).verdict,
  ).toBe("INCONCLUSIVE");
  const { correction: _correction, ...review } = source.value;
  const reviewed = decode(reviewSchema, { ...review, premises: ["P"] });
  const reviewReport = bindCodex(
    { ...source, value: reviewed },
    reviewed.premises,
  );
  expect(reviewReport.verdict).toBe("PASS");
  expect(reviewReport).not.toHaveProperty("correction");
  // Independent review's wire contract permits only newly inspected passages.
  expect(() =>
    decode(reviewSchema, { ...reviewed, passages: reused.value.passages }),
  ).toThrow();
});

async function codexLifecycle(mode: string) {
  const directory = await mkdtemp(join(process.cwd(), ".xean-codex-test-"));
  const path = join(directory, "campaign.sqlite");
  const log = () => Bun.file(join(directory, "invocations.jsonl")).text();
  const codex = await fixture(directory);
  codex.command = relative(process.cwd(), codex.command!);
  const options: XeanOptions = {
    task: "offline Codex lifecycle",
    limits: { concurrency: 1 },
    roles: [
      {
        name: "worker",
        async run(input, execution, context) {
          const workspace =
            mode === "workspace"
              ? await mkdtemp(join(directory, "workspace-"))
              : undefined;
          return (
            await askCodex(
              { ...codex, workspace },
              schema,
              "Return the answer",
              { mode: input },
              execution,
              context,
              "xean-tests",
            )
          ).value;
        },
      },
    ],
    coordinator: {
      name: "fixture",
      run(signal, view) {
        return {
          state: null,
          ...(signal.kind === "start"
            ? {
                dispatch: ["success", "invalid", "nonzero"].map((id) => ({
                  id,
                  role: "worker",
                  input: id,
                })),
              }
            : view.work.every((work) =>
                  ["completed", "failed"].includes(work.status),
                )
              ? { completion: "done" }
              : {}),
        };
      },
    },
    accept: (candidate) => candidate === "done",
  };
  let engine = await Xean.open(await openXeanStorage(path), options);
  try {
    const result = await engine.run();
    expect(result.status).toBe("completed");
    expect(result.work.map((work) => [work.status, work.result])).toEqual([
      ["completed", { answer: 25 }],
      ["failed", null],
      ["failed", null],
    ]);
    expect(result.work[2]!.error).toBe("Fixture failed after reporting usage");
    const records = await engine.records();
    const requests = records.filter(
      (entry) => entry.kind === "xean.call.request",
    );
    const settlements = records.filter(
      (entry) => entry.kind === "xean.call.settled",
    );
    expect(requests).toHaveLength(3);
    expect(settlements).toHaveLength(3);
    for (let index = 0; index < 3; index++) {
      expect(requests[index]!.id).toBeLessThan(settlements[index]!.id);
      expect(settlements[index]!.data).toMatchObject({
        message: {
          failed: index === 2,
          isCanceled: false,
          exitCode: index === 2 ? 7 : 0,
          stdout: expect.stringContaining('"turn.completed"'),
          stderr:
            index === 2
              ? expect.stringContaining("Fixture failed after reporting usage")
              : "",
        },
        usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 5 },
      });
    }
    expect(requests[0]!.data).toMatchObject({
      payload: {
        kind: "codex-exec",
        model: "xean-fixture",
        reasoning: "max",
        workspace: expect.any(String),
        sandbox: mode === "workspace" ? "workspace-write" : "read-only",
        shell: mode === "workspace",
        webSearch: mode === "workspace" ? "disabled" : "live",
        prompt: JSON.stringify({ mode: "success" }),
      },
    });
    const calls = await log();
    const invocations = calls
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(invocations).toEqual(
      result.work.map((work) => ({
        mode: work.id,
        profile: "fixture-profile",
        reasoning: 'model_reasoning_effort="max"',
        shell: `features.shell_tool=${mode === "workspace"}`,
        webSearch: `web_search="${mode === "workspace" ? "disabled" : "live"}"`,
        sandbox: mode === "workspace" ? "workspace-write" : "read-only",
        workspace: expect.any(String),
        schema: expect.any(String),
        codexHome: codex.environment!.CODEX_HOME,
        marker: "unchanged",
        usageTag: `xean-tests/${work.attemptId}`,
      })),
    );
    for (const invocation of invocations) {
      await expect(access(invocation.schema)).rejects.toThrow();
      if (mode === "workspace") {
        expect(
          await Bun.file(join(invocation.workspace, "program.ts")).text(),
        ).toBe("console.log(25);\n");
        expect(
          await Bun.file(join(invocation.workspace, "output.txt")).text(),
        ).toBe(invocation.mode);
      } else await expect(access(invocation.workspace)).rejects.toThrow();
    }
    await engine.close();
    engine = await Xean.open(await openXeanStorage(path), options);
    expect(await engine.run()).toEqual(result);
    expect(await engine.records()).toEqual(records);
    expect(await log()).toBe(calls);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("Coordinator Codex work freezes support and publishes only valid unverified drafts", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".xean-codex-worker-"));
  const log = () => Bun.file(join(directory, "invocations.jsonl")).text();
  const codex = {
    ...(await fixture(directory)),
    workspace: join(directory, "artifacts"),
  };
  const task = {
    problem: "Prove P",
    completionCriteria: "Give a complete proof",
  };
  const draft = {
    id: "n1",
    summary: "Finite evidence",
    detailedSummary: "P held in this finite test",
    text: "program.ts produced output.txt; the general case remains open",
    support: ["input/seed/n3"],
  };
  const replies = [
    { notes: [draft], candidate: true },
    { notes: [{ ...draft, support: ["missing"] }], candidate: false },
    { notes: [], candidate: true },
  ];
  let plans = 0;
  const solver = createSolver(
    task,
    fixtureRuntime((context, _options, selected) => {
      expect(selected.id).toBe("coordinator");
      const input = JSON.parse(
        String(
          context.messages.findLast((message) => message.role === "user")!
            .content,
        ),
      );
      expect(input.capabilities.codex).toBe(true);
      plans++;
      return fauxAssistantMessage(
        [
          fauxToolCall("submit_result", {
            work: replies.map((reply) => ({
              kind: "codex",
              assignment: JSON.stringify(reply),
              notes: ["input/seed/n3"],
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    }),
    { codex },
  );
  const coordinate = solver.functions.coordinator;
  solver.functions.coordinator = (...args) =>
    plans === 0 ? coordinate(...args) : Promise.resolve({ work: [] });
  let engine = await Xean.open(
    await openXeanStorage(join(directory, "campaign.sqlite")),
    { ...solver, limits: { attempts: 3 } },
  );
  try {
    const blankAssignment = { kind: "codex", assignment: " \n", notes: [] };
    expect(() => decode(codexPlan, blankAssignment)).toThrow();
    await expect(
      solver.functions.codex(
        { task, notes: [], assignment: blankAssignment.assignment },
        null!,
        BACKGROUND_CONTEXT,
      ),
    ).rejects.toThrow();
    await expect(access(codex.workspace)).rejects.toThrow();
    await submitCommand(engine, {
      kind: "submit",
      id: "seed",
      candidate: false,
      notes: ["base", "middle", "selected", "unrelated"].map((text, index) => ({
        id: `n${index + 1}`,
        summary: text,
        detailedSummary: `Detail: ${text}`,
        text: `Full argument: ${text}`,
        support: index === 1 || index === 2 ? [`n${index}`] : [],
      })),
    });
    const frozen = project(await engine.inspect()).slice(0, 3);
    const result = await engine.run();
    expect(plans).toBe(1);
    expect(result.result).toBeNull();
    expect(result.work.map((work) => work.status)).toEqual([
      "completed",
      "failed",
      "failed",
    ]);
    expect(result.work[1]!.error).toContain(
      "Unknown, dead, or forward support: missing",
    );
    expect(result.work[2]!.error).toContain(
      "A solution claim needs a new note",
    );
    const generated = project(result).filter((note) => !note.imported);
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      id: `${result.work[0]!.id}/n1`,
      support: draft.support,
      candidate: true,
      verified: false,
      accepted: false,
      checks: [],
    });
    expect(generated[0]!.text).toContain(draft.text);
    const invocations = (await log())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CodexInput & { workspace: string });
    expect(new Set(invocations.map(({ workspace }) => workspace)).size).toBe(3);
    for (const invocation of invocations) {
      const input = { task, notes: frozen, assignment: invocation.assignment };
      expect(invocation.notes).toEqual(frozen);
      expect(
        await Bun.file(join(invocation.workspace, "input.json")).json(),
      ).toEqual(input);
      expect(
        await Bun.file(join(invocation.workspace, "program.ts")).text(),
      ).toBe("console.log(25);\n");
      expect(
        await Bun.file(join(invocation.workspace, "output.txt")).text(),
      ).toBe(invocation.assignment);
      if (invocation.assignment === JSON.stringify(replies[0])) {
        expect(result.work[0]!.result).toMatchObject({
          workspace: invocation.workspace,
        });
        expect(generated[0]!.text).toContain(
          `Artifacts: ${invocation.workspace}`,
        );
      }
    }
    await engine.close();
    const declaration = {
      kind: "xean.role",
      version: declarationVersion,
      role: "codex",
      task,
      input: { notes: frozen, assignment: JSON.stringify(replies[0]) },
      settings: {
        profiles: { default: { provider: "openai", model: "unused" } },
        codex: {
          model: codex.model,
          command: codex.command,
          workspace: codex.workspace,
        },
      },
    } satisfies Declaration;
    expect(() =>
      readDeclaration({
        ...declaration,
        input: { ...declaration.input, task },
      }),
    ).toThrow("Standalone declaration input must omit task");
    expect(() =>
      readDeclaration({ ...declaration, version: declarationVersion - 1 }),
    ).toThrow("Invalid value");
    const standalone = campaignOptions(declaration, () => {
      throw new Error("Standalone Codex must not initialize Pi");
    });
    const entered = Promise.withResolvers<void>();
    let interrupt = true;
    const role = standalone.roles[0]!;
    const invoke = role.run;
    role.run = (input, execution, context) =>
      invoke(
        input,
        {
          ...execution,
          recorder: {
            ...execution.recorder,
            async begin(model, generation) {
              if (interrupt) {
                entered.resolve();
                await awaitWithContext(new Promise(() => {}), context);
              }
              return execution.recorder.begin(model, generation);
            },
          },
        },
        context,
      );
    const path = join(directory, "standalone.sqlite");
    engine = await Xean.open(await openXeanStorage(path), standalone);
    (standalone.task as unknown as typeof declaration).input.notes[0]!.text =
      "Caller mutation after open";
    const interrupted = engine.run();
    await Promise.race([
      entered.promise,
      interrupted.then(() => {
        throw new Error("Standalone role stopped before interruption");
      }),
    ]);
    expect((await engine.inspect()).work[0]!.input).toBeNull();
    await engine.close();
    await interrupted;
    standalone.task = declaration as unknown as typeof standalone.task;
    interrupt = false;
    engine = await Xean.open(await openXeanStorage(path), standalone);
    const completed = await engine.run();
    expect(completed).toMatchObject({
      status: "completed",
      providerCalls: 1,
      result: { kind: "notes", candidate: true },
    });
    expect<unknown>(completed.task).toEqual(declaration);
    expect(completed.work[0]).toMatchObject({ input: null, attempts: 2 });
    const workspace = (completed.work[0]!.result as { workspace: string })
      .workspace;
    expect(await Bun.file(join(workspace, "input.json")).json()).toEqual({
      ...declaration.input,
      task,
    });
    const calls = await log();
    await engine.close();
    engine = await Xean.open(await openXeanStorage(path), standalone);
    expect(await engine.run()).toEqual(completed);
    expect(await log()).toBe(calls);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("source batches preserve note identity and distinct evidence in one Codex call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-source-batch-"));
  try {
    const codex = await fixture(directory);
    const task = {
      problem: "Assume P holds.",
      completionCriteria: "Apply P and Q",
    };
    const notes = [
      { id: "a", text: "Apply P", premises: ["P holds"] },
      { id: "self", text: "Self-contained", premises: [] },
      { id: "b", text: "Apply Q", premises: ["Q holds"] },
    ].map((note) => ({
      ...note,
      summary: `Index: ${note.text}`,
      detailedSummary: `Detail: ${note.text}`,
    }));
    let admitted = 0;
    let request: { operationId: string; prompt: string } | undefined;
    const source = (selected: typeof notes) =>
      codexResearch(codex).source(
        { task, notes: selected },
        {
          attemptId: "batch",
          attempt: 1,
          recorder: {
            begin() {
              admitted++;
              return {
                recordRequest(payload) {
                  request = payload as typeof request;
                },
                settle() {},
              };
            },
          },
        },
        BACKGROUND_CONTEXT,
      );
    await expect(
      source([notes[0]!, { ...notes[1]!, id: "a" }]),
    ).rejects.toThrow("Duplicate source note IDs");
    expect(await source([notes[1]!])).toMatchObject([
      { noteId: "self", result: { verdict: "PASS" } },
    ]);
    expect(admitted).toBe(0);
    const results = await source(notes);
    expect(admitted).toBe(1);
    expect(JSON.parse(request!.prompt).task).toEqual(task);
    expect(JSON.parse(request!.prompt).notes).toEqual([notes[0], notes[2]]);
    expect(results.map(({ noteId }) => noteId)).toEqual(["a", "self", "b"]);
    expect(results[1]!.result).toMatchObject({ verdict: "PASS" });
    const reports = [
      results[0]!.result,
      results[2]!.result,
    ] as ResearchReport[];
    expect(
      reports.map(({ verdict, operationId }) => ({ verdict, operationId })),
    ).toEqual([
      { verdict: "PASS", operationId: request!.operationId },
      { verdict: "PASS", operationId: request!.operationId },
    ]);
    expect(reports.flatMap(({ passages }) => passages)).toEqual([
      {
        id: `${request!.operationId}/0/0`,
        premise: 0,
        statement: "P holds",
        url: "urn:xean:task",
        quote: task.problem,
      },
      {
        id: `${request!.operationId}/1/0`,
        premise: 0,
        statement: "Q holds",
        url: "https://example.com/paper",
        quote: "Q holds",
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("close kills a Codex launcher and its resistant descendant and preserves cancellation usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-codex-cancel-"));
  const path = join(directory, "campaign.sqlite");
  const codex = await fixture(directory);
  codex.workspace = await mkdtemp(join(directory, "workspace-"));
  const options: XeanOptions = {
    task: "cancel Codex",
    roles: [
      {
        name: "worker",
        async run(_input, execution, context) {
          return (
            await askCodex(
              codex,
              schema,
              "Wait",
              { mode: "wait" },
              execution,
              context,
            )
          ).value;
        },
      },
    ],
    coordinator: {
      name: "fixture",
      run(signal) {
        return {
          state: null,
          ...(signal.kind === "start"
            ? { dispatch: [{ id: "wait", role: "worker", input: null }] }
            : {}),
        };
      },
    },
  };
  let engine = await Xean.open(await openXeanStorage(path), options);
  let processes: number[] = [];
  const running = engine.run();
  try {
    const ready = join(directory, "processes.json");
    for (
      const deadline = Date.now() + 5000;
      !(await Bun.file(ready).exists());
    ) {
      if (Date.now() > deadline)
        throw new Error("Codex fixture did not become ready");
      await Bun.sleep(10);
    }
    const recorded: unknown = await Bun.file(ready).json();
    if (
      !Array.isArray(recorded) ||
      recorded.length !== 2 ||
      !recorded.every((pid) => Number.isSafeInteger(pid) && pid > 1)
    )
      throw new Error("Invalid fixture process IDs");
    processes = recorded as number[];
    const invocation = await Bun.file(
      join(directory, "invocations.jsonl"),
    ).json();
    expect(invocation.usageTag).toBe("caller-tag");
    expect(invocation.shell).toBe("features.shell_tool=true");
    expect(invocation.sandbox).toBe("workspace-write");
    await engine.close();
    await running;
    for (const pid of processes) {
      for (const deadline = Date.now() + 3000; alive(pid);) {
        if (Date.now() > deadline)
          throw new Error(`Codex fixture process ${pid} survived close`);
        await Bun.sleep(10);
      }
    }
    engine = await Xean.open(await openXeanStorage(path), options);
    const records = await engine.records();
    expect(
      records.find((entry) => entry.kind === "xean.call.request")!.data,
    ).toMatchObject({
      payload: {
        usageTag: "caller-tag",
        workspace: codex.workspace,
        sandbox: "workspace-write",
        shell: true,
        webSearch: "disabled",
      },
    });
    expect(await Bun.file(join(codex.workspace, "output.txt")).text()).toBe(
      "wait",
    );
    await expect(access(invocation.schema)).rejects.toThrow();
    const settlements = records.filter(
      (entry) => entry.kind === "xean.call.settled",
    );
    expect(settlements).toHaveLength(1);
    expect(settlements[0]!.data).toMatchObject({
      message: { failed: true, isCanceled: true },
      usage: { input_tokens: 7, output_tokens: 0 },
    });
    expect((await engine.inspect()).work[0]!.result).toBeNull();
  } finally {
    for (const pid of processes) if (alive(pid)) process.kill(pid, "SIGKILL");
    await engine.close();
    await running;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
