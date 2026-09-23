import { afterEach, expect, test } from "bun:test";
import { openCampaign, type Tool } from "xean";

import { explorerCall, solveSettings } from "../pi-roles";
import { createRoleHost } from "../role-host";
import { guideCampaign, inspectCampaign, submitNotes } from "../role-cli";
import { init, run } from "../runner";
import {
  deriveWorkflow,
  runWorkflow,
  workflowConfiguration,
} from "../workflow";
import {
  createWorkflowCampaign,
  campaignPath,
  cleanupCampaigns,
  dependencies,
  dispatchExplorer,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const input = {
  task,
  explorerGuidance: "Investigate the remaining case.",
  notes: [],
  support: [],
};
const note = { text: "An alleged complete proof.", support: [] };

test("Explorer always requires a solution claim and defaults to four responses", () => {
  const call = explorerCall(input);
  expect(call.submissionGate).toEqual({
    completeArgument: "solution",
    emptyArgument: "notes",
    contextBudgetTokens: 400_000,
    maxResponses: 4,
    continuationPrompt: "Keep trying, you can do it.",
  });
  expect(call.schema.safeParse({ notes: [note] }).success).toBe(false);
  expect(
    call.schema.safeParse({ notes: [note], solution: "true" }).success,
  ).toBe(false);
  for (const solution of [false, true])
    expect(call.schema.parse({ notes: [note], solution })).toHaveProperty(
      "solution",
      solution,
    );
  expect(call.schema.parse({ notes: [], solution: false })).toEqual({
    notes: [],
    solution: false,
  });
  expect(call.system).toContain("does not bypass mathematical verification");
  const { maxExplorerResponses: _, ...settings } = roleSettings();
  expect(solveSettings.parse(settings).maxExplorerResponses).toBe(4);
  expect(call.prompt).toContain(
    "at most 4 model responses, including the first",
  );
});

test.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "Explorer rejects an invalid response limit: %s",
  (maxExplorerResponses) => {
    expect(
      solveSettings.safeParse({ ...roleSettings(), maxExplorerResponses })
        .success,
    ).toBe(false);
  },
);

test("only Explorer uses a gate; a solution claim still goes through ordinary verification", async () => {
  const { maxExplorerResponses: _, ...defaults } = roleSettings();
  const path = campaignPath(),
    settings = {
      ...defaults,
    };
  const config = workflowConfiguration({ task, settings }),
    campaign = await createWorkflowCampaign(path, config, 2);
  expect(config.settings.maxExplorerResponses).toBe(4);
  const drive = dependencies([
    dispatchExplorer(input.explorerGuidance),
    { submission: { notes: [note], solution: true } },
    {
      submission: {
        filings: [{ note: "n1", summary: "A claimed proof." }],

        action: {
          role: "verifier",
          verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
        },
      },
    },
    {
      submission: {
        verdicts: [
          {
            note: "n1",
            verdict: "FAIL",
            report: "The claim is false.",
            externalResults: [],
          },
        ],
      },
    },
  ]);
  try {
    const result = await runWorkflow(
      campaign,
      createRoleHost(campaign, config.settings, drive),
    );
    expect(result.kind).toBe("turn-limit");
    expect(drive.calls[1]?.submissionGate).toEqual({
      completeArgument: "solution",
      emptyArgument: "notes",
      contextBudgetTokens: 400_000,
      maxResponses: 4,
      continuationPrompt:
        explorerCall(input).submissionGate!.continuationPrompt,
    });
    expect(
      drive.calls
        .filter((call) => call.role !== "explorer")
        .every((call) => call.submissionGate === undefined),
    ).toBe(true);
    expect(drive.calls.map((call) => call.role)).toEqual([
      "coordinator",
      "explorer",
      "coordinator",
      "verifier",
    ]);
    const inspection: any = await inspectCampaign(path);
    expect(inspection.calls[1].submission.solution).toBe(true);
    expect(inspection.result.outcome).toBe("turn-limit");
    expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
      "turn-limit",
    );
  } finally {
    campaign.close();
  }
});

