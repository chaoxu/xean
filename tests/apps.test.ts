import { temporaryDirectory } from "./directory.ts";
import { expect, spyOn, test } from "bun:test";
import { $ } from "bun";
import { chmod, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  awaitWithContext,
  BACKGROUND_CONTEXT as context,
} from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  defineExtension,
  defineTask,
  type EntryId,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { defaultSettings } from "../src/roles/config.ts";
import { inspect, open } from "../src/host.ts";
import { readDefinition, type Definition } from "../src/core/definition.ts";
import { Control, type Roles } from "../src/core/workflow.ts";
import { readReport, readStatus, readUsage } from "../src/report.ts";
import { Bodies, Catalog, noteIdPrefix } from "../src/core/math/state.ts";
import { ExternalLog, ExternalRequest } from "../src/roles/backend.ts";
import { controlCommand, observeOwner } from "../apps/cli/lifecycle.ts";
import { requestOwner, serveControl, socketPath } from "../apps/cli/control.ts";
import { limitRounds, readRounds } from "../scripts/bounded-solve.ts";

const task = {
  problem: "Prove 1 = 1.",
  completionCriteria: "A self-contained proof.",
};
const settings = defaultSettings;
const definition: Definition = { task, settings };
const draft = {
  id: "n1",
  summary: "Equality",
  detailedSummary: "Equality is reflexive.",
  text: "1 = 1\n\nPROOF: By reflexivity, 1 = 1.",
  support: [],
};
const pass = { verdict: "PASS" as const, report: "Checked." };
const root = resolve(import.meta.dir, "..");

async function command(file: string, ...args: string[]) {
  const result =
    await $`${process.execPath} --no-install --no-env-file ${join(root, file)} ${args} < /dev/null`
      .env({
        ...process.env,
        PI_CODING_AGENT_DIR: await temporaryDirectory("xean-cli-auth-"),
      })
      .quiet()
      .nothrow();
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
const cli = (...args: string[]) => command("apps/cli/index.ts", ...args);
const reportOf = (owner: Awaited<ReturnType<typeof open>>) =>
  owner.root.commit(
    (tx) => readReport(tx, owner.root.id, { bodies: false }),
    context,
  );

function withoutHistory(tx: Tx) {
  return new Proxy(tx, {
    get(target, key) {
      if (["entry", "scanEntries"].includes(String(key)))
        throw new Error(`Unexpected history read: ${String(key)}`);
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args: unknown[]) => {
            if (
              key === "scanConversations" &&
              (args[0] as Parameters<Tx["scanConversations"]>[0])
                ?.ownerTaskId === undefined
            )
              throw new Error("Unexpected campaign conversation scan");
            if (key === "doc" && args[0] === Bodies)
              throw new Error("Unexpected notebook body read");
            return Reflect.apply(value, target, args);
          }
        : value;
    },
  });
}

test("CLI controls use compact status without reading transcripts or notebook bodies", async () => {
  const directory = await temporaryDirectory("xean-compact-control-");
  const owner = await open(join(directory, "campaign.sqlite"), {
    create: definition,
    roles: () => ({ coordinator: async () => ({ work: null }) }),
  });
  const commit = owner.root.commit.bind(owner.root);
  const guarded = spyOn(owner.root, "commit").mockImplementation((read, ctx) =>
    commit((tx) => read(withoutHistory(tx)), ctx),
  );
  try {
    await owner.root.waitForIdle(context);
    for (const [kind, status] of [
      ["pause", "paused"],
      ["pause", "paused"],
      ["resume", "idle"],
      ["cancel", "cancelled"],
      ["cancel", "cancelled"],
    ] as const) {
      const receipt = await controlCommand(owner, { kind });
      expect(receipt).toMatchObject({ status });
      expect(receipt).not.toHaveProperty("calls");
      expect(receipt).not.toHaveProperty("usageNote");
    }
    await expect(controlCommand(owner, { kind: "resume" })).rejects.toThrow(
      "terminal",
    );
  } finally {
    guarded.mockRestore();
    await owner.close();
  }
});

test.each(["SIGINT", "SIGTERM"] as const)(
  "runner closes ownership and skips work when %s arrives during socket startup",
  async (signal) => {
    const directory = await temporaryDirectory("xean-runner-signal-");
    const database = join(directory, "campaign.sqlite");
    const source = `
import { runOwner } from ${JSON.stringify(join(root, "apps/cli/lifecycle.ts"))};
let closed = 0, worked = 0, finished = 0;
const owner = {
  close: async () => { closed++; },
  root: { waitForIdle: async () => { worked++; } },
};
const running = runOwner(owner, ${JSON.stringify(database)}, async () => { finished++; });
process.emit(${JSON.stringify(signal)});
await running;
console.log(JSON.stringify({ closed, worked, finished,
  listeners: ["SIGINT", "SIGTERM"].map(signal => process.listenerCount(signal)) }));
`;
    const result =
      await $`${process.execPath} --no-install --no-env-file -e ${source}`
        .quiet()
        .nothrow();
    expect(result.exitCode).toBe(130);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString())).toEqual({
      closed: 1,
      worked: 0,
      finished: 0,
      listeners: [0, 0],
    });
    expect(await Bun.file(socketPath(database)).exists()).toBe(false);
  },
);

