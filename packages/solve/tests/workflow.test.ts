import { afterEach, expect, test } from "bun:test";

import { createCampaign, openCampaign, openReader, type Campaign } from "xean";

import { createPiRoles } from "../pi-roles";
import {
  applicationId,
  coordinatorResultFor,
  explorerResultFor,
  judgedBy,
  reconstructionResultFor,
  verdictsFor,
  verificationComplete,
  verifierLabels,
  verifierNames,
  type Verdict,
  type Verification,
} from "../roles";
import {
  exportCandidate,
  inspectCampaign,
  inspectAndExportCampaignRecords,
} from "../role-cli";
import { Projection } from "../projection";
import {
  deriveWorkflow,
  runWorkflow,
  verificationPrefix,
  workflowConfiguration,
} from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);

const task = {
  problem: "Prove P.",
  completionCriteria: "Give a complete proof of P.",
};
const good = { text: "Complete proof of P.", support: [] };
const all = [...verifierNames];
const lemma: Verification["verifiers"] = ["source", "correctness"];

function verdictsOf(
  name: string,
  notes: readonly string[],
  verdict = "PASS",
): Reply {
  return {
    submission: {
      ...(name === "reconstruction" ? { statement: null } : {}),
      verdicts: notes.map((note) => ({
        note,
        verdict,
        report: `${name} ${verdict.toLowerCase()}.`,
      })),
    },
  };
}

function sourceOf(notes: readonly string[], verdict = "PASS"): Reply {
  return {
    codex: {
      verdicts: notes.map((note) => ({
        note,
        verdict,
        report: `source ${verdict.toLowerCase()}.`,
        sources: [],
      })),
    },
  };
}

function reconstruction(note: string, verdict = "PASS"): readonly Reply[] {
  return [
    { submission: { statement: `What ${note} proves.` } },
    { submission: { proof: `Independent proof of ${note}.` } },
    verdictsOf("reconstruction", [note], verdict),
  ];
}

function passes(note: string): readonly Reply[] {
  return [
    sourceOf([note]),
    verdictsOf("correctness", [note]),
    verdictsOf("requirements", [note]),
    ...reconstruction(note),
  ];
}

function config(maxExplorerTurns = 4) {
  return workflowConfiguration({
    task,
    settings: { ...roleSettings(), maxExplorerTurns },
  });
}

function coordination(
  notes: string | readonly string[],
  options: {
    readonly verify?: readonly Verification[];
    readonly read?: readonly string[];
  } = {},
) {
  const filed = typeof notes === "string" ? [notes] : notes;
  return {
    filings: filed.map((note) => ({ note, summary: `Summary of ${note}.` })),
    explorerGuidance: `Continue from ${filed.at(-1)}.`,
    support: options.read ?? [filed.at(-1)!],
    verify: options.verify ?? [{ note: filed.at(-1)!, verifiers: all }],
  };
}

async function phaseOf(campaign: Campaign) {
  return (await deriveWorkflow(campaign.records())).phase;
}

function shorthand(notes: readonly { verdicts: readonly Verdict[] }[]) {
  return notes.map(({ verdicts }) =>
    verdicts.map(({ verifier, verdict }) => `${verifier}:${verdict}`),
  );
}

