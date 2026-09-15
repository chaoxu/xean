import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  codexExec,
  codexRequest,
  codexResult,
  codexTranscript,
  type CodexRequest,
} from "../source";
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
const search = (id: string, type = "item.completed") => ({
  type,
  item: { id, type: "web_search", query: "source ☃" },
});
const request: CodexRequest = {
  protocol: "xean/codex-exec/v1",
  model: "fixture-model",
  reasoning: "low",
  search: true,
  developerInstructions: "Verify the cited premise.",
  prompt: "Inspect the cited primary source.",
  outputSchema: { type: "object" },
};

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

test("web action limits are optional positive integers", () => {
  expect(codexRequest.parse(request)).not.toHaveProperty("maxWebActions");
  expect(
    codexRequest.parse({ ...request, maxWebActions: 1 }).maxWebActions,
  ).toBe(1);
  for (const maxWebActions of [0, -1, 1.5]) {
    expect(codexRequest.safeParse({ ...request, maxWebActions }).success).toBe(
      false,
    );
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
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const save = (name, value = "ready") => writeFileSync(join(process.env.HOME, name), value);
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
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

async function expectReaped(directory: string, name = "pid") {
  const pid = Number(await readFile(join(directory, name), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}

test("the observed limit stops chunked searches and kills a launcher with its native child", async () => {
  const transcript =
    jsonl([
      ...start,
      search("s1", "item.started"),
      search("s1", "item.updated"),
      search("s1"),
      search("s2", "item.started"),
    ]) + "\n";
  const setup = await fixture(`
process.on("SIGTERM", () => process.stderr.write("ignored SIGTERM\\n"));
const native = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdout: "inherit", stderr: "inherit" });
save("native-pid", String(native.pid));
process.stderr.write("before limit\\n");
const bytes = Buffer.from(${JSON.stringify(transcript)});
for (let index = 0; index < bytes.length; index += 7) {
  process.stdout.write(bytes.subarray(index, index + 7));
  await wait(1);
}
await wait(2000);
save("ran-away");
`);
  const result = await setup.exec({ ...request, maxWebActions: 2 });
  expect(result.state).toBe("exhausted");
  expect(codexResult.parse(result)).toEqual(result);
  expect(result.stdout).toBe(transcript);
  expect(result.stderr).toContain("before limit\n");
  expect(result.stderr).toContain("ignored SIGTERM\n");
  expect("error" in result && result.error).toContain("maxWebActions=2");
  expect(existsSync(join(setup.directory, "ran-away"))).toBe(false);
  await expectReaped(setup.directory);
  await expectReaped(setup.directory, "native-pid");
});

test("started, updated, and completed events for one action consume one slot", async () => {
  const transcript = jsonl([
    ...start,
    search("s1", "item.started"),
    search("s1", "item.updated"),
    search("s1"),
    final,
    completed,
  ]);
  const setup = await fixture(
    `process.stdout.write(${JSON.stringify(transcript)});`,
  );
  const result = await setup.exec({ ...request, maxWebActions: 2 });
  expect(result.state).toBe("succeeded");
  expect(result.stdout).toBe(transcript);
  expect(codexTranscript(result.stdout).searches).toBe(1);
});

test("reaching the limit remains exhausted when a final result shares the buffer", async () => {
  const transcript = jsonl([...start, search("s1"), final, completed]);
  const setup = await fixture(
    `process.stdout.write(${JSON.stringify(transcript)});`,
  );
  const result = await setup.exec({ ...request, maxWebActions: 1 });
  expect(result.state).toBe("exhausted");
  expect(result.stdout).toBe(transcript);
});

test("an unterminated last JSONL event still consumes its observed action", async () => {
  const transcript = jsonl([...start, search("s1")]);
  const setup = await fixture(
    `process.stdout.write(${JSON.stringify(transcript)});`,
  );
  const result = await setup.exec({ ...request, maxWebActions: 1 });
  expect(result.state).toBe("exhausted");
  expect(result.stdout).toBe(transcript);
});

test("independent review execution remains unbounded when no limit is requested", async () => {
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
  expect(codexTranscript(result.stdout).searches).toBe(2);
});

test.each([
  ["malformed JSON", "{not-json}\n"],
  [
    "unknown event type",
    jsonl([...start, { ...search("s1"), type: "item.unknown" }]) + "\n",
  ],
  [
    "unknown item type",
    jsonl([
      ...start,
      { type: "item.started", item: { id: "s1", type: "unknown" } },
    ]) + "\n",
  ],
  [
    "missing action ID",
    jsonl([...start, { type: "item.started", item: { type: "web_search" } }]) +
      "\n",
  ],
  ["blank action ID", jsonl([...start, search(" ", "item.started")]) + "\n"],
])("%s cannot disable the limit", async (_name, transcript) => {
  const setup = await fixture(`
process.on("SIGTERM", () => {});
process.stdout.write(${JSON.stringify(transcript)});
await wait(2000);
save("ran-away");
`);
  const result = await setup.exec({ ...request, maxWebActions: 2 });
  expect(result.state).toBe("failed");
  expect(result.stdout).toBe(transcript);
  expect(existsSync(join(setup.directory, "ran-away"))).toBe(false);
  await expectReaped(setup.directory);
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
  const pending = setup.exec(
    { ...request, maxWebActions: 2 },
    controller.signal,
  );
  await waitForFile(join(setup.directory, "ready"));
  controller.abort();
  const result = await pending;
  expect(result.state).toBe("cancelled");
  expect(result.stdout).toBe(jsonl(start) + "\n");
  expect(result.stderr).toBe("partial stderr\n");
  await expectReaped(setup.directory);
});

test("caller cancellation takes precedence after exhaustion starts", async () => {
  const setup = await fixture(`
process.on("SIGTERM", () => save("terminating"));
process.stdout.write(${JSON.stringify(jsonl([...start, search("s1")]) + "\n")});
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const pending = setup.exec(
    { ...request, maxWebActions: 1 },
    controller.signal,
  );
  await waitForFile(join(setup.directory, "terminating"));
  controller.abort();
  expect((await pending).state).toBe("cancelled");
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
