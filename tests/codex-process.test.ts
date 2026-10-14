import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect, open, readReport, type OpenOptions } from "../src/index.ts";
import { RoleFailure } from "../src/core/roles.ts";
import { ExternalLog, ExternalRequest } from "../src/roles/backend.ts";
import { codex, codexTranscript } from "../src/plugins/role-backends/codex.ts";
import { context, noteResult, settings, task } from "./fixture.ts";

// Every fixture is an actual child process, including signal and overflow cases.
async function codexFixture(
  source: string,
  mode: "research" | "worker" = "research",
  roles?: OpenOptions["roles"],
) {
  const directory = await temporaryDirectory("codex-process-");
  const command = join(directory, "codex-fixture");
  await writeFile(command, `#!${process.execPath}\n${source}\n`);
  await chmod(command, 0o700);
  const path = join(directory, "campaign.sqlite");
  const owner = await open(path, {
    roles: (builtins) => {
      Object.assign(
        builtins,
        codex(
          mode === "worker"
            ? {
                implementation: {
                  model: "fixture",
                  command,
                  workspace: directory,
                },
              }
            : { research: { model: "fixture", command } },
        )(builtins),
      );
      return { ...builtins, ...roles?.(builtins) };
    },
    create: {
      task,
      settings,
      mode:
        mode === "worker"
          ? {
              role: "implementation",
              input: { assignment: "Fixture only", notes: [] },
            }
          : { role: "review", input: { argument: "Fixture only" } },
    },
  });
  return { directory, path, owner };
}

const reportOf = (owner: Awaited<ReturnType<typeof open>>) =>
  owner.root.commit(
    (tx) => readReport(tx, owner.root.id, { records: true }),
    context,
  );
const review = {
  verdict: "PASS",
  report: "Checked",
  premises: [],
  passages: [],
};
const completed = { type: "turn.completed", usage: { output_tokens: 7 } };
const jsonl = (events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

test("Codex reuses a completed request without leaking caller edits or conflating assignments", async () => {
  const output = [
    {
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(noteResult) },
    },
    completed,
  ];
  const { owner } = await codexFixture(
    `const request = JSON.parse(await Bun.stdin.text());
const output = ${JSON.stringify(output)};
const result = JSON.parse(output[0].item.text);
result.notes[0].id = request.noteIdPrefix + "reflexivity";
output[0].item.text = JSON.stringify(result);
process.stdout.write(output.map(event => JSON.stringify(event)).join("\\n") + "\\n");`,
    "worker",
    (builtins) => ({
      async implementation(input, runtime, context) {
        const first = await builtins.implementation(input, runtime, context);
        if (first.kind !== "notes")
          throw new Error("Expected implementation notes");
        const expected = structuredClone(first);
        first.notes[0]!.text = "Caller changed its copy";
        expect(await builtins.implementation(input, runtime, context)).toEqual(
          expected,
        );
        const changed = await builtins.implementation(
          { ...input, assignment: "Different assignment" },
          runtime,
          context,
        );
        if (changed.kind !== "notes")
          throw new Error("Expected implementation notes");
        expect(changed.notes[0]!.text).not.toBe(expected.notes[0]!.text);
        return changed;
      },
    }),
  );
  try {
    await owner.root.waitForIdle(context);
    const report = await reportOf(owner);
    expect(report.status.status, JSON.stringify(report.work)).toBe("completed");
    expect(report.records!.filter(ExternalLog.is)).toHaveLength(2);
  } finally {
    await owner.close();
  }
});

test.each(["\n", "\r\n"])(
  "Codex JSONL accepts blank lines and %j separators while retaining results and usage",
  (separator) => {
    const value = review;
    const output = [
      "",
      JSON.stringify({ type: "item.completed", item: { type: "web_search" } }),
      JSON.stringify({ type: "error", message: "Reconnecting... 1/5" }),
      " \t",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(value) },
      }),
      "",
      JSON.stringify(completed),
    ].join(separator);
    expect(codexTranscript(output)).toEqual({
      value,
      usage: { output_tokens: 7 },
      searches: 1,
    });
  },
);

test("Codex malformed final JSON retains later accounting and remains a fault", () => {
  const transcript = codexTranscript(
    jsonl([
      {
        type: "item.completed",
        item: { type: "agent_message", text: "malformed" },
      },
      completed,
    ]),
  );
  expect(transcript.usage).toEqual({ output_tokens: 7 });
  expect(transcript.error?.message).toBe("Codex final answer was not JSON");
  expect(transcript.error).not.toBeInstanceOf(RoleFailure);
});

