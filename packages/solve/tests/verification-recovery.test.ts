import { afterEach, expect, test } from "bun:test";

import { openCampaign } from "xean";

import { createPiRoles } from "../pi-roles";
import {
  reconstructionResultFor,
  verifierLabels,
  verifierNames,
} from "../roles";
import { inspectCampaign } from "../role-cli";
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
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const text = "ORIGINAL_PROOF: P follows by the argument written here.";

function config() {
  const settings = roleSettings();
  return workflowConfiguration({
    task,
    settings,
  });
}

function verdict(note = "n1", value = "PASS") {
  return { note, verdict: value, report: `Check ${value.toLowerCase()}.` };
}

const externalResults = (note: string) => [`External premise of ${note}`];
const correctnessVerdict = (note = "n1", value = "PASS") => ({
  ...verdict(note, value),
  externalResults: externalResults(note),
});
const correctness = (value = "PASS", note = "n1"): Reply => ({
  submission: { verdicts: [correctnessVerdict(note, value)] },
});
const sourceVerdict = (note = "n1", value = "PASS") => ({
  ...verdict(note, value),
  sources:
    value === "PASS"
      ? [
          {
            resultId: `${note}#1`,
            result: externalResults(note)[0]!,
            source: "Example Theorem 1",
            url: "https://example.org/theorem",
            quote: "Exact inspected theorem.",
          },
        ]
      : [],
});

const check = (value = "PASS", note = "n1"): Reply => ({
  submission: { verdicts: [verdict(note, value)] },
});
const sourceCheck = (value = "PASS", note = "n1"): Reply => ({
  codex: {
    verdicts: [sourceVerdict(note, value)],
  },
});
const reconstruction = (value = "PASS", note = "n1"): Reply => ({
  submission: { statement: null, verdicts: [verdict(note, value)] },
});
const correction = (statement: string): Reply => ({
  submission: { statement, verdicts: [] },
});
const proof = (value = "Independent proof."): Reply => ({
  submission: { proof: value },
});

const start: readonly Reply[] = [
  dispatchExplorer(),
  { submission: { solution: false, notes: [{ text, support: [] }] } },
  {
    submission: {
      filings: [{ note: "n1", summary: "P holds." }],
      explorerGuidance: "Prove P fully.",
      support: ["n1"],
      verify: [{ note: "n1", verifiers: [...verifierNames] }],
      action: { role: "verifier" },
    },
  },
];

const beforeReconstruction: readonly Reply[] = [
  ...start,
  correctness(),
  sourceCheck(),
  check(),
  { submission: { statement: "P holds." } },
  proof(),
];

test.each([...verifierNames])(
  "an inconclusive %s check reaches the next Explorer within the turn limit",
  async (name) => {
    const configuration = config();
    const campaign = await createWorkflowCampaign(
      campaignPath(),
      configuration,
      3,
    );
    const replies: Reply[] = [...start];
    for (const verifier of verifierNames) {
      const value = verifier === name ? "INCONCLUSIVE" : "PASS";
      if (verifier === "reconstruction") {
        replies.push(
          { submission: { statement: "P holds." } },
          proof(),
          reconstruction(value),
        );
      } else if (verifier === "source") {
        replies.push(sourceCheck(value));
      } else if (verifier === "correctness") {
        replies.push(correctness(value));
      } else {
        replies.push(check(value));
      }
      if (verifier === name) break;
    }
    const nextCoordinator = replies.length;
    replies.push(dispatchExplorer(), {
      submission: {
        solution: false,
        notes: [{ text: "A new approach to P.", support: [] }],
      },
    });
    const drive = dependencies(replies);
    try {
      expect(
        await runWorkflow(
          campaign,
          createPiRoles(campaign, configuration.settings, drive),
        ),
      ).toMatchObject({ kind: "turn-limit", turns: 3 });
      expect(drive.allCalls).toHaveLength(replies.length);
      expect(drive.allCalls[nextCoordinator]?.label).toBe(
        "xean-solve/coordinator",
      );
      expect(drive.allCalls[nextCoordinator]?.prompt).toContain(
        "Check inconclusive.",
      );
      expect(drive.allCalls[nextCoordinator + 1]?.label).toBe(
        "xean-solve/explorer",
      );
      expect(drive.allCalls[nextCoordinator + 1]?.prompt).toContain(
        "Check inconclusive.",
      );
      expect((await deriveWorkflow(campaign.records())).notes[0]).toMatchObject(
        {
          verified: name === "requirements" || name === "reconstruction",
          dead: false,
          verdicts: expect.arrayContaining([
            { verifier: name, ...verdict("n1", "INCONCLUSIVE") },
          ]),
        },
      );
      expect(
        campaign.records().filter((entry) => entry.kind === "candidate"),
      ).toHaveLength(1);
    } finally {
      campaign.close();
    }
  },
);

