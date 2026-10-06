import { expect, test } from "bun:test";
import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
} from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { defaultSettings } from "../src/config.ts";
import { inspect, open } from "../src/host.ts";
import { readDefinition, type Definition } from "../src/definition.ts";
import { Control, type Roles } from "../src/workflow.ts";
import { readReport, readUsage } from "../src/report.ts";
import { CodexLog, CodexRequest } from "../src/roles/codex.ts";
import { controlCommand, observeOwner } from "../apps/cli/lifecycle.ts";
import { requestOwner, serveControl, socketPath } from "../apps/cli/control.ts";
import { api, readSources } from "../apps/observe/server.ts";
import { readRun } from "../apps/observe/read.ts";
import { noteStatus } from "../apps/observe/web/notes.ts";
import { limitRounds, readRounds } from "../scripts/bounded-solve.ts";

const task = {
  problem: "Prove 1 = 1.",
  completionCriteria: "A self-contained proof.",
};
const settings = { ...defaultSettings, research: false as const };
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

async function temporary(action: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "xean-apps-"));
  try {
    await action(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function command(file: string, ...args: string[]) {
  const result =
    await $`${process.execPath} --no-install --no-env-file ${join(root, file)} ${args} < /dev/null`
      .quiet()
      .nothrow();
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
const cli = (...args: string[]) => command("apps/cli/index.ts", ...args);

test(
  "CLI offline inputs are durable, idempotent after cancellation, and do not start providers",
  () =>
    temporary(async (directory) => {
      const taskFile = join(directory, "task.json"),
        settingsFile = join(directory, "settings.json"),
        input = join(directory, "input.json");
      await Bun.write(taskFile, JSON.stringify(task));
      await Bun.write(settingsFile, JSON.stringify(settings));
      await Bun.write(
        input,
        JSON.stringify({ notes: [draft], candidate: true }),
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
        (await cli(...prefix, "submit", "named", input, "--id", "import"))
          .stdout,
      ).toBe(imported.stdout);
      const inspected = await cli(...prefix, "inspect", "named", "--records");
      expect(inspected.stderr).toBe("");
      expect(inspected.code).toBe(0);
      const full = JSON.parse(inspected.stdout);
      expect(full.notes[0]).toMatchObject({
        id: "input/import/n1",
        imported: true,
      });
      expect(full.work).toEqual([]);
      expect(full.status.calls.recordedResponses).toBe(0);
      const compact = JSON.parse(
        (await cli(...prefix, "status", "named")).stdout,
      );
      expect(compact.pendingDecisions).toBe(2);
      expect(JSON.stringify(compact)).not.toContain(draft.text);
      expect((await cli(...prefix, "export", "named")).code).not.toBe(0);
      expect((await cli(...prefix, "cancel", "named")).code).toBe(0);
      expect(
        (await cli(...prefix, "submit", "named", input, "--id", "import"))
          .stdout,
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
      expect(noRecords.status.calls).toEqual(compact.calls);
      expect(noRecords).not.toHaveProperty("records");
    }),
  30_000,
);

test(
  "sealed acceptance, native note IDs, and latest standalone results reach reports and CLI export",
  () =>
    temporary(async (directory) => {
      const path = join(directory, "campaign.sqlite");
      const owner = await open(path, {
        create: definition,
        roles: () => ({
          coordinator: async (input) => ({
            work: input.notes.length
              ? {
                  kind: "verifier",
                  notes: [input.notes[0].id],
                  through: "reconstruction",
                }
              : { kind: "explorer", guidance: "Prove equality." },
          }),
          explorer: async () => ({
            kind: "notes",
            notes: [draft],
            candidate: true,
          }),
          verifier: async (input) => ({
            kind: "verification",
            checks: [
              {
                noteId: input.targets[0].id,
                correctness: { ...pass, statement: "1 = 1", premises: [] },
                source: pass,
                requirements: pass,
                reconstruction: {
                  ...pass,
                  proof: "Reflexivity.",
                },
              },
            ],
          }),
        }),
      });
      try {
        await owner.root.waitForIdle(context);
        const report = await observeOwner(owner);
        expect(report.status.status).toBe("completed");
        expect(report.status.acceptedNoteId).toMatch(/^\d+\/n1$/);
        expect(report.work[0]!.noteIds).toEqual([
          report.status.acceptedNoteId!,
        ]);
        const unsealed = await owner.root.commit(async (tx) => {
          (await tx.doc(Control, owner.root.id)).accepted = null;
          return readReport(tx, owner.root.id);
        }, context);
        expect(unsealed.notes[0]!.accepted).toBe(true);
        expect(unsealed.status.status).toBe("running");
        expect(unsealed.status.acceptedNoteId).toBeNull();
        expect(
          noteStatus(unsealed.notes[0]!, unsealed.status.acceptedNoteId),
        ).toBe("Candidate");
        expect(noteStatus(report.notes[0]!, report.status.acceptedNoteId)).toBe(
          "Accepted",
        );
        await owner.root.commit(async (tx) => {
          (await tx.doc(Control, owner.root.id)).accepted =
            report.status.acceptedNoteId;
        }, context);
      } finally {
        await owner.close();
      }
      const exported = await cli("export", path);
      expect(exported.stderr).toBe("");
      expect(exported.code).toBe(0);
      expect(exported.stdout).toContain(draft.text);
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
        await standalone.root.waitForIdle(context);
        expect((await observeOwner(standalone)).status.status).toBe("blocked");
        await controlCommand(standalone, { kind: "resume" });
        const report = await observeOwner(standalone);
        expect(report.status.status).toBe("completed");
        expect(report.kind).toBe("review");
        expect(report.result).toEqual(pass);
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
      expect((await cli("run", standalonePath)).code).toBe(0);
      expect(attempts).toBe(2);
    }),
  30_000,
);

test("standalone completion waits for owned children and still permits cancellation", () =>
  temporary(async (directory) => {
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
      const pending = await observeOwner(owner);
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
      expect((await observeOwner(owner)).result).toEqual(pass);
    } finally {
      await owner.close();
    }
  }));

test("native usage distinguishes absent placeholders and explicit zero, deduplicates forks, and bounds groups", () =>
  temporary(async (directory) => {
    const owner = await open(join(directory, "campaign.sqlite"), {
      create: definition,
      initialize: () => {},
    });
    try {
      const forkAt = await owner.root.commit(async (tx) => {
        let forkAt;
        for (let index = 0; index < 4; index++) {
          const message = {
            ...structuredClone(fauxAssistantMessage("answer")),
            model: `model-${index}`,
            ...(index === 0
              ? { usageReported: true }
              : index === 2
                ? { usageReported: false }
                : {}),
          };
          if (index >= 2) message.usage.input = 7;
          const entry = await tx.appendEntry(AssistantEntry, owner.root.id, {
            model: [message],
          });
          if (index === 0) forkAt = entry.id;
        }
        for (const usage of [null, { input_tokens: 0 }]) {
          const operationId = usage === null ? "unknown" : "zero";
          await tx.appendEntry(CodexRequest, owner.root.id, {
            data: {
              operationId,
              model: "codex",
              workspace: "/fixture",
              reasoning: "max",
              profile: null,
              usageTag: null,
            },
          });
          for (const recorded of [{ input_tokens: 999 }, usage])
            await tx.appendEntry(CodexLog, owner.root.id, {
              data: {
                operationId,
                stdout: "",
                stderr: "",
                exitCode: 0,
                usage: recorded,
              },
            });
        }
        await tx.appendEntry(CodexRequest, owner.root.id, {
          data: {
            operationId: "interrupted",
            model: "codex",
            workspace: "/fixture",
            reasoning: "max",
            profile: null,
            usageTag: null,
          },
        });
        return forkAt!;
      }, context);
      await owner.root.commit(
        (tx) =>
          tx.forkConversation(owner.root.id, forkAt, {
            ownership: { kind: "ownerless" },
          }),
        context,
      );
      const usage = await owner.root.commit(
        (tx) => readUsage(tx, true),
        context,
      );
      expect(usage.calls).toMatchObject({
        recordedResponses: 4,
        codexInvocations: 3,
        unknownUsage: 4,
        byModel: { omitted: 0 },
      });
      const groups = new Map(
        usage.calls.byModel.items.map((group) => [group.model, group]),
      );
      expect(groups.get("model-0")!.reportedUsage.input).toBe(0);
      expect(groups.get("model-1")!.reportedUsage).toEqual({});
      expect(groups.get("model-2")!.reportedUsage).toEqual({});
      expect(groups.get("model-3")!.reportedUsage.input).toBe(7);
      expect(groups.get("codex")!.reportedUsage.input_tokens).toBe(0);
      expect(new Set(usage.records!.map((entry) => entry.id)).size).toBe(
        usage.records!.length,
      );
      await owner.root.commit(async (tx) => {
        for (let index = 4; index < 12; index++)
          await tx.appendEntry(AssistantEntry, owner.root.id, {
            model: [
              { ...fauxAssistantMessage("answer"), model: `model-${index}` },
            ],
          });
      }, context);
      const bounded = await owner.root.commit((tx) => readUsage(tx), context);
      expect(bounded.calls.byModel.items).toHaveLength(10);
      expect(bounded.calls).toMatchObject({
        recordedResponses: 12,
        codexInvocations: 3,
        unknownUsage: 12,
        byModel: { omitted: 3 },
      });
    } finally {
      await owner.close();
    }
  }));

test(
  "live owner controls reject foreign identity and execution overrides without a second writer",
  () =>
    temporary(async (directory) => {
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
        expect(
          (await cli("--usage-prefix", "new-owner", "pause", path)).stderr,
        ).toContain("already has an owner");
        expect((await observeOwner(owner)).status.status).toBe("running");
        await requestOwner(canonical, { kind: "cancel" }, "active");
        expect((await observeOwner(owner)).status.status).toBe("cancelled");
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
    }),
  30_000,
);

test("observer reads arbitrary native databases without ownership and retains only matching stale evidence", () =>
  temporary(async (directory) => {
    const idle = join(directory, "idle.sqlite");
    await (await open(idle, { create: definition })).close();
    const dormant = await readRun({ id: "idle", database: idle }, true);
    expect(dormant.error).toBeUndefined();
    expect(dormant.summary?.status.status).toBe("running");
    const database = join(directory, "review.sqlite");
    const owner = await open(database, {
      create: {
        ...definition,
        mode: { role: "review", input: { argument: "Exact proof." } },
      },
      roles: () => ({ review: async () => pass }),
    });
    let sources = readSources(
      [{ id: "review", database: "review.sqlite" }],
      directory,
    );
    expect(sources).toEqual([{ id: "review", database }]);
    expect(() =>
      readSources([{ id: "review", directory }], directory),
    ).toThrow();
    const handle = api(async () => sources);
    const request = (path: string) =>
      handle(new Request(`http://localhost${path}`));
    try {
      await owner.root.waitForIdle(context);
      const report = await observeOwner(owner);
      const full = await (await request("/api/runs/review")).json();
      expect(full.snapshot).toMatchObject({
        kind: "review",
        task,
        result: pass,
      });
      expect(full.error).toBeUndefined();
      expect(await observeOwner(owner)).toEqual(report);
      const initial = await (
        await request("/api/runs/review?view=status")
      ).json();
      expect(initial.snapshot.status.status).toBe("completed");
      expect(initial.snapshot).not.toHaveProperty("notes");
      expect(initial.snapshot).not.toHaveProperty("result");
      await owner.close();
      await rm(database);
      const stale = await (
        await request("/api/runs/review?view=status")
      ).json();
      expect(stale).toMatchObject({
        stale: true,
        observedAt: initial.observedAt,
      });
      expect(stale.snapshot).toEqual(initial.snapshot);
      expect(stale.error).toBeTruthy();
      const detail = await (await request("/api/runs/review")).json();
      expect(detail.snapshot).toBeUndefined();
      expect(detail.error).toBeTruthy();
      sources = readSources(
        [{ id: "review", database: "other.sqlite" }],
        directory,
      );
      const changed = await (
        await request("/api/runs/review?view=status")
      ).json();
      expect(changed.snapshot).toBeUndefined();
      expect(changed.stale).toBe(false);
      sources = [];
      expect((await request("/api/runs/review")).status).toBe(404);
      expect(
        (await handle(new Request("http://foreign/api/runs"))).status,
      ).toBe(403);
      expect(
        (
          await handle(
            new Request("http://localhost/api/runs", {
              headers: { origin: "http://foreign" },
            }),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await handle(
            new Request("http://localhost/api/runs", {
              method: "POST",
            }),
          )
        ).status,
      ).toBe(405);
    } finally {
      await owner.close();
    }
  }));

test("closed-book executable rejects retrieval and reopens without calls", () =>
  temporary(async (directory) => {
    const profiles = { default: { provider: "openai", model: "unavailable" } };
    const configured = { profiles, research: { model: "unused" } };
    const browser = {
      baseUrl: "http://127.0.0.1:17841/v1",
      model: "chatgpt-web/gpt-6-pro",
    };
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
      [
        { chatgpt: browser },
        "ChatGPT Web cannot enforce closed-book execution",
      ],
      [
        { codex: { model: "unused", workspace: directory } },
        "Codex implementation cannot enforce closed-book execution",
      ],
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
        calls: { recordedResponses: 0, codexInvocations: 0, unknownUsage: 0 },
      });
      expect((await inspect(database, readDefinition)).settings.research).toBe(
        false,
      );
    }
  }));

test("round allowance counts workers, excludes empty waits, and resumes only extra rounds", () =>
  temporary(async (directory) => {
    let calls = 0;
    const role = async (input: unknown) => {
      calls++;
      expect(JSON.stringify(input)).not.toMatch(/roundLimit|remainingRounds/);
      return {
        work:
          calls === 1
            ? null
            : { kind: "explorer" as const, guidance: "Next worker." },
      };
    };
    const roles = {
      coordinator: role,
      explorer: async () => ({ kind: "notes", notes: [], candidate: false }),
    };
    limitRounds(roles, 1);
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
      expect((await observeOwner(owner)).work).toHaveLength(1);
      expect(calls).toBe(2);
      await controlCommand(owner, { kind: "pause" });
      await owner.close();
      const resumed = { ...roles, coordinator: role };
      limitRounds(resumed, 3);
      owner = await open(path, { roles: () => resumed });
      await controlCommand(owner, { kind: "resume" });
      const admitted = await owner.root.commit(
        (tx) => readRounds(tx, owner.root.id),
        context,
      );
      expect(admitted).toHaveLength(3);
      expect((await observeOwner(owner)).work).toHaveLength(3);
      expect(calls).toBe(4);
      await owner.close();
      const reduced = { coordinator: role };
      limitRounds(reduced, 2);
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
  }));

test("rounds exclude discarded plans and count an interrupted decision only after admission", () =>
  temporary(async (directory) => {
    const explorer = async () => ({
      kind: "notes",
      notes: [],
      candidate: false,
    });
    for (const outcome of ["rejected", "paused", "cancelled"] as const) {
      const roles: Pick<Roles, "coordinator" | "explorer"> = {
        coordinator: async (_input, runtime, invocation) => {
          if (outcome !== "rejected")
            await runtime.commit(async (tx) => {
              (await tx.doc(Control, runtime.conversationId))[outcome] = true;
            }, invocation);
          return {
            work: {
              kind: "explorer",
              guidance: outcome === "rejected" ? "" : "Explore.",
            },
          };
        },
        explorer,
      };
      limitRounds(roles, 1);
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
        expect(await observeOwner(stopped)).toMatchObject({
          status: { status: outcome === "rejected" ? "blocked" : outcome },
          work: [],
        });
      } finally {
        await stopped.close();
      }
    }
    const entered = Promise.withResolvers<{
      taskId: TaskId;
      cutoff: EntryId;
    }>();
    const pending = Promise.withResolvers<void>();
    const first: Pick<Roles, "coordinator"> = {
      coordinator: async (_input, runtime, invocation, source) => {
        entered.resolve({ taskId: runtime.taskId, cutoff: source!.cutoff });
        await awaitWithContext(pending.promise, invocation);
        return { work: null };
      },
    };
    limitRounds(first, 1);
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
        coordinator: async (_input, runtime) => {
          recovered.push(runtime.taskId);
          return { work: { kind: "explorer", guidance: "Explore." } };
        },
        explorer,
      };
      limitRounds(next, 1);
      owner = await open(path, { roles: () => next });
      await owner.root.waitForIdle(context);
      expect(recovered).toEqual([original.taskId]);
      const admitted = await owner.root.commit(
        (tx) => readRounds(tx, owner.root.id),
        context,
      );
      expect(admitted).toEqual([original.cutoff]);
      expect((await observeOwner(owner)).work).toHaveLength(1);
      await controlCommand(owner, { kind: "resume" });
      expect(recovered).toEqual([original.taskId]);
      expect(
        await owner.root.commit((tx) => readRounds(tx, owner.root.id), context),
      ).toEqual(admitted);
    } finally {
      pending.resolve();
      await owner.close();
    }
  }));

