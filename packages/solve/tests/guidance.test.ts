import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createCampaign, openCampaign, openReader } from "xean";

import { freezeExplorerGuidance, inspectGuidance } from "../guidance";
import { guideCampaign, inspectCampaign } from "../role-cli";
import { applicationId, jsonSnapshot, roleLabels } from "../roles";
import { run } from "../runner";
import { deriveWorkflow, workflowConfiguration } from "../workflow";
import {
  campaignPath,
  createWorkflowCampaign,
  cleanupCampaigns,
  dependencies,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const first = "Test small counterexamples first.";
const second = "Try a direct construction next.";

async function setup(turns = 2) {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
  };
  const config = workflowConfiguration({ task, settings });
  (await createWorkflowCampaign(path, config, turns)).close();
  return { path, request: { task, settings, campaignPath: path } };
}

function turn(index: number, onStarted?: () => Promise<void>): Reply[] {
  return [
    {
      submission: {
        solution: false,
        notes: [{ text: `Partial result ${index}.`, support: [] }],
      },
      ...(onStarted === undefined ? {} : { onStarted }),
    },
    {
      submission: {
        filings: [{ note: `n${index}`, summary: `Partial result ${index}.` }],
        explorerGuidance: "Prove the remaining case.",
        support: [],
        verify: [],
      },
    },
  ];
}

function records(path: string) {
  const reader = openReader(path);
  try {
    return [...reader.records()];
  } finally {
    reader.close();
  }
}

