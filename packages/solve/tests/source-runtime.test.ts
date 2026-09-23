import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCampaign } from "xean";

import {
  prepareCodex,
  codexCall,
  codexOutcome,
  codexRequest,
  codexSubmission,
  codexTranscript,
  readCodexResult,
  type CodexResult,
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

test("recognized compaction and reconnect notices preserve complete submissions", () => {
  for (const events of [
    [
      ...start,
      {
        type: "error",
        message:
          "Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)",
      },
      search("s1"),
      final,
      completed,
    ],
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

test.each(["missing", "corrupt"])(
  "Codex replay uses compact results while explicit logs reject %s payloads",
  async (damage) => {
    const directory = await mkdtemp(join(tmpdir(), "xean-source-result-"));
    directories.push(directory);
    const path = join(directory, "campaign.db");
    const campaign = createCampaign(path, "source-storage", null);
    try {
      const raw = {
        state: "succeeded" as const,
        codexVersion: "fixture",
        stdout: codexStdout({ verdict: "PASS" }),
        stderr: "PRIVATE_PROCESS_LOG",
      };
      const result = await codexCall(
        campaign,
        { label: "source", role: "verifier" },
        request,
        async () => raw,
      );
      const records = campaign.records();
      const submission = codexSubmission(records, result.call);
      expect(submission).toMatchObject({
        input: { verdict: "PASS" },
        searches: 1,
        usage: { input: 10 },
      });
      expect(JSON.stringify(records)).not.toContain("PRIVATE_PROCESS_LOG");
      expect(JSON.stringify(records)).not.toContain("thread.started");
      expect(readCodexResult(result.output, campaign)).toEqual(raw);
      const database = new Database(path);
      try {
        database.run(
          `DROP TRIGGER payloads_no_${damage === "missing" ? "delete" : "update"}`,
        );
        database.run(
          damage === "missing"
            ? "DELETE FROM payloads WHERE digest=?"
            : "UPDATE payloads SET body='null' WHERE digest=?",
          [result.output.stdoutRef],
        );
      } finally {
        database.close();
      }
      expect(codexSubmission(records, result.call)).toEqual(submission);
      expect(() => readCodexResult(result.output, campaign)).toThrow(
        damage === "missing" ? "payload not found" : "payload digest mismatch",
      );
    } finally {
      campaign.close();
    }
  },
);

test("compact Codex results distinguish malformed submissions from operational failures and reject the old format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-source-result-"));
  directories.push(directory);
  const campaign = createCampaign(
    join(directory, "campaign.db"),
    "source-storage",
    null,
  );
  try {
    const malformedMessage = codexStdout({}).replace(
      '"text":"{}"',
      '"text":"not-json"',
    );
    const raw: CodexResult[] = [
      {
        state: "succeeded",
        codexVersion: "fixture",
        stdout: "invalid JSON",
        stderr: "",
      },
      {
        state: "succeeded",
        codexVersion: "fixture",
        stdout: malformedMessage,
        stderr: "",
      },
      {
        state: "failed",
        error: "process failed",
        stdout: "",
        stderr: "",
        exitCode: 1,
      },
      {
        state: "cancelled",
        error: "process cancelled",
        stdout: "",
        stderr: "",
        exitCode: null,
      },
    ];
    for (const output of raw) {
      const result = await codexCall(
        campaign,
        { label: "source", role: "verifier" },
        request,
        async () => output,
      );
      expect(codexOutcome(campaign.records(), result.call)?.state).toBe(
        output.state,
      );
      expect(readCodexResult(result.output, campaign)).toEqual(output);
      if (output.state === "succeeded")
        expect(() => codexSubmission(campaign.records(), result.call)).toThrow(
          "JSON",
        );
      else
        expect(
          codexSubmission(campaign.records(), result.call),
        ).toBeUndefined();
    }
    const old = await campaign.call(
      { label: "source", request },
      async () => raw[0],
    );
    expect(() => codexOutcome(campaign.records(), old.call)).toThrow();
  } finally {
    campaign.close();
  }
});

async function fixture(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "xean-source-runtime-"));
  directories.push(directory);
  const command = join(directory, "fake-codex");
  await mkdir(join(directory, ".codex"));
  await writeFile(
    join(directory, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "fixture" } }),
  );
  await writeFile(
    command,
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
if (Bun.argv.includes("--version")) {
  console.log("codex-cli fixture");
  process.exit(0);
}
if (Bun.argv.includes("--help")) {
  console.log("--search --disable --model --config --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check --sandbox --json --color --output-schema --cd");
  process.exit(0);
}
if (Bun.argv.includes("login")) process.exit(0);
await Bun.stdin.text();
const save = (name, value = "ready") => writeFileSync(join(process.env.HOME, name), value);
save("pid", String(process.pid));
${script}
`,
    { mode: 0o700 },
  );
  return {
    directory,
    exec: await prepareCodex({
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

test.each([0, 7])(
  "Codex execution preserves output after exit %s",
  async (exitCode) => {
    const transcript = jsonl([
      ...start,
      search("s1"),
      search("s2"),
      final,
      completed,
    ]);
    const setup = await fixture(
      `process.stdout.write(${JSON.stringify(transcript)}); process.stderr.write("diagnostic"); process.exitCode = ${exitCode};`,
    );
    const result = await setup.exec(request);
    expect(result.state).toBe(exitCode === 0 ? "succeeded" : "failed");
    expect(result.stdout).toBe(transcript);
    expect(result.stderr).toBe("diagnostic");
    if (exitCode === 0) expect(result).not.toHaveProperty("exitCode");
    else
      expect(result).toMatchObject({
        exitCode,
        error: "Codex exited with status 7",
      });
    expect(codexTranscript(result.stdout).searches).toBe(2);
  },
);

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
  expect(result).toMatchObject({ exitCode: null });
  await expectReaped(setup.directory);
});

test("an already cancelled request starts no Codex execution", async () => {
  const setup = await fixture('save("executed");');
  const controller = new AbortController();
  controller.abort();
  const result = await setup.exec(request, controller.signal);
  expect(result.state).toBe("cancelled");
  expect(result).toMatchObject({ stdout: "", stderr: "", exitCode: null });
  expect(existsSync(join(setup.directory, "executed"))).toBe(false);
});