test("CLI doctor reuses saved Pi ChatGPT and Claude logins without refreshing or exposing them", async () => {
  const directory = await temporaryDirectory("xean-pi-auth-");
  const file = join(directory, "settings.json");
  const authFile = join(directory, "auth.json");
  const credentials = Object.fromEntries(
    ["openai", "anthropic"].map((provider) => [
      provider,
      {
        type: "oauth",
        access: "private-fixture-access",
        refresh: "private-fixture-refresh",
        expires: 0,
      },
    ]),
  );
  const bytes = JSON.stringify(credentials);
  for (const provider of ["openai", "anthropic"] as const) {
    await Bun.write(
      file,
      JSON.stringify({
        profiles: {
          default: { provider, model: getBuiltinModels(provider)[0]!.id },
        },
      }),
    );
    await Bun.write(authFile, bytes);
    const result =
      await $`${process.execPath} --no-install --no-env-file ${join(root, "apps/cli/index.ts")} doctor ${file} < /dev/null`
        .env({
          ...process.env,
          PI_CODING_AGENT_DIR: directory,
          OPENAI_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        })
        .quiet()
        .nothrow();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString()).ok).toBe(true);
    expect(result.stdout.toString() + result.stderr.toString()).not.toContain(
      "private-fixture",
    );
    expect(await Bun.file(authFile).text()).toBe(bytes);
    await Bun.write(authFile, "{}");
    const explicit =
      await $`${process.execPath} --no-install --no-env-file ${join(root, "apps/cli/index.ts")} --key-stdin doctor ${file} < ${Buffer.from("explicit-fixture-key")}`
        .env({
          ...process.env,
          PI_CODING_AGENT_DIR: directory,
          OPENAI_API_KEY: "",
          ANTHROPIC_API_KEY: "",
        })
        .quiet()
        .nothrow();
    expect(explicit.exitCode).toBe(0);
    expect(JSON.parse(explicit.stdout.toString()).ok).toBe(true);
    expect(
      explicit.stdout.toString() + explicit.stderr.toString(),
    ).not.toContain("explicit-fixture-key");
  }
});

test("CLI offline inputs are durable, idempotent after cancellation, and do not start providers", async () => {
  const directory = await temporaryDirectory("xean-apps-");
  const taskFile = join(directory, "task.json"),
    settingsFile = join(directory, "settings.json"),
    input = join(directory, "input.json");
  await Bun.write(taskFile, JSON.stringify(task));
  await Bun.write(settingsFile, JSON.stringify(settings));
  await Bun.write(
    input,
    JSON.stringify({
      notes: [
        {
          ...draft,
          id: "input/import/n1",
          candidate: true,
          support: ["input/import/n2"],
        },
        { ...draft, id: "input/import/n2" },
      ],
    }),
  );
  const prefix = ["--campaign-dir", directory];
  const initialized = await cli(
    ...prefix,
    "init",
    taskFile,
    "named",
    settingsFile,
  );
  expect(initialized.code).toBe(0);
  expect(JSON.parse(initialized.stdout)).toMatchObject({
    status: "running",
    pendingDecisions: 1,
  });
  const imported = await cli(
    ...prefix,
    "submit",
    "named",
    input,
    "--id",
    "import",
  );
  expect(imported.code).toBe(0);
  expect(
    (await cli(...prefix, "submit", "named", input, "--id", "import")).stdout,
  ).toBe(imported.stdout);
  const inspected = await cli(...prefix, "inspect", "named", "--records");
  expect(inspected.stderr).toBe("");
  expect(inspected.code).toBe(0);
  const full = JSON.parse(inspected.stdout);
  expect(full.status.verificationIssues.items).toContainEqual({
    noteId: "input/import/n2",
    stage: "reconstruction",
    verdict: "unchecked",
    report: null,
  });
  expect(full.notes[0]).toMatchObject({
    id: "input/import/n1",
    checks: { external: { entry: expect.any(Number) } },
    candidate: true,
  });
  expect(full.work).toEqual([]);
  expect(full.status.calls.recordedResponses).toBe(0);
  // Status must not need a temporary snapshot directory.
  const compact = JSON.parse(
    await $`${process.execPath} --no-install --no-env-file ${join(root, "apps/cli/index.ts")} ${prefix} status named < /dev/null`
      .env({ ...process.env, TMPDIR: taskFile, PI_CODING_AGENT_DIR: directory })
      .quiet()
      .text(),
  );
  const { observedAt: _observedAt, ...status } = compact;
  const { calls: _calls, usageNote: _usageNote, ...expected } = full.status;
  expect(status).toEqual(expected);
  expect(
    await inspect(join(directory, "named/campaign.sqlite"), (tx, root) =>
      readStatus(withoutHistory(tx), root),
    ),
  ).toEqual(expected);
  expect(compact.pendingDecisions).toBe(1);
  expect(JSON.stringify(compact)).not.toContain(draft.text);
  expect((await cli(...prefix, "export", "named")).code).not.toBe(0);
  expect((await cli(...prefix, "cancel", "named")).code).toBe(0);
  expect(
    (await cli(...prefix, "submit", "named", input, "--id", "import")).stdout,
  ).toBe(imported.stdout);
  expect(
    (await cli(...prefix, "submit", "named", input, "--id", "new")).code,
  ).not.toBe(0);
  expect((await cli(...prefix, "resume", "named")).stderr).toContain(
    "Cannot resume terminal",
  );
  const noRecords = JSON.parse(
    (await cli(...prefix, "inspect", "named")).stdout,
  );
  expect(noRecords.status.calls).toEqual(full.status.calls);
  expect(noRecords).not.toHaveProperty("records");
}, 30_000);

