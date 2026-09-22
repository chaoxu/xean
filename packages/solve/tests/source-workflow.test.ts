import { afterEach, expect, test } from "bun:test";
import { createCampaign, type Campaign, type Json } from "xean";
import { z } from "zod";

import {
  createPiRoles,
  localSourceRequest,
  sourceCall,
  sourceVerdictsOf,
  verifierCall,
} from "../pi-roles";
import {
  applicationId,
  correctnessVerdictsFor,
  sourceVerdictsFor,
  type Note,
  type VerifierInput,
} from "../roles";
import { inspectCampaign, inspectCampaignRecords } from "../role-cli";
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
        correctedText: null,
        sources: sources.map((value) => ({ ...value, resultId: `${note}#1` })),
      },
    ],
  },
});
const calls = (campaign: Campaign) =>
  campaign
    .records({ kinds: ["call"] })
    .filter((entry) => entry.kind === "call");

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
    const local = calls(campaign).find(
      (call) => localSourceRequest.safeParse(call.request).success,
    )!;
    expect(local.request).toMatchObject({
      notes: ["n2"],
      correctnessCall: prompt.correctnessCall,
    });
    expect(local.parent).toBe(calls(campaign)[0]!.seq);
    const inspection: any = await inspectCampaign(path);
    expect(
      inspection.calls.find((call: any) => call.call === local.seq).submission,
    ).toMatchObject({
      verdicts: [{ note: "n2", verdict: "PASS", sources: [] }],
    });
    expect(inspection.accounting.unpricedCalls).toHaveLength(1);
  } finally {
    campaign.close();
  }
});

const usage = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
};

test("unusable source evidence is inconclusive for that note alone", () => {
  const assigned = [
    { note: "n1", externalResults: [result] },
    { note: "n2", externalResults: ["Another theorem."] },
  ];
  const verdict = (note: string, sources: Json[]) => ({
    note,
    verdict: "PASS",
    report: "Checked.",
    correctedText: null,
    sources,
  });
  const outcome = (
    verdicts: Json[],
    searches = 1,
    supplied: Parameters<typeof sourceVerdictsOf>[1] = [],
  ) =>
    sourceVerdictsOf(
      { settled: 1, input: { verdicts }, searches, usage },
      supplied,
      assigned,
    )?.verdicts;
  const states = (value: ReturnType<typeof outcome>) =>
    value?.map(({ note, verdict }) => [note, verdict]);
  // A PASS missing a passage for an assigned ID.
  expect(
    outcome([
      verdict("n1", [{ ...source, result: "Restated.", resultId: "n1#1" }]),
      verdict("n2", []),
    ]),
  ).toMatchObject([
    { note: "n1", verdict: "PASS", sources: [{ resultId: "n1#1", result }] },
    {
      note: "n2",
      verdict: "INCONCLUSIVE",
      report: expect.stringContaining("not usable"),
      sources: [],
    },
  ]);
  // Another note's valid ID does not bind.
  expect(
    outcome([
      verdict("n1", [{ ...source, resultId: "n1#1" }]),
      verdict("n2", [{ ...source, resultId: "n1#1" }]),
    ]),
  ).toMatchObject([
    { note: "n1", verdict: "PASS" },
    { note: "n2", verdict: "INCONCLUSIVE", sources: [] },
  ]);
  // Without any search, a passage not supplied is unusable for its note only.
  expect(
    states(
      outcome(
        [
          verdict("n1", [{ ...source, resultId: "n1#1" }]),
          verdict("n2", [{ ...source, resultId: "n2#1" }]),
        ],
        0,
        [source],
      ),
    ),
  ).toEqual([
    ["n1", "PASS"],
    ["n2", "INCONCLUSIVE"],
  ]);
  // Not one verdict per judged note: nothing is usable.
  expect(outcome([verdict("n1", [])])).toBeUndefined();
});

test("the source output schema admits only this call's premise IDs and requires a passage for each on PASS", () => {
  const schema = sourceVerdictsFor(
    ["n1"],
    [{ note: "n1", externalResults: [result] }],
  );
  const value = {
    note: "n1",
    verdict: "PASS",
    report: "Checked.",
    correctedText: null,
    sources: [{ ...source, resultId: "n1#1" }],
  };
  expect(z.toJSONSchema(schema, { io: "input" })).toMatchObject({
    properties: {
      verdicts: {
        items: {
          properties: {
            sources: {
              items: { properties: { resultId: { enum: ["n1#1"] } } },
            },
          },
        },
      },
    },
  });
  expect(schema.safeParse({ verdicts: [value] }).success).toBe(true);
  for (const sources of [[], [{ ...source, resultId: "n1#2" }]]) {
    expect(
      schema.safeParse({ verdicts: [{ ...value, sources }] }).success,
    ).toBe(false);
  }
  expect(
    schema.safeParse({
      verdicts: [{ ...value, verdict: "INCONCLUSIVE", sources: [] }],
    }).success,
  ).toBe(true);
});

