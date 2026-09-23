import { afterEach, expect, test } from "bun:test";
import { createRoleHost } from "../role-host";
import { notesInbox } from "../notes";
import { submitNotes } from "../role-cli";
import { judgedBy, verifierInput, type Note } from "../roles";
import { supportClosure } from "../support";
import {
  deriveWorkflow,
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
  const initial = {
    snapshot: deriveWorkflow(campaign.records()),
    through: campaign.lastSequence(),
  };
  try {
    await submitNotes(
      path,
      { notes: [{ text: "New caller work.", support: [] }] },
      "fresh",
    );
    await notesInbox.freeze(campaign, initial.snapshot.after!);
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
