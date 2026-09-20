import { afterEach, expect, test } from "bun:test";
import { createCampaign, type Campaign } from "xean";

import {
  createPiRoles,
  localSourceRequest,
  solveSettings,
  verifierCall,
} from "../pi-roles";
import {
  applicationId,
  correctnessVerdictsFor,
  sourceVerdictsFor,
  type Note,
  type VerifierInput,
} from "../roles";
import { inspectCampaign } from "../role-cli";
import { init } from "../runner";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);

const result =
  "For x > 0, the primary theorem establishes T(x). This theorem note states T(x) with that hypothesis.";
const source = {
  result,
  source: "Primary paper, Theorem 2",
  url: "https://example.test/paper#theorem2",
  quote: "For every x > 0, T(x) holds.",
};
const makeNote = (
  id: string,
  text = "Theorem T(x) for x > 0, citing the primary paper.",
): Note => ({
  id,
  text,
  support: [],
  verdicts: [],
  verified: false,
  dead: false,
});
const input = (notes: Note[]): VerifierInput => ({
  task: {
    problem: "Establish T(x).",
    completionCriteria: "Prove the exact theorem.",
  },
  notes,
  support: [],
  verify: notes.map(({ id: note }) => ({
    note,
    verifiers: ["correctness", "source"],
  })),
});
const correctness = (
  notes: { note: string; externalResults: string[] }[],
): Reply => ({
  submission: {
    verdicts: notes.map((entry) => ({
      ...entry,
      verdict: "PASS",
      report: "The mathematics is correct conditional on its listed premises.",
    })),
  },
});
const checked = (note: string, searched = true, sources = [source]): Reply => ({
  searched,
  codex: {
    verdicts: [
      {
        note,
        verdict: "PASS",
        report:
          "The exact source establishes the stated premise and applicability.",
        externalResults: [result],
        sources,
      },
    ],
  },
});
const calls = (campaign: Campaign) =>
  campaign
    .records({ kinds: ["call"] })
    .filter((entry) => entry.kind === "call");

test("source settings default, validate, and freeze the observed action limit", async () => {
  const { maxSourceWebActions: _, ...settings } = roleSettings();
  expect(solveSettings.parse(settings).maxSourceWebActions).toBe(16);
  for (const limit of [0, -1, 1.5, Infinity]) {
    expect(
      solveSettings.safeParse({ ...settings, maxSourceWebActions: limit })
        .success,
    ).toBe(false);
  }
  const path = campaignPath();
  const request = {
    task: input([makeNote("n1")]).task,
    campaignPath: path,
    settings,
  };
  await init(request);
  const before = await Bun.file(path).arrayBuffer();
  await expect(
    init({ ...request, settings: { ...settings, maxSourceWebActions: 17 } }),
  ).rejects.toThrow();
  expect(await Bun.file(path).arrayBuffer()).toEqual(before);
});

test("correctness lists hidden premises and preserves mathematical defects before source checking", async () => {
  const call = await verifierCall("correctness", input([makeNote("n1")]), [
    "n1",
  ]);
  expect(call.prompt).toContain(
    "Include hidden external premises even when the citation is vague or absent",
  );
  expect(call.prompt).toContain(
    "fail an undeclared substantive dependency or an application that does not meet those hypotheses",
  );
  expect(call.prompt).toContain(
    "An isolated theorem note may cite its external source directly without proving that theorem",
  );
  expect(call.prompt).toContain("an unsupported essential premise");
  expect(
    correctnessVerdictsFor(["n1"]).safeParse({
      verdicts: [{ note: "n1", verdict: "PASS", report: "Correct." }],
    }).success,
  ).toBe(false);
});

