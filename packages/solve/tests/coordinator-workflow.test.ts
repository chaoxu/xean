import { afterEach, expect, test } from "bun:test";
import { openCampaign, openReader } from "xean";

import {
  coordinatorCall,
  createPiRoles,
  defaultCoordinatorBehavior,
  literatureCall,
} from "../pi-roles";
import { appendAllowance, turnAllowances } from "../allowance";
import { inspectCampaign, submitNotes } from "../role-cli";
import { init, run } from "../runner";
import { runWorkflow, workflowConfiguration } from "../workflow";
import { codexRequest } from "../source";
import { codexStdout } from "./fixtures/codex-stdout";
import {
  jsonSnapshot,
  literatureReport,
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
  explorerGuidance: "Choose the next useful mathematical step.",
  support: [],
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

test("coordinator mode starts with the coordinator and returns after literature", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
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
    workflowMode: "coordinator" as const,
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
  const completed = coordinatorCall(
    {
      task,
      notes: [],
      literatureStatus: "completed",
      coordinatorBehavior: settings.coordinatorBehavior,
    },
    "coordinator",
  );
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
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
  };
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

test("an allowance extends a coordinator-mode campaign by whole turns", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
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
    workflowMode: "coordinator" as const,
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
    workflowMode: "coordinator" as const,
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

test("a verifier action is unavailable until a note is added after a verification", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
  };
  const request = { task, settings, campaignPath: path, turns: 4 };
  await init(request);
  const partial = (id: string) => ({
    note: id,
    verdict: "PASS",
    report: "Correct.",
    externalResults: [],
  });
  const checks: Verification["verifiers"] = ["correctness", "source"];
  const unavailable =
    "No note has been added since the last completed verification";
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
    // No note was added since that verification: this coordinator's schema
    // has no verifier action, and n2 waits.
    { submission: coordination({ role: "explorer" }) },
    { submission: { solution: false, notes: [] } },
    // An explorer turn that adds no note keeps the verifier unavailable.
    { submission: coordination({ role: "explorer" }) },
    { submission: { solution: false, notes: [] } },
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "turn-limit",
    turns: 4,
  });
  expect(drive.allCalls.map(({ label }) => label)).toEqual([
    "xean-solve/coordinator",
    "xean-solve/explorer",
    "xean-solve/coordinator",
    "xean-solve/verifier/correctness",
    "xean-solve/coordinator",
    "xean-solve/explorer",
    "xean-solve/coordinator",
    "xean-solve/explorer",
  ]);
  expect(drive.allCalls[2]?.prompt).not.toContain(unavailable);
  expect(drive.allCalls[4]?.prompt).toContain(unavailable);
  expect(drive.allCalls[6]?.prompt).toContain(unavailable);
  // A caller submission adds a note and restores the verifier action.
  await submitNotes(
    path,
    { notes: [{ text: "A supplied lemma.", support: [] }] },
    "later",
  );
  const more = dependencies([
    {
      submission: coordination(
        { role: "verifier" },
        [{ note: "n3", verifiers: checks }],
        [{ note: "n3", summary: "A supplied lemma." }],
      ),
    },
    { submission: { verdicts: [partial("n3")] } },
  ]);
  expect(await run({ ...request, turns: 1, id: "more" }, more)).toMatchObject({
    outcome: "turn-limit",
    turns: 5,
  });
  expect(more.allCalls.map(({ label }) => label)).toEqual([
    "xean-solve/coordinator",
    "xean-solve/verifier/correctness",
  ]);
  expect(more.allCalls[0]?.prompt).not.toContain(unavailable);
  expect(await inspectCampaign(path)).toMatchObject({
    phase: "turn-limit",
    notes: [
      { id: "n1", verified: true },
      { id: "n2", verified: false },
      { id: "n3", verified: true },
    ],
  });
});

