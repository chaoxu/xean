import { afterEach, expect, test } from "bun:test";
import { openCampaign } from "xean";

import { sourceVerdictsOf } from "../pi-roles";
import { createRoleHost } from "../role-host";
import { exportSolutionRecords } from "../role-cli";
import {
  correctnessVerdictsFor,
  reconstructionResultFor,
  sourceVerdictsFor,
  verificationLabel,
  verifierLabels,
  verifierNames,
  verdictsFor,
  type VerifierName,
} from "../roles";
import {
  deriveWorkflow,
  runWorkflow,
  workflowConfiguration,
} from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  createWorkflowCampaign,
  dependencies,
  dispatchExplorer,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);

const pass = { note: "n1", verdict: "PASS", report: "Checked the exact text." };
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const configuration = () =>
  workflowConfiguration({ task, settings: roleSettings() });
const verify = (verifiers: readonly VerifierName[], file = false): Reply => ({
  submission: {
    filings: file ? [{ note: "n1", summary: "P holds." }] : [],
    action: {
      role: "verifier",
      verify: [{ note: "n1", verifiers: [...verifiers] }],
    },
  },
});
const finish: readonly Reply[] = [
  { submission: { verdicts: [pass] } },
  { submission: { statement: "P holds." } },
  { submission: { proof: "An independent proof of P." } },
  { submission: { statement: null, verdicts: [pass] } },
];

test("a correctness correction reaches later checks and export without rewriting the submission or leaking to reconstruction", async () => {
  const original = "P: 2 is even, since 1 + 1 = 3 and 2 = 2 times 1.";
  const corrected = "P: 2 is even, since 1 + 1 = 2 and 2 = 2 times 1.";
  const submitted = {
    solution: false,
    notes: [{ text: original, support: [] }],
  };
  const config = configuration();
  const path = campaignPath();
  let campaign = await createWorkflowCampaign(path, config, 2);
  const drive = dependencies([
    dispatchExplorer(),
    { submission: submitted },
    verify(verifierNames, true),
    {
      submission: {
        verdicts: [{ ...pass, correctedText: corrected, externalResults: [] }],
      },
    },
    ...finish,
  ]);
  try {
    const phase = await runWorkflow(
      campaign,
      createRoleHost(campaign, config.settings, drive),
    );
    expect(phase).toMatchObject({
      kind: "accepted",
      note: { id: "n1", text: corrected, support: [] },
    });
    if (phase.kind !== "accepted") throw new Error("expected acceptance");
    expect(phase.note.summary).toBeUndefined();
    expect(drive.codexCalls).toHaveLength(0);
    const calls = drive.allCalls;
    expect(
      calls.find(({ label }) => label === verifierLabels.correctness)?.prompt,
    ).toContain(original);
    for (const label of [
      verifierLabels.requirements,
      `${verifierLabels.reconstruction}/statement`,
      verifierLabels.reconstruction,
    ]) {
      const prompt = calls.find((call) => call.label === label)!.prompt;
      expect(prompt).toContain(corrected);
      expect(prompt).not.toContain(original);
    }
    const blind = calls.find(
      ({ label }) => label === `${verifierLabels.reconstruction}/proof`,
    )!.prompt;
    expect(blind).not.toContain(original);
    expect(blind).not.toContain(corrected);
    expect(blind).not.toContain('"correctedText":');
    const records = campaign.records();
    expect(records).toContainEqual(
      expect.objectContaining({ kind: "tool-call", input: submitted }),
    );
    expect(
      records.find(
        (entry) => entry.kind === "call" && entry.label === verificationLabel,
      ),
    ).toMatchObject({
      request: { notes: [{ text: original }] },
    });
    const artifact = await exportSolutionRecords(records);
    expect(new TextDecoder().decode(artifact)).toBe(
      `--- n1 ---\n\n${corrected}`,
    );
    campaign.close();
    campaign = openCampaign(path);
    const noCalls = dependencies([]);
    expect(
      await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, noCalls),
      ),
    ).toEqual(phase);
    expect(noCalls.allCalls).toHaveLength(0);
    expect(campaign.records()).toEqual(records);
    expect(await exportSolutionRecords(campaign.records())).toEqual(artifact);
  } finally {
    campaign.close();
  }
});

const premise = "For every x > 0, the primary theorem establishes T(x).";
const passage = {
  resultId: "n1#1",
  source: "Primary paper, Theorem 7",
  url: "https://example.test/paper#theorem7",
  quote: "For every x > 0, T(x) holds.",
};