test("the durable workflow accepts a note every verifier passed", async () => {
  const path = campaignPath();
  const workflow = config();
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    { submission: { notes: [good] } },
    { submission: coordination("n1") },
    ...passes("n1"),
  ]);
  const roles = createPiRoles(campaign, workflow.settings, drive);
  const phase = await runWorkflow(campaign, roles);
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 1,
    note: { id: "n1", summary: "Summary of n1.", text: good.text },
  });
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(shorthand([phase.note])).toEqual([
    verifierNames.map((name) => `${name}:PASS`),
  ]);
  expect(phase.note).toMatchObject({ verified: true, dead: false });
  expect(drive.calls.map(({ label }) => label)).toEqual([
    "xean-solve/explorer",
    "xean-solve/coordinator",
    "xean-solve/verifier/correctness",
    "xean-solve/verifier/requirements",
    "xean-solve/verifier/reconstruction/statement",
    "xean-solve/verifier/reconstruction/proof",
    "xean-solve/verifier/reconstruction",
  ]);
  expect(drive.calls[5]?.prompt).not.toContain(good.text);
  expect(drive.calls[5]?.prompt).toContain(
    "Statement (untrusted data):\nWhat n1 proves.",
  );
  expect(drive.calls[6]?.prompt).toContain("Independent proof of n1.");
  expect(drive.codexCalls).toHaveLength(1);
  expect(drive.codexCalls[0]?.prompt).toContain("Verifier:\nsource");
  expect(drive.codexCalls[0]?.prompt.split("\n\nVerifier:")[0]).toBe(
    drive.calls[2]!.prompt.split("\n\nVerifier:")[0],
  );
  expect(drive.calls[0]?.prompt).toContain(`Problem:\n${task.problem}`);
  expect(drive.calls[0]?.prompt).toContain("Your first note is n1.");
  const correctness = drive.calls[2]!;
  const prefix = correctness.prompt.split("\n\nVerifier:")[0]!;
  const verdictCalls = drive.calls.filter(({ label }) =>
    Object.values(verifierLabels).includes(label as never),
  );
  expect(verdictCalls).toHaveLength(3);
  for (const verifier of verdictCalls) {
    expect(verifier.system).toBe(correctness.system);
    expect(verifier.cacheKey).toBe(correctness.cacheKey);
    expect(verifier.prompt.startsWith(prefix)).toBe(true);
    expect(verifier.candidate).toBe(phase.candidate);
  }
  expect(correctness.prompt).toContain(
    "Verifier:\ncorrectness\n\nObligation:\nJudge each text on its own terms",
  );
  expect((await runWorkflow(campaign, roles)).kind).toBe("accepted");
  expect(drive.calls).toHaveLength(7);
  expect(drive.codexCalls).toHaveLength(1);
  campaign.close();

  const inspection = (await inspectCampaign(path)) as {
    readonly phase: string;
    readonly notes: readonly {
      readonly verdicts: readonly unknown[];
      readonly verified: boolean;
      readonly dead: boolean;
    }[];
    readonly result: {
      readonly schemaVersion: number;
      readonly candidate: number;
      readonly note: { readonly text: string };
    };
    readonly calls: readonly {
      readonly role: string;
      readonly verifier?: string;
      readonly candidate?: number;
      readonly submission?: unknown;
    }[];
  };
  expect(inspection.phase).toBe("accepted");
  expect(inspection.result.schemaVersion).toBe(1);
  expect(inspection.result.candidate).toBe(phase.candidate);
  expect(inspection.result.note.text).toBe(good.text);
  expect(inspection.notes[0]).toMatchObject({ verified: true, dead: false });
  expect(inspection.notes[0]?.verdicts).toHaveLength(4);
  expect(inspection.calls.map(({ role }) => role)).toEqual([
    "explorer",
    "coordinator",
    "verifier",
    "verifier",
    "verifier",
    "verifier",
    "verifier",
    "verifier",
  ]);
  expect(
    inspection.calls
      .slice(5, 8)
      .map(({ verifier, submission }) => [
        verifier,
        Object.keys(submission as object)[0],
      ]),
  ).toEqual([
    ["reconstruction", "statement"],
    ["reconstruction", "proof"],
    ["reconstruction", "verifier"],
  ]);
  expect(inspection.calls[1]?.submission).toEqual(coordination("n1"));
  expect(inspection.calls[2]).toMatchObject({
    verifier: "source",
    candidate: phase.candidate,
    submission: {
      verdicts: [{ note: "n1", verdict: "PASS", sources: [] }],
      usage: { input: 10 },
    },
  });
  expect(inspection.calls[3]).toMatchObject({
    verifier: "correctness",
    candidate: phase.candidate,
    submission: { verdicts: [{ note: "n1", verdict: "PASS" }] },
  });
  expect(inspection.calls[7]).toMatchObject({
    verifier: "reconstruction",
    submission: { verdicts: [{ verdict: "PASS" }] },
  });
  expect(new TextDecoder().decode(await exportCandidate(path))).toBe(
    `--- n1 ---\n\n${good.text}`,
  );
  const reader = openReader(path);
  const captured = reader.records();
  reader.close();
  const original = Projection.prototype.at;
  let derivations = 0;
  Projection.prototype.at = function (seq) {
    if (seq === 1) derivations += 1;
    return original.call(this, seq);
  };
  try {
    const combined = await inspectAndExportCampaignRecords(captured);
    expect(combined.inspection as unknown).toEqual(inspection);
    expect(new TextDecoder().decode(combined.candidate)).toBe(
      `--- n1 ---\n\n${good.text}`,
    );
    expect(derivations).toBe(1);
  } finally {
    Projection.prototype.at = original;
  }
});

