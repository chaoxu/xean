import { afterEach, expect, test } from "bun:test";
import { openCampaign, openReader } from "xean";

import { coordinatorCall, createPiRoles, literatureCall } from "../pi-roles";
import { appendAllowance, turnAllowances } from "../allowance";
import { inspectCampaign, submitNotes } from "../role-cli";
import { init, run } from "../runner";
import { runWorkflow, workflowConfiguration } from "../workflow";
import { codexRequest } from "../source";
import { codexStdout } from "./fixtures/codex-stdout";
import {
  defaultCoordinatorBehavior,
  jsonSnapshot,
  literatureReport,
  pendingVerifiers,
  roleLabels,
  type CoordinatorAction,
  type Verification,
} from "../roles";
import {
  campaignPath,
  cleanupCampaigns,
  createWorkflowCampaign,
  dependencies,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);

const task = {
  problem: "Prove P.",
  completionCriteria: "Give a complete proof of P.",
};
const good = { text: "Complete proof of P.", support: [] };
const all: Verification["verifiers"] = [
  "correctness",
  "source",
  "requirements",
  "reconstruction",
];

const coordination = (
  action: CoordinatorAction,
  verify: Verification[] = [],
  filings: { note: string; summary: string }[] = [],
) => ({
  filings,
  ...(action.role === "explorer"
    ? {
        explorerGuidance: "Choose the next useful mathematical step.",
        support: [],
      }
    : {}),
  verify,
  action,
});

const passes = [
  {
    submission: {
      verdicts: [
        {
          note: "n2",
          verdict: "PASS",
          report: "Correct.",
          externalResults: [],
        },
      ],
    },
  },
  {
    submission: {
      verdicts: [{ note: "n2", verdict: "PASS", report: "Meets the task." }],
    },
  },
  { submission: { statement: "P." } },
  { submission: { proof: "A proof of P." } },
  {
    submission: {
      statement: null,
      verdicts: [{ note: "n2", verdict: "PASS", report: "Independent." }],
    },
  },
];

test("the workflow starts with the coordinator and returns to it after literature", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    coordinatorBehavior: {
      literature: "required-if-not-started" as const,
      verification: "decide" as const,
    },
  };
  const workflow = workflowConfiguration({ task, settings });
  const campaign = await createWorkflowCampaign(path, workflow, 12);
  const drive = dependencies([
    {
      submission: coordination({
        role: "literature",
        request: "Find prior work on P.",
      }),
    },
    {
      codex: {
        notes: [
          {
            text: "A cited result relevant to P. Source: Example et al., Theorem 1.",
            support: [],
          },
        ],
      },
    },
    {
      submission: coordination(
        { role: "explorer" },
        [],
        [{ note: "n1", summary: "A cited result relevant to P." }],
      ),
    },
    { submission: { solution: false, notes: [good] } },
    {
      submission: coordination(
        { role: "verifier" },
        [{ note: "n2", verifiers: all }],
        [{ note: "n2", summary: "P." }],
      ),
    },
    ...passes,
  ]);
  let accepted = false;
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase.kind).toBe("accepted");
    accepted = phase.kind === "accepted";
    expect(drive.allCalls.map(({ label }) => label)).toEqual([
      "xean-solve/coordinator",
      "xean-solve/literature",
      "xean-solve/coordinator",
      "xean-solve/explorer",
      "xean-solve/coordinator",
      "xean-solve/verifier/correctness",
      "xean-solve/verifier/requirements",
      "xean-solve/verifier/reconstruction/statement",
      "xean-solve/verifier/reconstruction/proof",
      "xean-solve/verifier/reconstruction",
    ]);
    expect(drive.allCalls[1]?.prompt).toContain('"problemToSolve": "Prove P."');
    expect(drive.allCalls[1]?.prompt).toContain(
      '"completionCriteria": "Give a complete proof of P."',
    );
    expect(drive.allCalls[1]?.prompt).toContain(
      '"request": "Find prior work on P."',
    );
    expect(drive.allCalls[2]?.prompt).toContain(
      "A cited result relevant to P.",
    );
  } finally {
    campaign.close();
  }
  expect(accepted).toBe(true);
  const inspection = (await inspectCampaign(path)) as {
    readonly notes: readonly unknown[];
    readonly calls: readonly {
      readonly role: string;
      readonly submission?: unknown;
    }[];
  };
  expect(inspection.notes).toContainEqual(
    expect.objectContaining({
      id: "n1",
      text: "A cited result relevant to P. Source: Example et al., Theorem 1.",
    }),
  );
  expect(
    inspection.calls.find(({ role }) => role === "literature")?.submission,
  ).toMatchObject({
    notes: [
      {
        text: "A cited result relevant to P. Source: Example et al., Theorem 1.",
        support: [],
      },
    ],
  });
});

