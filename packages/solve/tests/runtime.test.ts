import { afterEach, expect, test } from "bun:test";
import { existsSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { withCampaignLock } from "../runtime";
import { run } from "../runner";
import { inspectCampaign } from "../role-cli";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
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
  const settings = { ...roleSettings(), maxExplorerTurns: 1 };
  const request = {
    task: { problem: "P", completionCriteria: "Prove P" },
    campaignPath: path,
    settings,
  };
  const drive = dependencies([
    { submission: { notes: [{ text: "An unfinished idea.", support: [] }] } },
    {
      submission: {
        filings: [{ note: "n1", summary: "An unfinished idea." }],
        explorerGuidance: "Prove P",
        support: [],
        verify: [],
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

test("run honors an injected source executor instead of invoking the CLI", async () => {
  const path = campaignPath();
  const previous = process.env["XEAN_CODEX_COMMAND"];
  process.env["XEAN_CODEX_COMMAND"] = join(dirname(path), "codex-must-not-run");
  try {
    const drive = dependencies([
      { submission: { notes: [{ text: "Proof of P.", support: [] }] } },
      {
        submission: {
          filings: [{ note: "n1", summary: "P holds." }],
          explorerGuidance: "Prove P.",
          support: [],
          verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
        },
      },
      {
        submission: {
          verdicts: [
            {
              note: "n1",
              verdict: "PASS",
              report: "Conditional on the external theorem.",
              externalResults: ["P is the cited external theorem."],
            },
          ],
        },
      },
      {
        codex: {
          verdicts: [
            {
              note: "n1",
              verdict: "INCONCLUSIVE",
              report: "Source unavailable.",
              externalResults: ["P is the cited external theorem."],
              sources: [],
            },
          ],
        },
      },
    ]);
    expect(
      await run(
        {
          task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
          campaignPath: path,
          settings: { ...roleSettings(), maxExplorerTurns: 1 },
        },
        drive,
      ),
    ).toMatchObject({ outcome: "turn-limit", turns: 1 });
    expect(drive.codexCalls).toHaveLength(1);
    expect(drive.calls).toHaveLength(3);
    expect(await inspectCampaign(path)).toMatchObject({
      phase: "turn-limit",
      result: {
        schemaVersion: 1,
        application: "xean-solve",
        protocol: "workflow",
        outcome: "turn-limit",
        turns: 1,
      },
    });
  } finally {
    if (previous === undefined) delete process.env["XEAN_CODEX_COMMAND"];
    else process.env["XEAN_CODEX_COMMAND"] = previous;
  }
});

test("only one process may own a campaign", async () => {
  const path = campaignPath();
  await withCampaignLock(path, async () => {
    expect(existsSync(`${path}.runner.lock`)).toBe(true);
    await expect(
      withCampaignLock(path, async () => {
        throw new Error("the contender must never run");
      }),
    ).rejects.toThrow("campaign already has a running process");
  });
});

test("campaign lock resolves path aliases", async () => {
  const path = campaignPath();
  const alias = join(dirname(path), "campaign-alias.db");
  writeFileSync(path, "");
  symlinkSync(basename(path), alias);

  await withCampaignLock(path, async () => {
    await expect(
      withCampaignLock(alias, async () => {
        throw new Error("the alias contender must never run");
      }),
    ).rejects.toThrow("campaign already has a running process");
  });
});