test("the source request uses strict structured output with explicit nullable corrections", async () => {
  const assigned = [{ note: "n1", externalResults: [result] }];
  const call = await sourceCall(
    roleSettings().source,
    input([makeNote("n1")]),
    ["n1"],
    {
      call: 1,
      verdicts: [{ ...assigned[0]!, verdict: "PASS", report: "Correct." }],
    },
  );
  const strictObjects = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    const schema = value as Record<string, unknown>;
    if (schema.properties !== undefined) {
      expect(schema.additionalProperties).toBe(false);
      expect([...(schema.required as string[])].sort()).toEqual(
        Object.keys(schema.properties as object).sort(),
      );
    }
    for (const child of Object.values(value)) strictObjects(child);
  };
  strictObjects(call.request.outputSchema);
  const wire = z.fromJSONSchema(
    call.request.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
  );
  const assess = (value: Json) =>
    sourceVerdictsOf(
      { settled: 1, input: { verdicts: [value] }, searches: 1, usage },
      [],
      assigned,
    )?.verdicts[0];
  const base = {
    note: "n1",
    verdict: "PASS",
    report: "Checked.",
    sources: [{ ...source, resultId: "n1#1" }],
  };
  expect(wire.safeParse({ verdicts: [base] }).success).toBe(false);
  const correctedText =
    "Theorem T(x) for x > 0, by the primary paper's Theorem 2.";
  const corrected = { ...base, correctedText };
  expect(wire.safeParse({ verdicts: [corrected] }).success).toBe(true);
  expect(assess(corrected)?.correctedText).toBe(correctedText);
  for (const verdict of ["PASS", "FAIL", "INCONCLUSIVE"]) {
    const value = { ...base, verdict, correctedText: null };
    expect(wire.safeParse({ verdicts: [value] }).success).toBe(true);
    expect(assess(value)).toMatchObject({ note: "n1", verdict });
    expect(assess(value)).not.toHaveProperty("correctedText");
    if (verdict !== "PASS")
      expect(assess({ ...value, correctedText })).toBeUndefined();
  }
});

test("an earlier PASS passage is supplied under the new call's premise ID and reused without a search", async () => {
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
      { call: old.seq, note: "n1", resultId: "n2#1", ...source },
    ]);
    expect(JSON.parse(drive.codexCalls[0]!.prompt).passages).toEqual([]);
  } finally {
    campaign.close();
  }
});

test("a malformed matching source transcript becomes inconclusive", async () => {
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
    const originalRecordEvidence = campaign.recordEvidence.bind(campaign) as (
      ...args: any[]
    ) => unknown;
    let interrupted = false;
    (campaign as any).recordEvidence = (...args: any[]) => {
      const entry = campaign.record(args[0]);
      if (
        !interrupted &&
        entry?.kind === "call" &&
        entry.label.endsWith("/source")
      ) {
        interrupted = true;
        throw new Error("simulated interruption before source verdict");
      }
      return originalRecordEvidence(...args);
    };
    await expect(
      createPiRoles(campaign, roleSettings(), first).verifier(packet),
    ).rejects.toThrow("simulated interruption");
    (campaign as any).recordEvidence = originalRecordEvidence;
    const verification = calls(campaign).find((call) =>
      call.label.endsWith("/correctness"),
    )?.parent;
    if (verification === undefined) throw new Error("missing verification");

    let replacements = 0;
    const second = {
      ...dependencies([]),
      codex: async () => {
        replacements += 1;
        throw new Error("replacement paid call");
      },
    };
    const verdicts = await createPiRoles(
      campaign,
      roleSettings(),
      second,
    ).verifier(packet, verification);
    expect(verdicts).toContainEqual(
      expect.objectContaining({
        note: "n1",
        verifier: "source",
        verdict: "INCONCLUSIVE",
      }),
    );
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
      const verdicts = await roles.verifier(
        input([makeNote(changed ? "n2" : "n1")]),
      );
      expect(verdicts).toContainEqual(
        expect.objectContaining({
          note: changed ? "n2" : "n1",
          verifier: "source",
          verdict: "INCONCLUSIVE",
        }),
      );
      const inspection = (await inspectCampaignRecords(
        campaign.records(),
      )) as any;
      const sourceCall = inspection.calls.findLast(
        (call: any) => call.verifier === "source",
      );
      expect(sourceCall.submission.verdicts[0].verdict).toBe("PASS");
      expect(sourceCall.evidence.verdicts[0].verdict).toBe("INCONCLUSIVE");
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
            correctedText: null,
            sources: [{ ...source, resultId: "n1#1" }],
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
    const verdicts = await roles.verifier(input([makeNote("n2")]));
    expect(verdicts).toContainEqual(
      expect.objectContaining({
        note: "n2",
        verifier: "source",
        verdict: "INCONCLUSIVE",
      }),
    );
    expect(JSON.parse(drive.codexCalls[1]!.prompt).passages).toEqual([]);
  } finally {
    campaign.close();
  }
});