test("a repeated literature request after a failed search runs a fresh call, and none after a completed one", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    coordinatorBehavior: {
      literature: "optional" as const,
      verification: "decide" as const,
    },
  };
  const workflow = workflowConfiguration({ task, settings });
  const campaign = await createWorkflowCampaign(path, workflow, 3);
  const search = coordination({
    role: "literature",
    request: "Find prior work on P.",
  });
  const drive = dependencies([
    { submission: search },
    { codex: {}, state: "failed", error: "gateway unavailable" },
    // The failed search leaves literature inconclusive, so the same request
    // runs a fresh call instead of reusing the failed one.
    { submission: search },
    { codex: { notes: [{ text: "A cited result.", support: [] }] } },
    {
      submission: coordination(
        { role: "explorer" },
        [],
        [{ note: "n1", summary: "A cited result." }],
      ),
    },
    { submission: { solution: false, notes: [] } },
  ]);
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase.kind).toBe("turn-limit");
    expect(drive.allCalls.map(({ label }) => label)).toEqual([
      "xean-solve/coordinator",
      "xean-solve/literature",
      "xean-solve/coordinator",
      "xean-solve/literature",
      "xean-solve/coordinator",
      "xean-solve/explorer",
    ]);
    expect(drive.allCalls[2]?.prompt).toContain(
      "Literature status: inconclusive",
    );
    expect(drive.allCalls[4]?.prompt).toContain("Literature status: completed");
    expect(
      campaign
        .records({ kinds: ["call"], labels: ["xean-solve/notes"] })
        .map((entry) => entry.kind === "call" && entry.request),
    ).toEqual([
      expect.objectContaining({
        notes: [{ text: "A cited result.", support: [] }],
      }),
    ]);
  } finally {
    campaign.close();
  }
  // After a completed search the coordinator schema has no literature action.
  const completed = coordinatorCall({
    task,
    notes: [],
    literatureStatus: "completed",
    coordinatorBehavior: settings.coordinatorBehavior,
  });
  const base = {
    filings: [],
    explorerGuidance: "Explore.",
    support: [],
    verify: [],
  };
  expect(
    completed.schema.safeParse({
      ...base,
      action: { role: "literature", request: "Again." },
    }).success,
  ).toBe(false);
  expect(
    completed.schema.safeParse({ ...base, action: { role: "explorer" } })
      .success,
  ).toBe(true);
});

test("a note submitted while an explorer phase waits returns to the coordinator", async () => {
  const path = campaignPath();
  const settings = roleSettings();
  const request = { task, settings, campaignPath: path, turns: 2 };
  await init(request);
  // The coordinator settles, then the process stops before any explorer call.
  await expect(
    run(
      request,
      dependencies([{ submission: coordination({ role: "explorer" }) }]),
    ),
  ).rejects.toThrow("no reply for xean-solve/explorer");
  const supplied = "A separately supplied lemma with its full proof.";
  await submitNotes(path, { notes: [{ text: supplied, support: [] }] }, "idle");
  const drive = dependencies([
    {
      submission: coordination(
        { role: "explorer" },
        [],
        [{ note: "n1", summary: "A supplied lemma." }],
      ),
    },
    { submission: { solution: false, notes: [good] } },
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "turn-limit",
    turns: 2,
  });
  expect(drive.allCalls.map(({ role }) => role)).toEqual([
    "coordinator",
    "explorer",
  ]);
  expect(drive.allCalls[0]?.prompt).toContain(supplied);
  const inspection = (await inspectCampaign(path, {
    includeSubmissions: true,
  })) as {
    readonly notes: readonly { readonly id: string }[];
    readonly submissions: readonly unknown[];
  };
  expect(inspection.notes.map(({ id }) => id)).toEqual(["n1", "n2"]);
  expect(inspection.submissions).toMatchObject([
    { id: "idle", pending: false, noteIds: ["n1"] },
  ]);
});