test("reopening after an inconclusive source check lets Explorer supply a new proof", async () => {
  const path = campaignPath();
  const configuration = config();
  let campaign = await createWorkflowCampaign(path, configuration, 4);
  const first = dependencies([
    ...start,
    correctness(),
    sourceCheck("INCONCLUSIVE"),
  ]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, first),
      {
        pauseRequested: () => first.allCalls.length === 5,
      },
    ),
  ).toMatchObject({ kind: "coordinator" });
  campaign.close();

  expect(await inspectCampaign(path)).toMatchObject({
    phase: "coordinator",
    notes: [
      {
        id: "n1",
        verified: false,
        dead: false,
        verdicts: [
          { verifier: "correctness", ...verdict() },
          { verifier: "source", ...verdict("n1", "INCONCLUSIVE") },
        ],
      },
    ],
  });
  expect(await inspectCampaign(path)).not.toHaveProperty("result");

  campaign = openCampaign(path);
  const resumed = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
        notes: [{ text: "A self-contained proof of P.", support: [] }],
      },
    },
    {
      submission: {
        filings: [
          { note: "n2", summary: "P holds by a self-contained proof." },
        ],
        explorerGuidance: "Prove P.",
        support: [],
        verify: [{ note: "n2", verifiers: [...verifierNames] }],
        action: { role: "verifier" },
      },
    },
    { submission: { verdicts: [{ ...verdict("n2"), externalResults: [] }] } },
    check("PASS", "n2"),
    { submission: { statement: "P holds." } },
    proof(),
    reconstruction("PASS", "n2"),
  ]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, resumed),
    ),
  ).toMatchObject({ kind: "accepted", turns: 4, note: { id: "n2" } });
  expect(resumed.allCalls[0]?.label).toBe("xean-solve/coordinator");
  expect(resumed.allCalls[0]?.prompt).toContain("Check inconclusive.");
  expect(resumed.allCalls[1]?.label).toBe("xean-solve/explorer");
  expect(resumed.allCalls[1]?.prompt).toContain("Check inconclusive.");
  expect(
    campaign.records().filter((entry) => entry.kind === "candidate"),
  ).toHaveLength(2);
  campaign.close();
  expect(await inspectCampaign(path)).toMatchObject({
    result: {
      schemaVersion: 1,
      outcome: "accepted",
      turns: 4,
      note: { id: "n2" },
    },
  });
});

test("an inconclusive native source check respects the turn limit", async () => {
  const configuration = workflowConfiguration({
    task,
    settings: roleSettings(),
  });
  const path = campaignPath();
  const campaign = await createWorkflowCampaign(path, configuration, 2);
  const drive = dependencies([
    ...start,
    correctness(),
    sourceCheck("INCONCLUSIVE"),
  ]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, drive),
    ),
  ).toMatchObject({
    kind: "turn-limit",
    turns: 2,
    notes: [{ verified: false, dead: false }],
  });
  expect(drive.codexCalls).toHaveLength(1);
  expect(drive.allCalls).toHaveLength(5);
  campaign.close();

  expect(await inspectCampaign(path)).toMatchObject({
    result: { schemaVersion: 1, outcome: "turn-limit", turns: 2 },
  });
});