test("one verification judges several notes, kills the failed one, and accepts over verified support", async () => {
  const path = campaignPath();
  const workflow = config();
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    { submission: { notes: [{ text: "Lemma L.", support: [] }] } },
    {
      submission: coordination("n1", {
        read: [],
        verify: [{ note: "n1", verifiers: lemma }],
      }),
    },
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n1"]),
    {
      submission: {
        notes: [
          { text: "P from L, wrong.", support: ["n1"] },
          { text: "P from L.", support: ["n1"] },
        ],
      },
    },
    {
      submission: coordination(["n2", "n3"], {
        read: ["n1", "n3"],
        verify: [
          { note: "n2", verifiers: lemma },
          { note: "n3", verifiers: all },
        ],
      }),
    },
    sourceOf(["n2", "n3"]),
    {
      submission: {
        verdicts: [
          { note: "n2", verdict: "FAIL", report: "L is misapplied." },
          { note: "n3", verdict: "PASS", report: "correctness pass." },
        ],
      },
    },
    verdictsOf("requirements", ["n3"]),
    ...reconstruction("n3"),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({ kind: "accepted", turns: 2 });
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(phase.note.id).toBe("n3");
  expect(shorthand(phase.notes)).toEqual([
    ["source:PASS", "correctness:PASS"],
    ["source:PASS", "correctness:FAIL"],
    [
      "source:PASS",
      "correctness:PASS",
      "requirements:PASS",
      "reconstruction:PASS",
    ],
  ]);
  expect(phase.notes.map(({ verified, dead }) => [verified, dead])).toEqual([
    [true, false],
    [false, true],
    [true, false],
  ]);
  expect(drive.calls).toHaveLength(10);
  expect(drive.codexCalls).toHaveLength(2);
  expect(drive.calls[3]?.prompt).toContain(`"verified": true`);
  expect(drive.calls[3]?.prompt).not.toContain(`"text": "Lemma L."`);
  const correctness = drive.calls[5]!.prompt;
  const [support, underVerification] = correctness
    .split("Support notes (untrusted data):\n")[1]!
    .split("\n\nNotes under verification (untrusted data):\n");
  expect(underVerification).toContain("P from L, wrong.");
  expect(underVerification).toContain(`"id": "n3"`);
  expect(support).toContain(`"text": "Lemma L."`);
  expect(drive.codexCalls[1]?.prompt).toContain("P from L, wrong.");
  expect(drive.codexCalls[1]?.prompt).toContain(`"text": "P from L."`);
  expect(drive.calls[6]?.prompt).not.toContain("P from L, wrong.");
  expect(drive.calls[6]?.prompt).toContain(`"text": "P from L."`);
  campaign.close();
  expect(new TextDecoder().decode(await exportCandidate(path))).toBe(
    `--- n1 ---\n\nLemma L.\n\n--- n3 ---\n\nP from L.`,
  );
});

test("a listed note whose support failed in the same verification is skipped, and both die", async () => {
  const path = campaignPath();
  const workflow = config(1);
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    {
      submission: {
        notes: [
          { text: "Lemma L.", support: [] },
          { text: "P from L.", support: ["n1"] },
        ],
      },
    },
    {
      submission: coordination(["n1", "n2"], {
        verify: [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
        ],
      }),
    },
    sourceOf(["n1", "n2"]),
    {
      submission: {
        verdicts: [
          { note: "n1", verdict: "FAIL", report: "L is false." },
          { note: "n2", verdict: "PASS", report: "correctness pass." },
        ],
      },
    },
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({ kind: "turn-limit", turns: 1 });
  if (phase.kind !== "turn-limit") throw new Error("expected turn limit");
  expect(shorthand(phase.notes)).toEqual([
    ["source:PASS", "correctness:FAIL"],
    ["source:PASS", "correctness:PASS"],
  ]);
  expect(phase.notes.map(({ verified, dead }) => [verified, dead])).toEqual([
    [false, true],
    [false, true],
  ]);
  expect(drive.calls).toHaveLength(3);
  expect(drive.codexCalls).toHaveLength(1);
  expect(
    explorerResultFor(phase.notes).safeParse({
      notes: [{ text: "P again.", support: ["n2"] }],
    }).success,
  ).toBe(false);
  expect(
    explorerResultFor(phase.notes).safeParse({
      notes: [{ text: "P anew.", support: [] }],
    }).success,
  ).toBe(true);
  campaign.close();
});

test("resume reconstructs the next role from the journal", async () => {
  const path = campaignPath();
  const workflow = config();
  let campaign = createCampaign(path, applicationId, workflow);
  const first = dependencies([{ submission: { notes: [good] } }]);
  const paused = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, first),
    { pauseRequested: () => first.calls.length >= 1 },
  );
  expect(paused.kind).toBe("coordinator");
  campaign.close();

  campaign = openCampaign(path);
  expect((await phaseOf(campaign)).kind).toBe("coordinator");
  const rest = dependencies([
    { submission: coordination("n1") },
    ...passes("n1"),
  ]);
  const completed = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, rest),
  );
  expect(completed.kind).toBe("accepted");
  expect(rest.calls).toHaveLength(6);
  campaign.close();
});