test("an allowance extends a campaign by whole turns", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    coordinatorBehavior: {
      literature: "optional" as const,
      verification: "decide" as const,
    },
  };
  const request = { task, settings, campaignPath: path, turns: 1 };
  await init(request);
  const first = dependencies([
    {
      submission: coordination({
        role: "literature",
        request: "Find prior work on P.",
      }),
    },
    { codex: { notes: [] } },
  ]);
  expect(await run(request, first)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
  // Without a new allowance the campaign stays stopped and makes no call.
  expect(await run(request, dependencies([]))).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
  const more = dependencies([
    { submission: coordination({ role: "explorer" }) },
    { submission: { solution: false, notes: [good] } },
  ]);
  expect(await run({ ...request, turns: 1, id: "more" }, more)).toMatchObject({
    outcome: "turn-limit",
    turns: 2,
  });
  expect(more.allCalls.map(({ role }) => role)).toEqual([
    "coordinator",
    "explorer",
  ]);
  expect(more.allCalls[0]?.prompt).toContain("Literature status: completed");
  expect(await inspectCampaign(path)).toMatchObject({
    maxTurns: 2,
    allowances: [
      { turns: 1, afterTurns: 0 },
      { id: "more", turns: 1, afterTurns: 1 },
    ],
    phase: "turn-limit",
  });
  const opened = openCampaign(path);
  try {
    await expect(appendAllowance(opened, 3, 0, "direct")).rejects.toThrow(
      "invalid turn allowance sequence",
    );
    expect(turnAllowances(opened.records())).toHaveLength(2);
  } finally {
    opened.close();
  }
});

test("a failed literature call settles without candidates and reports inconclusive", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    coordinatorBehavior: {
      literature: "optional" as const,
      verification: "decide" as const,
    },
  };
  const workflow = workflowConfiguration({ task, settings });
  const campaign = await createWorkflowCampaign(path, workflow, 2);
  const drive = dependencies([
    {
      submission: coordination({
        role: "literature",
        request: "Find prior work on P.",
      }),
    },
    { codex: {}, state: "failed", error: "gateway unavailable" },
    { submission: coordination({ role: "explorer" }) },
    { submission: { solution: false, notes: [good] } },
  ]);
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase.kind).toBe("turn-limit");
    expect(drive.allCalls.map(({ label }) => label)).toEqual([
      "xean-solve/coordinator",
      "xean-solve/literature",
      "xean-solve/coordinator",
      "xean-solve/explorer",
    ]);
    expect(drive.allCalls[2]?.prompt).toContain(
      "Literature status: inconclusive",
    );
    expect(
      campaign.records({ kinds: ["call"], labels: ["xean-solve/notes"] }),
    ).toHaveLength(0);
    expect(
      campaign.records({ kinds: ["call"], labels: ["xean-solve/literature"] }),
    ).toHaveLength(1);
  } finally {
    campaign.close();
  }
});

