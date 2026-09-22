import { afterEach, expect, test } from "bun:test";
import { createCampaign, openCampaign } from "xean";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";

import {
  createPiRoles,
  explorerCall,
  sameRequest,
  solveSettings,
  type PiRoleDependencies,
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

test("sameRequest compares generic JSON by value rather than key order", () => {
  expect(
    sameRequest(
      { kind: "request", nested: { first: 1, second: ["x", "y"] } },
      { nested: { second: ["x", "y"], first: 1 }, kind: "request" },
    ),
  ).toBe(true);
});

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

test.each([false, true])(
  "removed Explorer continuation setting is rejected: %s",
  (explorerContinuation) => {
    expect(
      solveSettings.safeParse({ ...roleSettings(), explorerContinuation })
        .success,
    ).toBe(false);
  },
);

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
        verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
        action: { role: "verifier" },
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
    const explored = campaign
      .records()
      .find((entry) => entry.kind === "call" && entry.role === "explorer")!;
    if (explored.kind !== "call") throw new Error("fixture");
    expect(sameRequest(explored.request, explorerCall(input))).toBe(true);
    const altered: any = structuredClone(explored.request);
    delete altered.submissionGate;
    expect(sameRequest(altered, explorerCall(input))).toBe(false);
    altered.submissionGate = {
      ...drive.calls[1]!.submissionGate,
      contextBudgetTokens: 80_000,
    };
    expect(sameRequest(altered, explorerCall(input))).toBe(false);
    altered.submissionGate = {
      ...drive.calls[1]!.submissionGate,
      continuationPrompt: "Different research assignment.",
    };
    expect(sameRequest(altered, explorerCall(input))).toBe(false);
    expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
      "turn-limit",
    );
  } finally {
    campaign.close();
  }
});

test("a one-response Explorer keeps the gate and returns assigned note IDs", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const drive = dependencies([
    { submission: { notes: [note], solution: false } },
  ]);
  try {
    await createPiRoles(campaign, roleSettings(), drive).explorer(input);
    expect(drive.calls[0]?.submissionGate?.maxResponses).toBe(1);
    expect(
      campaign.records().find((entry) => entry.kind === "tool-result"),
    ).toMatchObject({
      state: "returned",
      output: { noteIds: ["n1"] },
    });
  } finally {
    campaign.close();
  }
});