test("a verification that fails mid-way resumes on the same candidate", async () => {
  const path = campaignPath();
  const workflow = config();
  let campaign = createCampaign(path, applicationId, workflow);
  const first = dependencies([
    { submission: { notes: [good] } },
    { submission: coordination("n1") },
    sourceOf(["n1"]),
    { state: "failed", error: "provider down" },
  ]);
  await expect(
    runWorkflow(campaign, createPiRoles(campaign, workflow.settings, first)),
  ).rejects.toThrow("provider down");
  const paused = await phaseOf(campaign);
  expect(paused.kind).toBe("verifier");
  if (paused.kind !== "verifier") throw new Error("expected verifier");
  expect(paused.candidate).toBe(first.calls[2]!.candidate!);
  campaign.close();

  campaign = openCampaign(path);
  const rest = dependencies(passes("n1").slice(1));
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, rest),
  );
  expect(phase.kind).toBe("accepted");
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(phase.candidate).toBe(paused.candidate!);
  expect(rest.calls.map(({ label }) => label)).toEqual([
    "xean-solve/verifier/correctness",
    "xean-solve/verifier/requirements",
    "xean-solve/verifier/reconstruction/statement",
    "xean-solve/verifier/reconstruction/proof",
    "xean-solve/verifier/reconstruction",
  ]);
  expect(rest.codexCalls).toHaveLength(0);
  expect(phase.note.verdicts.map(({ report }) => report)).toEqual([
    "source pass.",
    "correctness pass.",
    "requirements pass.",
    "reconstruction pass.",
  ]);
  campaign.close();
});

test("a journal written by other prompts is refused", async () => {
  const path = campaignPath();
  const workflow = config();
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([{ submission: { notes: [good] } }]);
  const roles = createPiRoles(campaign, workflow.settings, drive);
  await roles.explorer({
    task,
    explorerGuidance: "Some other objective.",
    notes: [],
    support: [],
  });
  await expect(deriveWorkflow(campaign.records())).rejects.toThrow(
    "does not match the derived explorer request",
  );
  campaign.close();
});

test("the turn limit ends a workflow without a verified note", async () => {
  const path = campaignPath();
  const workflow = config(1);
  const campaign = createCampaign(path, applicationId, workflow);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(
      campaign,
      workflow.settings,
      dependencies([
        { submission: { notes: [good] } },
        { submission: coordination("n1", { verify: [] }) },
      ]),
    ),
  );
  expect(phase).toMatchObject({ kind: "turn-limit", turns: 1 });
  campaign.close();
});

test("a source FAIL kills the note before correctness runs, and the explorer still sees it with its verdict", async () => {
  const path = campaignPath();
  const workflow = config(2);
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    { submission: { notes: [good] } },
    { submission: coordination("n1") },
    {
      codex: {
        verdicts: [
          {
            note: "n1",
            verdict: "FAIL",
            report: "Smith 2020 states the bound for n > 2 only.",
            sources: [],
          },
        ],
      },
    },
    { submission: { notes: [{ text: "P without Smith.", support: [] }] } },
    { submission: coordination("n2", { verify: [] }) },
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({ kind: "turn-limit", turns: 2 });
  if (phase.kind !== "turn-limit") throw new Error("expected turn limit");
  expect(shorthand(phase.notes)).toEqual([["source:FAIL"], []]);
  expect(phase.notes[0]).toMatchObject({ verified: false, dead: true });
  expect(drive.calls).toHaveLength(4);
  expect(drive.calls[2]?.prompt).toContain(`"dead": true`);
  expect(drive.calls[2]?.prompt).toContain("Smith 2020");
  expect(
    coordinatorResultFor(phase.notes).safeParse({
      filings: [],
      explorerGuidance: "Go.",
      support: [],
      verify: [{ note: "n1", verifiers: all }],
    }).success,
  ).toBe(false);
  campaign.close();
});

test("a source PASS that confirms sources without searching is an operational error", async () => {
  const path = campaignPath();
  const workflow = config(1);
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    { submission: { notes: [good] } },
    { submission: coordination("n1") },
    {
      codex: {
        verdicts: [
          {
            note: "n1",
            verdict: "PASS",
            report: "confirmed",
            sources: [
              {
                result: "Every X is Y.",
                source: "Smith 2020",
                url: "https://example.org/smith",
              },
            ],
          },
        ],
      },
      searched: false,
    },
  ]);
  await expect(
    runWorkflow(campaign, createPiRoles(campaign, workflow.settings, drive)),
  ).rejects.toThrow("without a search");
  expect((await phaseOf(campaign)).kind).toBe("verifier");
  campaign.close();
});

test("a Pi source profile runs the source verifier as a Pi call without web search", async () => {
  const path = campaignPath();
  const settings = roleSettings();
  const workflow = workflowConfiguration({
    task,
    settings: { ...settings, maxExplorerTurns: 1, source: settings.explorer },
  });
  let campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    { submission: { notes: [good] } },
    {
      submission: coordination("n1", {
        verify: [{ note: "n1", verifiers: lemma }],
      }),
    },
    verdictsOf("source", ["n1"]),
    verdictsOf("correctness", ["n1"]),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({ kind: "turn-limit", turns: 1 });
  if (phase.kind !== "turn-limit") throw new Error("expected turn limit");
  expect(phase.notes[0]).toMatchObject({ verified: true, dead: false });
  expect(drive.codexCalls).toHaveLength(0);
  expect(drive.calls.map(({ label }) => label)).toEqual([
    "xean-solve/explorer",
    "xean-solve/coordinator",
    "xean-solve/verifier/source",
    "xean-solve/verifier/correctness",
  ]);
  expect(drive.calls[2]?.prompt).toContain("Verifier:\nsource");
  expect(drive.calls[2]?.prompt).toContain(
    "your mathematical knowledge and the supplied texts",
  );
  expect(drive.calls[2]?.system).toContain("Do not use web search");
  campaign.close();
  campaign = openCampaign(path);
  expect((await phaseOf(campaign)).kind).toBe("turn-limit");
  campaign.close();
});