test(
  "prompt preparation freezes inputs and source identity without leaking expected answers",
  () =>
    temporary(async (directory) => {
      const file = join(directory, "settings.json"),
        output = join(directory, "output");
      const settingsText = JSON.stringify(settings);
      await Bun.write(file, settingsText);
      const prepared = await command("scripts/prompt-eval.ts", file, output);
      expect(prepared.code).toBe(0);
      expect(JSON.parse(prepared.stdout)).toMatchObject({
        executed: false,
        cases: 3,
      });
      const manifest = await Bun.file(join(output, "manifest.json")).json();
      expect(manifest.settingsSha256).toBe(
        createHash("sha256").update(settingsText).digest("hex"),
      );
      expect(manifest.source["src/roles/index.ts"]).toMatch(/^[a-f0-9]{64}$/);
      expect(manifest.source["scripts/dependencies.ts"]).toMatch(
        /^[a-f0-9]{64}$/,
      );
      const cases = await Bun.file(join(output, "cases.json")).json();
      for (const example of cases) {
        const input = await Bun.file(
          join(output, example.id, "input.json"),
        ).json();
        expect(input.notes[0]).toMatchObject({
          text: `${example.statement}\n\n${example.argument}`,
        });
        expect(JSON.stringify(input)).not.toContain(example.expected.reason);
        expect(input).not.toHaveProperty("expected");
        expect(
          await Bun.file(join(output, example.id, "campaign.sqlite")).exists(),
        ).toBe(false);
        expect(
          manifest.commands
            .find((row: { id: string }) => row.id === example.id)
            .argv.slice(4, 6),
        ).toEqual(["role", "verifier"]);
      }
      const frozen = await readFile(join(output, "manifest.json"));
      expect(
        (await command("scripts/prompt-eval.ts", file, output)).code,
      ).not.toBe(0);
      expect(await readFile(join(output, "manifest.json"))).toEqual(frozen);
    }),
  30_000,
);