test("extended verifier prefixes reuse earlier checks across reopening and source corrections become the working text", async () => {
  const original = "P: T(1), by Primary paper Theorem 3; 1 + 1 = 3.";
  const arithmetic = "P: T(1), by Primary paper Theorem 3; 1 + 1 = 2.";
  const sourced = "P: T(1), by Primary paper Theorem 7; 1 + 1 = 2.";
  const config = configuration();
  const path = campaignPath();
  let campaign = await createWorkflowCampaign(path, config, 4);
  const first = dependencies([
    dispatchExplorer(),
    {
      submission: { solution: false, notes: [{ text: original, support: [] }] },
    },
    verify(["correctness"], true),
    {
      submission: {
        verdicts: [
          { ...pass, correctedText: arithmetic, externalResults: [premise] },
        ],
      },
    },
  ]);
  try {
    expect(
      await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, first),
        {
          pauseRequested: () => first.allCalls.length === 4,
        },
      ),
    ).toMatchObject({ kind: "coordinator" });
    const correctness = campaign
      .records()
      .find(
        (entry) =>
          entry.kind === "call" && entry.label === verifierLabels.correctness,
      )!;
    campaign.close();
    campaign = openCampaign(path);
    const rest = dependencies([
      verify(["correctness", "source"], true),
      {
        codex: {
          verdicts: [{ ...pass, correctedText: sourced, sources: [passage] }],
        },
      },
      verify(verifierNames, true),
      ...finish,
    ]);
    const phase = await runWorkflow(
      campaign,
      createRoleHost(campaign, config.settings, rest),
    );
    expect(phase).toMatchObject({
      kind: "accepted",
      turns: 4,
      note: { text: sourced, verified: true },
    });
    expect(rest.allCalls.map(({ label }) => label)).toEqual([
      "xean-solve/coordinator",
      verifierLabels.source,
      "xean-solve/coordinator",
      verifierLabels.requirements,
      `${verifierLabels.reconstruction}/statement`,
      `${verifierLabels.reconstruction}/proof`,
      verifierLabels.reconstruction,
    ]);
    const sourceInput = JSON.parse(rest.codexCalls[0]!.prompt);
    expect(
      campaign
        .records()
        .filter(
          (entry) =>
            entry.kind === "call" && entry.label === verifierLabels.correctness,
        )
        .map((entry) => entry.seq),
    ).toEqual([correctness.seq]);
    expect(sourceInput.notes[0]).toMatchObject({
      text: arithmetic,
      externalResults: [{ text: premise }],
    });
    for (const call of rest.allCalls)
      expect(call.prompt).not.toContain('"correctedText":');
    for (const label of [
      verifierLabels.requirements,
      `${verifierLabels.reconstruction}/statement`,
      verifierLabels.reconstruction,
    ]) {
      const prompt = rest.allCalls.find((call) => call.label === label)!.prompt;
      expect(prompt).toContain(sourced);
      expect(prompt).not.toContain(arithmetic);
    }
    const blind = rest.allCalls.find(
      ({ label }) => label === `${verifierLabels.reconstruction}/proof`,
    )!.prompt;
    expect(blind).not.toContain(sourced);
    expect(blind).not.toContain(arithmetic);
    expect(
      (await deriveWorkflow(campaign.records())).notes[0]!.verdicts.map(
        ({ verifier }) => verifier,
      ),
    ).toEqual([...verifierNames]);
    const records = campaign.records();
    const artifact = await exportSolutionRecords(records);
    expect(new TextDecoder().decode(artifact)).toBe(`--- n1 ---\n\n${sourced}`);
    campaign.close();
    campaign = openCampaign(path);
    const noCalls = dependencies([]);
    expect(
      await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, noCalls),
      ),
    ).toEqual(phase);
    expect(noCalls.allCalls).toHaveLength(0);
    expect(campaign.records()).toEqual(records);
    expect(await exportSolutionRecords(campaign.records())).toEqual(artifact);
  } finally {
    campaign.close();
  }
});

test("failed or inconclusive checks cannot replace text, and unusable source evidence discards its correction", () => {
  const assigned = [{ note: "n1", externalResults: [premise] }];
  const replacement = {
    ...pass,
    correctedText: "A purported corrected proof.",
  };
  for (const verdict of ["FAIL", "INCONCLUSIVE"]) {
    const value = { ...replacement, verdict };
    expect(verdictsFor(["n1"]).safeParse({ verdicts: [value] }).success).toBe(
      false,
    );
    expect(
      correctnessVerdictsFor(["n1"]).safeParse({
        verdicts: [{ ...value, externalResults: [] }],
      }).success,
    ).toBe(false);
    expect(
      sourceVerdictsFor(["n1"], assigned).safeParse({
        verdicts: [{ ...value, sources: [] }],
      }).success,
    ).toBe(false);
    expect(
      reconstructionResultFor("n1").safeParse({
        statement: null,
        verdicts: [value],
      }).success,
    ).toBe(false);
  }
  for (const { sources, searches } of [
    { sources: [], searches: 1 },
    { sources: [passage], searches: 0 },
  ]) {
    const result = sourceVerdictsOf(
      {
        input: { verdicts: [{ ...replacement, sources }] },
        searches,
      },
      [],
      assigned,
    );
    expect(result?.verdicts[0]).toMatchObject({
      note: "n1",
      verdict: "INCONCLUSIVE",
      sources: [],
    });
    expect(result?.verdicts[0]).not.toHaveProperty("correctedText");
  }
});