test("Codex parsing leaves an unnamed terminal failure for process diagnostics", () => {
  const transcript = codexTranscript(
    jsonl([{ type: "turn.failed", error: { message: "  " } }]),
  );
  expect(transcript.error).toBeInstanceOf(RoleFailure);
  expect(transcript.error?.message).toBe("");
});

test.each([1, 0, "bare"] as const)(
  "Codex terminal provider errors survive process exit %j with bounded status and raw evidence",
  async (failure) => {
    const exitCode = typeof failure === "number" ? failure : 1;
    const fallback = typeof failure === "string";
    const stderr =
      fallback || exitCode === 0 ? "fixture provider detail on stderr" : "";
    const reason =
      "Selected model is at capacity. Please try a different model." +
      (exitCode === 0 ? " Detail".repeat(700) : "");
    const computation =
      'require("node:fs").writeFileSync("partial-artifact.txt", "unverified draft"); process.stdout.write("partial output\\n");';
    const output = jsonl([
      { type: "error", message: "Reconnecting... 1/5" },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: JSON.stringify([process.execPath, "-e", computation]),
          aggregated_output: "partial output\n",
          exit_code: 0,
        },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "I will check the source." },
      },
      { type: "error", message: reason },
      {
        type: "turn.failed",
        ...(failure === "bare" ? {} : { error: { message: reason } }),
      },
    ]);
    expect(codexTranscript(output).error?.message).toBe(fallback ? "" : reason);
    const { owner, path } = await codexFixture(
      `
import { writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
const computation = spawnSync(process.execPath, ["-e", ${JSON.stringify(computation)}], { encoding: "utf8" });
if (computation.status !== 0 || computation.stdout !== "partial output\\n") throw new Error("Fixture command failed");
writeSync(1, ${JSON.stringify(output)});
writeSync(2, ${JSON.stringify(stderr)});
process.exitCode = ${exitCode};
`,
      "worker",
    );
    try {
      await owner.root.waitForIdle(context);
      const report = await reportOf(owner);
      expect(report.status.status).toBe("blocked");
      expect(report.status.error).toStartWith(
        fallback ? stderr : "Selected model is at capacity.",
      );
      const request = report.records!.find(ExternalRequest.is)!;
      const log = report.records!.find(ExternalLog.is)!;
      const worker = report.tasks!.find(({ id }) => id === log.byTaskId)!;
      if (worker.state.outcome?.status !== "failed")
        throw new Error("Expected a failed Codex worker");
      const error = worker.state.outcome.error!.message;
      expect(error).toContain(`Execution receipt: ${log.data.operationId}`);
      expect(error).toContain(`Request entry: ${request.id}`);
      expect(error).toContain(
        `Codex log entry: ${log.id}; exit code: ${exitCode}`,
      );
      expect(error).toContain(request.data.workspace);
      expect(error).toContain("Failure does not imply that no commands ran");
      expect(error).not.toContain("partial output");
      expect(error.length).toBeLessThan(5000);
      expect(log.data).toMatchObject({ stdout: output, stderr, exitCode });
      expect(log.data.outputTruncated).toBeUndefined();
      if (reason.length > 4096)
        expect(error).toStartWith(`${reason.slice(0, 4096)}… [see Codex log]`);
      expect(report.result).toBeUndefined();
      await owner.close();
      const reopened = await open(path);
      try {
        await reopened.root.waitForIdle(context);
        const retained = await reportOf(reopened);
        expect(retained.status.error).toBe(report.status.error);
        expect(
          retained.tasks!.find(({ id }) => id === worker.id)!.state,
        ).toEqual(worker.state);
        expect(retained.records!.filter(ExternalLog.is)).toEqual([log]);
        expect(retained.records!.find(ExternalRequest.is)).toEqual(request);
        expect(
          await Bun.file(
            join(request.data.workspace, "partial-artifact.txt"),
          ).text(),
        ).toBe("unverified draft");
      } finally {
        await reopened.close();
      }
    } finally {
      await owner.close();
    }
  },
);