test.each([false, true])(
  "the first empty handoff returns to the coordinator and a fresh Explorer with saved notes: %s",
  async (saveFirst) => {
    const config = workflowConfiguration({
      task,
      settings: {
        ...roleSettings(),
        maxExplorerResponses: 4,
      },
    });
    const campaign = await createWorkflowCampaign(campaignPath(), config, 3);
    const guidance =
      "Try a counting argument instead of the failed construction.";
    const nextId = saveFirst ? "n2" : "n1";
    const drive = dependencies([
      dispatchExplorer(),
      {
        onStarted: async (tools) => {
          if (saveFirst)
            await tools[0]!.execute({ notes: [note], solution: false });
        },
        submission: { notes: [], solution: false },
      },
      {
        submission: {
          filings: saveFirst
            ? [{ note: "n1", summary: "Earlier partial work." }]
            : [],

          action: {
            role: "explorer",
            explorerGuidance: guidance,
            support: saveFirst ? ["n1"] : [],
          },
        },
      },
      {
        submission: {
          notes: [
            {
              text: "A new counting argument with a remaining gap.",
              support: saveFirst ? ["n1"] : [],
            },
          ],
          solution: true,
        },
      },
      {
        submission: {
          filings: [
            { note: nextId, summary: "A counting argument with a gap." },
          ],

          action: {
            role: "explorer",
            explorerGuidance: "Resolve the remaining gap.",
            support: [],
          },
        },
      },
      { submission: { notes: [], solution: false } },
    ]);
    try {
      const result = await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, drive),
      );
      expect(result.kind).toBe("turn-limit");
      if (result.kind !== "turn-limit") throw new Error("expected turn limit");
      expect(result.turns).toBe(3);
      expect(drive.calls.map((call) => call.role)).toEqual([
        "coordinator",
        "explorer",
        "coordinator",
        "explorer",
        "coordinator",
        "explorer",
      ]);
      expect(drive.calls[2]!.prompt).toContain(
        "ended with an empty submission",
      );
      expect(drive.calls[2]!.prompt).toContain(
        "Choose a different promising approach",
      );
      expect(drive.calls[3]!.prompt).toContain(guidance);
      expect(drive.calls[3]!.prompt).toContain(task.problem);
      expect(drive.calls[3]!.prompt).toContain(task.completionCriteria);
      expect(drive.calls[4]!.prompt).not.toContain(
        "ended with an empty submission",
      );
      if (saveFirst) {
        expect(drive.calls[2]!.prompt).toContain(note.text);
        expect(drive.calls[3]!.prompt).toContain(note.text);
      }
      expect(result.notes.map((note) => note.id)).toEqual(
        saveFirst ? ["n1", "n2"] : ["n1"],
      );
      const before = campaign.records();
      await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, dependencies([])),
      );
      expect(campaign.records()).toEqual(before);
    } finally {
      campaign.close();
    }
  },
);

test.each([
  { explorerContextBudgetTokens: 500_000 },
  { maxExplorerResponses: 2 },
  { explorer: { ...roleSettings().explorer, replayReasoning: false } },
])("Explorer settings remain frozen on resume: %j", async (change) => {
  const path = campaignPath(),
    settings = roleSettings();
  await init({ task, campaignPath: path, settings });
  const before = await Bun.file(path).arrayBuffer();
  await expect(
    run(
      {
        task,
        campaignPath: path,
        settings: { ...settings, ...change },
      },
      {
        models: async () => {
          throw new Error("must reject the change before provider setup");
        },
      },
    ),
  ).rejects.toThrow("configuration disagrees");
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
  expect(await init({ task, campaignPath: path, settings })).toMatchObject({
    created: false,
  });
});

test("omitted response budget is saved explicitly and matches its explicit default on resume", async () => {
  const { maxExplorerResponses: _, ...settings } = roleSettings();
  const path = campaignPath();
  await init({ task, campaignPath: path, settings });
  const campaign = openCampaign(path);
  try {
    expect(campaign.record(1)).toMatchObject({
      config: {
        settings: { maxExplorerResponses: 4 },
      },
    });
  } finally {
    campaign.close();
  }
  expect(
    await init({
      task,
      campaignPath: path,
      settings: {
        ...settings,
        maxExplorerResponses: 4,
      },
    }),
  ).toMatchObject({ created: false });
});

