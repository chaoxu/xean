import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCampaign } from "xean";

import { applicationId, task as taskSchema } from "../roles";
import { settings as settingsSchema } from "../runner";
import { workflowConfiguration } from "../workflow";

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run starts, resumes, inspects, and exports one workflow", async () => {
  const directory = await testDirectory();
  const settings = await writeSettings(directory);
  const task = await writeJson(directory, "task.json", {
    problem: "Prove that there are infinitely many prime numbers.",
    completionCriteria: "Give a complete self-contained proof.",
  });
  const campaign = join(directory, "run.db");

  const first = await cli(directory, "run", task, campaign, settings);
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    schemaVersion: 1,
    application: "xean-solve",
    protocol: "workflow",
    outcome: "accepted",
    turns: 2,
    note: { id: "n2" },
  });
  const requests = await recordedRequests(directory);
  expect(requests).toHaveLength(10);
  expect(requests[0]).toMatchObject({
    tools: [
      {
        name: "submit_notes",
        parameters: { properties: { solution: { type: "boolean" } } },
      },
    ],
  });

  // Completed journals need neither the model registry nor native credentials.
  await rm(join(directory, "models.json"));
  await rm(join(directory, ".codex"), { recursive: true });
  const second = await cli(directory, "run", task, campaign, settings);
  expect(second.code).toBe(0);
  expect(JSON.parse(second.stdout).outcome).toBe("accepted");
  expect(await recordedRequests(directory)).toHaveLength(10);

  const inspection = JSON.parse(
    (await cli(directory, "inspect", campaign)).stdout,
  );
  expect(inspection).toMatchObject({
    task: {
      problem: "Prove that there are infinitely many prime numbers.",
    },
    phase: "accepted",
    result: { outcome: "accepted", note: { id: "n2" } },
    spend: { logicalProviderRequests: 10, requestErrors: 0 },
    accounting: {
      complete: true,
      unmeasuredRequests: 0,
      unaccountedCalls: [],
      potentialRequests: [],
    },
  });
  // The self-contained proof records a local source PASS with no provider cost.
  expect(inspection.accounting.unpricedCalls).toHaveLength(0);
  expect(
    inspection.calls.map(({ role }: { readonly role: string }) => role),
  ).toEqual([
    "explorer",
    "coordinator",
    "verifier",
    "explorer",
    "coordinator",
    "verifier",
    "verifier",
    "verifier",
    "verifier",
    "verifier",
    "verifier",
  ]);
  expect(
    inspection.calls.map(
      ({ verifier }: { readonly verifier?: string }) => verifier ?? null,
    ),
  ).toEqual([
    null,
    null,
    "correctness",
    null,
    null,
    "correctness",
    "source",
    "requirements",
    "reconstruction",
    "reconstruction",
    "reconstruction",
  ]);
  expect(
    inspection.notes.map(
      ({
        id,
        verdicts,
        dead,
      }: {
        id: string;
        verdicts: unknown[];
        dead: boolean;
      }) => [id, verdicts.length, dead],
    ),
  ).toEqual([
    ["n1", 1, true],
    ["n2", 4, false],
  ]);

  const exported = await cli(directory, "export", campaign);
  expect(exported.code).toBe(0);
  expect(exported.stdout).toContain("Since 2 is prime");
});

test("run refuses a concurrent owner of the same campaign", async () => {
  const directory = await testDirectory();
  const settings = await writeSettings(directory);
  const task = await writeJson(directory, "task.json", {
    problem: "Prove P.",
    completionCriteria: "Give a proof.",
  });
  const campaign = join(directory, "locked.db");
  using lock = new Database(`${campaign}.runner.lock`, { create: true });
  lock.run("BEGIN EXCLUSIVE");
  const result = await cli(directory, "run", task, campaign, settings);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("campaign already has a running process");
});

