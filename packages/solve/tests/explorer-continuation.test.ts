import { afterEach, expect, test } from "bun:test";
import { createCampaign, openCampaign } from "xean";
import { z } from "zod";

import {
  createPiRoles,
  explorerCall,
  sameRequest,
  solveSettings,
} from "../pi-roles";
import { guideCampaign, inspectCampaign, submitNotes } from "../role-cli";
import { init, run } from "../runner";
import { applicationId, jsonSnapshot } from "../roles";
import {
  deriveWorkflow,
  runWorkflow,
  workflowConfiguration,
} from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
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

test("Explorer continuation defaults on and only its enabled schema requires a solution claim", () => {
  const ordinary = explorerCall(input),
    off = explorerCall(input, false),
    on = explorerCall(input, true);
  expect(off.system).toBe(ordinary.system);
  expect(off.prompt).toBe(ordinary.prompt);
  expect(z.toJSONSchema(off.schema)).toEqual(z.toJSONSchema(ordinary.schema));
  expect(off.submissionGate).toBeUndefined();
  expect(on.submissionGate).toEqual({
    completeArgument: "solution",
    emptyArgument: "notes",
    contextBudgetTokens: 400_000,
    maxResponses: 4,
    continuationPrompt: "Keep trying, you can do it.",
  });
  expect(ordinary.schema.safeParse({ notes: [note] }).success).toBe(true);
  expect(
    ordinary.schema.safeParse({ notes: [note], solution: false }).success,
  ).toBe(false);
  expect(on.schema.safeParse({ notes: [note] }).success).toBe(false);
  expect(on.schema.safeParse({ notes: [note], solution: "true" }).success).toBe(
    false,
  );
  for (const solution of [false, true])
    expect(on.schema.parse({ notes: [note], solution })).toHaveProperty(
      "solution",
      solution,
    );
  expect(on.system).toContain("does not bypass mathematical verification");
  const {
    explorerContinuation: _,
    maxExplorerResponses: __,
    ...settings
  } = roleSettings();
  expect(solveSettings.parse(settings).explorerContinuation).toBe(true);
  expect(solveSettings.parse(settings).maxExplorerResponses).toBe(4);
  expect(on.prompt).toContain("at most 4 model responses, including the first");
  expect(
    solveSettings.parse({ ...roleSettings(), explorerContinuation: false })
      .explorerContinuation,
  ).toBe(false);
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

test("Explorer accepts a large response limit", () => {
  expect(
    solveSettings.parse({
      ...roleSettings(),
      maxExplorerResponses: 1_000_000_000_000_000,
    }).maxExplorerResponses,
  ).toBe(1_000_000_000_000_000);
});

test("omitted continuation enables only Explorer's gate; a solution claim still goes through ordinary verification", async () => {
  const { explorerContinuation: _, ...defaults } = roleSettings();
  const path = campaignPath(),
    settings = {
      ...defaults,
      maxExplorerTurns: 1,
    };
  const config = workflowConfiguration({ task, settings }),
    campaign = createCampaign(path, applicationId, config);
  expect(config.settings.explorerContinuation).toBe(true);
  const drive = dependencies([
    { submission: { notes: [note], solution: true } },
    {
      submission: {
        filings: [{ note: "n1", summary: "A claimed proof." }],
        explorerGuidance: "Check it.",
        support: [],
        verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
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
      createPiRoles(campaign, config.settings, drive),
    );
    expect(result.kind).toBe("turn-limit");
    expect(drive.calls[0]?.submissionGate).toEqual({
      completeArgument: "solution",
      emptyArgument: "notes",
      contextBudgetTokens: 400_000,
      maxResponses: 4,
      continuationPrompt: explorerCall(input, true).submissionGate!
        .continuationPrompt,
    });
    expect(
      drive.calls.slice(1).every((call) => call.submissionGate === undefined),
    ).toBe(true);
    expect(drive.calls.map((call) => call.role)).toEqual([
      "explorer",
      "coordinator",
      "verifier",
    ]);
    const inspection: any = await inspectCampaign(path);
    expect(inspection.calls[0].submission.solution).toBe(true);
    expect(inspection.result.outcome).toBe("turn-limit");
    const explored = campaign
      .records()
      .find((entry) => entry.kind === "call" && entry.role === "explorer")!;
    if (explored.kind !== "call") throw new Error("fixture");
    expect(
      sameRequest(
        explored.request,
        explorerCall({ ...input, explorerGuidance: "" }, true),
      ),
    ).toBe(true);
    const altered: any = structuredClone(explored.request);
    delete altered.submissionGate;
    expect(
      sameRequest(
        altered,
        explorerCall({ ...input, explorerGuidance: "" }, true),
      ),
    ).toBe(false);
    altered.submissionGate = {
      ...drive.calls[0]!.submissionGate,
      reserveTokens: 1024,
    };
    expect(
      sameRequest(
        altered,
        explorerCall({ ...input, explorerGuidance: "" }, true),
      ),
    ).toBe(false);
    altered.submissionGate = {
      ...drive.calls[0]!.submissionGate,
      continuationPrompt: "Different research assignment.",
    };
    expect(
      sameRequest(
        altered,
        explorerCall({ ...input, explorerGuidance: "" }, true),
      ),
    ).toBe(false);
    expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
      "turn-limit",
    );
  } finally {
    campaign.close();
  }
});

test("explicitly disabled Explorer omits the kernel gate", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const drive = dependencies([{ submission: { notes: [note] } }]);
  try {
    await createPiRoles(
      campaign,
      { ...roleSettings(), explorerContinuation: false },
      drive,
    ).explorer(input);
    expect(drive.calls[0]?.submissionGate).toBeUndefined();
  } finally {
    campaign.close();
  }
});

test.each(["openai-responses", "openai-codex-responses"] as const)(
  "Solver selects transport for the model adapter: %s",
  async (api) => {
    const campaign = createCampaign(campaignPath(), applicationId, {
      kind: "calls",
    });
    const drive = dependencies([{ submission: { notes: [note] } }]);
    const models = {
      ...drive.models,
      getModel(provider: string, id: string) {
        const selected = drive.models.getModel(provider, id);
        return selected === undefined ? undefined : { ...selected, api };
      },
    };
    try {
      await createPiRoles(campaign, roleSettings(), {
        ...drive,
        models,
      }).explorer(input);
      expect(drive.calls[0]?.model.api).toBe(api);
      expect(drive.calls[0]?.transport).toBe(
        api === "openai-codex-responses" ? "auto" : "sse",
      );
    } finally {
      campaign.close();
    }
  },
);

test.each([false, true])(
  "the first empty handoff returns to the coordinator and a fresh Explorer with saved notes: %s",
  async (saveFirst) => {
    const config = workflowConfiguration({
      task,
      settings: {
        ...roleSettings(),
        maxExplorerTurns: 2,
        explorerContinuation: true,
      },
    });
    const campaign = createCampaign(campaignPath(), applicationId, config);
    const guidance =
      "Try a counting argument instead of the failed construction.";
    const nextId = saveFirst ? "n2" : "n1";
    const drive = dependencies([
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
          explorerGuidance: guidance,
          support: saveFirst ? ["n1"] : [],
          verify: [],
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
          explorerGuidance: "Resolve the remaining gap.",
          support: [],
          verify: [],
        },
      },
    ]);
    try {
      const result = await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, drive),
      );
      expect(result.kind).toBe("turn-limit");
      if (result.kind !== "turn-limit") throw new Error("expected turn limit");
      expect(result.turns).toBe(2);
      expect(drive.calls.map((call) => call.role)).toEqual([
        "explorer",
        "coordinator",
        "explorer",
        "coordinator",
      ]);
      expect(drive.calls[1]!.prompt).toContain(
        "ended with an empty submission",
      );
      expect(drive.calls[1]!.prompt).toContain(
        "Choose a different promising approach",
      );
      expect(drive.calls[2]!.prompt).toContain(guidance);
      expect(drive.calls[2]!.prompt).toContain(task.problem);
      expect(drive.calls[2]!.prompt).toContain(task.completionCriteria);
      expect(drive.calls[3]!.prompt).not.toContain(
        "ended with an empty submission",
      );
      if (saveFirst) {
        expect(drive.calls[1]!.prompt).toContain(note.text);
        expect(drive.calls[2]!.prompt).toContain(note.text);
      }
      expect(result.notes.map((note) => note.id)).toEqual(
        saveFirst ? ["n1", "n2"] : ["n1"],
      );
      const before = campaign.records();
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, dependencies([])),
      );
      expect(campaign.records()).toEqual(before);
    } finally {
      campaign.close();
    }
  },
);

