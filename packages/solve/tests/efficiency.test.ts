import { afterEach, expect, test } from "bun:test";
import { createRoleHost } from "../role-host";
import { notesInbox } from "../notes";
import { guidanceInbox } from "../guidance";
import { inspectCampaignSnapshot, submitNotes } from "../role-cli";
import { judgedBy, roleCallRecords, verifierInput, type Note } from "../roles";
import { supportClosure } from "../support";
import { createCampaign, defineTool, type Entry } from "xean";
import { z } from "zod";
import type { RecordSource } from "../history";
import {
  deriveWorkflow,
  Workflow,
  runWorkflow,
  verificationPrefix,
  workflowConfiguration,
} from "../workflow";
import {
  campaignPath,
  createWorkflowCampaign,
  cleanupCampaigns,
  dependencies,
  dispatchExplorer,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);

test("workflow drops consumed inbox and historical support while inspection preserves interrupted Explorer inputs", async () => {
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "A complete proof." },
    settings: roleSettings(),
  });
  const campaign = await createWorkflowCampaign(campaignPath(), config, 3);
  const workflow = new Workflow(campaign);
  let explorations = 0;
  const roles = createRoleHost(
    campaign,
    config.settings,
    {},
    {
      coordinator: async (input) => {
        await guidanceInbox.append(campaign, {
          schemaVersion: 1,
          id: `g${input.notes.length}`,
          text: "Use the previous partial result.",
        });
        return {
          filings: input.notes
            .filter((note) => note.summary === undefined)
            .map((note) => ({ note: note.id, summary: note.text })),
          action: {
            role: "explorer",
            explorerGuidance: "Continue.",
            support: input.notes.length ? [input.notes.at(-1)!.id] : [],
          },
        };
      },
      explorer: async (input, execution) => {
        const result = {
          notes: [
            {
              text: `Partial result ${++explorations}.`,
              support: input.notes.length ? [input.notes.at(-1)!.id] : [],
            },
          ],
          solution: false,
        };
        if (explorations === 3) {
          await execution.submit(result);
          throw new Error("interrupted proof");
        }
        return result;
      },
    },
  );
  const explorerCalls = () => {
    const report: any = inspectCampaignSnapshot(campaign).inspection;
    return report.calls
      .filter((call: any) => call.role === "explorer")
      .map(({ noteIds, support }: any) => ({ noteIds, support }));
  };
  const assertRetainedState = () => {
    for (const submission of workflow.read().noteSubmissions)
      expect(submission).not.toHaveProperty("support");
    expect((workflow as any).checkpoint.inboxRecords).toEqual([]);
  };
  try {
    await expect(runWorkflow(campaign, roles, {}, workflow)).rejects.toThrow(
      "interrupted proof",
    );
    assertRetainedState();
    expect(explorerCalls()).toEqual([
      { noteIds: ["n1"], support: [] },
      { noteIds: ["n2"], support: ["n1"] },
      { noteIds: ["n3"], support: ["n1", "n2"] },
    ]);
    expect(await runWorkflow(campaign, roles, {}, workflow)).toMatchObject({
      kind: "turn-limit",
      turns: 3,
      notes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }, { id: "n4" }],
    });
    assertRetainedState();
    expect(explorerCalls()).toEqual([
      { noteIds: ["n1"], support: [] },
      { noteIds: ["n2"], support: ["n1"] },
      { noteIds: ["n3"], support: ["n1", "n2"] },
      { noteIds: ["n4"], support: ["n1", "n2", "n3"] },
    ]);
  } finally {
    campaign.close();
  }
});

