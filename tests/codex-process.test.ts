import { temporaryDirectory } from "./directory.ts";
import { expect, test } from "bun:test";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect, open, readReport } from "../src/index.ts";
import { CodexLog, CodexRequest, codexTranscript } from "../src/roles/codex.ts";
import { context, settings, task } from "./fixture.ts";

test.each(["\n", "\r\n"])(
  "Codex JSONL accepts blank lines and %j separators while retaining results and usage",
  (separator) => {
    const value = { verdict: "PASS", report: "Checked" };
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
      JSON.stringify({ type: "turn.completed", usage: { output_tokens: 7 } }),
    ].join(separator);
    expect(codexTranscript(output)).toEqual({
      value,
      usage: { output_tokens: 7 },
      searches: 1,
    });
  },
);

test.each([1, 0, "bare", "blank"] as const)(
  "Codex terminal provider errors survive process exit %s with bounded status and raw evidence",
  async (failure) => {
    const directory = await temporaryDirectory("codex-provider-failure-");
    const command = join(directory, "codex-fixture");
    const exitCode = typeof failure === "number" ? failure : 1;
    const fallback = typeof failure === "string";
    const stderr =
      fallback || exitCode === 0 ? "fixture provider detail on stderr" : "";
    const reason =
      "Selected model is at capacity. Please try a different model." +
      (exitCode === 0 ? " Detail".repeat(700) : "");
    const output =
      [
        { type: "error", message: "Reconnecting... 1/5" },
        {
          type: "item.completed",
          item: { type: "agent_message", text: "I will check the source." },
        },
        { type: "error", message: reason },
        {
          type: "turn.failed",
          ...(failure === "bare"
            ? {}
            : { error: { message: failure === "blank" ? "  " : reason } }),
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    expect(codexTranscript(output).error?.message).toBe(
      fallback ? "Codex reported a failed turn" : reason,
    );
    await writeFile(
      command,
      `#!${process.execPath}\nimport { writeSync } from "node:fs";\nwriteSync(1, ${JSON.stringify(output)});\nwriteSync(2, ${JSON.stringify(stderr)});\nprocess.exitCode = ${exitCode};\n`,
    );
    await chmod(command, 0o700);
    const path = join(directory, "campaign.sqlite");
    const owner = await open(path, {
      create: {
        task,
        settings: { ...settings, research: { model: "fixture", command } },
        mode: { role: "review", input: { argument: "Fixture only" } },
      },
    });
    try {
      await owner.root.waitForIdle(context);
      const report = await owner.root.commit(
        (tx) => readReport(tx, owner.root.id, { records: true }),
        context,
      );
      expect(report.status.status).toBe("blocked");
      expect(report.status.error).toStartWith(
        fallback ? stderr : "Selected model is at capacity.",
      );
      const log = report.records!.find(CodexLog.is)!;
      expect(log.data).toMatchObject({ stdout: output, stderr, exitCode });
      expect(log.data.outputTruncated).toBeUndefined();
      expect(
        report.tasks!.find(({ id }) => id === log.byTaskId)!.state,
      ).toMatchObject({
        status: "terminal",
        outcome: {
          status: "failed",
          error: {
            message: fallback
              ? stderr
              : reason.length > 4096
                ? `${reason.slice(0, 4096)}… [see Codex log]`
                : reason,
          },
        },
      });
      expect(report.result).toBeUndefined();
    } finally {
      await owner.close();
    }
  },
);

test.each(["stdout", "stderr"] as const)(
  "Codex %s overflow kills a lingering process and rejects an early answer",
  async (stream) => {
    const directory = await temporaryDirectory("codex-output-limit-");
    const command = join(directory, "codex-fixture");
    const output =
      [
        {
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify({
              verdict: "PASS",
              report: "Checked",
              premises: [],
              passages: [],
            }),
          },
        },
        { type: "turn.completed", usage: { output_tokens: 7 } },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n";
    await writeFile(
      command,
      `#!${process.execPath}\nimport {writeSync} from "node:fs";\nprocess.on("SIGTERM",()=>{});\nwriteSync(1,${JSON.stringify(output)});\nsetInterval(()=>{},1000);\nconst chunk="x".repeat(65536);\ntry { for(let i=0;i<300;i++)writeSync(${stream === "stdout" ? 1 : 2},chunk); } catch(error) { if(error.code!=="EPIPE") throw error; }\n`,
    );
    await chmod(command, 0o700);
    const path = join(directory, "campaign.sqlite");
    const owner = await open(path, {
      create: {
        task,
        settings: { ...settings, research: { model: "fixture", command } },
        mode: { role: "review", input: { argument: "Fixture only" } },
      },
    });
    try {
      await owner.root.waitForIdle(context);
      const report = await owner.root.commit(
        (tx) => readReport(tx, owner.root.id, { records: true }),
        context,
      );
      expect(report.status.status).toBe("blocked");
      expect(report.status.error).toContain("output capture limit");
      const log = report.records!.find(CodexLog.is)!.data;
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
  ["final JSON", "research"],
  ["schema", "research"],
  ["failed turn", "research"],
  ["signal", "research"],
  ["signal", "worker"],
] as const)(
  "Codex %s/%s preserves accounting, failure identity, and workspace policy",
  async (failure, mode) => {
    const directory = await temporaryDirectory("codex-failure-");
    const path = join(directory, "campaign.sqlite");
    const command = join(directory, "codex-fixture");
    const output =
      [
        ...(failure === "JSONL" ? ["malformed"] : []),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text:
              failure === "final JSON"
                ? "malformed"
                : JSON.stringify(
                    failure === "schema"
                      ? {}
                      : {
                          verdict: "PASS",
                          report: "Checked",
                          premises: [],
                          passages: [],
                        },
                  ),
          },
        }),
        JSON.stringify({ type: "turn.completed", usage: { output_tokens: 7 } }),
        ...(failure === "failed turn"
          ? [JSON.stringify({ type: "turn.failed" })]
          : []),
      ].join("\n") + "\n";
    if (failure === "signal") await signalFixture(directory);
    else {
      await writeFile(
        command,
        `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`,
      );
      await chmod(command, 0o700);
    }
    const owner = await open(path, {
      create: {
        task,
        settings: {
          ...settings,
          ...(mode === "worker"
            ? { codex: { model: "fixture", command, workspace: directory } }
            : { research: { model: "fixture", command } }),
        },
        mode: {
          role: mode === "worker" ? "codex" : "review",
          input: {
            assignment: "Fixture only",
            argument: "Fixture only",
            notes: [],
          },
        },
      },
    });
    try {
      await owner.root.waitForIdle(context);
      await owner.close();
      const report = await inspect(path, (tx, root) =>
        readReport(tx, root, { records: true }),
      );
      expect(report.status.status).toBe("blocked");
      if (failure === "signal")
        expect(report.status.error).toBe("fixture diagnostic");
      const logs = report.records!.filter(CodexLog.is);
      expect(logs).toHaveLength(1);
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
      const workspace = report.records!.find(CodexRequest.is)!.data.workspace;
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
    const directory = await temporaryDirectory("codex-cancel-");
    const path = join(directory, "campaign.sqlite");
    const command = join(directory, "codex-fixture");
    const ready = join(directory, "processes.json");
    await writeFile(
      command,
      `#!${process.execPath}
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
`,
    );
    await chmod(command, 0o700);
    const owner = await open(path, {
      create: {
        task,
        settings: { ...settings, research: { model: "fixture", command } },
        mode: { role: "review", input: { argument: "Fixture only" } },
      },
    });
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
            `Codex fixture did not become ready: ${JSON.stringify(await owner.root.commit((tx) => readReport(tx, owner.root.id, { records: true }), context))}`,
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
      const before = await owner.root.commit(
        (tx) => readReport(tx, owner.root.id, { records: true }),
        context,
      );
      const request = before.records!.find(CodexRequest.is)!;
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
      const logs = report.records!.filter(CodexLog.is);
      expect(logs).toHaveLength(0);
      expect(report.status.calls).toMatchObject({
        codexInvocations: 1,
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

async function signalFixture(directory: string) {
  const command = join(directory, "codex-fixture");
  await writeFile(
    command,
    `#!${process.execPath}
import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ type: "turn.completed", usage: { output_tokens: 7 } }) + "\\n");
writeSync(2, "fixture diagnostic\\n");
process.kill(process.pid, "SIGTERM");
`,
  );
  await chmod(command, 0o700);
  return command;
}

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
  "Codex cleanup failure preserves result and primary error: %s",
  async (failed) => {
    const directory = await temporaryDirectory("codex-cleanup-");
    const command = join(directory, "codex-fixture");
    const output = [
      {
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({
            verdict: "PASS",
            report: "Checked",
            premises: [],
            passages: [],
          }),
        },
      },
      { type: "turn.completed", usage: { output_tokens: 7 } },
      ...(failed ? [{ type: "turn.failed" }] : []),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n");
    await writeFile(
      command,
      `#!${process.execPath}\nimport { chmodSync } from "node:fs";\nchmodSync(process.cwd(), 0o500);\nconsole.log(${JSON.stringify(output)});\n`,
    );
    await chmod(command, 0o700);
    const owner = await open(join(directory, "campaign.sqlite"), {
      create: {
        task,
        settings: { ...settings, research: { model: "fixture", command } },
        mode: { role: "review", input: { argument: "Fixture only" } },
      },
    });
    let workspace: string | undefined;
    try {
      await owner.root.waitForIdle(context);
      const report = await owner.root.commit(
        (tx) => readReport(tx, owner.root.id, { records: true }),
        context,
      );
      workspace = report.records!.find(CodexRequest.is)!.data.workspace;
      expect(report.records!.find(CodexLog.is)!.data.usage).toEqual({
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