test("a corrected reconstruction statement preserves the note and all successful checks", async () => {
  const path = campaignPath();
  const configuration = config();
  const campaign = await createWorkflowCampaign(path, configuration, 4);
  const drive = dependencies([
    ...beforeReconstruction,
    correction("The precise proposition P."),
    proof("A proof from the corrected statement."),
    reconstruction(),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, configuration.settings, drive),
  );
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 2,
    note: { id: "n1", text },
  });
  expect(drive.allCalls.map(({ label }) => label)).toEqual([
    "xean-solve/coordinator",
    "xean-solve/explorer",
    "xean-solve/coordinator",
    verifierLabels.correctness,
    verifierLabels.source,
    verifierLabels.requirements,
    `${verifierLabels.reconstruction}/statement`,
    `${verifierLabels.reconstruction}/proof`,
    verifierLabels.reconstruction,
    `${verifierLabels.reconstruction}/proof`,
    verifierLabels.reconstruction,
  ]);
  expect(drive.allCalls[9]?.prompt).toContain("The precise proposition P.");
  expect(drive.allCalls[9]?.prompt).not.toContain("ORIGINAL_PROOF");
  expect(
    campaign.records().filter((entry) => entry.kind === "candidate"),
  ).toHaveLength(1);
  expect(
    campaign.records().filter((entry) => entry.kind === "verdict"),
  ).toHaveLength(4);
  const noCalls = dependencies([]);
  await runWorkflow(
    campaign,
    createPiRoles(campaign, configuration.settings, noCalls),
  );
  expect(noCalls.allCalls).toHaveLength(0);
  campaign.close();
  const inspected = (await inspectCampaign(path)) as {
    calls: { submission?: unknown }[];
  };
  expect(inspected.calls[8]?.submission).toMatchObject({
    statement: "The precise proposition P.",
    verdicts: [],
  });
});

test("reopening after a corrected proof settled reuses it and retries only the failed verdict call", async () => {
  const path = campaignPath();
  const configuration = config();
  let campaign = await createWorkflowCampaign(path, configuration, 4);
  const first = dependencies([
    ...beforeReconstruction,
    correction("The precise proposition P."),
    proof("Corrected proof."),
    { state: "failed", error: "interrupted verifier" },
  ]);
  await expect(
    runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, first),
    ),
  ).rejects.toThrow("interrupted verifier");
  campaign.close();

  campaign = openCampaign(path);
  const resumed = dependencies([reconstruction()]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, resumed),
    ),
  ).toMatchObject({ kind: "accepted", turns: 2 });
  expect(resumed.allCalls.map(({ label }) => label)).toEqual([
    verifierLabels.reconstruction,
  ]);
  expect(resumed.allCalls[0]?.prompt).toContain("Corrected proof.");
  campaign.close();
});

test("a corrected statement cannot also submit a mathematical verdict", () => {
  const schema = reconstructionResultFor("n1");
  expect(schema.safeParse({ statement: "P.", verdicts: [] }).success).toBe(
    true,
  );
  expect(
    schema.safeParse({ statement: "P.", verdicts: [verdict()] }).success,
  ).toBe(false);
  expect(schema.safeParse({ statement: null, verdicts: [] }).success).toBe(
    false,
  );
  expect(
    schema.safeParse({ statement: null, verdicts: [verdict("n2")] }).success,
  ).toBe(false);
});

test("resuming an interrupted verification preserves inconclusive and successful checks", async () => {
  const path = campaignPath();
  const configuration = config();
  let campaign = await createWorkflowCampaign(path, configuration, 4);
  const first = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
        notes: [
          { text: "Lemma L.", support: [] },
          { text: "P.", support: [] },
        ],
      },
    },
    {
      submission: {
        filings: [
          { note: "n1", summary: "L holds." },
          { note: "n2", summary: "P holds." },
        ],
        explorerGuidance: "Prove P.",
        support: [],
        verify: [
          { note: "n1", verifiers: ["correctness", "source"] },
          { note: "n2", verifiers: [...verifierNames] },
        ],
        action: { role: "verifier" },
      },
    },
    {
      submission: {
        verdicts: [
          correctnessVerdict("n1"),
          correctnessVerdict("n2", "INCONCLUSIVE"),
        ],
      },
    },
    { ...sourceCheck(), state: "failed", error: "provider disconnected" },
  ]);
  await expect(
    runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, first),
    ),
  ).rejects.toThrow("provider disconnected");
  expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
    "verifier",
  );
  const candidates = campaign
    .records()
    .filter((entry) => entry.kind === "candidate");
  campaign.close();
  expect(await inspectCampaign(path)).not.toHaveProperty("result");

  campaign = openCampaign(path);
  const resumed = dependencies([sourceCheck()]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, resumed),
      {
        pauseRequested: () => resumed.allCalls.length === 1,
      },
    ),
  ).toMatchObject({ kind: "coordinator" });
  expect(
    (await deriveWorkflow(campaign.records())).notes.map(
      ({ verified }) => verified,
    ),
  ).toEqual([true, false]);
  expect(resumed.allCalls).toHaveLength(1);
  expect(resumed.allCalls[0]?.label).toBe(verifierLabels.source);
  expect(resumed.allCalls[0]?.prompt).not.toContain('"id": "n2"');
  expect(
    campaign.records().filter((entry) => entry.kind === "candidate"),
  ).toEqual(candidates);
  campaign.close();
});