test("role reads load only their own tool results", async () => {
  const campaign = createCampaign(campaignPath(), "role-read-test", null);
  const tool = defineTool({
    name: "read_notes",
    description: "Read one note",
    input: z.strictObject({}),
    async run() {
      return { text: "Exact note text." };
    },
  });
  try {
    for (const ownsTool of [false, true]) {
      let childTool = 0;
      const logical = await campaign.call(
        { label: "logical", request: null, tools: ownsTool ? [tool] : [] },
        async (context) => {
          if (ownsTool) await context.tools[0]!.execute({});
          const child = await campaign.call(
            {
              label: "model",
              parent: context.call,
              request: null,
              tools: [tool],
            },
            async (context) => {
              await context.tools[0]!.execute({});
              return null;
            },
          );
          childTool = campaign.records({
            kinds: ["tool-call"],
            call: child.call,
          })[0]!.seq;
          return null;
        },
      );
      const checked = (entry: Entry | undefined) => {
        if (entry?.kind === "tool-result" && entry.parent === childTool)
          throw new Error("loaded an unrelated child tool result");
        return entry;
      };
      const source: RecordSource = {
        lastSequence: () => campaign.lastSequence(),
        record: (seq) => checked(campaign.record(seq)),
        records: (query) => [...source.scan(query)],
        *scan(query) {
          for (const entry of campaign.scan(query)) yield checked(entry)!;
        },
      };
      const records = roleCallRecords(source, logical.call);
      expect(records.map(({ kind }) => kind)).toEqual(
        ownsTool
          ? ["call", "tool-call", "tool-result", "call-result"]
          : ["call", "call-result"],
      );
    }
  } finally {
    campaign.close();
  }
});

test("continued execution never reloads completed turns' role inputs", async () => {
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "A complete proof." },
    settings: roleSettings(),
  });
  const campaign = await createWorkflowCampaign(campaignPath(), config, 3);
  let completedThrough = 0;
  const checked = (entry: Entry | undefined) => {
    if (entry?.kind === "call" && entry.role && entry.seq <= completedThrough)
      throw new Error("reloaded a completed turn's role input");
    return entry;
  };
  const source: RecordSource = {
    lastSequence: () => campaign.lastSequence(),
    record: (seq) => checked(campaign.record(seq)),
    records: (query) => [...source.scan(query)],
    *scan(query) {
      for (const entry of campaign.scan(query)) yield checked(entry)!;
    },
  };
  const workflow = new Workflow(source);
  let explorations = 0;
  const roles = createRoleHost(campaign, config.settings, dependencies([]), {
    coordinator: async (input) => ({
      filings: input.notes
        .filter((note) => note.summary === undefined)
        .map((note) => ({ note: note.id, summary: note.text })),
      action: { role: "explorer", explorerGuidance: "Continue.", support: [] },
    }),
    explorer: async () => ({
      notes: [{ text: `Partial result ${++explorations}.`, support: [] }],
      solution: false,
    }),
  });
  try {
    expect(
      (
        await runWorkflow(
          campaign,
          roles,
          { pauseRequested: () => explorations === 2 },
          workflow,
        )
      ).kind,
    ).toBe("coordinator");
    completedThrough = campaign.lastSequence();
    const phase = await runWorkflow(campaign, roles, {}, workflow);
    expect(phase).toMatchObject({ kind: "turn-limit", turns: 3 });
    expect(workflow.read()).toEqual(deriveWorkflow(campaign));
    expect(explorations).toBe(3);
  } finally {
    campaign.close();
  }
});

function note(id: number, support: string[] = []): Note {
  return {
    id: `n${id}`,
    text: `Result ${id}.`,
    support,
    verdicts: [],
    verified: true,
    dead: false,
  };
}

test("shared support yields one ordered closure and keeps all eligible notes", () => {
  const known = Array.from({ length: 512 }, (_, index) =>
    note(
      index + 1,
      index === 0
        ? []
        : index === 1
          ? ["n1"]
          : ["n" + index, "n" + (index - 1)],
    ),
  );
  const verify = known.map(({ id }) => ({
    note: id,
    verifiers: ["correctness" as const],
  }));
  expect(supportClosure([known.at(-1)!], known)).toEqual(
    known.slice(0, -1).map(({ id }) => id),
  );
  expect(
    judgedBy({ verify, notes: known, support: [] }, [], "correctness"),
  ).toEqual(known.map(({ id }) => id));
  expect(verificationPrefix(verify, known, 100_000)).toEqual(verify);
});

test("the verification window validates only notes it reads", async () => {
  expect(verificationPrefix([], [], 1)).toEqual([]);
  const known = [note(1), note(2), note(4, ["n3"])];
  const verify = known.map(({ id }) => ({
    note: id,
    verifiers: ["source" as const],
  }));
  expect(await verificationPrefix(verify, known, 1)).toEqual(
    verify.slice(0, 1),
  );
  expect(() => verificationPrefix(verify, known, 1000)).toThrow(
    "missing support note n3",
  );
});