test.each([1, 2])(
  "Codex failed commit %j references only durable evidence and preserves the fault",
  async (failedCommit) => {
    const output = jsonl([
      {
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(noteResult) },
      },
      completed,
    ]);
    const { owner } = await codexFixture(
      `require("node:fs").writeFileSync("ran.txt", "ran"); console.log(${JSON.stringify(output)});`,
      "worker",
      (builtins) => ({
        implementation(input, runtime, context) {
          let commits = 0;
          return builtins.implementation(
            input,
            {
              ...runtime,
              commit: (change, context) =>
                runtime.commit(async (tx, current) => {
                  await change(tx, current);
                  if (++commits === failedCommit)
                    throw new Error("Fixture receipt commit failed");
                }, context),
            },
            context,
          );
        },
      }),
    );
    try {
      await owner.root.waitForIdle(context);
      const report = await reportOf(owner);
      const outcome = report.tasks!.find(
        (task) => task.state.outcome?.status === "faulted",
      )!.state.outcome!;
      const error = outcome.error!.message;
      expect(error).toStartWith("Fixture receipt commit failed");
      expect(error).toContain(
        "Completion unrecorded; execution may have occurred",
      );
      expect(error).not.toContain("Codex log entry:");
      expect(report.records!.filter(ExternalLog.is)).toEqual([]);
      const requests = report.records!.filter(ExternalRequest.is);
      expect(requests).toHaveLength(failedCommit - 1);
      if (failedCommit === 1) {
        expect(error).toContain("Codex operation:");
        expect(error).toContain("Request entry: unrecorded");
        expect(error).not.toContain("Execution receipt:");
      } else {
        expect(error).toContain(`Request entry: ${requests[0]!.id}`);
        expect(
          await Bun.file(join(requests[0]!.data.workspace, "ran.txt")).text(),
        ).toBe("ran");
      }
      expect(report.result).toBeUndefined();
    } finally {
      await owner.close();
    }
  },
);

test.each(["stdout", "stderr"] as const)(
  "Codex %s overflow kills a lingering process and rejects an early answer",
  async (stream) => {
    const output = jsonl([
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify(review),
        },
      },
      completed,
    ]);
    // Bun can report a closed subprocess pipe as ECONNRESET on Linux.
    const { owner } = await codexFixture(`
import { writeSync } from "node:fs";
process.on("SIGTERM", () => {});
writeSync(1, ${JSON.stringify(output)});
setInterval(() => {}, 1000);
const chunk = "x".repeat(65536);
try {
  for (let i = 0; i < 300; i++) writeSync(${stream === "stdout" ? 1 : 2}, chunk);
} catch (error) {
  if (!["EPIPE", "ECONNRESET"].includes(error.code)) throw error;
}
`);
    try {
      await owner.root.waitForIdle(context);
      const report = await reportOf(owner);
      expect(report.status.status).toBe("blocked");
      expect(report.status.error).toContain("output capture limit");
      const entry = report.records!.find(ExternalLog.is)!;
      const log = entry.data;
      expect(report.status.error).toContain(`Codex log entry: ${entry.id}`);
      expect(report.status.error).toContain("output truncated: true");
      expect(log.outputTruncated).toBe(true);
      expect(log.exitCode).toBeNull();
      expect(log.usage).toEqual({ output_tokens: 7 });
      expect(log.stdout.length).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(log.stderr.length).toBeLessThanOrEqual(1024 * 1024);
      expect(report.result).toBeUndefined();
    } finally {
      await owner.close();
    }
  },
);

test.each([
  ["JSONL", "research"],
  ["schema", "research"],
  ["failed turn", "research"],
  ["signal", "research"],
  ["signal", "worker"],
] as const)(
  "Codex %s/%s preserves accounting, failure identity, and workspace policy",
  async (failure, mode) => {
    const output =
      (failure === "JSONL" ? "malformed\n" : "") +
      jsonl([
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify(failure === "schema" ? {} : review),
          },
        },
        completed,
        ...(failure === "failed turn" ? [{ type: "turn.failed" }] : []),
      ]);
    const { owner, path } = await codexFixture(
      failure === "signal"
        ? `import { writeSync } from "node:fs";
writeSync(1, ${JSON.stringify(jsonl([completed]))});
writeSync(2, "fixture diagnostic\\n");
process.kill(process.pid, "SIGTERM");`
        : `process.stdout.write(${JSON.stringify(output)});`,
      mode,
    );
    try {
      await owner.root.waitForIdle(context);
      await owner.close();
      const report = await inspect(path, (tx, root) =>
        readReport(tx, root, { records: true }),
      );
      expect(report.status.status).toBe("blocked");
      if (failure !== "schema")
        expect(report.status.error).toContain(
          {
            JSONL: "Codex emitted malformed JSONL",
            "failed turn": "Codex reported a failed turn",
            signal: "fixture diagnostic",
          }[failure],
        );
      const logs = report.records!.filter(ExternalLog.is);
      expect(logs).toHaveLength(1);
      const request = report.records!.find(ExternalRequest.is)!;
      expect(report.status.error).toContain(`Request entry: ${request.id}`);
      expect(report.status.error).toContain(`Codex log entry: ${logs[0]!.id}`);
      expect(report.status.error).toContain(request.data.workspace);
      expect(logs[0]!.data).toMatchObject({
        stdout:
          failure === "signal"
            ? expect.stringContaining('"output_tokens":7')
            : output,
        stderr: failure === "signal" ? "fixture diagnostic\n" : "",
        exitCode: failure === "signal" ? null : 0,
        usage: { output_tokens: 7 },
      });
      expect(
        report.tasks!.find(({ id }) => id === logs[0]!.byTaskId)!.state,
      ).toMatchObject({
        status: "terminal",
        outcome: {
          status: ["failed turn", "signal"].includes(failure)
            ? "failed"
            : "faulted",
        },
      });
      expect(report.result).toBeUndefined();
      const workspace = report.records!.find(ExternalRequest.is)!.data
        .workspace;
      if (mode === "research")
        await expect(access(workspace)).rejects.toThrow();
      else await access(workspace);
    } finally {
      await owner.close();
    }
  },
);

