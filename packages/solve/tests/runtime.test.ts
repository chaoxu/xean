import { afterEach, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { withCampaignLock } from "../runtime";
import { run } from "../runner";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  dispatchExplorer,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);

test("an unknown late verifier model fails before creating a campaign or making a call", async () => {
  const path = campaignPath();
  const drive = dependencies([]);
  const settings = roleSettings();
  settings.reconstruction = {
    ...settings.reconstruction,
    model: "missing-model",
  };
  await expect(
    run(
      {
        task: { problem: "P", completionCriteria: "Prove P" },
        campaignPath: path,
        settings,
      },
      drive,
    ),
  ).rejects.toThrow("reconstruction: unknown Pi model: test/missing-model");
  expect(existsSync(path)).toBe(false);
  expect(drive.calls).toHaveLength(0);
  expect(drive.codexCalls).toHaveLength(0);
});

test("missing provider credentials fail before exploration and campaign creation", async () => {
  const path = campaignPath();
  const drive = dependencies([]);
  const checked: string[] = [];
  await expect(
    run(
      {
        task: { problem: "P", completionCriteria: "Prove P" },
        campaignPath: path,
        settings: roleSettings(),
      },
      {
        ...drive,
        models: {
          ...drive.models,
          async checkAuth(provider) {
            checked.push(provider);
            return undefined;
          },
        },
      },
    ),
  ).rejects.toThrow("No credential for provider(s): test");
  expect(checked).toEqual(["test"]);
  expect(existsSync(path)).toBe(false);
  expect(drive.calls).toHaveLength(0);
});

test("unsupported late-role reasoning is rejected before any provider call", async () => {
  const path = campaignPath();
  const drive = dependencies([]);
  const settings = roleSettings();
  settings.reconstruction = { ...settings.reconstruction, reasoning: "max" };
  await expect(
    run(
      {
        task: { problem: "P", completionCriteria: "Prove P" },
        campaignPath: path,
        settings,
      },
      drive,
    ),
  ).rejects.toThrow("reconstruction: unsupported reasoning level max");
  expect(existsSync(path)).toBe(false);
  expect(drive.calls).toHaveLength(0);
});

test("a completed campaign is returned before initializing models or checking credentials", async () => {
  const path = campaignPath();
  const settings = roleSettings();
  const request = {
    task: { problem: "P", completionCriteria: "Prove P" },
    campaignPath: path,
    settings,
    turns: 1,
  };
  const drive = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
        notes: [{ text: "An unfinished idea.", support: [] }],
      },
    },
  ]);
  const first = await run(request, drive);
  expect(first.outcome).toBe("turn-limit");
  const before = await Bun.file(path).arrayBuffer();
  expect(
    await run(request, {
      models: async () => {
        throw new Error("must not initialize provider");
      },
    }),
  ).toEqual(first);
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
});

test("run injects Codex without preflighting the CLI", async () => {
  const path = campaignPath();
  const previous = process.env["XEAN_CODEX_COMMAND"];
  process.env["XEAN_CODEX_COMMAND"] = join(dirname(path), "codex-must-not-run");
  try {
    const settings = roleSettings();
    settings.coordinatorBehavior = {
      ...settings.coordinatorBehavior,
      literature: "required-if-not-started",
    };
    const drive = dependencies([
      {
        submission: {
          filings: [],
          action: { role: "literature", request: "Find P." },
        },
      },
      { codex: { notes: [] } },
    ]);
    expect(
      await run(
        {
          task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
          campaignPath: path,
          settings,
          turns: 1,
        },
        drive,
      ),
    ).toMatchObject({ outcome: "turn-limit", turns: 1 });
    expect(drive.codexCalls).toHaveLength(1);
    expect(drive.calls).toHaveLength(1);
  } finally {
    if (previous === undefined) delete process.env["XEAN_CODEX_COMMAND"];
    else process.env["XEAN_CODEX_COMMAND"] = previous;
  }
});

test("campaign locking excludes direct and aliased contenders", async () => {
  const path = campaignPath();
  const alias = join(dirname(path), "campaign-alias.db");
  writeFileSync(path, "");
  symlinkSync(basename(path), alias);

  await withCampaignLock(path, async () => {
    for (const contender of [path, alias]) {
      await expect(
        withCampaignLock(contender, async () => {
          throw new Error("the contender must never run");
        }),
      ).rejects.toThrow("campaign already has a running process");
    }
  });
});