async function cli(path: string, ...args: string[]) {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../solve.ts"), ...args],
    {
      cwd: dirname(path),
      env: { PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("guidance leaves default inspection, settings, and historical entries unchanged", async () => {
  const { path, request } = await setup();
  const before = records(path);
  const report = await inspectCampaign(path);
  const receipt = await guideCampaign(path, first, "strategy-1");
  expect(receipt).toMatchObject({
    id: "strategy-1",
    text: first,
    schemaVersion: 1,
  });
  expect(records(path).slice(0, before.length)).toEqual(before);
  expect(await inspectCampaign(path)).toEqual(report);
  expect(await inspectCampaign(path, { includeGuidance: true })).toMatchObject({
    guidance: [{ id: "strategy-1", pending: true, calls: [] }],
  });
  const drive = dependencies([...turn(1), ...turn(2)]);
  expect((await run(request, drive)).outcome).toBe("turn-limit");
  const explorers = drive.calls.filter((call) => call.role === "explorer");
  expect(explorers).toHaveLength(2);
  expect(explorers[0]!.prompt.split(first)).toHaveLength(2);
  expect(explorers[1]!.prompt).not.toContain(first);
  expect(explorers[1]!.prompt).toContain("Prove the remaining case.");
  for (const call of drive.calls.filter((call) => call.role !== "explorer"))
    expect(call.system).not.toContain(first);
  const delivered = inspectGuidance(records(path));
  expect(delivered[0]!.pending).toBe(false);
  expect(delivered[0]!.calls).toHaveLength(1);
  const ended = readFileSync(path);
  expect(await guideCampaign(path, first, "strategy-1")).toEqual(receipt);
  await expect(guideCampaign(path, second, "strategy-1")).rejects.toThrow(
    "different text",
  );
  expect(readFileSync(path)).toEqual(ended);
  const terminal = await inspectCampaign(path);
  await guideCampaign(path, second, "strategy-2");
  expect(inspectGuidance(records(path))[1]).toMatchObject({
    pending: true,
    calls: [],
  });
  expect(await inspectCampaign(path)).toEqual(terminal);
  expect((await run(request, dependencies([]))).outcome).toBe("turn-limit");
});

test("another process can guide an active explorer without changing its request or runner lock", async () => {
  const { path, request } = await setup();
  const textPath = join(dirname(path), "guidance.txt");
  writeFileSync(textPath, first);
  const drive = dependencies([
    ...turn(1, async () => {
      const active = records(path).find(
        (entry) => entry.kind === "call" && entry.role === "explorer",
      )!;
      const receipt = await cli(
        path,
        "guide",
        "--id",
        "live-1",
        path,
        textPath,
      );
      expect(receipt.code, receipt.stderr).toBe(0);
      expect(JSON.parse(receipt.stdout).id).toBe("live-1");
      expect(records(path).find((entry) => entry.seq === active.seq)).toEqual(
        active,
      );
      expect(inspectGuidance(records(path))[0]!.pending).toBe(true);
      await expect(run(request, dependencies([]))).rejects.toThrow(
        "already has a running process",
      );
    }),
    ...turn(2),
  ]);
  expect((await run(request, drive)).outcome).toBe("turn-limit");
  const explorers = drive.calls.filter((call) => call.role === "explorer");
  expect(explorers[0]!.prompt).not.toContain(first);
  expect(explorers[1]!.prompt).toContain(first);
  expect(inspectGuidance(records(path))[0]!.calls).toHaveLength(1);
});

test("guidance submitted after a frozen boundary waits through its retries and reaches the next turn", async () => {
  const { path, request } = await setup();
  await guideCampaign(path, first, "a");
  const initial = dependencies([
    { state: "failed", error: "provider unavailable" },
  ]);
  expect((await run(request, initial)).outcome).toBe("call-failure");
  const before = records(path);
  await guideCampaign(path, second, "b");
  const rest = dependencies([...turn(1), ...turn(2)]);
  expect((await run(request, rest)).outcome).toBe("turn-limit");
  const explorers = rest.calls.filter((call) => call.role === "explorer");
  expect(explorers[0]!.prompt).toBe(initial.calls[0]!.prompt);
  expect(explorers[0]!.prompt).not.toContain(second);
  expect(explorers[1]!.prompt).toContain(second);
  expect(explorers[1]!.prompt).not.toContain(first);
  expect(records(path).slice(0, before.length)).toEqual(before);
  expect(
    inspectGuidance(records(path)).map((entry) => entry.calls.length),
  ).toEqual([2, 1]);
});

test("a crash after freezing guidance but before starting Explorer preserves the boundary", async () => {
  const { path, request } = await setup();
  await guideCampaign(path, first, "a");
  const campaign = openCampaign(path);
  const snapshot = await deriveWorkflow(campaign.records());
  expect(await freezeExplorerGuidance(campaign, snapshot.explorerAfter!)).toBe(
    true,
  );
  campaign.close();
  await guideCampaign(path, second, "b");
  const rest = dependencies([...turn(1), ...turn(2)]);
  expect((await run(request, rest)).outcome).toBe("turn-limit");
  const explorers = rest.calls.filter((call) => call.role === "explorer");
  expect(explorers[0]!.prompt).toContain(first);
  expect(explorers[0]!.prompt).not.toContain(second);
  expect(explorers[1]!.prompt).toContain(second);
  expect(explorers[1]!.prompt).not.toContain(first);
});

test("concurrent CLI retries through a path alias append one guidance request", async () => {
  const { path } = await setup();
  const alias = join(dirname(path), "alias.db");
  symlinkSync(path, alias);
  const textPath = join(dirname(path), "guidance.txt");
  writeFileSync(textPath, first);
  const results = await Promise.all(
    [path, alias].map((target) =>
      cli(path, "guide", "--id", "same", target, textPath),
    ),
  );
  for (const result of results) expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(results[0]!.stdout)).toEqual(
    JSON.parse(results[1]!.stdout),
  );
  expect(inspectGuidance(records(path))).toHaveLength(1);
  const report = await cli(path, "inspect", "--include-guidance", path);
  expect(report.code, report.stderr).toBe(0);
  expect(JSON.parse(report.stdout).guidance[0]).toMatchObject({
    id: "same",
    pending: true,
  });
});

test("coordinator guidance and external advice share the next Explorer input without duplicate records", async () => {
  const { path, request } = await setup();
  const initial = dependencies(turn(1));
  expect(
    await run(request, {
      ...initial,
      pauseRequested: () => initial.calls.length === 2,
    }),
  ).toMatchObject({ outcome: "paused", at: "explorer" });
  const before = records(path);
  expect(
    before.filter((entry) => entry.kind === "call").map((entry) => entry.label),
  ).toEqual([
    "xean-solve/allowance",
    roleLabels.explorer,
    roleLabels.coordinator,
  ]);
  await guideCampaign(path, first, "outside-advice");
  const rest = dependencies(turn(2));
  expect((await run(request, rest)).outcome).toBe("turn-limit");
  expect(rest.calls[0]!.prompt).toContain(
    `Explorer guidance (fallible advice):\nProve the remaining case.\n\n${first}`,
  );
  expect(rest.calls[0]!.prompt.split("Prove the remaining case.")).toHaveLength(
    2,
  );
  expect(rest.calls[0]!.system).not.toContain(first);
  expect(records(path).slice(0, before.length)).toEqual(before);
  expect(
    records(path).filter(
      (entry) =>
        entry.kind === "call" && entry.label === roleLabels.coordinator,
    ),
  ).toHaveLength(2);
});

test("process death after guidance and boundary requests preserves receipt and replay", async () => {
  const { path, request } = await setup();
  for (const mode of ["submit", "freeze"]) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/guidance-crash.ts"),
        path,
        mode,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [error, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(73);
  }
  const before = records(path);
  expect(
    (await guideCampaign(path, "Use the direct construction.", "crash-1")).call,
  ).toBe(4);
  expect(records(path)).toEqual(before);
  await guideCampaign(path, second, "later");
  const drive = dependencies([...turn(1), ...turn(2)]);
  expect((await run(request, drive)).outcome).toBe("turn-limit");
  const explorers = drive.calls.filter((call) => call.role === "explorer");
  expect(explorers[0]!.prompt).toContain("Use the direct construction.");
  expect(explorers[0]!.prompt).not.toContain(second);
  expect(explorers[1]!.prompt).toContain(second);
  expect(explorers[1]!.prompt).not.toContain("Use the direct construction.");
});

test("a run without external advice adds no guidance calls", async () => {
  const { path, request } = await setup(1);
  const drive = dependencies(turn(1));
  const start = records(path)[0];
  expect(start).toMatchObject({ config: { schemaVersion: 21 } });
  const baseline = await inspectCampaign(path);
  expect(baseline).not.toHaveProperty("guidance");
  await run(request, drive);
  expect(
    records(path)
      .filter((entry) => entry.kind === "call")
      .map((entry) => entry.label),
  ).toEqual([
    "xean-solve/allowance",
    roleLabels.explorer,
    roleLabels.coordinator,
  ]);
  expect(records(path)[0]).toEqual(start);
});

test("unknown settings and unsupported workflow schemas are rejected without rewriting journals", async () => {
  const { path, request } = await setup();
  const before = readFileSync(path);
  await expect(
    run(
      {
        ...request,
        settings: { ...request.settings, unknownSetting: true },
      } as never,
      dependencies([]),
    ),
  ).rejects.toThrow();
  expect(readFileSync(path)).toEqual(before);
  const invalid = join(dirname(path), "invalid-schema.db");
  createCampaign(
    invalid,
    applicationId,
    jsonSnapshot({
      ...workflowConfiguration({ task, settings: request.settings }),
      schemaVersion: 0,
    }),
  ).close();
  const invalidBytes = readFileSync(invalid);
  await expect(guideCampaign(invalid, first)).rejects.toThrow();
  await expect(
    run({ ...request, campaignPath: invalid }, dependencies([])),
  ).rejects.toThrow();
  expect(readFileSync(invalid)).toEqual(invalidBytes);
});

test("invalid guidance fails without creating a campaign or changing its records", async () => {
  const { path } = await setup();
  const before = readFileSync(path);
  await expect(guideCampaign(path, " \n", "empty")).rejects.toThrow();
  await expect(guideCampaign(path, first, " ")).rejects.toThrow();
  expect(readFileSync(path)).toEqual(before);
  const missing = join(dirname(path), "missing.db");
  await expect(guideCampaign(missing, first)).rejects.toThrow("does not exist");
  expect(existsSync(missing)).toBe(false);
  const calls = join(dirname(path), "roles.db");
  createCampaign(calls, applicationId, { kind: "calls" }).close();
  await expect(guideCampaign(calls, first)).rejects.toThrow();
});
