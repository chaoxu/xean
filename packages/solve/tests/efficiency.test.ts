import { afterEach, expect, test } from "bun:test";
import { createCampaign, type RecordQuery } from "xean";

import { createPiRoles } from "../pi-roles";
import { Projection } from "../projection";
import {
  applicationId,
  judgedBy,
  savedExplorerSubmission,
  succeededSubmission,
  verifierInput,
  type Note,
} from "../roles";
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

test("eligibility visits shared support once per fixed evidence view", () => {
  let reads = 0;
  const count = 80;
  const known = Array.from({ length: count }, (_, i): Note => ({
    ...note(i + 1),
    get support() {
      if (++reads > count * 3)
        throw new Error("shared support was repeatedly expanded");
      return i === 0 ? [] : i === 1 ? ["n1"] : [`n${i}`, `n${i - 1}`];
    },
  }));
  expect(
    judgedBy(
      {
        verify: known.map(({ id }) => ({
          note: id,
          verifiers: ["correctness"],
        })),
        notes: known,
        support: [],
      },
      [],
      "correctness",
    ),
  ).toEqual(known.map(({ id }) => id));
  expect(reads).toBeLessThanOrEqual(count * 3);
});

test("support closure visits shared ancestors once without storing all root closures", async () => {
  let reads = 0;
  const count = 100;
  const known = Array.from({ length: count }, (_, i): Note => ({
    ...note(i + 1),
    get support() {
      if (++reads > count) throw new Error("shared ancestor expanded twice");
      return i === 0 ? [] : ["n" + i, ...(i > 1 ? ["n" + (i - 1)] : [])];
    },
  }));
  expect(supportClosure([known.at(-1)!], known)).toEqual(
    known.slice(0, -1).map(({ id }) => id),
  );
  expect(reads).toBe(count);
});