test("a coordinator verifier action drains its list in window batches before the next coordinator", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    window: 1,
  };
  const workflow = workflowConfiguration({ task, settings });
  const campaign = await createWorkflowCampaign(path, workflow, 2);
  const partial = (id: string) => ({
    note: id,
    verdict: "PASS",
    report: "Correct.",
    externalResults: [],
  });
  const drive = dependencies([
    { submission: coordination({ role: "explorer" }) },
    {
      submission: {
        solution: false,
        notes: [
          { text: "Lemma A.", support: [] },
          { text: "Lemma B.", support: [] },
        ],
      },
    },
    {
      submission: coordination(
        { role: "verifier" },
        [
          { note: "n1", verifiers: ["correctness", "source"] },
          { note: "n2", verifiers: ["correctness", "source"] },
        ],
        [
          { note: "n1", summary: "Lemma A." },
          { note: "n2", summary: "Lemma B." },
        ],
      ),
    },
    { submission: { verdicts: [partial("n1")] } },
    { submission: { verdicts: [partial("n2")] } },
  ]);
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase.kind).toBe("turn-limit");
    expect(drive.allCalls.map(({ label }) => label)).toEqual([
      "xean-solve/coordinator",
      "xean-solve/explorer",
      "xean-solve/coordinator",
      "xean-solve/verifier/correctness",
      "xean-solve/verifier/correctness",
    ]);
    expect(campaign.records({ kinds: ["candidate"] })).toHaveLength(2);
    expect(
      phase.kind === "turn-limit" &&
        phase.notes.map(({ id, verified }) => [id, verified]),
    ).toEqual([
      ["n1", true],
      ["n2", true],
    ]);
  } finally {
    campaign.close();
  }
});

test("a coordinator can verify an omitted ready note immediately after another verification", async () => {
  const path = campaignPath();
  const settings = roleSettings();
  const request = { task, settings, campaignPath: path, turns: 3 };
  await init(request);
  const partial = (id: string) => ({
    note: id,
    verdict: "PASS",
    report: "Correct.",
    externalResults: [],
  });
  const checks: Verification["verifiers"] = ["correctness", "source"];
  const drive = dependencies([
    { submission: coordination({ role: "explorer" }) },
    {
      submission: {
        solution: false,
        notes: [
          { text: "Lemma A.", support: [] },
          { text: "Lemma B.", support: [] },
        ],
      },
    },
    {
      submission: coordination(
        { role: "verifier" },
        [{ note: "n1", verifiers: checks }],
        [
          { note: "n1", summary: "Lemma A." },
          { note: "n2", summary: "Lemma B." },
        ],
      ),
    },
    { submission: { verdicts: [partial("n1")] } },
    {
      submission: coordination({ role: "verifier" }, [
        { note: "n2", verifiers: checks },
      ]),
    },
    { submission: { verdicts: [partial("n2")] } },
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "turn-limit",
    turns: 3,
  });
  expect(drive.allCalls.map(({ label }) => label)).toEqual([
    "xean-solve/coordinator",
    "xean-solve/explorer",
    "xean-solve/coordinator",
    "xean-solve/verifier/correctness",
    "xean-solve/coordinator",
    "xean-solve/verifier/correctness",
  ]);
  expect(await inspectCampaign(path)).toMatchObject({
    phase: "turn-limit",
    notes: [
      { id: "n1", verified: true },
      { id: "n2", verified: true },
    ],
  });
});

test("completed checks cannot be repeated while omitted checks remain available", () => {
  const live = {
    id: "n1",
    summary: "A live result.",
    text: "A live result.",
    support: [],
    verdicts: [],
    verified: false,
    dead: false,
  };
  const checks: Verification["verifiers"] = ["correctness", "source"];
  const completed = {
    ...live,
    verified: true,
    verdicts: checks.map((verifier) => ({
      note: "n1",
      verifier,
      verdict: "PASS" as const,
      report: "Established.",
    })),
  };
  const input = {
    task,
    notes: [completed, { ...live, id: "n2" }],
    // A failed search keeps literature available; a completed one would not.
    literatureStatus: "inconclusive" as const,
    coordinatorBehavior: {
      literature: "optional" as const,
      verification: "always" as const,
    },
  };
  const open = coordinatorCall(input);
  expect(
    open.schema.safeParse(coordination({ role: "explorer" })).success,
  ).toBe(false);
  expect(
    open.schema.safeParse(
      coordination({ role: "verifier" }, [{ note: "n2", verifiers: checks }]),
    ).success,
  ).toBe(true);
  // Even a list containing the required fresh note cannot repeat n1's checks.
  expect(
    open.schema.safeParse(
      coordination({ role: "verifier" }, [
        { note: "n1", verifiers: checks },
        { note: "n2", verifiers: checks },
      ]),
    ).success,
  ).toBe(false);
  const decide = coordinatorCall({
    ...input,
    coordinatorBehavior: {
      ...input.coordinatorBehavior,
      verification: "decide",
    },
  });
  expect(
    decide.schema.safeParse(coordination({ role: "explorer" })).success,
  ).toBe(true);
  expect(
    decide.schema.safeParse(
      coordination({ role: "verifier" }, [{ note: "n1", verifiers: all }]),
    ).success,
  ).toBe(true);
});

