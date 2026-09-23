import { afterEach, expect, test } from "bun:test";
import { createCampaign, openCampaign, openReader } from "xean";

import { coordinatorCall, literatureCall } from "../pi-roles";
import { createRoleHost } from "../role-host";
import { inspectCampaign, submitNotes } from "../role-cli";
import { init, run } from "../runner";
import { runWorkflow, workflowConfiguration } from "../workflow";
import { codexRequest } from "../source";
import {
  defaultCoordinatorBehavior,
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

test("coordinator reads frozen older texts on demand and journals the read", async () => {
  const input = {
    task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
    notes: [
      {
        id: "n1",
        summary: "Old result.",
        text: "Exact old proof.",
        support: [],
        verdicts: [],
        verified: false,
        dead: false,
      },
      {
        id: "n2",
        text: "New proof to file.",
        support: [],
        verdicts: [],
        verified: false,
        dead: false,
      },
    ],
  };
  const campaign = createCampaign(campaignPath(), "xean-solve", {
    kind: "calls",
    schemaVersion: 1,
  });
  const drive = dependencies([
    {
      onStarted: async (tools) => {
        input.notes[0]!.text = "Later caller mutation.";
        const read = tools.find((tool) => tool.name === "read_notes")!;
        await expect(read.execute({ noteIds: ["n9"] })).rejects.toThrow();
        await expect(read.execute({ noteIds: ["n1", "n1"] })).rejects.toThrow();
        expect(await read.execute({ noteIds: ["n1"] })).toEqual([
          { id: "n1", text: "Exact old proof." },
        ]);
      },
      submission: {
        filings: [{ note: "n2", summary: "New result." }],
        action: {
          role: "explorer",
          explorerGuidance: "Extend the old result.",
          support: ["n1"],
        },
      },
    },
  ]);
  try {
    await createRoleHost(campaign, roleSettings(), drive).coordinator(input);
    expect(drive.calls[0]!.prompt).not.toContain("Exact old proof.");
    expect(drive.calls[0]!.prompt).toContain("New proof to file.");
    expect(drive.calls[0]!.prompt).toContain("Old result.");
    expect(drive.calls[0]!.terminalTool).toBe("submit_coordination");
    expect(
      campaign
        .records()
        .some(
          (entry) =>
            entry.kind === "tool-result" &&
            entry.state === "returned" &&
            JSON.stringify(entry.output).includes("Exact old proof."),
        ),
    ).toBe(true);
  } finally {
    campaign.close();
  }
});

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
  action:
    | { role: "explorer" | "verifier" }
    | Extract<CoordinatorAction, { role: "literature" }>,
  verify: Verification[] = [],
  filings: { note: string; summary: string }[] = [],
) => ({
  filings,
  action:
    action.role === "explorer"
      ? {
          ...action,
          explorerGuidance: "Choose the next useful mathematical step.",
          support: [],
        }
      : action.role === "verifier"
        ? { ...action, verify }
        : action,
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
      createRoleHost(campaign, workflow.settings, drive),
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

test("a failed search allows a fresh call, and a successful empty search completes literature", async () => {
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
    { codex: { notes: [] } },
    { submission: coordination({ role: "explorer" }) },
    { submission: { solution: false, notes: [] } },
  ]);
  try {
    const phase = await runWorkflow(
      campaign,
      createRoleHost(campaign, workflow.settings, drive),
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
    expect(phase).toMatchObject({ notes: [] });
    expect(
      campaign.records({ kinds: ["call"], labels: ["xean-solve/notes"] }),
    ).toEqual([]);
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
  expect(
    completed.schema.safeParse(
      coordination({ role: "literature", request: "Again." }),
    ).success,
  ).toBe(false);
  expect(
    completed.schema.safeParse(coordination({ role: "explorer" })).success,
  ).toBe(true);
});

test("a note submitted while an explorer phase waits returns to the coordinator", async () => {
  const path = campaignPath();
  const settings = roleSettings();
  const request = { task, settings, campaignPath: path, turns: 2 };
  await init(request);
  // The coordinator settles, then the process stops before any explorer call.
  let paused = false;
  const first = dependencies([
    { submission: coordination({ role: "explorer" }) },
  ]);
  await expect(
    run(request, {
      ...first,
      pauseRequested: () => paused,
      run: async (campaign, options) => {
        const result = await first.run(campaign, options);
        paused = true;
        return result;
      },
    }),
  ).resolves.toMatchObject({ outcome: "paused", at: "explorer" });
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
      records.filter(
        (entry) => entry.kind === "call" && entry.label === "xean-solve/notes",
      ),
    ).toEqual([]);
  } finally {
    reader.close();
  }
  expect(await inspectCampaign(path)).toMatchObject({
    notes: [{ id: "n1", text: "A cited result." }],
  });
});