test("explorer notes name only live earlier notes as support", () => {
  const schema = explorerResultFor([
    { id: "n1", dead: false },
    { id: "n2", dead: true },
  ]);
  expect(
    schema.safeParse({
      notes: [
        { text: "a", support: ["n1"] },
        { text: "b", support: ["n1", "n3"] },
      ],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({ notes: [{ text: "a", support: ["n2"] }] }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ notes: [{ text: "a", support: ["n3"] }] }).success,
  ).toBe(false);
  expect(
    schema.safeParse({ notes: [{ text: "a", support: ["n1", "n1"] }] }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      notes: [
        { text: "a", support: ["n4"] },
        { text: "b", support: [] },
      ],
    }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      notes: [{ text: "By the case analysis of n1, P.", support: ["n1"] }],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      notes: [{ text: "By the case analysis of n1, P.", support: [] }],
    }).success,
  ).toBe(true); // Mathematical verification judges omitted dependencies.
  expect(
    schema.safeParse({
      notes: [{ text: "This replaces the dead n2.", support: ["n1"] }],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      notes: [
        { text: "First note n3; the rest is in n4.", support: [] },
        { text: "Second note n4, after n3.", support: ["n3"] },
      ],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      notes: [
        { text: "First note n3.", support: [] },
        { text: "Uses the case from n3.", support: [] },
      ],
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({
      notes: [{ text: "Let $n_1$ be the count; see (n1).", support: ["n1"] }],
    }).success,
  ).toBe(true);
});

test.each(["n2^{-q}", "n4^{-L}", "n8^(-L)"])(
  "Explorer validation does not read %s as a support ID",
  (expression) => {
    const notes = Array.from({ length: 8 }, (_, index) => ({
      id: `n${index + 1}`,
      dead: false,
    }));
    const submitted = {
      notes: [{ text: `The bound is ${expression}.`, support: [] }],
    };
    expect(explorerResultFor(notes).parse(submitted)).toEqual(submitted);
  },
);

test("coordination files every note without a summary and lists live notes over verified or earlier-listed support", () => {
  const schema = coordinatorResultFor([
    { id: "n1", summary: "filed", support: [], verified: true, dead: false },
    { id: "n2", support: ["n1"], verified: false, dead: false },
    {
      id: "n3",
      summary: "filed",
      support: ["n2"],
      verified: false,
      dead: false,
    },
    { id: "n4", summary: "filed", support: [], verified: false, dead: true },
  ]);
  const filed = {
    filings: [{ note: "n2", summary: "new" }],
    explorerGuidance: "Go.",
  };
  const accepts = (value: unknown) => schema.safeParse(value).success;
  expect(
    accepts({ filings: [], explorerGuidance: "Go.", support: [], verify: [] }),
  ).toBe(false);
  expect(
    accepts({
      filings: [{ note: "n1", summary: "again" }],
      explorerGuidance: "Go.",
      support: [],
      verify: [],
    }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: ["n2"],
      verify: [{ note: "n2", verifiers: lemma }],
    }),
  ).toBe(true);
  expect(accepts({ ...filed, support: ["n9"], verify: [] })).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [{ note: "n9", verifiers: all }],
    }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [{ note: "n3", verifiers: all }],
    }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [
        { note: "n2", verifiers: lemma },
        { note: "n3", verifiers: all },
      ],
    }),
  ).toBe(true);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [
        { note: "n2", verifiers: ["source"] },
        { note: "n3", verifiers: all },
      ],
    }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [
        { note: "n3", verifiers: all },
        { note: "n2", verifiers: lemma },
      ],
    }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [{ note: "n4", verifiers: all }],
    }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [{ note: "n2", verifiers: ["correctness"] }],
    }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [{ note: "n2", verifiers: ["source", "requirements"] }],
    }),
  ).toBe(false);
  expect(
    accepts({ ...filed, support: [], verify: [{ note: "n2", verifiers: [] }] }),
  ).toBe(false);
  expect(
    accepts({
      ...filed,
      support: [],
      verify: [
        { note: "n2", verifiers: lemma },
        { note: "n2", verifiers: all },
      ],
    }),
  ).toBe(false);
});