test("after a verification without new notes the coordinator schema omits the verifier action even under always", () => {
  const live = {
    id: "n1",
    summary: "A live result.",
    text: "A live result.",
    support: [],
    verdicts: [],
    verified: false,
    dead: false,
  };
  const base = {
    filings: [],
    explorerGuidance: "Continue.",
    support: [],
    verify: [],
  };
  const listed = [{ note: "n1", verifiers: ["correctness", "source"] }];
  const input = {
    task,
    notes: [live],
    // A failed search keeps literature available; a completed one would not.
    literatureStatus: "inconclusive" as const,
    coordinatorBehavior: {
      literature: "optional" as const,
      verification: "always" as const,
    },
  };
  const open = coordinatorCall(input, "coordinator");
  expect(open.prompt).not.toContain("No note has been added since");
  expect(
    open.schema.safeParse({ ...base, action: { role: "explorer" } }).success,
  ).toBe(false);
  expect(
    open.schema.safeParse({
      ...base,
      verify: listed,
      action: { role: "verifier" },
    }).success,
  ).toBe(true);
  const guarded = coordinatorCall(
    { ...input, afterVerification: true },
    "coordinator",
  );
  expect(guarded.prompt).toContain(
    "No note has been added since the last completed verification",
  );
  expect(
    guarded.schema.safeParse({
      ...base,
      verify: listed,
      action: { role: "verifier" },
    }).success,
  ).toBe(false);
  expect(
    guarded.schema.safeParse({ ...base, action: { role: "explorer" } }).success,
  ).toBe(true);
  expect(
    guarded.schema.safeParse({
      ...base,
      action: { role: "literature", request: "Search." },
    }).success,
  ).toBe(true);
});

test("an unusable literature response is replaced by a fresh call on resume", async () => {
  const path = campaignPath();
  const settings = {
    ...roleSettings(),
    workflowMode: "coordinator" as const,
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
    workflowMode: "coordinator" as const,
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

test("coordinator workflow mode requires a typed action and a nonempty verifier list", () => {
  const call = coordinatorCall({ task, notes: [] }, "coordinator");
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
});

test("coordinator behavior and literature status reach only coordinator workflow mode prompts", () => {
  const behavior = {
    literature: "never" as const,
    verification: "decide" as const,
    instructions: "Use Explorer for this campaign.",
  };
  const input = {
    task,
    notes: [],
    literatureStatus: "not-started" as const,
    coordinatorBehavior: behavior,
  };
  const fixed = coordinatorCall(input);
  expect(fixed.prompt).not.toContain("Coordinator behavior:");
  expect(fixed.prompt).not.toContain("Literature status:");
  expect(fixed.system).not.toContain("The frozen coordinator behavior");
  const call = coordinatorCall(input, "coordinator");
  expect(call.prompt).toContain("Coordinator behavior:");
  expect(call.prompt).toContain("Literature status:");
  expect(call.system).toContain("The frozen coordinator behavior");
  expect(
    call.schema.safeParse({
      filings: [],
      explorerGuidance: "Explore the task.",
      support: [],
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(true);
});

test("new campaigns disable literature unless their policy opts in", () => {
  expect(defaultCoordinatorBehavior.literature).toBe("never");
  const call = coordinatorCall({ task, notes: [] }, "coordinator");
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
  const literatureFirst = coordinatorCall(
    {
      task,
      notes: [],
      literatureStatus: "not-started",
      coordinatorBehavior: {
        literature: "required-if-not-started",
        verification: "decide",
      },
    },
    "coordinator",
  );
  expect(
    literatureFirst.schema.safeParse({
      ...base,
      verify: [],
      action: { role: "explorer" },
    }).success,
  ).toBe(false);
  expect(
    literatureFirst.schema.safeParse({
      ...base,
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
  const alwaysVerify = coordinatorCall(
    {
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
    },
    "coordinator",
  );
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
      ...base,
      verify: [{ note: "n1", verifiers: all }],
      action: { role: "verifier" },
    }).success,
  ).toBe(false);
  expect(
    alwaysVerify.schema.safeParse({
      ...base,
      verify: [
        { note: "n1", verifiers: checks },
        { note: "n3", verifiers: checks },
      ],
      action: { role: "verifier" },
    }).success,
  ).toBe(true);
  expect(
    alwaysVerify.schema.safeParse({
      ...base,
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
  const inconclusiveSupport = coordinatorCall(
    {
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
    },
    "coordinator",
  );
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
