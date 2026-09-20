import { afterEach, expect, test } from "bun:test";
import { createCampaign, openCampaign, openReader } from "xean";

import { allowanceLabel, turnAllowances } from "../allowance";
import {
  guideCampaign,
  inspectCampaign,
  inspectCampaignRecords,
  submitNotes,
} from "../role-cli";
import { applicationId } from "../roles";
import { init, run } from "../runner";
import { withCampaignLock } from "../runtime";
import { workflowConfiguration } from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
function records(path: string) {
  const reader = openReader(path);
  try {
    return [...reader.records()];
  } finally {
    reader.close();
  }
}
function emptyTurn(): Reply[] {
  return [
    { submission: { notes: [], solution: false } },
    {
      submission: {
        filings: [],
        support: [],
        verify: [],
        explorerGuidance: "Try another route.",
      },
    },
  ];
}

test("additional allowances preserve source evidence, failures, support, guidance, spending, and original settings", async () => {
  const path = campaignPath();
  const request = { task, settings: roleSettings(), campaignPath: path };
  const first = dependencies([
    {
      submission: {
        solution: false,
        notes: [
          { text: "An external lemma.", support: [] },
          { text: "A false proposed route.", support: [] },
        ],
      },
    },
    {
      submission: {
        filings: [
          { note: "n1", summary: "A useful lemma." },
          { note: "n2", summary: "A possible route." },
        ],
        support: ["n1"],
        explorerGuidance: "Use the verified lemma.",
        verify: [
          { note: "n1", verifiers: ["correctness", "source"] },
          { note: "n2", verifiers: ["correctness", "source"] },
        ],
      },
    },
    {
      submission: {
        verdicts: [
          {
            note: "n1",
            verdict: "PASS",
            report: "Exact external premise.",
            externalResults: ["Theorem T"],
          },
          {
            note: "n2",
            verdict: "FAIL",
            report: "A counterexample rules out this route.",
            externalResults: [],
          },
        ],
      },
    },
    {
      codex: {
        verdicts: [
          {
            note: "n1",
            verdict: "PASS",
            report: "Primary source checked.",
            externalResults: ["Theorem T"],
            sources: [
              {
                result: "Theorem T",
                source: "Theorem 1",
                url: "https://example.org/theorem",
                quote: "The exact theorem T.",
              },
            ],
          },
        ],
      },
    },
  ]);
  expect(await run({ ...request, turns: 1 }, first)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
  const before = records(path);
  expect(before[0]).not.toHaveProperty("config.settings.maxExplorerTurns");
  const oldInspection = await inspectCampaign(path);
  await guideCampaign(
    path,
    "Do not repeat the counterexample route.",
    "advice",
  );
  await submitNotes(
    path,
    { notes: [{ text: "A new consequence of the lemma.", support: ["n1"] }] },
    "new-work",
  );
  const rest = dependencies([
    {
      submission: {
        filings: [{ note: "n3", summary: "Consequence of the lemma." }],
        support: ["n1", "n3"],
        verify: [],
        explorerGuidance: "Use these two notes.",
      },
    },
    {
      submission: {
        solution: false,
        notes: [{ text: "Further partial progress.", support: ["n1", "n3"] }],
      },
    },
    {
      submission: {
        filings: [{ note: "n4", summary: "Partial progress." }],
        support: ["n4"],
        verify: [],
        explorerGuidance: "Continue the proof.",
      },
    },
  ]);
  expect(await run({ ...request, turns: 1, id: "more" }, rest)).toMatchObject({
    outcome: "turn-limit",
    turns: 2,
    notes: [
      { id: "n1", verified: true },
      { id: "n2", dead: true },
      { id: "n3", support: ["n1"] },
      { id: "n4", support: ["n1", "n3"] },
    ],
  });
  expect(rest.calls.map(({ role }) => role)).toEqual([
    "coordinator",
    "explorer",
    "coordinator",
  ]);
  expect(rest.calls[1]!.prompt).toContain(
    "Do not repeat the counterexample route.",
  );
  expect(rest.calls[1]!.prompt).toContain(
    "A counterexample rules out this route.",
  );
  expect(rest.codexCalls).toHaveLength(0);
  expect(records(path).slice(0, before.length)).toEqual(before);
  expect(await inspectCampaignRecords(before)).toEqual(oldInspection);
  expect(await inspectCampaign(path)).toMatchObject({
    maxExplorerTurns: 2,
    allowances: [
      { turns: 1, afterTurns: 0 },
      { id: "more", turns: 1, afterTurns: 1 },
    ],
  });
  const settled = records(path);
  expect(
    await run({ ...request, turns: 1, id: "more" }, dependencies([])),
  ).toMatchObject({ outcome: "turn-limit", turns: 2 });
  expect(await run(request, dependencies([]))).toMatchObject({ turns: 2 });
  expect(records(path)).toEqual(settled);
  expect((await inspectCampaign(path)) as object).toHaveProperty("spend");
});

test("an interrupted allowance is resumed with its ID, without granting more turns", async () => {
  const path = campaignPath();
  const request = {
    task,
    settings: roleSettings(),
    campaignPath: path,
    turns: 2,
    id: "batch-1",
  };
  const first = dependencies(emptyTurn());
  expect(
    await run(request, {
      ...first,
      pauseRequested: () => first.calls.length === 2,
    }),
  ).toMatchObject({ outcome: "paused" });
  const before = records(path);
  await expect(
    run({ ...request, id: "batch-2" }, dependencies([])),
  ).rejects.toThrow("turn limit");
  await expect(run({ ...request, turns: 3 }, dependencies([]))).rejects.toThrow(
    "different turns",
  );
  expect(records(path)).toEqual(before);
  expect(await run(request, dependencies(emptyTurn()))).toMatchObject({
    outcome: "turn-limit",
    turns: 2,
  });
  expect(turnAllowances(records(path))).toHaveLength(1);
});

test("default allowance is outside config and invalid requests do not mutate it", async () => {
  const path = campaignPath();
  const request = { task, settings: roleSettings(), campaignPath: path };
  await init(request);
  const before = records(path);
  expect(turnAllowances(before)).toMatchObject([{ turns: 10, afterTurns: 0 }]);
  for (const turns of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(
      run({ ...request, turns, id: "bad" }, dependencies([])),
    ).rejects.toThrow();
  }
  await expect(
    run({ ...request, id: "bad" }, dependencies([])),
  ).rejects.toThrow();
  await expect(
    run(
      {
        ...request,
        settings: { ...request.settings, maxExplorerTurns: 1 },
      } as never,
      dependencies([]),
    ),
  ).rejects.toThrow();
  await withCampaignLock(path, async () => {
    await expect(run(request, dependencies([]))).rejects.toThrow(
      "running process",
    );
  });
  expect(records(path)).toEqual(before);
});

test("an allowance request survives a missing receipt, and init recovers a declaration-only interruption", async () => {
  const path = campaignPath();
  const request = { task, settings: roleSettings(), campaignPath: path };
  createCampaign(
    path,
    applicationId,
    workflowConfiguration({ task, settings: request.settings }),
  ).close();
  await init({ ...request, turns: 1 });
  await run(request, dependencies(emptyTurn()));
  const campaign = openCampaign(path);
  await expect(
    campaign.call(
      {
        label: allowanceLabel,
        request: { schemaVersion: 1, id: "durable", turns: 1, afterTurns: 1 },
      },
      async () => {
        throw new Error("receipt lost");
      },
    ),
  ).rejects.toThrow("receipt lost");
  campaign.close();
  expect(
    await run(
      { ...request, turns: 1, id: "durable" },
      dependencies(emptyTurn()),
    ),
  ).toMatchObject({ outcome: "turn-limit", turns: 2 });
  expect(turnAllowances(records(path))).toHaveLength(2);
});