test.each(["cancel", "close"] as const)(
  "Codex %s kills resistant descendants and abandons private research output",
  async (action) => {
    const { owner, path, directory } = await codexFixture(`
import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);']);
await new Promise((resolve) => child.stdout.once("data", resolve));
writeSync(1, "unfinished Codex output\\n");
writeSync(2, "fixture waiting\\n");
writeFileSync(join(import.meta.dir, "processes.json"), JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`);
    const ready = join(directory, "processes.json");
    let processes: number[] = [];
    let workspace: string | undefined;
    try {
      owner.harness.resume();
      for (
        const deadline = Date.now() + 5000;
        !(await Bun.file(ready).exists());
      ) {
        if (Date.now() > deadline)
          throw new Error(
            `Codex fixture did not become ready: ${JSON.stringify(await reportOf(owner))}`,
          );
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
      const before = await reportOf(owner);
      const request = before.records!.find(ExternalRequest.is)!;
      workspace = request.data.workspace;
      if (action === "cancel") {
        await owner.harness.abortTask(request.byTaskId!, context);
        expect(
          (await owner.harness.waitForTask(request.byTaskId!, context)).state
            .outcome.status,
        ).toBe("aborted");
        await owner.root.waitForIdle(context);
      }
      await owner.close();
      for (const pid of processes)
        for (const deadline = Date.now() + 3000; alive(pid);) {
          if (Date.now() > deadline)
            throw new Error(`Codex fixture process ${pid} survived ${action}`);
          await Bun.sleep(10);
        }
      const report = await inspect(path, (tx, root) =>
        readReport(tx, root, { records: true }),
      );
      const logs = report.records!.filter(ExternalLog.is);
      expect(logs).toHaveLength(0);
      expect(report.status.calls).toMatchObject({
        externalInvocations: 1,
        unknownUsage: 1,
      });
      expect(report.notes).toEqual([]);
      expect(report.result).toBeUndefined();
      await expect(access(workspace)).rejects.toThrow();
    } finally {
      for (const pid of processes) if (alive(pid)) process.kill(pid, "SIGKILL");
      await owner.close();
      if (workspace) await rm(workspace, { recursive: true, force: true });
    }
  },
  15_000,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test.each([false, true])(
  "Codex cleanup failure preserves result and primary error: %j",
  async (failed) => {
    const output = jsonl([
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify(review),
        },
      },
      completed,
      ...(failed ? [{ type: "turn.failed" }] : []),
    ]);
    const { owner } = await codexFixture(`
import { chmodSync } from "node:fs";
chmodSync(process.cwd(), 0o500);
console.log(${JSON.stringify(output)});
`);
    let workspace: string | undefined;
    try {
      await owner.root.waitForIdle(context);
      const report = await reportOf(owner);
      workspace = report.records!.find(ExternalRequest.is)!.data.workspace;
      expect(report.records!.find(ExternalLog.is)!.data.usage).toEqual({
        output_tokens: 7,
      });
      await access(workspace);
      if (failed)
        expect(report.status.error).toContain("Codex reported a failed turn");
      else expect(report.result).toMatchObject({ verdict: "PASS" });
    } finally {
      await owner.close();
      if (workspace) {
        await chmod(workspace, 0o700);
        await rm(workspace, { recursive: true, force: true });
      }
    }
  },
);