test.each([
  {
    known: [note(1), note(2), note(2)],
    verify: ["n1"],
    error: "duplicate note",
  },
  {
    known: [note(1), note(2, ["n2"])],
    verify: ["n1", "n2"],
    error: "must precede",
  },
  {
    known: [note(1, ["n2"]), note(2)],
    verify: ["n2", "n1"],
    error: "must precede",
  },
  {
    known: [note(1), note(3, ["n2"])],
    verify: ["n1", "n3"],
    error: "missing support note n2",
  },
])(
  "verification prefix still rejects $error",
  async ({ known, verify, error }) => {
    expect(() =>
      verificationPrefix(
        verify.map((note) => ({ note, verifiers: ["source"] })),
        known,
        100_000,
      ),
    ).toThrow(error);
  },
);

test.each([true, false])(
  "eligibility handles a deep valid support chain, verified=%s",
  async (verified) => {
    const known = Array.from({ length: 32_000 }, (_, index): Note => ({
      ...note(index + 1, index === 0 ? [] : [`n${index}`]),
      verified,
    }));
    const last = known.at(-1)!;
    const input = verifierInput.parse({
      task: { problem: "Prove P.", completionCriteria: "A complete proof." },
      verify: [{ note: last.id, verifiers: ["correctness", "source"] }],
      notes: [last],
      support: known.slice(0, -1),
    });
    expect(judgedBy(input, [], "correctness")).toEqual([last.id]);
    expect(
      judgedBy(
        input,
        [
          {
            note: last.id,
            verifier: "correctness",
            verdict: "PASS",
            report: "Passed.",
          },
          {
            note: "n1",
            verifier: "correctness",
            verdict: "FAIL",
            report: "Root failed.",
          },
        ],
        "source",
      ),
    ).toEqual([]);
  },
);

test("startup discards its captured phase after the journal changes", async () => {
  const task = { problem: "Prove P.", completionCriteria: "A complete proof." };
  const config = workflowConfiguration({ task, settings: roleSettings() });
  const path = campaignPath();
  const campaign = await createWorkflowCampaign(path, config);
  const initial = new Workflow(campaign);
  const snapshot = initial.read();
  try {
    await submitNotes(
      path,
      { notes: [{ text: "New caller work.", support: [] }] },
      "fresh",
    );
    await notesInbox.freeze(campaign, snapshot.after!);
    const phase = await runWorkflow(
      campaign,
      createRoleHost(campaign, config.settings, dependencies([])),
      { pauseRequested: () => true },
      initial,
    );
    expect(phase).toMatchObject({
      kind: "coordinator",
      input: { notes: [{ id: "n1", text: "New caller work." }] },
    });
  } finally {
    campaign.close();
  }
});

test("Explorer notes are visible before settlement and survive missing tool receipts", async () => {
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "A complete proof." },
    settings: { ...roleSettings(), maxExplorerResponses: 4 },
  });
  const campaign = await createWorkflowCampaign(campaignPath(), config);
  const first = { text: "A durable partial proof.", support: [] };
  const drive = dependencies([
    dispatchExplorer(),
    {
      onStarted: async (tools) => {
        await tools[0]!.execute({ notes: [first], solution: false });
      },
      submission: { notes: [], solution: false },
    },
  ]);
  try {
    await runWorkflow(
      campaign,
      createRoleHost(campaign, config.settings, drive),
      { pauseRequested: () => drive.calls.length === 2 },
    );
    const records = campaign.records();
    const owner = records.find(
      (entry) => entry.kind === "call" && entry.role === "explorer",
    )!;
    const saved = records.findLast(
      (entry) => entry.kind === "tool-call" && entry.call === owner.seq,
    )!;
    const completed = deriveWorkflow(records);
    expect(completed.phase).toMatchObject({
      kind: "coordinator",
      input: { emptySubmission: true, notes: [{ id: "n1", text: first.text }] },
    });
    const beforeReceipt = deriveWorkflow(
      records.filter((entry) => entry.seq <= saved.seq),
    );
    expect(beforeReceipt.phase.kind).toBe("explorer");
    expect(beforeReceipt.notes).toMatchObject([{ id: "n1", text: first.text }]);
    const withoutReceipts = deriveWorkflow(
      records.filter(
        (entry) => entry.kind !== "tool-result" || entry.seq < owner.seq,
      ),
    );
    expect(withoutReceipts.phase).toEqual(completed.phase);
  } finally {
    campaign.close();
  }
});
