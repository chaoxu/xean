import { afterEach, expect, test } from "bun:test";
import { createCampaign, type Campaign, type Json } from "xean";
import { z } from "zod";

import { createPiRoles, sourceCall, sourceVerdictsOf } from "../pi-roles";
import {
  applicationId,
  correctnessVerdictsFor,
  journalVerdicts,
  localSourceRequest,
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
const opened = {
  source: "Primary paper, Theorem 2",
  url: "https://example.test/paper#theorem2",
  quote: "For every x > 0, T(x) holds.",
};
const source = { result, ...opened };
const supplied = { id: "p1", call: 1, note: "n1", ...source };
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
const checked = (
  notes: string | string[],
  searched = true,
  sources: Record<string, Json>[] = [opened],
): Reply => ({
  searched,
  codex: {
    verdicts: (typeof notes === "string" ? [notes] : notes).map((note) => ({
      note,
      verdict: "PASS",
      report:
        "The exact source establishes the stated premise and applicability.",
      correctedText: null,
      sources: sources.map((value) => ({ ...value, resultId: `${note}#1` })),
    })),
  },
});
const calls = (campaign: Campaign) =>
  campaign
    .records({ kinds: ["call"] })
    .filter((entry) => entry.kind === "call");

test("source grouping preserves origin and judged order while local conclusions avoid model calls", async () => {
  const path = campaignPath();
  const campaign = createCampaign(path, applicationId, { kind: "calls" });
  const drive = dependencies([
    correctness([
      { note: "n1", externalResults: [result] },
      { note: "n2", externalResults: [] },
      { note: "n3", externalResults: [result] },
    ]),
    correctness([{ note: "n4", externalResults: [result] }]),
    checked("n4"),
    checked(["n3", "n1"]),
  ]);
  try {
    const roles = createPiRoles(campaign, roleSettings(), drive);
    const established: Note["verdicts"] = [];
    for (const ids of [["n1", "n2", "n3"], ["n4"]]) {
      const packet = input(ids.map((id) => makeNote(id)));
      packet.verify.forEach((entry) => {
        entry.verifiers = ["correctness"];
      });
      established.push(...(await roles.verifier(packet)));
    }
    const [first, second] = calls(campaign).filter(({ label }) =>
      label.endsWith("/correctness"),
    );
    const packet = input(
      ["n4", "n3", "n2", "n1"].map((id) => ({
        ...makeNote(id),
        verdicts: established.filter((value) => value.note === id),
      })),
    );
    await roles.verifier(packet);
    expect(
      calls(campaign)
        .filter(({ label }) => label.endsWith("/source"))
        .map(({ request }) => {
          const local = localSourceRequest.safeParse(request);
          if (local.success)
            return {
              correctnessCall: local.data.correctnessCall,
              notes: local.data.notes,
            };
          const remote = JSON.parse((request as { prompt: string }).prompt);
          return {
            correctnessCall: remote.correctnessCall,
            notes: remote.notes.map(({ id }: { id: string }) => id),
          };
        }),
    ).toEqual([
      { correctnessCall: second!.seq, notes: ["n4"] },
      { correctnessCall: first!.seq, notes: ["n2"] },
      { correctnessCall: first!.seq, notes: ["n3", "n1"] },
    ]);
    const inspection: any = await inspectCampaign(path);
    expect(
      inspection.calls.find(
        (call: any) => call.submission?.verdicts?.[0]?.note === "n2",
      ).submission,
    ).toMatchObject({
      verdicts: [{ note: "n2", verdict: "PASS", sources: [] }],
    });
    expect(inspection.accounting.unpricedCalls).toHaveLength(2);
    const verification = calls(campaign).at(-1)!.parent!;
    const receipts = campaign.records();
    await roles.verifier(packet, verification);
    expect(campaign.records()).toEqual(receipts);
    expect(drive.codexCalls).toHaveLength(2);
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
      verdict("n1", [{ ...opened, resultId: "n1#1" }]),
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
      verdict("n1", [{ ...opened, resultId: "n1#1" }]),
      verdict("n2", [{ ...opened, resultId: "n1#1" }]),
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
          verdict("n1", [{ resultId: "n1#1", passageId: "p1" }]),
          verdict("n2", [{ ...opened, resultId: "n2#1" }]),
        ],
        0,
        [supplied],
      ),
    ),
  ).toEqual([
    ["n1", "PASS"],
    ["n2", "INCONCLUSIVE"],
  ]);
  // A known passage cannot establish a different assigned premise, even
  // when the same response also searched; an unknown reference is unusable.
  for (const searches of [0, 1]) {
    expect(
      states(
        outcome(
          [
            verdict("n1", [{ resultId: "n1#1", passageId: "p1" }]),
            verdict("n2", [{ resultId: "n2#1", passageId: "p1" }]),
          ],
          searches,
          [supplied],
        ),
      ),
    ).toEqual([
      ["n1", "PASS"],
      ["n2", "INCONCLUSIVE"],
    ]);
    expect(
      outcome(
        [
          verdict("n1", [{ resultId: "n1#1", passageId: "missing" }]),
          verdict("n2", []),
        ],
        searches,
        [supplied],
      )?.[0],
    ).toMatchObject({
      verdict: "INCONCLUSIVE",
      sources: [],
    });
  }
  // Not one verdict per judged note: nothing is usable.
  expect(outcome([verdict("n1", [])])).toBeUndefined();
});