test("a verdict call returns one verdict per note under verification", () => {
  const schema = verdictsFor(["n1", "n2"]);
  const pass = (note: string) => ({ note, verdict: "PASS", report: "ok" });
  expect(
    schema.safeParse({
      verdicts: [pass("n2"), { ...pass("n1"), verdict: "FAIL" }],
    }).success,
  ).toBe(true);
  expect(schema.safeParse({ verdicts: [pass("n1")] }).success).toBe(false);
  expect(
    schema.safeParse({ verdicts: [pass("n1"), pass("n2"), pass("n3")] })
      .success,
  ).toBe(false);
  expect(schema.safeParse({ verdicts: [pass("n1"), pass("n1")] }).success).toBe(
    false,
  );
  expect(
    schema.safeParse({
      verdicts: [pass("n1"), { ...pass("n2"), verdict: "INCONCLUSIVE" }],
    }).success,
  ).toBe(true);
  expect(
    reconstructionResultFor("n1").safeParse({
      statement: null,
      verdicts: [{ ...pass("n1"), verdict: "INCONCLUSIVE" }],
    }).success,
  ).toBe(true);
});

test("each verifier judges the listed notes that passed the verifiers before it and are not dead", () => {
  const note = (id: string, support: string[] = []) => ({
    id,
    summary: "s",
    text: `text ${id}`,
    support,
    verdicts: [],
    verified: false,
    dead: false,
  });
  const input = {
    verify: [
      { note: "n1", verifiers: lemma },
      { note: "n2", verifiers: all },
    ],
    notes: [note("n1"), note("n2", ["n1"])],
    support: [],
  };
  const v = (
    verifier: Verdict["verifier"],
    id: string,
    verdict: Verdict["verdict"] = "PASS",
  ): Verdict => ({ verifier, note: id, verdict, report: "r" });
  expect(judgedBy(input, [], "source")).toEqual(["n1", "n2"]);
  expect(judgedBy(input, [], "correctness")).toEqual([]);
  const passedSource = [v("source", "n1"), v("source", "n2")];
  expect(judgedBy(input, passedSource, "correctness")).toEqual(["n1", "n2"]);
  expect(judgedBy(input, passedSource, "requirements")).toEqual([]);
  expect(
    judgedBy(
      input,
      [v("source", "n1", "FAIL"), v("source", "n2")],
      "correctness",
    ),
  ).toEqual([]);
  expect(
    verificationComplete(input, [v("source", "n1", "FAIL"), v("source", "n2")]),
  ).toBe(true);
  const passedCorrectness = [
    ...passedSource,
    v("correctness", "n1"),
    v("correctness", "n2"),
  ];
  expect(judgedBy(input, passedCorrectness, "requirements")).toEqual(["n2"]);
  expect(judgedBy(input, passedCorrectness, "reconstruction")).toEqual([]);
  expect(verificationComplete(input, passedCorrectness)).toBe(false);
  const passedRequirements = [...passedCorrectness, v("requirements", "n2")];
  expect(judgedBy(input, passedRequirements, "reconstruction")).toEqual(["n2"]);
  expect(verificationComplete(input, passedRequirements)).toBe(false);
  expect(
    verificationComplete(input, [
      ...passedRequirements,
      v("reconstruction", "n2", "INCONCLUSIVE"),
    ]),
  ).toBe(true);
  expect(
    verificationComplete(input, [
      ...passedCorrectness,
      v("requirements", "n2", "FAIL"),
    ]),
  ).toBe(true);

  const chained = {
    verify: [
      { note: "n1", verifiers: all },
      { note: "n3", verifiers: all },
    ],
    notes: [note("n1"), note("n3", ["n2"])],
    support: [{ ...note("n2", ["n1"]), verified: true }],
  };
  expect(
    judgedBy(
      chained,
      [
        v("source", "n1"),
        v("source", "n3"),
        v("correctness", "n1", "FAIL"),
        v("correctness", "n3"),
      ],
      "requirements",
    ),
  ).toEqual([]);

  const both = {
    verify: [
      { note: "n1", verifiers: all },
      { note: "n2", verifiers: all },
    ],
    notes: input.notes,
    support: [],
  };
  const throughRequirements = [
    ...passedCorrectness,
    v("requirements", "n1"),
    v("requirements", "n2"),
  ];
  expect(judgedBy(both, throughRequirements, "reconstruction")).toEqual([
    "n1",
    "n2",
  ]);
  expect(
    judgedBy(
      both,
      [...throughRequirements, v("reconstruction", "n1", "FAIL")],
      "reconstruction",
    ),
  ).toEqual(["n1"]);
  expect(
    verificationComplete(both, [
      ...throughRequirements,
      v("reconstruction", "n1", "FAIL"),
    ]),
  ).toBe(true);
});