test("inconclusive checks may be retried but failed prerequisites block later checks", () => {
  const partial = {
    id: "n1",
    summary: "A partial result.",
    text: "A partial result.",
    support: [],
    verified: false,
    dead: false,
    verdicts: [
      {
        note: "n1",
        verifier: "correctness" as const,
        verdict: "PASS" as const,
        report: "Correct.",
      },
      {
        note: "n1",
        verifier: "source" as const,
        verdict: "INCONCLUSIVE" as const,
        report: "Source unavailable.",
      },
    ],
  };
  expect(pendingVerifiers(partial, all)).toEqual([
    "source",
    "requirements",
    "reconstruction",
  ]);
  const retry = coordinatorCall({ task, notes: [partial] });
  expect(
    retry.schema.safeParse(
      coordination({ role: "verifier" }, [{ note: "n1", verifiers: all }]),
    ).success,
  ).toBe(true);
  const failed = {
    ...partial,
    verified: true,
    verdicts: [
      partial.verdicts[0]!,
      {
        note: "n1",
        verifier: "source" as const,
        verdict: "PASS" as const,
        report: "Source checked.",
      },
      {
        note: "n1",
        verifier: "requirements" as const,
        verdict: "FAIL" as const,
        report: "Only partial.",
      },
    ],
  };
  expect(pendingVerifiers(failed, all)).toEqual([]);
  const finished = coordinatorCall({ task, notes: [failed] });
  expect(
    finished.schema.safeParse(
      coordination({ role: "verifier" }, [{ note: "n1", verifiers: all }]),
    ).success,
  ).toBe(false);
  expect(
    finished.schema.safeParse(coordination({ role: "explorer" })).success,
  ).toBe(true);
});

test("an unusable literature response is replaced by a fresh call on resume", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    coordinatorBehavior: {
      literature: "optional" as const,
      verification: "decide" as const,
    },
  };
  const request = { task, settings, campaignPath: path, turns: 1 };
  await init(request);
  const search = coordination({
    role: "literature",
    request: "Find prior work on P.",
  });
  await expect(
    run(request, {
      ...dependencies([{ submission: search }]),
      codex: async () => ({
        state: "succeeded" as const,
        codexVersion: "fake",
        stdout: "not-json\n",
        stderr: "",
      }),
    }),
  ).resolves.toMatchObject({
    outcome: "call-failure",
    at: "literature",
    reason: "literature returned no valid note candidates",
  });
  const drive = dependencies([
    { codex: { notes: [{ text: "A cited result.", support: [] }] } },
  ]);
  expect(await run(request, drive)).toMatchObject({ outcome: "turn-limit" });
  const reader = openReader(path);
  try {
    const records = [...reader.records()];
    const literature = records.filter(
      (entry) => entry.kind === "call" && entry.label === roleLabels.literature,
    );
    expect(literature).toHaveLength(2);
    expect(
      records
        .filter(
          (entry) =>
            entry.kind === "call" && entry.label === "xean-solve/notes",
        )
        .map((entry) => entry.kind === "call" && entry.request),
    ).toMatchObject([{ id: `literature:${literature[1]!.seq}` }]);
  } finally {
    reader.close();
  }
});