test("CLI role review executes and reopens an independent review without the retired command", async () => {
  const directory = await temporaryDirectory("xean-cli-review-");
  const input = join(directory, "input.json");
  const settingsFile = join(directory, "settings.json");
  const database = join(directory, "review.sqlite");
  const executable = join(directory, "codex-fixture");
  const requests = join(directory, "requests.jsonl");
  const argument = "1 = 1.\nBy reflexivity.\n";
  const result = { ...pass, premises: [], passages: [] };
  const events = [
    {
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(result) },
    },
    { type: "turn.completed", usage: { output_tokens: 7 } },
  ];
  await Bun.write(
    executable,
    `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(requests)}, (await Bun.stdin.text()) + "\\n");\nfor (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));\n`,
  );
  await chmod(executable, 0o700);
  await Bun.write(input, JSON.stringify({ task, argument }));
  await Bun.write(
    settingsFile,
    JSON.stringify({
      profiles: { default: { provider: "openai", model: "unavailable" } },
    }),
  );
  const rolesFile = join(directory, "roles.ts");
  await Bun.write(
    rolesFile,
    `import { codex } from ${JSON.stringify(join(root, "src/plugins/role-backends/codex.ts"))};\nexport default codex({research: {model: "fixture", command: ${JSON.stringify(executable)}}});\n`,
  );
  const obsolete = await cli("review", input, input, database, settingsFile);
  expect(obsolete.code).not.toBe(0);
  expect(obsolete.stderr).toContain("unknown command 'review'");
  expect(await Bun.file(database).exists()).toBe(false);
  expect(await Bun.file(requests).exists()).toBe(false);

  for (let attempt = 0; attempt < 2; attempt++) {
    const completed = await cli(
      "--roles",
      rolesFile,
      "role",
      "review",
      input,
      database,
      settingsFile,
    );
    expect(completed.code).toBe(0);
    expect(completed.stderr).toBe("");
    expect(JSON.parse(completed.stdout)).toMatchObject({
      status: "completed",
      acceptedNoteId: null,
    });
    expect(
      (await Bun.file(requests).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([{ task, argument }]);
  }
  expect(await inspect(database, readDefinition)).toMatchObject({
    task,
    mode: { role: "review", input: { argument } },
  });
  const report = await inspect(database, readReport);
  expect(report.kind).toBe("review");
  expect(report.result).toMatchObject(result);
  expect(report.status.calls.externalInvocations).toBe(1);
  expect(report.notes).toEqual([]);
}, 30_000);

test("sealed acceptance and native note IDs reach reports and CLI export", async () => {
  const directory = await temporaryDirectory("xean-apps-");
  const trace: string[] = [];
  const path = join(directory, "campaign.sqlite");
  const owner = await open(path, {
    create: definition,
    roles: () => ({
      coordinator: async (input) => {
        trace.push("coordinator");
        return {
          work: input.notes.length
            ? {
                kind: "verifier",
                notes: [input.notes[0].id],
                through: "reconstruction",
              }
            : { kind: "explorer", assignment: "Prove equality." },
        };
      },
      explorer: async (_input, runtime) => {
        trace.push("explorer");
        return {
          kind: "notes",
          notes: [
            {
              ...draft,
              id: noteIdPrefix(runtime.taskId) + "n1",
              candidate: true,
            },
          ],
        };
      },
      verifier: async (input) => {
        trace.push("verifier");
        return {
          kind: "verification",
          checks: [
            {
              noteId: input.targets[0],
              correctness: { ...pass, statement: "1 = 1", premises: [] },
              source: pass,
              requirements: pass,
              reconstruction: {
                ...pass,
                proof: "Reflexivity.",
              },
            },
          ],
        };
      },
    }),
  });
  try {
    await owner.root.waitForIdle(context);
    const report = await reportOf(owner);
    const full = await owner.root.commit(
      (tx) => readReport(tx, owner.root.id),
      context,
    );
    expect(report.status).toEqual(full.status);
    const { calls: _calls, usageNote: _usageNote, ...expected } = full.status;
    expect(
      await owner.root.commit(
        (tx) => readStatus(withoutHistory(tx), owner.root.id),
        context,
      ),
    ).toEqual(expected);
    expect(report.notes[0]!.text).toBe("");
    expect(full.notes[0]!.text).toBe(draft.text);
    expect(full.work[0]).toMatchObject({ assignment: "Prove equality." });
    expect(report.status.status).toBe("completed");
    expect(await controlCommand(owner, { kind: "pause" })).toEqual(expected);
    expect(report.status.acceptedNoteId).toMatch(/^\d+\/n1$/);
    expect(report.work[0]!.noteIds).toEqual([report.status.acceptedNoteId!]);
    expect(trace).toEqual([
      "coordinator",
      "explorer",
      "coordinator",
      "verifier",
    ]);
    expect(report.notes).toHaveLength(1);
    expect(report.work.map((work) => work.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(report.status.pendingDecisions).toBe(0);
    await expect(
      owner.root.commit(
        (tx) =>
          owner.workflow.input(tx, owner.root.id, {
            kind: "guide",
            id: "late",
            text: "reopen",
          }),
        context,
      ),
    ).rejects.toThrow("terminal");
    await expect(
      controlCommand(owner, {
        kind: "recheck",
        id: "late-recheck",
        notes: [{ id: full.notes[0]!.id, revision: full.notes[0]!.revision }],
        reason: "Request an additional assessment.",
      }),
    ).rejects.toThrow("terminal");
    expect((await reportOf(owner)).notes).toEqual(report.notes);
    const accepted = await owner.harness.snapshot(
      Control,
      owner.root.id,
      context,
    );
    const unsealed = await owner.root.commit(async (tx) => {
      (await tx.doc(Control, owner.root.id)).accepted = null;
      return readReport(tx, owner.root.id);
    }, context);
    expect(unsealed.notes[0]!.accepted).toBe(true);
    expect(unsealed.status.status).toBe("idle");
    expect(unsealed.status.acceptedNoteId).toBeNull();
    expect((await cli("export", path)).stderr).toContain(
      "No accepted argument",
    );
    await owner.root.commit(async (tx) => {
      (await tx.doc(Control, owner.root.id)).accepted = accepted!.accepted;
      // A later native document write must not rewrite the sealed export.
      const body = await tx.doc(
        Bodies,
        owner.root.id,
        report.status.acceptedNoteId!,
        { detailedSummary: "", text: "" },
      );
      body.text = "Later text outside the accepted snapshot.";
    }, context);
  } finally {
    await owner.close();
  }
  const exported = await cli("export", path);
  expect(exported.stderr).toBe("");
  expect(exported.code).toBe(0);
  expect(exported.stdout).toContain(draft.text);
  expect(exported.stdout).not.toContain("Later text outside");
}, 30_000);

test("standalone retries report only the latest result and CLI reopening does not rerun work", async () => {
  const pass = {
    verdict: "PASS",
    report: "Checked.",
    kind: "external-report",
    operationId: "fixture",
    reportedAt: "2026-10-13",
    premises: [],
    passages: [],
  };
  const directory = await temporaryDirectory("xean-standalone-retry-");
  const standalonePath = join(directory, "standalone.sqlite");
  let attempts = 0;
  const standalone = await open(standalonePath, {
    create: {
      ...definition,
      mode: {
        role: "review",
        input: { argument: "Exact proof." },
      },
    },
    roles: () => ({
      review: async (input) => {
        expect(input).toEqual({ task, argument: "Exact proof." });
        if (++attempts === 1) throw new Error("fixture failure");
        return { ...pass };
      },
    }),
  });
  try {
    expect(
      await standalone.harness.snapshot(Catalog, standalone.root.id, context),
    ).toEqual({ notes: [], inputs: [] });
    expect((await inspect(standalonePath, readStatus)).status).toBe("running");
    expect(attempts).toBe(0);
    await standalone.root.waitForIdle(context);
    expect((await reportOf(standalone)).status.status).toBe("blocked");
    expect(
      await standalone.root.commit(
        (tx) => readStatus(withoutHistory(tx), standalone.root.id),
        context,
      ),
    ).toMatchObject({ status: "blocked", work: { failed: 1 } });
    const receipt = await controlCommand(standalone, { kind: "resume" });
    const report = await reportOf(standalone);
    expect(receipt).toEqual(await observeOwner(standalone));
    expect(report.status.status).toBe("completed");
    expect(report.kind).toBe("review");
    expect(report.result).toEqual(pass);
    const { calls: _calls, usageNote: _usageNote, ...expected } = report.status;
    expect(
      await standalone.root.commit(
        (tx) => readStatus(withoutHistory(tx), standalone.root.id),
        context,
      ),
    ).toEqual(expected);
    expect(
      await standalone.root.commit(
        (tx) => readRounds(tx, standalone.root.id),
        context,
      ),
    ).toEqual([]);
    expect(report.status.acceptedNoteId).toBeNull();
    expect(report.status.failures.items).toHaveLength(1);
    expect(report.work[1]!.retryOf).toBe(report.work[0]!.id);
    expect(report.notes).toEqual([]);
  } finally {
    await standalone.close();
  }
  expect(attempts).toBe(2);
  const before = await inspect(standalonePath, readReport);
  expect((await cli("run", standalonePath)).code).toBe(0);
  const after = await inspect(standalonePath, readReport);
  expect(after.work).toEqual(before.work);
  expect(after.result).toEqual(pass);
  expect((await cli("export", standalonePath)).stderr).toContain(
    "No accepted argument",
  );
}, 30_000);

test("standalone completion waits for owned children and still permits cancellation", async () => {
  const pass = {
    verdict: "PASS",
    report: "Checked.",
    kind: "external-report",
    operationId: "fixture",
    reportedAt: "2026-10-13",
    premises: [],
    passages: [],
  };
  const directory = await temporaryDirectory("xean-apps-");
  const completing = Promise.withResolvers<void>();
  let aborted = false;
  const Child = defineTask<null, { phase: "run" }, null>({
    name: "test.standalone-child",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(_task, _runtime, ctx) {
        await awaitWithContext(new Promise<never>(() => {}), ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      aborted = true;
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "test.standalone-child", tasks: [Child] }),
  );
  const owner = await open(join(directory, "standalone.sqlite"), {
    create: { ...definition, mode: { role: "review", input: {} } },
    registry,
    roles: () => ({
      review: async (_input, runtime, ctx) => {
        await runtime.commit(async (tx) => {
          await tx.createTask(Child, null, {
            ownership: { kind: "task", taskId: runtime.taskId },
          });
        }, ctx);
        return pass;
      },
    }),
  });
  owner.harness.subscribeCommits(({ changes }) => {
    if (
      changes.some(
        (change) =>
          change.type === "task" &&
          change.value.kind === "research.worker" &&
          change.value.state.status === "completing",
      )
    )
      completing.resolve();
  });
  try {
    owner.harness.resume();
    await completing.promise;
    const pending = await reportOf(owner);
    expect(pending.status.status).toBe("running");
    expect(pending.status.work.active).toBe(1);
    expect(pending.result).toBeUndefined();
    await controlCommand(owner, { kind: "cancel" });
    expect(aborted).toBe(true);
    expect(
      await owner.root.commit(
        async (tx) => (await tx.doc(Control, owner.root.id)).cancelled,
        context,
      ),
    ).toBe(true);
    expect((await reportOf(owner)).result).toEqual(pass);
  } finally {
    await owner.close();
  }
});

test("native usage distinguishes absent placeholders and explicit zero, deduplicates forks, and bounds groups", async () => {
  const directory = await temporaryDirectory("xean-apps-");
  const owner = await open(join(directory, "campaign.sqlite"), {
    create: definition,
    initialize: () => {},
  });
  try {
    const forkAt = await owner.root.commit(async (tx) => {
      let forkAt;
      for (const [model, usageReported, input] of [
        ["explicit-zero", true, 0],
        ["placeholder", undefined, 0],
        ["explicit-absent", false, 7],
        ["inferred", undefined, 7],
      ] as const) {
        const message = {
          ...structuredClone(fauxAssistantMessage("answer")),
          model,
          usageReported,
        };
        message.usage.input = input;
        const entry = await tx.appendEntry(AssistantEntry, owner.root.id, {
          model: [message],
        });
        if (model === "inferred") forkAt = entry.id;
      }
      for (const [operationId, usage] of [
        ["unknown", null],
        ["zero", { input_tokens: 0 }],
        ["interrupted", undefined],
      ] as const) {
        await tx.appendEntry(ExternalRequest, owner.root.id, {
          data: {
            operationId,
            provider: "codex-cli",
            api: "codex-exec",
            model: "codex",
            workspace: "/fixture",
            reasoning: "max",
            profile: null,
            usageTag: null,
          },
        });
        if (usage !== undefined)
          for (const recorded of [{ input_tokens: 999 }, usage])
            await tx.appendEntry(ExternalLog, owner.root.id, {
              data: {
                operationId,
                stdout: "",
                stderr: "",
                exitCode: 0,
                usage: recorded,
              },
            });
      }
      return forkAt!;
    }, context);
    const forkEntry = await owner.root.commit(async (tx) => {
      const fork = await tx.forkConversation(owner.root.id, forkAt, {
        ownership: { kind: "ownerless" },
      });
      const message = structuredClone(fauxAssistantMessage("fork answer"));
      message.model = "inferred";
      message.usage.input = 11;
      return tx.appendEntry(AssistantEntry, fork.id, { model: [message] });
    }, context);
    const usage = await owner.root.commit((tx) => readUsage(tx, true), context);
    expect(usage.calls).toMatchObject({
      recordedResponses: 5,
      externalInvocations: 3,
      unknownUsage: 4,
      byModel: { omitted: 0 },
    });
    const groups = new Map(
      usage.calls.byModel.items.map((group) => [group.model, group]),
    );
    expect(groups.get("explicit-zero")!.reportedUsage.input).toBe(0);
    expect(groups.get("placeholder")!.reportedUsage).toEqual({});
    expect(groups.get("explicit-absent")!.reportedUsage).toEqual({});
    expect(groups.get("inferred")!.responses).toBe(2);
    expect(groups.get("inferred")!.reportedUsage.input).toBe(18);
    expect(groups.get("codex")!.reportedUsage.input_tokens).toBe(0);
    expect(new Set(usage.records!.map((entry) => entry.id)).size).toBe(
      usage.records!.length,
    );
    expect(usage.records!.filter((entry) => entry.id === forkAt)).toHaveLength(
      1,
    );
    expect(usage.records!.find((entry) => entry.id === forkEntry.id)).toEqual(
      forkEntry,
    );
    await owner.root.commit(async (tx) => {
      for (let index = 4; index < 10; index++)
        await tx.appendEntry(AssistantEntry, owner.root.id, {
          model: [
            { ...fauxAssistantMessage("answer"), model: `model-${index}` },
          ],
        });
    }, context);
    const bounded = await owner.root.commit((tx) => readUsage(tx), context);
    expect(bounded.calls.byModel.items).toHaveLength(10);
    expect(bounded.calls).toMatchObject({
      recordedResponses: 11,
      externalInvocations: 3,
      unknownUsage: 10,
      byModel: { omitted: 1 },
    });
  } finally {
    await owner.close();
  }
});

test("live owner controls admit revision-checked submissions and reject foreign ownership", async () => {
  const directory = await temporaryDirectory("xean-apps-");
  const path = join(directory, "campaign.sqlite");
  const owner = await open(path, {
    create: definition,
    initialize: () => {},
  });
  const canonical = await realpath(path);
  const server = await serveControl(
    canonical,
    (value) => controlCommand(owner, value),
    "active",
  );
  try {
    const wrong = await fetch("http://xean/command", {
      unix: socketPath(canonical),
      method: "POST",
      body: JSON.stringify({ kind: "pause", expectedOwnerId: "previous" }),
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({
      error: { code: "owner_changed", message: "Campaign owner changed" },
    });
    const receipt = await requestOwner(
      canonical,
      { kind: "guide", id: "live", text: "Keep exact hypotheses." },
      "active",
    );
    expect(receipt).toMatchObject({ command: { id: "live" } });
    expect((await inspect(path, readReport)).inputs).toHaveLength(1);
    const file = join(directory, "submission.json");
    const notes = [
      { ...draft, id: "input/seed/n1", trusted: true },
      { ...draft, id: "input/seed/n2", trusted: false },
      { ...draft, id: "input/seed/n3" },
    ];
    await Bun.write(file, JSON.stringify({ notes }));
    expect((await cli("submit", path, file, "--id", "seed")).code).toBe(0);
    expect(
      (await inspect(path, readReport)).notes.map(
        (note) => !!note.checks.external,
      ),
    ).toEqual([true, false, true]);
    await Bun.write(
      file,
      JSON.stringify({
        notes: [
          { ...notes[0], id: "input/forced/n1" },
          { ...notes[2], id: "input/forced/n3" },
        ],
      }),
    );
    for (let attempt = 0; attempt < 2; attempt++)
      expect(
        (await cli("submit", path, file, "--id", "forced", "--untrusted")).code,
      ).toBe(0);
    expect(
      (await cli("submit", path, file, "--id", "forced")).stderr,
    ).toContain("Input ID already has another value");
    const preserved = (await inspect(path, readReport)).notes.slice(1);
    expect(preserved.map((n) => !!n.checks.external)).toEqual([
      false,
      true,
      false,
      false,
    ]);
    const original = (await inspect(path, readReport)).notes[0]!;
    expect(original.candidate).toBe(false);
    const submission = {
      notes: [],
      edits: [
        {
          id: original.id,
          revision: original.revision,
          text: "1 = 1\n\nEquality is reflexive.",
        },
      ],
    };
    await Bun.write(file, JSON.stringify(submission));
    const editedReceipt = await cli(
      "submit",
      path,
      file,
      "--id",
      "edit",
      "--untrusted",
    );
    expect(editedReceipt.code).toBe(0);
    expect(JSON.parse(editedReceipt.stdout)).toMatchObject({
      command: { id: "edit" },
    });
    const edited = (await inspect(path, readReport)).notes[0]!;
    expect(edited).toMatchObject({
      id: original.id,
      summary: original.summary,
      detailedSummary: original.detailedSummary,
      text: submission.edits[0]!.text,
      checks: {},
    });
    expect(edited.revision).toBeGreaterThan(original.revision);
    expect(
      (await cli("submit", path, file, "--id", "edit", "--untrusted")).code,
    ).toBe(0);
    const stale = await cli("submit", path, file, "--id", "stale");
    expect(stale.code).not.toBe(0);
    expect(stale.stderr).toContain("Stale note revision");
    expect((await inspect(path, readReport)).notes).toEqual([
      edited,
      ...preserved,
    ]);
    const recheck = {
      notes: [{ id: edited.id, revision: edited.revision }],
      reason: "Withdraw an unsupported verification assessment.",
    };
    await Bun.write(file, JSON.stringify(recheck));
    const recheckedReceipt = await cli(
      "--expected-owner-id",
      "active",
      "recheck",
      path,
      file,
      "--id",
      "audit",
    );
    expect(recheckedReceipt.code).toBe(0);
    expect(JSON.parse(recheckedReceipt.stdout)).toMatchObject({
      command: { kind: "recheck", id: "audit", ...recheck },
    });
    const rechecked = (await inspect(path, readReport)).notes[0]!;
    expect(rechecked).toMatchObject({
      ...edited,
      revision: rechecked.revision,
    });
    expect(rechecked.revision).toBeGreaterThan(edited.revision);
    expect((await cli("recheck", path, file, "--id", "audit")).stdout).toBe(
      recheckedReceipt.stdout,
    );
    const obsolete = await cli("correct", path, file, "--id", "obsolete");
    expect(obsolete.code).not.toBe(0);
    expect(obsolete.stderr).toContain("unknown command 'correct'");
    expect(
      (await cli("--usage-prefix", "new-owner", "pause", path)).stderr,
    ).toContain("already has an owner");
    for (const flag of ["--usage-prefix", "--owner-id"])
      expect(
        (await cli("--expected-owner-id", "previous", flag, "", "resume", path))
          .stderr,
      ).toContain("Execution overrides require local ownership");
    expect((await reportOf(owner)).status.status).toBe("running");
    await requestOwner(canonical, { kind: "cancel" }, "active");
    expect((await reportOf(owner)).status.status).toBe("cancelled");
    await Bun.write(
      file,
      JSON.stringify({
        ...recheck,
        notes: [{ id: rechecked.id, revision: rechecked.revision }],
      }),
    );
    expect(
      (await cli("recheck", path, file, "--id", "after-cancel")).stderr,
    ).toContain("terminal");
    expect((await inspect(path, readReport)).notes).toEqual([
      rechecked,
      ...preserved,
    ]);
    for (const body of [
      "{",
      JSON.stringify({ kind: "resume", expectedOwnerId: "active" }),
    ]) {
      const rejected = await fetch("http://xean/command", {
        unix: socketPath(canonical),
        method: "POST",
        body,
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({
        error: { code: "command_rejected" },
      });
    }
  } finally {
    await server.close(true);
    await owner.close();
  }
  const reopened = await open(path);
  try {
    expect(
      (await reportOf(reopened)).notes.map((note) => !!note.checks.external),
    ).toEqual([false, false, true, false, false]);
  } finally {
    await reopened.close();
  }
}, 30_000);

test("closed-book executable rejects retrieval and reopens without calls", async () => {
  const directory = await temporaryDirectory("xean-apps-");
  const profiles = { default: { provider: "openai", model: "unavailable" } };
  const configured = { profiles };
  const file = join(directory, "settings.json");
  const database = join(directory, "campaign.sqlite");
  await Bun.write(join(directory, "task.json"), JSON.stringify(task));
  const run = () =>
    command(
      "scripts/bounded-solve.ts",
      directory,
      "--offline",
      "--round-limit",
      "0",
    );
  for (const [override, error] of [
    [{ literature: true }, "Closed-book runs cannot enable literature"],
  ] as const) {
    await Bun.write(file, JSON.stringify({ ...configured, ...override }));
    const rejected = await run();
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain(error);
    expect(await Bun.file(database).exists()).toBe(false);
  }
  await Bun.write(file, JSON.stringify(configured));
  for (const outcome of ["round_limit", "paused"]) {
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      outcome,
      status: "paused",
      rounds: 0,
    });
    expect((await inspect(database, readReport)).status.calls).toMatchObject({
      recordedResponses: 0,
      externalInvocations: 0,
      unknownUsage: 0,
    });
    expect((await inspect(database, readDefinition)).settings).toEqual(
      configured,
    );
  }
});

test("round allowance counts workers, excludes empty waits, and resumes only extra rounds", async () => {
  const directory = await temporaryDirectory("xean-apps-");
  let calls = 0;
  const role = async (input: unknown) => {
    calls++;
    expect(JSON.stringify(input)).not.toMatch(/roundLimit|remainingRounds/);
    return {
      work:
        calls === 1
          ? null
          : { kind: "explorer" as const, assignment: "Next worker." },
    };
  };
  const roles = {
    coordinator: limitRounds(role, 1),
    explorer: async () => ({ kind: "notes", notes: [] }),
  };
  const path = join(directory, "campaign.sqlite");
  let owner = await open(path, { create: definition, roles: () => roles });
  try {
    await owner.root.waitForIdle(context);
    expect(
      await owner.root.commit((tx) => readRounds(tx, owner.root.id), context),
    ).toEqual([]);
    expect(calls).toBe(1);
    await controlCommand(owner, { kind: "resume" });
    expect(
      await owner.root.commit((tx) => readRounds(tx, owner.root.id), context),
    ).toHaveLength(1);
    expect((await reportOf(owner)).work).toHaveLength(1);
    expect(calls).toBe(2);
    await controlCommand(owner, { kind: "pause" });
    await owner.close();
    const resumed = { ...roles, coordinator: limitRounds(role, 3) };
    owner = await open(path, { roles: () => resumed });
    await controlCommand(owner, { kind: "resume" });
    const admitted = await owner.root.commit(
      (tx) => readRounds(tx, owner.root.id),
      context,
    );
    expect(admitted).toHaveLength(3);
    expect((await reportOf(owner)).work).toHaveLength(3);
    expect(calls).toBe(4);
    await owner.close();
    const reduced = { coordinator: limitRounds(role, 2) };
    owner = await open(path, { roles: () => reduced });
    expect(await controlCommand(owner, { kind: "resume" })).toMatchObject({
      status: "blocked",
      error: "Experiment exceeded its round limit",
    });
    expect(calls).toBe(4);
    expect(
      await owner.root.commit((tx) => readRounds(tx, owner.root.id), context),
    ).toEqual(admitted);
  } finally {
    await owner.close();
  }
});

test.each(["rejected", "paused", "cancelled"] as const)(
  "rounds exclude %s plans before worker admission",
  async (outcome) => {
    const directory = await temporaryDirectory("xean-discarded-plan-");
    let decisions = 0;
    const roles: Pick<Roles, "coordinator" | "explorer"> = {
      coordinator: limitRounds(async (_input, runtime, invocation) => {
        if (outcome !== "rejected" && decisions++ === 0)
          await runtime.commit(async (tx) => {
            (await tx.doc(Control, runtime.conversationId))[outcome] = true;
          }, invocation);
        return {
          work: {
            kind: "explorer",
            assignment: outcome === "rejected" ? "" : "Explore.",
          },
        };
      }, 1),
      explorer: async () => ({ kind: "notes", notes: [] }),
    };
    const stopped = await open(join(directory, `${outcome}.sqlite`), {
      create: definition,
      roles: () => roles,
    });
    try {
      await stopped.root.waitForIdle(context);
      expect(
        await stopped.root.commit(
          (tx) => readRounds(tx, stopped.root.id),
          context,
        ),
      ).toEqual([]);
      expect(await reportOf(stopped)).toMatchObject({
        status: { status: outcome === "rejected" ? "blocked" : outcome },
        work: [],
      });
      if (outcome === "paused") {
        expect((await reportOf(stopped)).status.pendingDecisions).toBe(0);
        await controlCommand(stopped, { kind: "resume" });
        expect((await reportOf(stopped)).work).toHaveLength(1);
      }
    } finally {
      await stopped.close();
    }
  },
);

test("interrupted decisions count a round only after recovered worker admission", async () => {
  const directory = await temporaryDirectory("xean-round-recovery-");
  const entered = Promise.withResolvers<{
    taskId: TaskId;
    cutoff: EntryId;
  }>();
  const pending = Promise.withResolvers<void>();
  const first: Pick<Roles, "coordinator"> = {
    coordinator: limitRounds(async (_input, runtime, invocation, source) => {
      entered.resolve({ taskId: runtime.taskId, cutoff: source!.cutoff });
      await awaitWithContext(pending.promise, invocation);
      return { work: null };
    }, 1),
  };
  const path = join(directory, "campaign.sqlite");
  let owner = await open(path, { create: definition, roles: () => first });
  try {
    owner.harness.resume();
    const original = await entered.promise;
    expect(
      await owner.root.commit((tx) => readRounds(tx, owner.root.id), context),
    ).toEqual([]);
    await owner.close();
    const recovered: TaskId[] = [];
    const next: Pick<Roles, "coordinator" | "explorer"> = {
      coordinator: limitRounds(async (_input, runtime) => {
        recovered.push(runtime.taskId);
        return { work: { kind: "explorer", assignment: "Explore." } };
      }, 1),
      explorer: async () => ({ kind: "notes", notes: [] }),
    };
    owner = await open(path, { roles: () => next });
    await owner.root.waitForIdle(context);
    expect(recovered).toEqual([original.taskId]);
    const admitted = await owner.root.commit(
      (tx) => readRounds(tx, owner.root.id),
      context,
    );
    expect(admitted).toEqual([original.cutoff]);
    expect((await reportOf(owner)).work).toHaveLength(1);
    await controlCommand(owner, { kind: "resume" });
    expect(recovered).toEqual([original.taskId]);
    expect(
      await owner.root.commit((tx) => readRounds(tx, owner.root.id), context),
    ).toEqual(admitted);
  } finally {
    pending.resolve();
    await owner.close();
  }
});