test("a verification takes the longest prefix that fits the window, counting shared support once, and always the first entry", async () => {
  const note = (id: string, support: string[] = []) => ({
    id,
    summary: "s",
    text: "0123456789",
    support,
    verdicts: [],
    verified: false,
    dead: false,
  });
  const notes = [note("n1"), note("n2", ["n1"]), note("n3", ["n1"])];
  const verify = [
    { note: "n2", verifiers: lemma },
    { note: "n3", verifiers: lemma },
    { note: "n1", verifiers: lemma },
  ];
  expect(
    (await verificationPrefix(verify, notes, 25)).map(({ note }) => note),
  ).toEqual(["n2"]);
  expect(
    (await verificationPrefix(verify, notes, 30)).map(({ note }) => note),
  ).toEqual(["n2", "n3", "n1"]);
  expect(
    (await verificationPrefix(verify, notes, 5)).map(({ note }) => note),
  ).toEqual(["n2"]);
  expect(await verificationPrefix([], notes, 5)).toEqual([]);
});

test("drains requested verification batches at the turn cap and stops at the first acceptance", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), maxExplorerTurns: 1, window: 1 },
  });
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    {
      submission: {
        notes: [
          { text: "Lemma L.", support: [] },
          { text: "Lemma M from L.", support: ["n1"] },
          { text: "Complete proof of P from M.", support: ["n2"] },
          { text: "Another complete proof of P.", support: [] },
        ],
      },
    },
    {
      submission: coordination(["n1", "n2", "n3", "n4"], {
        verify: [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
          { note: "n3", verifiers: all },
          { note: "n4", verifiers: all },
        ],
      }),
    },
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n2"]),
    verdictsOf("correctness", ["n2"]),
    ...passes("n3"),
  ]);
  const roles = createPiRoles(campaign, workflow.settings, drive);
  const phase = await runWorkflow(campaign, roles);
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 1,
    note: { id: "n3" },
  });
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(shorthand(phase.notes)).toEqual([
    ["source:PASS", "correctness:PASS"],
    ["source:PASS", "correctness:PASS"],
    verifierNames.map((name) => `${name}:PASS`),
    [],
  ]);
  const candidates = campaign
    .records()
    .filter((entry) => entry.kind === "candidate");
  expect(candidates).toHaveLength(3);
  expect(phase.candidate).toBe(candidates[2]!.seq);
  expect(drive.calls.filter(({ role }) => role === "explorer")).toHaveLength(1);
  expect(drive.calls.filter(({ role }) => role === "coordinator")).toHaveLength(
    1,
  );
  expect(drive.codexCalls).toHaveLength(3);
  const settledCount = campaign.records().length;
  expect(await runWorkflow(campaign, roles)).toEqual(phase);
  expect(campaign.records()).toHaveLength(settledCount);
  campaign.close();
  expect(new TextDecoder().decode(await exportCandidate(path))).toContain(
    "Complete proof of P from M.",
  );
});

test.each([
  ["source", "FAIL"],
  ["source", "INCONCLUSIVE"],
  ["correctness", "FAIL"],
  ["correctness", "INCONCLUSIVE"],
] as const)(
  "later batches skip dependencies after %s %s and still check independent notes",
  async (verifier, verdict) => {
    const path = campaignPath();
    const workflow = workflowConfiguration({
      task,
      settings: { ...roleSettings(), maxExplorerTurns: 1, window: 1 },
    });
    const campaign = createCampaign(path, applicationId, workflow);
    const drive = dependencies([
      {
        submission: {
          notes: [
            { text: "Lemma L.", support: [] },
            { text: "Lemma M from L.", support: ["n1"] },
            { text: "P from M.", support: ["n2"] },
            good,
          ],
        },
      },
      {
        submission: coordination(["n1", "n2", "n3", "n4"], {
          verify: [
            { note: "n1", verifiers: lemma },
            { note: "n2", verifiers: lemma },
            { note: "n3", verifiers: all },
            { note: "n4", verifiers: all },
          ],
        }),
      },
      ...(verifier === "source"
        ? [sourceOf(["n1"], verdict)]
        : [sourceOf(["n1"]), verdictsOf("correctness", ["n1"], verdict)]),
      ...passes("n4"),
    ]);
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase).toMatchObject({
      kind: "accepted",
      turns: 1,
      note: { id: "n4" },
    });
    if (phase.kind !== "accepted") throw new Error("expected acceptance");
    expect(
      phase.notes.slice(0, 3).map(({ verified, dead }) => ({ verified, dead })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        verified: false,
        dead: verdict === "FAIL",
      })),
    );
    expect(phase.notes[1]!.verdicts).toEqual([]);
    expect(phase.notes[2]!.verdicts).toEqual([]);
    expect(
      campaign.records().filter((entry) => entry.kind === "candidate"),
    ).toHaveLength(2);
    expect(drive.codexCalls).toHaveLength(2);
    campaign.close();
  },
);