test("a succeeded literature call whose notes were not yet delivered is delivered without a new call", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    coordinatorBehavior: {
      literature: "optional" as const,
      verification: "decide" as const,
    },
  };
  const request = { task, settings, campaignPath: path, turns: 2 };
  await init(request);
  const input = { task, request: "Find prior work on P." };
  await expect(
    run(request, {
      ...dependencies([
        {
          submission: coordination({
            role: "literature",
            request: input.request,
          }),
        },
      ]),
      codex: async () => {
        throw new Error("stopped before discovery");
      },
    }),
  ).rejects.toThrow("stopped before discovery");
  // The process died after the Codex result was journaled but before delivery.
  const campaign = openCampaign(path);
  let call: number;
  try {
    call = (
      await campaign.call(
        {
          label: roleLabels.literature,
          role: "literature",
          request: jsonSnapshot(literatureCall(input, settings.source).request),
        },
        async () => ({
          state: "succeeded",
          codexVersion: "fake",
          stdout: codexStdout({
            notes: [{ text: "A cited result.", support: [] }],
          }),
          stderr: "",
        }),
      )
    ).call;
  } finally {
    campaign.close();
  }
  const drive = dependencies([
    {
      submission: coordination(
        { role: "explorer" },
        [],
        [{ note: "n1", summary: "A cited result." }],
      ),
    },
    { submission: { solution: false, notes: [good] } },
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "turn-limit",
    turns: 2,
  });
  expect(drive.codexCalls).toHaveLength(0);
  expect(drive.allCalls.map(({ role }) => role)).toEqual([
    "coordinator",
    "explorer",
  ]);
  expect(drive.allCalls[0]?.prompt).toContain("A cited result.");
  const reader = openReader(path);
  try {
    expect(
      [...reader.records()]
        .filter(
          (entry) =>
            entry.kind === "call" && entry.label === "xean-solve/notes",
        )
        .map((entry) => entry.kind === "call" && entry.request),
    ).toMatchObject([{ id: `literature:${call}` }]);
  } finally {
    reader.close();
  }
});