test.each([
  { explorerContinuation: false },
  { explorerContextBudgetTokens: 500_000 },
  { maxExplorerResponses: 2 },
])("continuation settings remain frozen on resume: %j", async (change) => {
  const path = campaignPath(),
    settings = { ...roleSettings(), explorerContinuation: true };
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
  ).rejects.toThrow("task or settings disagree");
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
  expect(await init({ task, campaignPath: path, settings })).toMatchObject({
    created: false,
  });
});

test("omitted continuation and response budget are saved explicitly and match explicit defaults on resume", async () => {
  const {
    explorerContinuation: _,
    maxExplorerResponses: __,
    ...settings
  } = roleSettings();
  const path = campaignPath();
  await init({ task, campaignPath: path, settings });
  const campaign = openCampaign(path);
  try {
    expect(campaign.record(1)).toMatchObject({
      config: {
        schemaVersion: 9,
        settings: { explorerContinuation: true, maxExplorerResponses: 4 },
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
        explorerContinuation: true,
        maxExplorerResponses: 4,
      },
    }),
  ).toMatchObject({ created: false });
});

test.each([1, 2, 3, 4, 5, 6, 7])(
  "previous workflow schema %s is rejected without changing the journal",
  async (schemaVersion) => {
    const { explorerContinuation: _, ...settings } = roleSettings();
    const path = campaignPath();
    createCampaign(
      path,
      applicationId,
      jsonSnapshot({
        kind: "workflow",
        schemaVersion,
        task,
        settings,
      }),
    ).close();
    const before = await Bun.file(path).arrayBuffer();
    await expect(
      run(
        { task, campaignPath: path, settings },
        {
          models: async () => {
            throw new Error("must reject the schema before provider setup");
          },
        },
      ),
    ).rejects.toThrow("schemaVersion");
    expect(await Bun.file(path).arrayBuffer()).toEqual(before);
  },
);