test("an interrupted later verification batch resumes on its own candidate without replaying the first batch", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), maxExplorerTurns: 1, window: 1 },
  });
  let campaign = createCampaign(path, applicationId, workflow);
  const first = dependencies([
    {
      submission: {
        notes: [
          { text: "Lemma L.", support: [] },
          { text: "P from L.", support: ["n1"] },
        ],
      },
    },
    {
      submission: coordination(["n1", "n2"], {
        verify: [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: all },
        ],
      }),
    },
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n2"]),
    { state: "failed", error: "provider down in second batch" },
  ]);
  await expect(
    runWorkflow(campaign, createPiRoles(campaign, workflow.settings, first)),
  ).rejects.toThrow("provider down in second batch");
  const paused = await phaseOf(campaign);
  expect(paused).toMatchObject({
    kind: "verifier",
    input: { verify: [{ note: "n2", verifiers: all }] },
  });
  if (paused.kind !== "verifier") throw new Error("expected verifier");
  const candidates = campaign
    .records()
    .filter((entry) => entry.kind === "candidate");
  expect(candidates).toHaveLength(2);
  expect(paused.candidate).toBe(candidates[1]!.seq);
  campaign.close();

  campaign = openCampaign(path);
  const rest = dependencies(passes("n2").slice(1));
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, rest),
  );
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 1,
    candidate: paused.candidate,
    note: { id: "n2" },
  });
  expect(rest.codexCalls).toHaveLength(0);
  expect(rest.calls.map(({ label }) => label)).toEqual([
    "xean-solve/verifier/correctness",
    "xean-solve/verifier/requirements",
    "xean-solve/verifier/reconstruction/statement",
    "xean-solve/verifier/reconstruction/proof",
    "xean-solve/verifier/reconstruction",
  ]);
  expect(
    campaign.records().filter((entry) => entry.kind === "candidate"),
  ).toHaveLength(2);
  campaign.close();
});

test("later batches can use verified support that failed task completion", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), maxExplorerTurns: 1, window: 1 },
  });
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    {
      submission: {
        notes: [
          { text: "Lemma L.", support: [] },
          { text: "P from L.", support: ["n1"] },
        ],
      },
    },
    {
      submission: coordination(["n1", "n2"], {
        verify: [
          { note: "n1", verifiers: all },
          { note: "n2", verifiers: all },
        ],
      }),
    },
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n1"]),
    verdictsOf("requirements", ["n1"], "FAIL"),
    ...passes("n2"),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 1,
    note: { id: "n2" },
  });
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(phase.notes[0]).toMatchObject({ verified: true, dead: false });
  expect(shorthand([phase.notes[0]!])).toEqual([
    ["source:PASS", "correctness:PASS", "requirements:FAIL"],
  ]);
  campaign.close();
});

test("the next explorer starts only after all requested partial-result batches settle", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), maxExplorerTurns: 2, window: 1 },
  });
  const campaign = createCampaign(path, applicationId, workflow);
  const drive = dependencies([
    {
      submission: {
        notes: [
          { text: "Lemma L.", support: [] },
          { text: "Lemma M from L.", support: ["n1"] },
        ],
      },
    },
    {
      submission: coordination(["n1", "n2"], {
        verify: [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
        ],
      }),
    },
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n2"]),
    verdictsOf("correctness", ["n2"]),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
    { pauseRequested: () => drive.calls.length === 4 },
  );
  expect(phase.kind).toBe("explorer");
  if (phase.kind !== "explorer") throw new Error("expected explorer");
  expect(phase.input.notes.map(({ verified }) => verified)).toEqual([
    true,
    true,
  ]);
  expect(drive.codexCalls).toHaveLength(2);
  expect(drive.calls.filter(({ role }) => role === "explorer")).toHaveLength(1);
  campaign.close();
});

test.each([false, true])(
  "source verification can use knowledge without retrieved sources (search=%s)",
  async (search) => {
    const path = campaignPath();
    const settings = roleSettings();
    const workflow = workflowConfiguration({
      task,
      settings: {
        ...settings,
        maxExplorerTurns: 1,
        source: {
          provider: "codex",
          model: "codex-model",
          reasoning: "low",
          search,
        },
      },
    });
    const campaign = createCampaign(path, applicationId, workflow);
    const drive = dependencies([
      { submission: { notes: [good] } },
      {
        submission: coordination("n1", {
          verify: [{ note: "n1", verifiers: lemma }],
        }),
      },
      { ...sourceOf(["n1"]), searched: false },
      verdictsOf("correctness", ["n1"]),
    ]);
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase).toMatchObject({ kind: "turn-limit", turns: 1 });
    if (phase.kind !== "turn-limit") throw new Error("expected turn limit");
    expect(phase.notes[0]).toMatchObject({ verified: true, dead: false });
    expect(drive.codexCalls[0]).toMatchObject({ search });
    if (!search)
      expect(drive.codexCalls[0]?.developerInstructions).toContain(
        "no web search",
      );
    expect(drive.codexCalls[0]?.prompt).toContain(
      "your mathematical knowledge and the supplied texts",
    );
    campaign.close();
  },
);

test("the first Explorer works on the task without fixed guidance in settings", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: roleSettings(),
  });
  const campaign = createCampaign(path, applicationId, workflow);
  expect(await phaseOf(campaign)).toMatchObject({
    kind: "explorer",
    input: { task, explorerGuidance: "" },
  });
  campaign.close();
});