test("a coordinator result requires a typed action and a nonempty verifier list", () => {
  const call = coordinatorCall({
    task,
    notes: [],
    coordinatorBehavior: { literature: "optional", verification: "decide" },
  });
  const base = {
    filings: [],
    explorerGuidance: "Choose the next useful mathematical step.",
    support: [],
    verify: [],
  };
  expect(call.schema.safeParse(base).success).toBe(false);
  expect(
    call.schema.safeParse({ ...base, action: { role: "verifier" } }).success,
  ).toBe(false);
  expect(
    call.schema.safeParse({ ...base, action: { role: "explorer" } }).success,
  ).toBe(true);
  expect(
    call.schema.safeParse({
      ...base,
      action: { role: "explorer" },
      verify: [{ note: "n1", verifiers: ["correctness"] }],
    }).success,
  ).toBe(false);
  expect(
    call.schema.safeParse({
      filings: [],
      verify: [],
      action: { role: "literature", request: "Search." },
    }).success,
  ).toBe(true);
  expect(
    call.schema.safeParse({
      filings: [],
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(false);
  expect(
    call.schema.safeParse({
      filings: [],
      explorerGuidance: "Explore.",
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(false);
  expect(
    call.schema.safeParse({
      filings: [],
      explorerGuidance: "Discarded.",
      support: [],
      verify: [],
      action: { role: "literature", request: "Search." },
    }).success,
  ).toBe(false);
});

test("the frozen coordinator behavior and literature status reach the coordinator prompt", () => {
  const call = coordinatorCall({
    task,
    notes: [],
    literatureStatus: "inconclusive",
    coordinatorBehavior: {
      literature: "never",
      verification: "decide",
      instructions: "Use Explorer for this campaign.",
    },
  });
  expect(call.prompt).toContain("Literature status: inconclusive");
  expect(call.prompt).toContain(
    'Coordinator behavior:\n{\n  "literature": "never",\n  "verification": "decide",\n  "overlap": false,\n  "instructions": "Use Explorer for this campaign."\n}',
  );
  expect(call.system).toContain("The frozen coordinator behavior");
  expect(call.system).toContain(
    "When action is verifier or literature, omit explorerGuidance and support",
  );
});

test("new campaigns disable literature unless their policy opts in", () => {
  expect(defaultCoordinatorBehavior.literature).toBe("never");
  const call = coordinatorCall({ task, notes: [] });
  expect(
    call.schema.safeParse({
      filings: [],
      explorerGuidance: "Explore the task.",
      support: [],
      verify: [],
      action: { role: "literature", request: "Search." },
    }).success,
  ).toBe(false);
});

test("structured coordinator policies constrain optional literature and verification dispatch", () => {
  const base = {
    filings: [],
    explorerGuidance: "Continue.",
    support: [],
  };
  const literatureFirst = coordinatorCall({
    task,
    notes: [],
    literatureStatus: "not-started",
    coordinatorBehavior: {
      literature: "required-if-not-started",
      verification: "decide",
    },
  });
  expect(
    literatureFirst.schema.safeParse({
      ...base,
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(false);
  expect(
    literatureFirst.schema.safeParse({
      filings: [],
      verify: [],
      action: { role: "literature", request: "Search." },
    }).success,
  ).toBe(true);

  const ready = (id: string, summary: string) => ({
    id,
    summary,
    text: summary,
    support: [],
    verdicts: [],
    verified: false,
    dead: false,
  });
  const alwaysVerify = coordinatorCall({
    task,
    notes: [
      ready("n1", "A live result."),
      {
        // Over unverified support: not required until n1 is verified.
        id: "n2",
        summary: "A consequence of n1.",
        text: "A consequence of n1.",
        support: ["n1"],
        verdicts: [],
        verified: false,
        dead: false,
      },
      ready("n3", "Another live result."),
    ],
    literatureStatus: "completed",
    coordinatorBehavior: { literature: "never", verification: "always" },
  });
  const checks: Verification["verifiers"] = ["correctness", "source"];
  expect(
    alwaysVerify.schema.safeParse({
      ...base,
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(false);
  // Every live note without a verdict over verified support must be listed.
  expect(
    alwaysVerify.schema.safeParse({
      filings: [],
      verify: [{ note: "n1", verifiers: all }],
      action: { role: "verifier" },
    }).success,
  ).toBe(false);
  expect(
    alwaysVerify.schema.safeParse({
      filings: [],
      verify: [
        { note: "n1", verifiers: checks },
        { note: "n3", verifiers: checks },
      ],
      action: { role: "verifier" },
    }).success,
  ).toBe(true);
  expect(
    alwaysVerify.schema.safeParse({
      filings: [],
      verify: [
        { note: "n1", verifiers: checks },
        { note: "n2", verifiers: checks },
        { note: "n3", verifiers: checks },
      ],
      action: { role: "verifier" },
    }).success,
  ).toBe(true);
  // n1 was checked and stayed inconclusive, so it is not forced again; n2
  // waits for its unverified support; nothing is forced.
  const inconclusiveSupport = coordinatorCall({
    task,
    notes: [
      {
        ...ready("n1", "A live result."),
        verdicts: [
          {
            verifier: "correctness",
            note: "n1",
            verdict: "INCONCLUSIVE",
            report: "Unclear.",
          },
        ],
      },
      { ...ready("n2", "A consequence of n1."), support: ["n1"] },
    ],
    literatureStatus: "completed",
    coordinatorBehavior: { literature: "never", verification: "always" },
  });
  expect(
    inconclusiveSupport.schema.safeParse({
      ...base,
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(true);
});

test("literature output is only note candidates", () => {
  const call = literatureCall(
    { task, request: "Search for prior work on P." },
    { model: "codex-model", reasoning: "low" },
  );
  expect(
    literatureReport.safeParse({
      notes: [{ text: "A cited theorem and its source.", support: [] }],
    }).success,
  ).toBe(true);
  expect(
    literatureReport.safeParse({
      notes: [{ text: "A cited theorem and its source.", support: [] }],
      report: "extra fields are rejected",
    }).success,
  ).toBe(false);
  expect(
    literatureReport.safeParse({
      notes: [
        { text: "First claim.", support: [] },
        { text: "Uses the first claim.", support: [1] },
      ],
    }).success,
  ).toBe(true);
  expect(
    literatureReport.safeParse({
      notes: [{ text: "A self-dependent claim.", support: [1] }],
    }).success,
  ).toBe(false);
  expect(
    literatureReport.safeParse({
      notes: [
        { text: "First claim.", support: [] },
        { text: "Duplicate dependency claim.", support: [1, 1] },
      ],
    }).success,
  ).toBe(false);
  const request = codexRequest.parse(call.request);
  expect(request.prompt).toContain('"problemToSolve": "Prove P."');
  expect(request.prompt).toContain('"request": "Search for prior work on P."');
});