test("mixed verification sends only notes with external premises and journals local PASS honestly", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, applicationId, { kind: "calls" });
  const packet = input([
    makeNote("n1"),
    makeNote(
      "n2",
      "For every real x, x + 0 = x by the additive identity axiom.",
    ),
  ]);
  const drive = dependencies([
    correctness([
      { note: "n1", externalResults: [result] },
      { note: "n2", externalResults: [] },
    ]),
    checked("n1"),
  ]);
  try {
    const verdicts = await createPiRoles(
      campaign,
      roleSettings(),
      drive,
    ).verifier(packet);
    expect(verdicts).toHaveLength(4);
    expect(drive.codexCalls).toHaveLength(1);
    const prompt = JSON.parse(drive.codexCalls[0]!.prompt);
    expect(prompt.notes.map(({ id }: { id: string }) => id)).toEqual(["n1"]);
    expect(prompt.correctnessCall).toBe(
      calls(campaign).find((call) => call.label.endsWith("/correctness"))!.seq,
    );
    expect(drive.codexCalls[0]!.maxWebActions).toBe(16);
    const local = calls(campaign).find(
      (call) => localSourceRequest.safeParse(call.request).success,
    )!;
    expect(local.request).toMatchObject({
      notes: ["n2"],
      correctnessCall: prompt.correctnessCall,
    });
    expect(local.candidate).toBe(calls(campaign)[0]!.candidate);
    const inspection: any = await inspectCampaign(path);
    expect(
      inspection.calls.find((call: any) => call.call === local.seq).submission,
    ).toMatchObject({
      verdicts: [
        { note: "n2", verdict: "PASS", externalResults: [], sources: [] },
      ],
    });
    expect(inspection.accounting.unpricedCalls).toHaveLength(1);
  } finally {
    campaign.close();
  }
});

test("source cannot silently remove, weaken, or leave a passing assigned premise without evidence", () => {
  const schema = sourceVerdictsFor(
    ["n1"],
    [{ note: "n1", externalResults: [result] }],
  );
  const value = {
    note: "n1",
    verdict: "PASS",
    report: "Checked.",
    externalResults: [result],
    sources: [source],
  };
  expect(schema.safeParse({ verdicts: [value] }).success).toBe(true);
  for (const change of [
    { externalResults: [], sources: [] },
    { externalResults: ["Weaker theorem."], sources: [] },
    { sources: [] },
  ]) {
    expect(
      schema.safeParse({ verdicts: [{ ...value, ...change }] }).success,
    ).toBe(false);
  }
  expect(
    schema.safeParse({
      verdicts: [{ ...value, verdict: "INCONCLUSIVE", sources: [] }],
    }).success,
  ).toBe(true);
});

test("exact passages reuse recorded earlier source PASS evidence within the same campaign", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const drive = dependencies([
    correctness([{ note: "n1", externalResults: [result] }]),
    checked("n1"),
    correctness([{ note: "n2", externalResults: [result] }]),
    checked("n2", false),
  ]);
  try {
    const roles = createPiRoles(campaign, roleSettings(), drive);
    await roles.verifier(input([makeNote("n1")]));
    const old = calls(campaign).find((call) => call.label.endsWith("/source"))!;
    const verdicts = await roles.verifier(input([makeNote("n2")]));
    expect(verdicts.at(-1)?.verdict).toBe("PASS");
    expect(JSON.parse(drive.codexCalls[1]!.prompt).passages).toEqual([
      { call: old.seq, note: "n1", ...source },
    ]);
    expect(JSON.parse(drive.codexCalls[0]!.prompt).passages).toEqual([]);
  } finally {
    campaign.close();
  }
});

test("a malformed matching source transcript is not retried as a paid call", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const packet = input([makeNote("n1")]);
  const first = {
    ...dependencies([correctness([{ note: "n1", externalResults: [result] }])]),
    codex: async () => ({
      state: "succeeded" as const,
      codexVersion: "fake",
      stdout: "not-json\n",
      stderr: "",
    }),
  };
  try {
    await expect(
      createPiRoles(campaign, roleSettings(), first).verifier(packet),
    ).rejects.toThrow();
    const candidate = calls(campaign).find((call) =>
      call.label.endsWith("/correctness"),
    )?.candidate;
    if (candidate === undefined) throw new Error("missing candidate");

    let replacements = 0;
    const second = {
      ...dependencies([]),
      codex: async () => {
        replacements += 1;
        throw new Error("replacement paid call");
      },
    };
    await expect(
      createPiRoles(campaign, roleSettings(), second).verifier(
        packet,
        candidate,
      ),
    ).rejects.toThrow();
    expect(replacements).toBe(0);
  } finally {
    campaign.close();
  }
});