test("source wire schemas require assigned premises and explicit nullable corrections", () => {
  expect(
    correctnessVerdictsFor(["n1"]).safeParse({
      verdicts: [{ note: "n1", verdict: "PASS", report: "Missing premises." }],
    }).success,
  ).toBe(false);
  const assigned = [{ note: "n1", externalResults: [result] }];
  const call = sourceCall(
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
    sources: [{ ...opened, resultId: "n1#1" }],
  };
  expect(
    wire.safeParse({
      verdicts: [
        {
          ...base,
          correctedText: null,
          sources: [{ ...opened, resultId: "n1#2" }],
        },
      ],
    }).success,
  ).toBe(false);
  expect(wire.safeParse({ verdicts: [base] }).success).toBe(false);
  const correctedText =
    "Theorem T(x) for x > 0, by the primary paper's Theorem 2.";
  const corrected = { ...base, correctedText };
  expect(wire.safeParse({ verdicts: [corrected] }).success).toBe(true);
  expect(assess(corrected)?.correctedText).toBe(correctedText);
  expect(
    wire.safeParse({
      verdicts: [
        {
          ...corrected,
          sources: [{ ...base.sources[0], result }],
        },
      ],
    }).success,
  ).toBe(false);
  for (const verdict of ["PASS", "FAIL", "INCONCLUSIVE"]) {
    const value = { ...base, verdict, correctedText: null };
    expect(wire.safeParse({ verdicts: [value] }).success).toBe(true);
    expect(assess(value)).toMatchObject({ note: "n1", verdict });
    expect(assess(value)).not.toHaveProperty("correctedText");
    if (verdict !== "PASS")
      expect(assess({ ...value, correctedText })).toBeUndefined();
  }
});