test.each([1, 3])(
  "Explorer response limit %s reaches execution and replay with all saved notes",
  async (maxExplorerResponses) => {
    const config = workflowConfiguration({
      task,
      settings: {
        ...roleSettings(),
        explorerContextBudgetTokens: 80_000,
        maxExplorerResponses,
      },
    });
    const campaign = await createWorkflowCampaign(campaignPath(), config, 2);
    const notes = Array.from({ length: maxExplorerResponses }, (_, index) => ({
      text: `Partial work ${index + 1}.`,
      support: [],
    }));
    const drive = dependencies([
      dispatchExplorer(input.explorerGuidance),
      {
        onStarted: async (tools) => {
          for (const saved of notes.slice(0, -1))
            await tools[0]!.execute({ notes: [saved], solution: false });
        },
        submission: { notes: [notes.at(-1)!], solution: false },
      },
      {
        submission: {
          filings: notes.map((note, index) => ({
            note: `n${index + 1}`,
            summary: note.text,
          })),

          action: {
            role: "explorer",
            explorerGuidance: "Continue.",
            support: [],
          },
        },
      },
      { submission: { notes: [], solution: false } },
    ]);
    try {
      await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, drive),
      );
      expect(drive.calls[1]?.submissionGate?.contextBudgetTokens).toBe(80_000);
      expect(drive.calls[1]?.submissionGate?.maxResponses).toBe(
        maxExplorerResponses,
      );
      expect(drive.calls[1]?.prompt).toContain(
        `at most ${maxExplorerResponses} model responses`,
      );
      for (const note of notes)
        expect(drive.calls[2]?.prompt).toContain(note.text);
      expect(drive.calls[2]?.prompt).not.toContain(
        "ended with an empty submission",
      );
      expect(drive.calls.map((call) => call.role)).toEqual([
        "coordinator",
        "explorer",
        "coordinator",
        "explorer",
      ]);
      expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
        "turn-limit",
      );
      const before = campaign.records();
      await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, dependencies([])),
      );
      expect(campaign.records()).toEqual(before);
    } finally {
      campaign.close();
    }
  },
);

test("every saved submission reaches the coordinator, including early proofs before an empty handoff", async () => {
  const path = campaignPath();
  const config = workflowConfiguration({
    task,
    settings: {
      ...roleSettings(),
      maxExplorerResponses: 4,
    },
  });
  const campaign = await createWorkflowCampaign(path, config, 2);
  let hostSubmission: Tool | undefined;
  const call = campaign.call.bind(campaign);
  campaign.call = (options, runner) => {
    if (options.role === "explorer") hostSubmission = options.tools?.[0];
    return call(options, runner);
  };
  const first = {
    text: "An early detailed lemma, including its complete argument.",
    support: [],
  };
  const second = {
    text: "A failed route, with its obstruction explained.",
    support: [],
  };
  const improved = {
    text: "Using n1, a stronger partial result; the main problem remains unresolved.",
    support: ["n1"],
  };
  const external = { text: "An external application of n1.", support: ["n1"] };
  const drive = dependencies([
    dispatchExplorer(),
    {
      onStarted: async (tools) => {
        expect(
          await tools[0]!.execute({ notes: [first, second], solution: false }),
        ).toEqual({ noteIds: ["n1", "n2"] });
        const inspection: any = await inspectCampaign(path);
        expect(
          inspection.notes.map((note: any) => [
            note.id,
            note.text,
            note.verified,
          ]),
        ).toEqual([
          ["n1", first.text, false],
          ["n2", second.text, false],
        ]);
        expect(inspection.calls[1].submission.notes).toEqual([first, second]);
        await submitNotes(path, { notes: [external] }, "during-explorer");
        await expect(
          tools[0]!.execute({
            notes: [
              { text: "An invalid forward dependency.", support: ["n4"] },
            ],
            solution: false,
          }),
        ).rejects.toThrow("support must name");
        await expect(
          tools[0]!.execute({
            notes: [
              { text: "Invalid repeated support.", support: ["n1", "n1"] },
            ],
            solution: false,
          }),
        ).rejects.toThrow("support must name");
        expect(
          await tools[0]!.execute({ notes: [improved], solution: false }),
        ).toEqual({ noteIds: ["n3"] });
        // Reconcile an earlier interrupted receipt after another submission.
        // Repeating the tool body must neither allocate IDs nor lose n3.
        const before = campaign.records();
        const explorer = before.find(
          (entry) => entry.kind === "call" && entry.role === "explorer",
        )!;
        const firstCall = before.find(
          (entry) => entry.kind === "tool-call" && entry.call === explorer.seq,
        );
        if (firstCall?.kind !== "tool-call")
          throw new Error("missing saved submission");
        expect(
          await hostSubmission!.run(firstCall.input, {
            call: firstCall.call,
            toolCall: firstCall.seq,
            signal: new AbortController().signal,
          }),
        ).toEqual({ noteIds: ["n1", "n2"] });
        expect(campaign.records()).toEqual(before);
        expect(
          drive.calls[1]!.tools![0]!.input.safeParse({
            notes: [{ text: "A later argument using n3.", support: ["n3"] }],
            solution: false,
          }).success,
        ).toBe(true);
      },
      submission: { notes: [], solution: false },
    },
    {
      submission: {
        filings: ["n1", "n2", "n3", "n4"].map((note) => ({
          note,
          summary: "Partial work.",
        })),

        action: {
          role: "explorer",
          explorerGuidance: "Continue.",
          support: [],
        },
      },
    },
    { submission: { notes: [], solution: false } },
  ]);
  try {
    const result = await runWorkflow(
      campaign,
      createRoleHost(campaign, config.settings, drive),
    );
    expect(result.kind).toBe("turn-limit");
    const inspection: any = await inspectCampaign(path, {
      includeSubmissions: true,
    });
    expect(inspection.calls[1].submission).toEqual({
      notes: [first, second, improved],
      solution: false,
    });
    expect(
      inspection.notes.map((note: any) => [note.id, note.text, note.support]),
    ).toEqual([
      ["n1", first.text, []],
      ["n2", second.text, []],
      ["n3", improved.text, ["n1"]],
      ["n4", external.text, ["n1"]],
    ]);
    expect(inspection.submissions[0]).toMatchObject({
      noteIds: ["n4"],
      pending: false,
    });
    expect(drive.calls[2]!.prompt).toContain(first.text);
    expect(drive.calls[2]!.prompt).toContain(improved.text);
    expect(drive.calls[2]!.prompt).toContain("ended with an empty submission");
    const before = campaign.records();
    await runWorkflow(
      campaign,
      createRoleHost(campaign, config.settings, dependencies([])),
    );
    expect(campaign.records()).toEqual(before);
  } finally {
    campaign.close();
  }
});