test("new evidence without retrieval or a changed reused quotation cannot pass", async () => {
  for (const changed of [false, true]) {
    const campaign = createCampaign(campaignPath(), applicationId, {
      kind: "calls",
    });
    const replies = [
      correctness([{ note: "n1", externalResults: [result] }]),
      checked("n1", false),
    ];
    if (changed)
      replies.splice(
        0,
        replies.length,
        correctness([{ note: "n1", externalResults: [result] }]),
        checked("n1"),
        correctness([{ note: "n2", externalResults: [result] }]),
        checked("n2", false, [
          { ...source, quote: "An uninspected stronger claim." },
        ]),
      );
    const drive = dependencies(replies);
    try {
      const roles = createPiRoles(campaign, roleSettings(), drive);
      if (changed) await roles.verifier(input([makeNote("n1")]));
      await expect(
        roles.verifier(input([makeNote(changed ? "n2" : "n1")])),
      ).rejects.toThrow("list new sources without a search");
    } finally {
      campaign.close();
    }
  }
});

test("a failed source assessment never supplies reusable evidence", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const drive = dependencies([
    correctness([{ note: "n1", externalResults: [result] }]),
    {
      codex: {
        verdicts: [
          {
            note: "n1",
            verdict: "FAIL",
            report: "The theorem's hypotheses do not match.",
            externalResults: [result],
            sources: [source],
          },
        ],
      },
    },
    correctness([{ note: "n2", externalResults: [result] }]),
    checked("n2", false),
  ]);
  try {
    const roles = createPiRoles(campaign, roleSettings(), drive);
    await roles.verifier(input([makeNote("n1")]));
    await expect(roles.verifier(input([makeNote("n2")]))).rejects.toThrow(
      "list new sources without a search",
    );
    expect(JSON.parse(drive.codexCalls[1]!.prompt).passages).toEqual([]);
  } finally {
    campaign.close();
  }
});

test("exhausted source calls record candidate-bound INCONCLUSIVE and never infer again on replay", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const packet = input([makeNote("n1")]);
  const drive = dependencies([
    correctness([{ note: "n1", externalResults: [result] }]),
  ]);
  let executions = 0;
  const recordVerdict = campaign.recordVerdict.bind(campaign);
  campaign.recordVerdict = (call, ...args) => {
    const owner = campaign.record(call);
    if (owner?.kind === "call" && owner.label.endsWith("/source"))
      throw new Error("Interrupted before source verdict.");
    return recordVerdict(call, ...args);
  };
  try {
    const roles = createPiRoles(campaign, roleSettings(), {
      ...drive,
      codex: async () => {
        executions += 1;
        return {
          state: "exhausted",
          stdout: "",
          stderr: "",
          error: "Reached the observed web-action limit.",
        };
      },
    });
    await expect(roles.verifier(packet)).rejects.toThrow(
      "Interrupted before source verdict.",
    );
    campaign.recordVerdict = recordVerdict;
    const candidate = calls(campaign)[0]!.candidate!;
    const first = await roles.verifier(packet, candidate);
    expect(first.at(-1)).toMatchObject({
      verifier: "source",
      note: "n1",
      verdict: "INCONCLUSIVE",
    });
    expect(first.at(-1)?.report).toContain(
      "Required primary-source evidence remains unverified",
    );
    const before = campaign.lastSequence();
    expect(await roles.verifier(packet, candidate)).toEqual(first);
    expect(campaign.lastSequence()).toBe(before);
    expect(executions).toBe(1);
  } finally {
    campaign.close();
  }
});