test("the verification window validates only notes it reads", async () => {
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

test("verification prefixes do not expand support already read", async () => {
  let reads = 0;
  const count = 128;
  const known = Array.from({ length: count }, (_, index): Note => ({
    ...note(index + 1),
    get support() {
      if (++reads > count * 3)
        throw new Error("verification prefix repeatedly expanded support");
      return index === 0 ? [] : [`n${index}`];
    },
  }));
  const verify = known.map(({ id }) => ({
    note: id,
    verifiers: ["source" as const],
  }));
  expect(await verificationPrefix(verify, known, 100_000)).toEqual(verify);
  expect(reads).toBeLessThanOrEqual(count * 3);
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

test("startup reuses its captured derivation only while the journal boundary matches", async () => {
  const task = { problem: "Prove P.", completionCriteria: "A complete proof." };
  const config = workflowConfiguration({ task, settings: roleSettings() });
  const campaign = await createWorkflowCampaign(campaignPath(), config);
  const initial = {
    snapshot: await deriveWorkflow(campaign.records()),
    through: campaign.lastSequence(),
  };
  const original = Projection.prototype.at;
  let derivations = 0;
  Projection.prototype.at = function (seq) {
    if (seq === 1) derivations += 1;
    return original.call(this, seq);
  };
  const roles = createPiRoles(campaign, config.settings, dependencies([]));
  try {
    expect(
      (
        await runWorkflow(
          campaign,
          roles,
          { pauseRequested: () => true },
          initial,
        )
      ).kind,
    ).toBe("coordinator");
    expect(derivations).toBe(0);
    await campaign.call(
      { label: "new-boundary", request: null },
      async () => null,
    );
    expect(
      (
        await runWorkflow(
          campaign,
          roles,
          { pauseRequested: () => true },
          initial,
        )
      ).kind,
    ).toBe("coordinator");
    expect(derivations).toBe(1);
  } finally {
    Projection.prototype.at = original;
    campaign.close();
  }
});

test("projection snapshots are reused and later filings leave earlier snapshots intact", () => {
  const projection = new Projection([]);
  projection.add([note(1)], 2);
  const before = projection.at(2);
  expect(before[0]?.summary).toBeUndefined();
  expect(projection.accepted(2)).toEqual([]);
  expect(projection.at(2)).toBe(before);
  projection.file([{ note: "n1", summary: "A filed result." }], 3);
  expect(projection.at(3)[0]?.summary).toBe("A filed result.");
  expect(before[0]?.summary).toBeUndefined();
  expect(projection.at(2)).toEqual(before);
});

test("Explorer receipts reconcile only new owned submissions and reuse durable identities", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  await campaign.call(
    { label: "unrelated", request: { proof: "x".repeat(100_000) } },
    async () => null,
  );
  let checking = false,
    selected = 0;
  const original = campaign.records.bind(campaign);
  campaign.records = (query?: RecordQuery) => {
    if (checking) {
      expect(query?.kinds).toEqual(["tool-call"]);
      expect(query?.call).toBeDefined();
      expect(query?.after).toBeDefined();
      expect(query?.through).toBeDefined();
    }
    const rows = original(query);
    if (checking) selected += rows.length;
    return rows;
  };
  const drive = dependencies([
    {
      onStarted: async (tools) => {
        checking = true;
        try {
          for (let i = 1; i <= 10; i++) {
            const value = {
              notes: [
                {
                  text: `New result ${i}.`,
                  support: i === 1 ? [] : [`n${i - 1}`],
                },
              ],
              solution: false,
            };
            expect(await tools[0]!.execute(value, `call-${i}`)).toEqual({
              noteIds: [`n${i}`],
            });
          }
          const entry = campaign.record(campaign.lastSequence() - 1);
          if (entry?.kind !== "tool-call")
            throw new Error("missing durable submission");
          expect(
            await drive.calls[0]!.tools![0]!.run(entry.input, {
              call: entry.call,
              toolCall: entry.seq,
              signal: new AbortController().signal,
            }),
          ).toEqual({ noteIds: ["n10"] });
          expect(selected).toBe(10);
        } finally {
          checking = false;
        }
      },
    },
  ]);
  try {
    const result = await createPiRoles(
      campaign,
      { ...roleSettings(), maxExplorerResponses: 4 },
      drive,
    ).explorer({
      task: { problem: "Prove P.", completionCriteria: "A complete proof." },
      explorerGuidance: "",
      notes: [],
      support: [],
    });
    expect(result.notes).toHaveLength(10);
  } finally {
    campaign.close();
  }
});

test("completed Explorer replay reads submissions once and preserves tool and settlement boundaries", async () => {
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
      createPiRoles(campaign, config.settings, drive),
      { pauseRequested: () => drive.calls.length === 2 },
    );
    const records = campaign.records();
    const owner = records.find(
      (entry) => entry.kind === "call" && entry.role === "explorer",
    );
    if (owner?.kind !== "call") throw new Error("missing Explorer call");
    const reads = new Map<number, number>();
    const tracked = records.map((entry) =>
      entry.kind === "tool-call" && entry.call === owner.seq
        ? {
            ...entry,
            get input() {
              reads.set(entry.seq, (reads.get(entry.seq) ?? 0) + 1);
              return entry.input;
            },
          }
        : entry,
    );
    const completed = await deriveWorkflow(tracked);
    expect([...reads.values()]).toEqual([1, 1]);
    expect(completed.phase).toMatchObject({
      kind: "coordinator",
      input: { emptySubmission: true, notes: [{ id: "n1", text: first.text }] },
    });

    const saved = savedExplorerSubmission(records, owner.seq)!;
    const settled = succeededSubmission(
      records,
      owner.seq,
      "submit_notes",
      saved,
    )!;
    expect(saved.emptySubmission).toBe(true);
    expect(saved.settled).toBeLessThan(settled.settled);
    expect(settled.input).toBe(saved.input);
    const beforeReceipt = await deriveWorkflow(
      records.filter((entry) => entry.seq <= saved.settled),
    );
    expect(beforeReceipt.phase.kind).toBe("explorer");
    expect(beforeReceipt.notes).toMatchObject([{ id: "n1", text: first.text }]);
    // Explorer's saved submissions are durable without their receipts.
    const withoutReceipts = await deriveWorkflow(
      records.filter(
        (entry) => entry.kind !== "tool-result" || entry.seq < owner.seq,
      ),
    );
    expect(withoutReceipts.phase).toEqual(completed.phase);
  } finally {
    campaign.close();
  }
});