test.each([
  { first: "invalid", maxExplorerResponses: 1, succeeds: false },
  { first: "invalid", maxExplorerResponses: 2, succeeds: true },
  { first: "length", maxExplorerResponses: 1, succeeds: false },
  { first: "length", maxExplorerResponses: 2, succeeds: true },
  { first: "stop", maxExplorerResponses: 1, succeeds: false },
  { first: "stop", maxExplorerResponses: 2, succeeds: true },
  { first: "error", maxExplorerResponses: 1, succeeds: true },
] as const)(
  "Explorer response budget $maxExplorerResponses handles a first $first response",
  async ({ first, maxExplorerResponses, succeeds }) => {
    const settings = { ...roleSettings(), maxExplorerResponses };
    const catalog = dependencies([]).models;
    const model = catalog.getModel(
      settings.explorer.provider,
      settings.explorer.model,
    );
    if (model === undefined) throw new Error("missing fixture model");
    const submission = (solution?: boolean): AssistantMessage["content"] => [
      {
        type: "toolCall",
        id: solution === undefined ? "missing-solution" : "valid-submission",
        name: "submit_notes",
        arguments: {
          notes: [note],
          ...(solution === undefined ? {} : { solution }),
        },
      },
    ];
    const reply = (
      content: AssistantMessage["content"],
      stopReason: AssistantMessage["stopReason"],
    ): AssistantMessage => ({
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 11,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 18,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason,
      timestamp: Date.now(),
      ...(stopReason === "error"
        ? { errorMessage: "upstream_error: Codex upstream request failed" }
        : {}),
    });
    const replies = [
      reply(
        first === "invalid"
          ? submission()
          : [{ type: "text", text: "Partial reasoning." }],
        first === "invalid" ? "toolUse" : first,
      ),
      reply(submission(false), "toolUse"),
    ];
    let requests = 0;
    const models: PiRoleDependencies["models"] = {
      ...catalog,
      streamSimple(requestModel, context, options) {
        const message = replies[requests++];
        if (message === undefined)
          throw new Error("unexpected fixture request");
        const stream = createAssistantMessageEventStream();
        void (async () => {
          await options?.onPayload?.(
            { model: requestModel.id, context },
            requestModel,
          );
          if (message.stopReason === "error")
            stream.push({ type: "error", reason: "error", error: message });
          else if (
            message.stopReason === "toolUse" ||
            message.stopReason === "length" ||
            message.stopReason === "stop"
          )
            stream.push({ type: "done", reason: message.stopReason, message });
          else throw new Error("unexpected fixture stop reason");
        })();
        return stream;
      },
    };
    const campaign = createCampaign(campaignPath(), applicationId, {
      kind: "calls",
    });
    try {
      const result = createPiRoles(campaign, settings, { models }).explorer(
        input,
      );
      if (succeeds)
        expect(await result).toEqual({ notes: [note], solution: false });
      else await expect(result).rejects.toThrow("explorer failed:");
      expect(requests).toBe(succeeds ? 2 : 1);
      expect(
        campaign.records().filter((entry) => entry.kind === "tool-call"),
      ).toHaveLength(succeeds ? 1 : 0);
    } finally {
      campaign.close();
    }
  },
);

test("the role runner leaves the transport choice to the models wrapper", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const drive = dependencies([
    { submission: { notes: [note], solution: false } },
  ]);
  try {
    await createPiRoles(campaign, roleSettings(), drive).explorer(input);
    expect(drive.calls[0]).not.toHaveProperty("transport");
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
          explorerGuidance: guidance,
          support: saveFirst ? ["n1"] : [],
          verify: [],
          action: { role: "explorer" },
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
          action: { role: "explorer" },
        },
      },
      { submission: { notes: [], solution: false } },
    ]);
    try {
      const result = await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, drive),
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
        createPiRoles(campaign, config.settings, dependencies([])),
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
  ).rejects.toThrow("task or settings disagree");
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
        schemaVersion: 30,
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

test("an unsupported workflow schema is rejected without changing the journal", async () => {
  const settings = roleSettings();
  const path = campaignPath();
  createCampaign(
    path,
    applicationId,
    jsonSnapshot({
      kind: "workflow",
      schemaVersion: 0,
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
          explorerGuidance: "Continue.",
          support: [],
          verify: [],
          action: { role: "explorer" },
        },
      },
      { submission: { notes: [], solution: false } },
    ]);
    try {
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, drive),
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
      const call = campaign
        .records()
        .find((entry) => entry.kind === "call" && entry.role === "explorer");
      if (call?.kind !== "call") throw new Error("missing Explorer call");
      expect(
        sameRequest(
          call.request,
          explorerCall(input, 80_000, maxExplorerResponses),
        ),
      ).toBe(true);
      expect(
        sameRequest(
          call.request,
          explorerCall(input, 90_000, maxExplorerResponses),
        ),
      ).toBe(false);
      expect(
        sameRequest(
          call.request,
          explorerCall(input, 80_000, maxExplorerResponses + 1),
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
      maxExplorerResponses: 4,
    },
  });
  const campaign = await createWorkflowCampaign(path, config, 2);
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
          await drive.calls[1]!.tools![0]!.run(firstCall.input, {
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
        explorerGuidance: "Continue.",
        support: [],
        verify: [],
        action: { role: "explorer" },
      },
    },
    { submission: { notes: [], solution: false } },
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
      runWorkflow(campaign, createPiRoles(campaign, config.settings, initial)),
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