test("saved notes survive a lost receipt and a failed Explorer call, retaining IDs on a fresh retry", async () => {
  const path = campaignPath();
  const config = workflowConfiguration({
    task,
    settings: {
      ...roleSettings(),
      maxExplorerResponses: 4,
    },
  });
  const first = {
    text: "A durable partial proof from the interrupted call.",
    support: [],
  };
  const next = {
    text: "Using n1, the remaining case follows.",
    support: ["n1"],
  };
  const campaign = await createWorkflowCampaign(path, config, 1);
  const initial = dependencies([
    dispatchExplorer(),
    {
      state: "failed",
      error: "transport failed after saving notes",
      onStarted: async (tools) => {
        expect(
          await tools[0]!.execute({ notes: [first], solution: false }),
        ).toEqual({ noteIds: ["n1"] });
        const records = campaign.records();
        const at = records.findLastIndex((entry) => entry.kind === "tool-call");
        const savedBeforeReceipt = await deriveWorkflow(
          records.slice(0, at + 1),
        );
        expect(savedBeforeReceipt.notes).toMatchObject([
          { id: "n1", text: first.text, verified: false },
        ]);
        await guideCampaign(
          path,
          "Advice submitted during this Explorer must wait.",
          "later-advice",
        );
      },
    },
  ]);
  try {
    await expect(
      runWorkflow(campaign, createRoleHost(campaign, config.settings, initial)),
    ).rejects.toThrow("transport failed");
    const inspection: any = await inspectCampaign(path);
    expect(inspection.calls[1]).toMatchObject({
      outcome: "failed",
      submission: { notes: [first] },
    });
    expect(inspection.notes).toMatchObject([{ id: "n1", text: first.text }]);
  } finally {
    campaign.close();
  }
  const reopened = openCampaign(path);
  const rest = dependencies([
    {
      onStarted: async (tools) => {
        expect(
          await tools[0]!.execute({ notes: [next], solution: false }),
        ).toEqual({ noteIds: ["n2"] });
      },
      submission: { notes: [], solution: true },
    },
  ]);
  try {
    const result = await runWorkflow(
      reopened,
      createRoleHost(reopened, config.settings, rest),
    );
    expect(result).toMatchObject({
      kind: "turn-limit",
      turns: 1,
      notes: [
        { id: "n1", text: first.text },
        { id: "n2", text: next.text },
      ],
    });
    expect(rest.calls[0]!.prompt).toContain(first.text);
    expect(rest.calls[0]!.prompt).toContain("Your first note is n2.");
    expect(rest.calls[0]!.prompt).not.toContain("Advice submitted during");
    expect((await deriveWorkflow(reopened.records())).phase).toEqual(result);
  } finally {
    reopened.close();
  }
});