test("guided CLI workflow retains its verification, accounting, and execution report contract", async () => {
  const directory = await testDirectory();
  const settings = await writeSettings(directory);
  const task = await writeJson(directory, "task.json", {
    problem: "Prove that there are infinitely many prime numbers.",
    completionCriteria: "Give a complete self-contained proof.",
  });
  const campaign = join(directory, "guided.db");
  createCampaign(
    campaign,
    applicationId,
    workflowConfiguration({
      task: taskSchema.parse(await Bun.file(task).json()),
      settings: settingsSchema.parse(await Bun.file(settings).json()),
    }),
  ).close();
  const text = "Test small counterexamples first.";
  const guidance = join(directory, "guidance.txt");
  await Bun.write(guidance, text);
  const submitted = await cli(
    directory,
    "guide",
    "--id",
    "e2e-1",
    campaign,
    guidance,
  );
  expect(submitted.code, submitted.stderr).toBe(0);
  const result = await cli(directory, "run", task, campaign, settings);
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    application: "xean-solve",
    protocol: "workflow",
    outcome: "accepted",
    turns: 2,
    note: { id: "n2" },
  });
  const inspected = await cli(
    directory,
    "inspect",
    "--include-guidance",
    "--include-requests",
    campaign,
  );
  expect(inspected.code, inspected.stderr).toBe(0);
  const report = JSON.parse(inspected.stdout);
  expect(report).toMatchObject({
    phase: "accepted",
    spend: { logicalProviderRequests: 10, requestErrors: 0 },
    guidance: [{ id: "e2e-1", pending: false }],
    accounting: { unaccountedCalls: [], potentialRequests: [] },
  });
  expect(report.guidance[0].calls).toHaveLength(1);
  for (const call of report.calls) {
    if (call.call === report.guidance[0].calls[0])
      expect(call.request.prompt).toContain(text);
    else expect(JSON.stringify(call.request)).not.toContain(text);
  }
  expect((await cli(directory, "export", campaign)).stdout).toContain(
    "Since 2 is prime",
  );
});

test("a provider failure leaves no verdict", async () => {
  const directory = await testDirectory();
  const settings = await writeSettings(directory);
  const input = await writeJson(directory, "verifier.json", {
    task: { problem: "Prove P.", completionCriteria: "Give a proof." },
    verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
    notes: [
      {
        id: "n1",
        summary: "failure",
        text: "TRIGGER_PROVIDER_ERROR",
        support: [],
        verdicts: [],
        verified: false,
        dead: false,
      },
    ],
    support: [],
  });
  const campaign = join(directory, "failure.db");
  const result = await cli(directory, "verifier", input, campaign, settings);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("synthetic provider failure");
  const inspection = JSON.parse(
    (await cli(directory, "inspect", campaign)).stdout,
  );
  expect(inspection.calls).toHaveLength(1);
  expect(inspection.calls[0]).toMatchObject({ verifier: "correctness" });
  expect(inspection.calls[0]).not.toHaveProperty("submission");
  expect(inspection.spend.requestErrors).toBeGreaterThanOrEqual(1);
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "xean-role-e2e-"));
  directories.push(directory);
  return directory;
}

async function writeSettings(directory: string): Promise<string> {
  await writeJson(directory, "models.json", {
    providers: {
      e2e: {
        name: "E2E Responses",
        baseUrl: "https://e2e.invalid/v1",
        api: "openai-responses",
        apiKey: "test-key",
        models: [
          {
            id: "e2e-model",
            name: "E2E Model",
            reasoning: true,
            input: ["text"],
            cost: {
              input: 0.2,
              output: 1.2,
              cacheRead: 0.02,
              cacheWrite: 0.25,
            },
            contextWindow: 20_000,
            maxTokens: 4_000,
            thinkingLevelMap: { low: "low" },
            compat: {
              supportsStrictMode: true,
              supportsOpenAIGrammarTools: true,
            },
          },
        ],
      },
    },
  });
  await writeJson(directory, "auth.json", {});
  await mkdir(join(directory, ".codex"));
  await writeJson(join(directory, ".codex"), "auth.json", {
    tokens: { access_token: "fixture-only" },
  });
  const profile = { provider: "e2e", model: "e2e-model", reasoning: "low" };
  return writeJson(directory, "settings.json", {
    explorer: profile,
    coordinator: profile,
    correctness: profile,
    source: { model: "e2e-model", reasoning: "low" },
    requirements: profile,
    reconstruction: profile,
  });
}

async function writeJson(
  directory: string,
  name: string,
  value: unknown,
): Promise<string> {
  const path = join(directory, name);
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

async function cli(
  directory: string,
  ...args: readonly string[]
): Promise<CliResult> {
  const child = Bun.spawn(
    [
      process.execPath,
      "--preload",
      join(import.meta.dir, "fixtures/role-e2e-fetch.ts"),
      "solve.ts",
      ...args,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: directory,
        TMPDIR: directory,
        XEAN_MODELS_PATH: join(directory, "models.json"),
        PI_CODING_AGENT_DIR: directory,
        XEAN_E2E_REQUEST_LOG: join(directory, "requests.jsonl"),
        XEAN_CODEX_COMMAND: join(import.meta.dir, "fixtures/fake-codex.ts"),
        FAKE_CODEX_CAPTURE: join(directory, "codex.jsonl"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

async function recordedRequests(
  directory: string,
): Promise<Record<string, unknown>[]> {
  const file = Bun.file(join(directory, "requests.jsonl"));
  if (!(await file.exists())) return [];
  return (await file.text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