test.each([1, 3])(
  "Explorer response limit %s reaches execution and replay with all saved notes",
  async (maxExplorerResponses) => {
    const config = workflowConfiguration({
      task,
      settings: {
        ...roleSettings(),
        maxExplorerTurns: 1,
        explorerContinuation: true,
        explorerContextBudgetTokens: 80_000,
        maxExplorerResponses,
      },
    });
    const campaign = createCampaign(campaignPath(), applicationId, config);
    const notes = Array.from({ length: maxExplorerResponses }, (_, index) => ({
      text: `Partial work ${index + 1}.`,
      support: [],
    }));
    const drive = dependencies([
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
          explorerGuidance: "Continue.",
          support: [],
          verify: [],
        },
      },
    ]);
    try {
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, drive),
      );
      expect(drive.calls[0]?.submissionGate?.contextBudgetTokens).toBe(80_000);
      expect(drive.calls[0]?.submissionGate?.maxResponses).toBe(
        maxExplorerResponses,
      );
      expect(drive.calls[0]?.prompt).toContain(
        `at most ${maxExplorerResponses} model responses`,
      );
      for (const note of notes)
        expect(drive.calls[1]?.prompt).toContain(note.text);
      expect(drive.calls[1]?.prompt).not.toContain(
        "ended with an empty submission",
      );
      expect(drive.calls.map((call) => call.role)).toEqual([
        "explorer",
        "coordinator",
      ]);
      expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
        "turn-limit",
      );
      const call = campaign
        .records()
        .find((entry) => entry.kind === "call" && entry.role === "explorer");
      if (call?.kind !== "call") throw new Error("missing Explorer call");
      const initial = { ...input, explorerGuidance: "" };
      expect(
        sameRequest(
          call.request,
          explorerCall(initial, true, 80_000, maxExplorerResponses),
        ),
      ).toBe(true);
      expect(
        sameRequest(
          call.request,
          explorerCall(initial, true, 90_000, maxExplorerResponses),
        ),
      ).toBe(false);
      expect(
        sameRequest(
          call.request,
          explorerCall(initial, true, 80_000, maxExplorerResponses + 1),
        ),
      ).toBe(false);
      const before = campaign.records();
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, dependencies([])),
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
      explorerContinuation: true,
      maxExplorerTurns: 1,
    },
  });
  const campaign = createCampaign(path, applicationId, config);
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
        expect(inspection.calls[0].submission.notes).toEqual([first, second]);
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
        const firstCall = before.find((entry) => entry.kind === "tool-call");
        if (firstCall?.kind !== "tool-call")
          throw new Error("missing saved submission");
        expect(
          await drive.calls[0]!.tools![0]!.run(firstCall.input, {
            call: firstCall.call,
            toolCall: firstCall.seq,
            signal: new AbortController().signal,
          }),
        ).toEqual({ noteIds: ["n1", "n2"] });
        expect(campaign.records()).toEqual(before);
        expect(
          drive.calls[0]!.tools![0]!.input.safeParse({
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
        explorerGuidance: "Continue.",
        support: [],
        verify: [],
      },
    },
  ]);
  try {
    const result = await runWorkflow(
      campaign,
      createPiRoles(campaign, config.settings, drive),
    );
    expect(result.kind).toBe("turn-limit");
    const inspection: any = await inspectCampaign(path, {
      includeSubmissions: true,
    });
    expect(inspection.calls[0].submission).toEqual({
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
    expect(drive.calls[1]!.prompt).toContain(first.text);
    expect(drive.calls[1]!.prompt).toContain(improved.text);
    expect(drive.calls[1]!.prompt).toContain("ended with an empty submission");
    const before = campaign.records();
    await runWorkflow(
      campaign,
      createPiRoles(campaign, config.settings, dependencies([])),
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
      explorerContinuation: true,
      maxExplorerTurns: 1,
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
  const campaign = createCampaign(path, applicationId, config);
  const initial = dependencies([
    {
      state: "failed",
      error: "transport failed after saving notes",
      onStarted: async (tools) => {
        expect(
          await tools[0]!.execute({ notes: [first], solution: false }),
        ).toEqual({ noteIds: ["n1"] });
        const records = campaign.records();
        const at = records.findIndex((entry) => entry.kind === "tool-call");
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
      runWorkflow(campaign, createPiRoles(campaign, config.settings, initial)),
    ).rejects.toThrow("transport failed");
    const inspection: any = await inspectCampaign(path);
    expect(inspection.calls[0]).toMatchObject({
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
    {
      submission: {
        filings: ["n1", "n2"].map((note) => ({
          note,
          summary: "A claimed result.",
        })),
        explorerGuidance: "Continue.",
        support: [],
        verify: [],
      },
    },
  ]);
  try {
    const result = await runWorkflow(
      reopened,
      createPiRoles(reopened, config.settings, rest),
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