test("one supplied passage serves identical assignments without copying its text or trusting an unknown reference", () => {
  const assigned = ["n1", "n2"].map((note) => ({
    note,
    externalResults: [result],
  }));
  const { request, passages } = sourceCall(
    roleSettings().source,
    input(assigned.map(({ note }) => makeNote(note))),
    assigned.map(({ note }) => note),
    {
      call: 2,
      verdicts: assigned.map((entry) => ({
        ...entry,
        verdict: "PASS",
        report: "Correct.",
      })),
    },
    [{ call: 1, note: "n1", ...source }],
  );
  expect(JSON.parse(request.prompt).passages).toEqual([supplied]);
  const verdicts = assigned.map(({ note }) => ({
    note,
    verdict: "PASS",
    report: "The supplied passage establishes the exact application.",
    correctedText: null,
    sources: [{ resultId: `${note}#1`, passageId: "p1" }],
  }));
  const wire = z.fromJSONSchema(
    request.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
  );
  expect(wire.safeParse({ verdicts }).success).toBe(true);
  expect(
    wire.safeParse({
      verdicts: [
        {
          ...verdicts[0],
          sources: [{ resultId: "n1#1", passageId: "missing" }],
        },
      ],
    }).success,
  ).toBe(false);
  expect(
    sourceVerdictsOf(
      { settled: 3, input: { verdicts }, searches: 0, usage },
      passages,
      assigned,
    )?.verdicts,
  ).toMatchObject(
    assigned.map(({ note }) => ({
      note,
      verdict: "PASS",
      sources: [{ resultId: `${note}#1`, ...source }],
    })),
  );
});

test("an earlier PASS passage is supplied under the new call's premise ID and reused without a search", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  const drive = dependencies([
    correctness([{ note: "n1", externalResults: [result] }]),
    checked("n1"),
    correctness([{ note: "n2", externalResults: [result] }]),
    checked("n2", false, [{ passageId: "p1" }]),
  ]);
  try {
    const roles = createPiRoles(campaign, roleSettings(), drive);
    await roles.verifier(input([makeNote("n1")]));
    const old = calls(campaign).find((call) => call.label.endsWith("/source"))!;
    const receipts = campaign.records({ kinds: ["evidence"] });
    expect(receipts).toMatchObject([
      { evidence: { verdicts: [{ externalResults: [result] }] } },
      {
        evidence: {
          verdicts: [{ sources: [{ resultId: "n1#1", ...source }] }],
        },
      },
    ]);
    // Reuse consumes admitted evidence without interpreting the raw response again.
    const records = campaign.records.bind(campaign);
    campaign.records = (query) =>
      records(query).map((entry) =>
        entry.kind === "call-result" &&
        entry.state === "returned" &&
        entry.parent === old.seq
          ? {
              ...entry,
              output: {
                state: "succeeded",
                get stdout(): string {
                  throw new Error(
                    "raw source transcript read during evidence reuse",
                  );
                },
              },
            }
          : entry,
      );
    const verdicts = await roles.verifier(input([makeNote("n2")]));
    expect(verdicts.at(-1)?.verdict).toBe("PASS");
    expect(JSON.parse(drive.codexCalls[1]!.prompt).passages).toEqual([
      { id: "p1", call: old.seq, note: "n1", ...source },
    ]);
    expect(JSON.parse(drive.codexCalls[0]!.prompt).passages).toEqual([]);
  } finally {
    campaign.close();
  }
});

test.each(["wrong-id", "changed-result"])(
  "source receipt corruption fails before reuse: %s",
  async (corruption) => {
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
      const old = calls(campaign).find((call) =>
        call.label.endsWith("/source"),
      )!;
      const records = campaign.records.bind(campaign);
      campaign.records = (query) =>
        records(query).map((entry) => {
          if (entry.kind !== "evidence" || entry.call !== old.seq) return entry;
          const value = JSON.parse(JSON.stringify(entry.evidence));
          Object.assign(
            value.verdicts[0].sources[0],
            corruption === "wrong-id"
              ? { resultId: "wrong#1" }
              : { result: "A stronger unassigned result." },
          );
          return { ...entry, evidence: value };
        });
      expect(() => journalVerdicts(campaign.records())).toThrow(
        "malformed verdict",
      );
      expect(() => inspectCampaignRecords(campaign.records())).toThrow(
        "malformed verdict",
      );
      await expect(roles.verifier(input([makeNote("n2")]))).rejects.toThrow(
        "malformed verdict",
      );
      expect(drive.codexCalls).toHaveLength(1);
    } finally {
      campaign.close();
    }
  },
);

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
          { ...opened, quote: "An uninspected stronger claim." },
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
            sources: [{ ...opened, resultId: "n1#1" }],
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