test("settled literature survives a crash and enters before caller notes pending during search", async () => {
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
  await submitNotes(
    path,
    { notes: [{ text: "A caller result.", support: [] }] },
    "during-search",
  );
  expect(
    await inspectCampaign(path, { includeSubmissions: true }),
  ).toMatchObject({
    phase: "literature",
    notes: [],
    submissions: [{ id: "during-search", pending: true }],
  });
  // The process died immediately after the logical role result was journaled.
  const campaign = openCampaign(path);
  try {
    await campaign.call(
      {
        label: roleLabels.literature,
        role: "literature",
        parent: campaign
          .records()
          .findLast(
            (entry) => entry.kind === "call" && entry.role === "coordinator",
          )!.seq,
        request: { protocol: "xean-solve/role/v1", input },
      },
      async () => ({
        state: "succeeded",
        value: {
          notes: [
            { text: "A cited result.", support: [] },
            { text: "Its corollary.", support: [1] },
          ],
        },
      }),
    );
  } finally {
    campaign.close();
  }
  expect(
    await inspectCampaign(path, { includeSubmissions: true }),
  ).toMatchObject({
    phase: "coordinator",
    notes: [
      { id: "n1", text: "A cited result.", support: [] },
      { id: "n2", text: "Its corollary.", support: ["n1"] },
    ],
    submissions: [{ id: "during-search", pending: true }],
  });
  const drive = dependencies([
    {
      submission: coordination(
        { role: "explorer" },
        [],
        [
          { note: "n1", summary: "A cited result." },
          { note: "n2", summary: "Its corollary." },
          { note: "n3", summary: "A caller result." },
        ],
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
  expect(
    await inspectCampaign(path, { includeSubmissions: true }),
  ).toMatchObject({
    notes: [
      { id: "n1", support: [] },
      { id: "n2", support: ["n1"] },
      { id: "n3", text: "A caller result." },
      { id: "n4", text: good.text },
    ],
    submissions: [{ id: "during-search", pending: false, noteIds: ["n3"] }],
  });
});

test("coordinator actions own exactly their required payload", () => {
  const call = coordinatorCall({
    task,
    notes: [],
    coordinatorBehavior: { literature: "optional", verification: "decide" },
  });
  for (const action of [
    { role: "explorer", explorerGuidance: "Explore.", support: [] },
    { role: "literature", request: "Search." },
  ])
    expect(call.schema.safeParse({ filings: [], action }).success).toBe(true);
  for (const action of [
    { role: "verifier" },
    { role: "verifier", verify: [] },
    { role: "explorer" },
    { role: "explorer", explorerGuidance: "Explore." },
    { role: "explorer", explorerGuidance: "Explore.", support: [], verify: [] },
    {
      role: "literature",
      request: "Search.",
      explorerGuidance: "Discarded.",
      support: [],
    },
  ])
    expect(call.schema.safeParse({ filings: [], action }).success).toBe(false);
  expect(
    call.schema.safeParse({ ...coordination({ role: "explorer" }), verify: [] })
      .success,
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
  expect(call.prompt).toContain("Use Explorer for this campaign.");
  expect(call.system).not.toContain("Use Explorer for this campaign.");
});

test("structured coordinator policies constrain optional literature and verification dispatch", () => {
  expect(defaultCoordinatorBehavior.literature).toBe("never");
  expect(
    coordinatorCall({ task, notes: [] }).schema.safeParse(
      coordination({ role: "literature", request: "Search." }),
    ).success,
  ).toBe(false);
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
    literatureFirst.schema.safeParse(coordination({ role: "explorer" }))
      .success,
  ).toBe(false);
  expect(
    literatureFirst.schema.safeParse({
      filings: [],
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
    alwaysVerify.schema.safeParse(coordination({ role: "explorer" })).success,
  ).toBe(false);
  // Every live note without a verdict over verified support must be listed.
  expect(
    alwaysVerify.schema.safeParse({
      filings: [],
      action: { role: "verifier", verify: [{ note: "n1", verifiers: all }] },
    }).success,
  ).toBe(false);
  expect(
    alwaysVerify.schema.safeParse({
      filings: [],
      action: {
        role: "verifier",
        verify: [
          { note: "n1", verifiers: checks },
          { note: "n3", verifiers: checks },
        ],
      },
    }).success,
  ).toBe(true);
  expect(
    alwaysVerify.schema.safeParse({
      filings: [],
      action: {
        role: "verifier",
        verify: [
          { note: "n1", verifiers: checks },
          { note: "n2", verifiers: checks },
          { note: "n3", verifiers: checks },
        ],
      },
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
    inconclusiveSupport.schema.safeParse(coordination({ role: "explorer" }))
      .success,
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
  for (const fields of [
    { support: ["n1"] },
    { verification: { source: "literature", report: "Already checked." } },
  ]) {
    expect(
      literatureReport.safeParse({
        notes: [{ text: "A cited theorem.", support: [], ...fields }],
      }).success,
    ).toBe(false);
  }
  const request = codexRequest.parse(call.request);
  expect(request.prompt).toContain('"problemToSolve": "Prove P."');
  expect(request.prompt).toContain('"request": "Search for prior work on P."');
});