test("an accepted answer ends the workflow even when an unrelated note is unresolved", async () => {
  const configuration = config();
  const campaign = await createWorkflowCampaign(
    campaignPath(),
    configuration,
    4,
  );
  const drive = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
        notes: [
          { text: "An unrelated lemma.", support: [] },
          { text: "Proof of P.", support: [] },
        ],
      },
    },
    {
      submission: {
        filings: [
          { note: "n1", summary: "Lemma." },
          { note: "n2", summary: "P holds." },
        ],
        explorerGuidance: "Prove P.",
        support: [],
        verify: [
          { note: "n1", verifiers: [...verifierNames] },
          { note: "n2", verifiers: [...verifierNames] },
        ],
        action: { role: "verifier" },
      },
    },
    {
      submission: {
        verdicts: [correctnessVerdict("n1"), correctnessVerdict("n2")],
      },
    },
    {
      codex: {
        verdicts: [sourceVerdict("n1", "INCONCLUSIVE"), sourceVerdict("n2")],
      },
    },
    check("PASS", "n2"),
    { submission: { statement: "P holds." } },
    proof(),
    reconstruction("PASS", "n2"),
  ]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, drive),
    ),
  ).toMatchObject({ kind: "accepted", note: { id: "n2" } });
  expect(drive.allCalls).toHaveLength(9);
  campaign.close();
});

test("repeated statement corrections stop automatic retries and remain resumable", async () => {
  const path = campaignPath();
  const configuration = config();
  let campaign = await createWorkflowCampaign(path, configuration, 4);
  const first = dependencies([
    ...beforeReconstruction,
    correction("Corrected P, first try."),
    proof(),
    correction("Corrected P, second try."),
  ]);
  await expect(
    runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, first),
    ),
  ).rejects.toThrow("statement");
  expect((await deriveWorkflow(campaign.records())).notes[0]).toMatchObject({
    verified: true,
    dead: false,
  });
  expect(
    campaign.records().filter((entry) => entry.kind === "verdict"),
  ).toHaveLength(3);
  campaign.close();

  campaign = openCampaign(path);
  const resumed = dependencies([proof(), reconstruction()]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, resumed),
    ),
  ).toMatchObject({ kind: "accepted", turns: 2 });
  expect(resumed.allCalls).toHaveLength(2);
  expect(resumed.allCalls[0]?.prompt).toContain("Corrected P, second try.");
  campaign.close();
});

test("an inconclusive supporting lemma leaves its dependent note unverified at the turn limit", async () => {
  const path = campaignPath();
  const configuration = config();
  const campaign = await createWorkflowCampaign(path, configuration, 2);
  const first = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
        notes: [
          { text: "Lemma L.", support: [] },
          { text: "P from L.", support: ["n1"] },
        ],
      },
    },
    {
      submission: {
        filings: [
          { note: "n1", summary: "L holds." },
          { note: "n2", summary: "P holds." },
        ],
        explorerGuidance: "Prove P.",
        support: ["n1"],
        verify: [
          { note: "n1", verifiers: ["correctness", "source"] },
          { note: "n2", verifiers: [...verifierNames] },
        ],
        action: { role: "verifier" },
      },
    },
    {
      submission: {
        verdicts: [
          correctnessVerdict("n1", "INCONCLUSIVE"),
          correctnessVerdict("n2"),
        ],
      },
    },
  ]);
  expect(
    await runWorkflow(
      campaign,
      createPiRoles(campaign, configuration.settings, first),
    ),
  ).toMatchObject({ kind: "turn-limit", turns: 2 });
  expect(
    (await deriveWorkflow(campaign.records())).notes.map(
      ({ verified, dead }) => [verified, dead],
    ),
  ).toEqual([
    [false, false],
    [false, false],
  ]);
  expect(first.codexCalls).toHaveLength(0);
  campaign.close();
});
