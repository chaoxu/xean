import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { codexExec, codexRequest, codexTranscript } from "../source";
import { codexStdout } from "./fixtures/codex-stdout";

const warning = {
  type: "item.completed",
  item: {
    id: "warning",
    type: "error",
    message:
      "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.",
  },
};
const start = [{ type: "thread.started" }, { type: "turn.started" }];
const final = JSON.parse(
  codexStdout({ verdict: "PASS" }, false).split("\n")[2]!,
);
const completed = JSON.parse(codexStdout({}, false).split("\n")[3]!);
const jsonl = (events: readonly unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n");
const search = (id: string) => ({
  type: "item.completed",
  item: { id, type: "web_search", query: "source ☃" },
});
const request = {
  protocol: "xean/codex-exec/v1" as const,
  model: "fixture-model",
  reasoning: "low" as const,
  search: true as const,
  developerInstructions: "Verify the cited premise.",
  prompt: "Inspect the cited primary source.",
  outputSchema: { type: "object" },
};

test("Codex requests require live web search", () => {
  expect(codexRequest.parse(request).search).toBe(true);
  expect(codexRequest.safeParse({ ...request, search: false }).success).toBe(
    false,
  );
});

test("the precise compaction warning preserves a completed final submission", () => {
  for (const events of [
    [...start, warning, search("s1"), final, completed],
    [...start, search("s1"), final, warning, completed],
  ]) {
    expect(codexTranscript(jsonl(events))).toEqual({
      message: JSON.stringify({ verdict: "PASS" }),
      searches: 1,
      usage: {
        input: 10,
        cacheRead: 2,
        cacheWrite: 0,
        output: 5,
        reasoning: 1,
      },
    });
  }
});

test("the warning exception does not accept real errors or forbidden tools", () => {
  for (const event of [
    { ...warning, item: { ...warning.item, message: "API request failed" } },
    {
      ...warning,
      item: {
        ...warning.item,
        message: warning.item.message + " Fatal error.",
      },
    },
    { ...warning, type: "item.started" },
    { type: "error", message: warning.item.message },
    {
      type: "item.completed",
      item: { id: "shell", type: "command_execution", command: "true" },
    },
  ]) {
    expect(() =>
      codexTranscript(jsonl([...start, event, final, completed])),
    ).toThrow();
  }
});

test("a harmless warning still requires a complete turn and final agent message", () => {
  for (const events of [
    [...start, warning, final],
    [...start, warning, completed],
    [...start, final, search("s1"), warning, completed],
    [...start, final, completed, warning],
  ]) {
    expect(() => codexTranscript(jsonl(events))).toThrow();
  }
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "xean-source-runtime-"));
  directories.push(directory);
  const command = join(directory, "fake-codex");
  await writeFile(
    command,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (Bun.argv.includes("--version")) {
  console.log("codex-cli fixture");
  process.exit(0);
}
await Bun.stdin.text();
const save = (name, value = "ready") => writeFileSync(join(process.env.HOME, name), value);
save("pid", String(process.pid));
${script}
`,
    { mode: 0o700 },
  );
  return {
    directory,
    exec: codexExec({
      command,
      environment: { HOME: directory, PATH: dirname(process.execPath) },
    }),
  };
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(5);
  }
  throw new Error(`fixture did not write ${path}`);
}

async function expectReaped(directory: string) {
  const pid = Number(await readFile(join(directory, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}

test("Codex execution lets source search finish without an action cutoff", async () => {
  const transcript = jsonl([
    ...start,
    search("s1"),
    search("s2"),
    final,
    completed,
  ]);
  const setup = await fixture(
    `process.stdout.write(${JSON.stringify(transcript)});`,
  );
  const result = await setup.exec(request);
  expect(result.state).toBe("succeeded");
  expect(result.stdout).toBe(transcript);
  expect(codexTranscript(result.stdout).searches).toBe(2);
});

test("caller cancellation drains output and reaps a process ignoring SIGTERM", async () => {
  const setup = await fixture(`
process.on("SIGTERM", () => {});
process.stdout.write(${JSON.stringify(jsonl(start) + "\n")});
process.stderr.write("partial stderr\\n");
save("ready");
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const pending = setup.exec(request, controller.signal);
  await waitForFile(join(setup.directory, "ready"));
  controller.abort();
  const result = await pending;
  expect(result.state).toBe("cancelled");
  expect(result.stdout).toBe(jsonl(start) + "\n");
  expect(result.stderr).toBe("partial stderr\n");
  await expectReaped(setup.directory);
});

test("an already cancelled request starts no Codex execution", async () => {
  const setup = await fixture('save("executed");');
  const controller = new AbortController();
  controller.abort();
  const result = await setup.exec(request, controller.signal);
  expect(result.state).toBe("cancelled");
  expect(existsSync(join(setup.directory, "executed"))).toBe(false);
});
