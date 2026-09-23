import { afterEach, expect, test } from "bun:test";

import { openCampaign, openReader, type Campaign } from "xean";

import { createPiRoles } from "../pi-roles";
import {
  coordinatorInput,
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
  exportSolution,
  inspectCampaign,
  inspectAndExportCampaignRecords,
} from "../role-cli";
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

test.each(["coordinator", "literature"] as const)(
  "driver interruption reaches the active %s adapter without a construction-time signal",
  async (role) => {
    const settings = roleSettings();
    settings.coordinatorBehavior = {
      ...settings.coordinatorBehavior,
      literature: "required-if-not-started",
    };
    const configuration = workflowConfiguration({ task, settings });
    const campaign = await createWorkflowCampaign(
      campaignPath(),
      configuration,
    );
    const started = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<never>();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const wait = (signal?: AbortSignal) => {
      received = signal;
      signal?.addEventListener(
        "abort",
        () => stopped.reject(new Error("provider aborted")),
        { once: true },
      );
      started.resolve();
      return stopped.promise;
    };
    const drive = dependencies([
      {
        submission: {
          filings: [],
          action: { role: "literature", request: "Find P." },
        },
      },
    ]);
    const roles = createPiRoles(campaign, settings, {
      ...drive,
      run: (campaign, options) =>
        role === "coordinator"
          ? wait(options.signal)
          : drive.run(campaign, options),
      codex: (_request, signal) => wait(signal),
    });
    const running = runWorkflow(campaign, roles, { signal: controller.signal });
    try {
      await started.promise;
      controller.abort();
      expect(received?.aborted).toBe(true);
      await expect(running).rejects.toThrow();
    } finally {
      stopped.reject(new Error("test cleanup"));
      await running.catch(() => {});
      campaign.close();
    }
  },
);

const task = {
  problem: "Prove P.",
  completionCriteria: "Give a complete proof of P.",
};
const good = { text: "Complete proof of P.", support: [] };
const all = [...verifierNames];
const lemma: Verification["verifiers"] = ["correctness", "source"];

const externalResults = (note: string) => [`External premise of ${note}`];

function verdictsOf(
  name: string,
  notes: readonly string[],
  verdict = "PASS",
  premises: (note: string) => string[] = externalResults,
): Reply {
  return {
    submission: {
      ...(name === "reconstruction" ? { statement: null } : {}),
      verdicts: notes.map((note) => ({
        note,
        verdict,
        report: `${name} ${verdict.toLowerCase()}.`,
        ...(name === "correctness" ? { externalResults: premises(note) } : {}),
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
        correctedText: null,
        sources:
          verdict === "PASS"
            ? [
                {
                  resultId: `${note}#1`,
                  source: "Example Theorem 1",
                  url: "https://example.org/theorem",
                  quote: "Exact inspected theorem.",
                },
              ]
            : [],
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
    verdictsOf("correctness", [note]),
    sourceOf([note]),
    verdictsOf("requirements", [note]),
    ...reconstruction(note),
  ];
}

function config() {
  return workflowConfiguration({
    task,
    settings: roleSettings(),
  });
}

/** File the notes and dispatch the verifier over `verify`, or Explorer when the list is empty. */
function coordination(
  notes: string | readonly string[],
  options: {
    readonly verify?: readonly Verification[];
    readonly read?: readonly string[];
  } = {},
) {
  const filed = typeof notes === "string" ? [notes] : notes;
  const verify = options.verify ?? [{ note: filed.at(-1)!, verifiers: all }];
  return {
    filings: filed.map((note) => ({ note, summary: `Summary of ${note}.` })),
    action:
      verify.length > 0
        ? { role: "verifier", verify }
        : {
            role: "explorer",
            explorerGuidance: `Continue from ${filed.at(-1)}.`,
            support: options.read ?? [filed.at(-1)!],
          },
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
  const settings = roleSettings();
  const workflow = workflowConfiguration({
    task,
    settings: {
      ...settings,
      explorer: { ...settings.explorer, replayReasoning: false },
    },
  });
  const campaign = await createWorkflowCampaign(path, workflow, 4);
  const drive = dependencies([
    dispatchExplorer(),
    { submission: { solution: false, notes: [good] } },
    { submission: coordination("n1") },
    ...passes("n1"),
  ]);
  let accepted;
  try {
    const roles = createPiRoles(campaign, workflow.settings, drive);
    const phase = await runWorkflow(campaign, roles);
    const transportChanged = campaign.records().map((entry) => {
      if (
        entry.kind !== "call" ||
        entry.role === undefined ||
        typeof entry.request !== "object" ||
        entry.request === null ||
        Array.isArray(entry.request)
      )
        return entry;
      return {
        ...entry,
        request: {
          ...entry.request,
          prompt: "Transport wording is not workflow identity.",
        },
      };
    });
    expect(deriveWorkflow(transportChanged)).toEqual(
      deriveWorkflow(campaign.records()),
    );
    expect(phase).toMatchObject({
      kind: "accepted",
      turns: 2,
      note: {
        id: "n1",
        summary: "Summary of n1.",
        text: good.text,
        verified: true,
        dead: false,
      },
    });
    if (phase.kind !== "accepted") throw new Error("expected acceptance");
    accepted = phase;
    expect(shorthand([phase.note])).toEqual([
      verifierNames.map((name) => name + ":PASS"),
    ]);
    expect(drive.calls.map(({ label }) => label)).toEqual([
      "xean-solve/coordinator",
      "xean-solve/explorer",
      "xean-solve/coordinator",
      "xean-solve/verifier/correctness",
      "xean-solve/verifier/requirements",
      "xean-solve/verifier/reconstruction/statement",
      "xean-solve/verifier/reconstruction/proof",
      "xean-solve/verifier/reconstruction",
    ]);
    expect(drive.calls[6]?.prompt).not.toContain(good.text);
    expect(drive.calls[6]?.prompt).toContain("What n1 proves.");
    expect(drive.calls[7]?.prompt).toContain("Independent proof of n1.");
    expect(drive.calls[1]).toMatchObject({ replayReasoning: false });
    expect(drive.calls[0]).not.toHaveProperty("replayReasoning");
    for (const call of drive.calls.filter(({ role }) => role === "verifier"))
      expect(call.parent).toBe(phase.verification);
    const settled = campaign.records();
    expect(
      settled.find(
        (entry) => entry.kind === "call" && entry.role === "explorer",
      ),
    ).toMatchObject({ request: { replayReasoning: false } });
    expect(await runWorkflow(campaign, roles)).toEqual(phase);
    expect(campaign.records()).toEqual(settled);
  } finally {
    campaign.close();
  }
  const inspection = await inspectCampaign(path);
  expect(inspection).toMatchObject({
    phase: "accepted",
    result: {
      schemaVersion: 2,
      verification: accepted.verification,
      note: { text: good.text },
    },
    notes: [{ verified: true, dead: false }],
  });
  const calls = (inspection as { calls: { verifier?: string }[] }).calls;
  expect(
    calls.find(({ verifier }) => verifier === "correctness"),
  ).toMatchObject({
    parent: accepted.verification,
    submission: {
      verdicts: [
        { note: "n1", verdict: "PASS", externalResults: externalResults("n1") },
      ],
    },
  });
  expect(calls.find(({ verifier }) => verifier === "source")).toMatchObject({
    parent: accepted.verification,
    submission: {
      verdicts: [
        { note: "n1", verdict: "PASS", sources: [{ resultId: "n1#1" }] },
      ],
      usage: { input: 10 },
    },
  });
  expect(
    calls.findLast(({ verifier }) => verifier === "reconstruction"),
  ).toMatchObject({
    submission: { verdicts: [{ verdict: "PASS" }] },
  });
  const argument = "--- n1 ---\n\n" + good.text;
  expect(new TextDecoder().decode(await exportSolution(path))).toBe(argument);
  const reader = openReader(path);
  try {
    const combined = inspectAndExportCampaignRecords(reader.records());
    expect(combined.inspection).toEqual(inspection);
    expect(new TextDecoder().decode(combined.solution)).toBe(argument);
  } finally {
    reader.close();
  }
});

test("one verification judges several notes, kills the failed one, and accepts over verified support", async () => {
  const path = campaignPath();
  const workflow = config();
  const campaign = await createWorkflowCampaign(path, workflow, 4);
  const drive = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
        notes: [{ text: "Lemma L.", support: [] }],
      },
    },
    {
      submission: coordination("n1", {
        read: [],
        verify: [{ note: "n1", verifiers: lemma }],
      }),
    },
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n1"]),
    // No note was added since that verification, so the coordinator explores.
    dispatchExplorer(),
    {
      submission: {
        solution: false,
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
    {
      submission: {
        verdicts: [
          {
            note: "n2",
            verdict: "FAIL",
            report: "L is misapplied.",
            externalResults: [],
          },
          {
            note: "n3",
            verdict: "PASS",
            report: "correctness pass.",
            externalResults: externalResults("n3"),
          },
        ],
      },
    },
    sourceOf(["n3"]),
    verdictsOf("requirements", ["n3"]),
    ...reconstruction("n3"),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({ kind: "accepted", turns: 4 });
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(phase.note.id).toBe("n3");
  expect(shorthand(phase.notes)).toEqual([
    ["correctness:PASS", "source:PASS"],
    ["correctness:FAIL"],
    [
      "correctness:PASS",
      "source:PASS",
      "requirements:PASS",
      "reconstruction:PASS",
    ],
  ]);
  expect(phase.notes.map(({ verified, dead }) => [verified, dead])).toEqual([
    [true, false],
    [false, true],
    [true, false],
  ]);
  expect(drive.calls).toHaveLength(12);
  expect(drive.codexCalls).toHaveLength(2);
  expect(drive.calls[5]?.prompt).toContain(`"verified": true`);
  expect(drive.calls[5]?.prompt).not.toContain(`"text": "Lemma L."`);
  const correctness = drive.calls[7]!.prompt;
  const [support, underVerification] = correctness
    .split("Support notes (untrusted data):\n")[1]!
    .split("\n\nNotes under verification (untrusted data):\n");
  expect(underVerification).toContain("P from L, wrong.");
  expect(underVerification).toContain(`"id": "n3"`);
  expect(support).toContain(`"text": "Lemma L."`);
  expect(drive.codexCalls[1]?.prompt).not.toContain("P from L, wrong.");
  expect(drive.codexCalls[1]?.prompt).toContain(`"text": "P from L."`);
  expect(drive.codexCalls[1]?.prompt).not.toContain(`"text": "Lemma L."`);
  expect(drive.calls[8]?.prompt).not.toContain("P from L, wrong.");
  expect(drive.calls[8]?.prompt).toContain(`"text": "P from L."`);
  campaign.close();
  expect(new TextDecoder().decode(await exportSolution(path))).toBe(
    `--- n1 ---\n\nLemma L.\n\n--- n3 ---\n\nP from L.`,
  );
});

test("a listed note whose support failed in the same verification is skipped, and both die", async () => {
  const path = campaignPath();
  const workflow = config();
  const campaign = await createWorkflowCampaign(path, workflow, 2);
  const drive = dependencies([
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
      submission: coordination(["n1", "n2"], {
        verify: [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
        ],
      }),
    },
    {
      submission: {
        verdicts: [
          {
            note: "n1",
            verdict: "FAIL",
            report: "L is false.",
            externalResults: [],
          },
          {
            note: "n2",
            verdict: "PASS",
            report: "correctness pass.",
            externalResults: [],
          },
        ],
      },
    },
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({ kind: "turn-limit", turns: 2 });
  if (phase.kind !== "turn-limit") throw new Error("expected turn limit");
  expect(shorthand(phase.notes)).toEqual([
    ["correctness:FAIL"],
    ["correctness:PASS"],
  ]);
  expect(phase.notes.map(({ verified, dead }) => [verified, dead])).toEqual([
    [false, true],
    [false, true],
  ]);
  expect(drive.calls).toHaveLength(4);
  expect(drive.codexCalls).toHaveLength(0);
  expect(
    explorerResultFor(phase.notes).safeParse({
      solution: false,
      notes: [{ text: "P again.", support: ["n2"] }],
    }).success,
  ).toBe(false);
  expect(
    explorerResultFor(phase.notes).safeParse({
      solution: false,
      notes: [{ text: "P anew.", support: [] }],
    }).success,
  ).toBe(true);
  campaign.close();
});

test("resume reconstructs the next role from the journal", async () => {
  const path = campaignPath();
  const workflow = config();
  let campaign = await createWorkflowCampaign(path, workflow, 4);
  const first = dependencies([
    dispatchExplorer(),
    { submission: { solution: false, notes: [good] } },
  ]);
  const paused = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, first),
    { pauseRequested: () => first.calls.length >= 2 },
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

test("a verification that fails mid-way resumes on the same verification", async () => {
  const path = campaignPath();
  const workflow = config();
  let campaign = await createWorkflowCampaign(path, workflow, 4);
  const first = dependencies([
    dispatchExplorer(),
    { submission: { solution: false, notes: [good] } },
    { submission: coordination("n1") },
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n1"]),
    {
      state: "failed",
      error: "provider down",
      transcript: [
        { role: "assistant", stopReason: "length", content: [] },
        { role: "assistant", stopReason: "error", content: [] },
      ],
    },
  ]);
  await expect(
    runWorkflow(campaign, createPiRoles(campaign, workflow.settings, first)),
  ).rejects.toThrow("provider down");
  const paused = await phaseOf(campaign);
  expect(paused.kind).toBe("verifier");
  if (paused.kind !== "verifier") throw new Error("expected verifier");
  expect(paused.verification).toBe(first.calls[4]!.parent!);
  campaign.close();

  campaign = openCampaign(path);
  const rest = dependencies(passes("n1").slice(2));
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, rest),
  );
  expect(phase.kind).toBe("accepted");
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(phase.verification).toBe(paused.verification!);
  expect(rest.calls.map(({ label }) => label)).toEqual([
    "xean-solve/verifier/requirements",
    "xean-solve/verifier/reconstruction/statement",
    "xean-solve/verifier/reconstruction/proof",
    "xean-solve/verifier/reconstruction",
  ]);
  expect(rest.codexCalls).toHaveLength(0);
  expect(rest.calls[0]!.prompt).toBe(first.calls[4]!.prompt);
  expect(phase.note.verdicts.map(({ report }) => report)).toEqual([
    "correctness pass.",
    "source pass.",
    "requirements pass.",
    "reconstruction pass.",
  ]);
  campaign.close();
});

test("workflow calls require their recorded owner", async () => {
  const path = campaignPath();
  const workflow = config();
  const campaign = await createWorkflowCampaign(path, workflow, 4);
  const drive = dependencies([dispatchExplorer()]);
  const roles = createPiRoles(campaign, workflow.settings, drive);
  await expect(roles.coordinator({ task, notes: [] })).rejects.toThrow(
    "parent call",
  );
  const wrong = await campaign.call(
    { label: "wrong-owner", request: null },
    async () => null,
  );
  await roles.coordinator({ task, notes: [] }, wrong.call);
  expect(() => deriveWorkflow(campaign.records())).toThrow(
    "does not belong to its dispatch",
  );
  campaign.close();
});

test("a source FAIL kills a conditionally correct note before requirements, and the explorer still sees its verdict", async () => {
  const path = campaignPath();
  const workflow = config();
  const campaign = await createWorkflowCampaign(path, workflow, 3);
  const drive = dependencies([
    dispatchExplorer(),
    { submission: { solution: false, notes: [good] } },
    { submission: coordination("n1") },
    verdictsOf("correctness", ["n1"], "PASS", () => [
      "Smith's bound for all n.",
    ]),
    {
      codex: {
        verdicts: [
          {
            note: "n1",
            verdict: "FAIL",
            report: "Smith 2020 states the bound for n > 2 only.",
            correctedText: null,
            sources: [],
          },
        ],
      },
    },
    dispatchExplorer(),
    {
      submission: {
        solution: false,
        notes: [{ text: "P without Smith.", support: [] }],
      },
    },
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({ kind: "turn-limit", turns: 3 });
  if (phase.kind !== "turn-limit") throw new Error("expected turn limit");
  expect(shorthand(phase.notes)).toEqual([
    ["correctness:PASS", "source:FAIL"],
    [],
  ]);
  expect(phase.notes[0]).toMatchObject({ verified: false, dead: true });
  expect(drive.calls).toHaveLength(6);
  expect(drive.calls[5]?.prompt).toContain(`"dead": true`);
  expect(drive.calls[5]?.prompt).toContain("Smith 2020");
  expect(
    drive.calls.some(({ label }) => label === verifierLabels.requirements),
  ).toBe(false);
  expect(
    coordinatorResultFor(
      coordinatorInput.parse({ task, notes: phase.notes }),
    ).safeParse({
      filings: [{ note: "n2", summary: "P." }],

      action: { role: "verifier", verify: [{ note: "n1", verifiers: all }] },
    }).success,
  ).toBe(false);
  campaign.close();
});

test("explorer notes name only live earlier notes as support", () => {
  const schema = explorerResultFor([
    { id: "n1", dead: false },
    { id: "n2", dead: true },
  ]);
  const valid = {
    solution: false,
    notes: [
      {
        text: "The bound n2^{-q} does not use the dead note n2.",
        support: ["n1"],
      },
      { text: "A consequence of the new n3.", support: ["n3"] },
    ],
  };
  expect(schema.parse(valid)).toEqual(valid);
  expect(
    schema.safeParse({
      solution: false,
      notes: [{ text: "Uses n1 in prose only.", support: [] }],
    }).success,
  ).toBe(true);
  for (const support of [[["n2"]], [["n3"]], [["n1", "n1"]], [["n4"], []]]) {
    expect(
      schema.safeParse({
        solution: false,
        notes: support.map((support) => ({
          text: "An invalid dependency.",
          support,
        })),
      }).success,
    ).toBe(false);
  }
});

test("coordination files every note without a summary and lists live notes over verified or earlier-listed support", () => {
  const known = {
    summary: "filed",
    text: "Proof.",
    verdicts: [],
    verified: false,
    dead: false,
  };
  const schema = coordinatorResultFor(
    coordinatorInput.parse({
      task,
      notes: [
        { ...known, id: "n1", support: [], verified: true },
        { ...known, id: "n2", support: ["n1"], summary: undefined },
        { ...known, id: "n3", support: ["n2"] },
        { ...known, id: "n4", support: [], dead: true },
      ],
    }),
  );
  const filings = [{ note: "n2", summary: "new" }];
  const explorer = { role: "explorer", explorerGuidance: "Go.", support: [] };
  expect(schema.safeParse({ filings, action: explorer }).success).toBe(true);
  for (const invalid of [[], [{ note: "n1", summary: "again" }]])
    expect(
      schema.safeParse({ filings: invalid, action: explorer }).success,
    ).toBe(false);
  expect(
    schema.safeParse({ filings, action: { ...explorer, support: ["n9"] } })
      .success,
  ).toBe(false);
  const check = (note: string, verifiers: readonly string[] = all) => ({
    note,
    verifiers,
  });
  for (const verify of [
    [check("n2", ["correctness"])],
    [check("n2", lemma)],
    [check("n2", lemma), check("n3")],
  ])
    expect(
      schema.safeParse({ filings, action: { role: "verifier", verify } })
        .success,
    ).toBe(true);
  for (const verify of [
    [check("n9")],
    [check("n3")],
    [check("n4")],
    [check("n2", ["correctness"]), check("n3")],
    [check("n3"), check("n2", lemma)],
    [check("n2", ["correctness", "requirements"])],
    [check("n2", [])],
    [check("n2", lemma), check("n2")],
  ])
    expect(
      schema.safeParse({ filings, action: { role: "verifier", verify } })
        .success,
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
  expect(judgedBy(input, [], "correctness")).toEqual(["n1", "n2"]);
  expect(judgedBy(input, [], "source")).toEqual([]);
  const passedCorrectness = [v("correctness", "n1"), v("correctness", "n2")];
  expect(judgedBy(input, passedCorrectness, "source")).toEqual(["n1", "n2"]);
  expect(judgedBy(input, passedCorrectness, "requirements")).toEqual([]);
  expect(
    judgedBy(
      input,
      [v("correctness", "n1", "FAIL"), v("correctness", "n2")],
      "source",
    ),
  ).toEqual([]);
  expect(
    verificationComplete(input, [
      v("correctness", "n1", "FAIL"),
      v("correctness", "n2"),
    ]),
  ).toBe(true);
  const passedSource = [
    ...passedCorrectness,
    v("source", "n1"),
    v("source", "n2"),
  ];
  expect(judgedBy(input, passedSource, "requirements")).toEqual(["n2"]);
  expect(judgedBy(input, passedSource, "reconstruction")).toEqual([]);
  expect(verificationComplete(input, passedSource)).toBe(false);
  const passedRequirements = [...passedSource, v("requirements", "n2")];
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
      ...passedSource,
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
        v("correctness", "n1", "FAIL"),
        v("correctness", "n3"),
        v("source", "n3"),
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
    ...passedSource,
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

test("drains requested verification batches at the turn cap and stops at the first acceptance", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), window: 1 },
  });
  const campaign = await createWorkflowCampaign(path, workflow, 2);
  const drive = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
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
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n2"]),
    sourceOf(["n2"]),
    ...passes("n3"),
  ]);
  const roles = createPiRoles(campaign, workflow.settings, drive);
  const phase = await runWorkflow(campaign, roles);
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 2,
    note: { id: "n3" },
  });
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(shorthand(phase.notes)).toEqual([
    ["correctness:PASS", "source:PASS"],
    ["correctness:PASS", "source:PASS"],
    verifierNames.map((name) => `${name}:PASS`),
    [],
  ]);
  const verifications = campaign
    .records()
    .filter(
      (entry) =>
        entry.kind === "call" && entry.label === "xean-solve/verification",
    );
  expect(verifications).toHaveLength(3);
  expect(phase.verification).toBe(verifications[2]!.seq);
  expect(drive.calls.filter(({ role }) => role === "explorer")).toHaveLength(1);
  expect(drive.calls.filter(({ role }) => role === "coordinator")).toHaveLength(
    2,
  );
  expect(drive.codexCalls).toHaveLength(3);
  const settledCount = campaign.records().length;
  expect(await runWorkflow(campaign, roles)).toEqual(phase);
  expect(campaign.records()).toHaveLength(settledCount);
  campaign.close();
  expect(new TextDecoder().decode(await exportSolution(path))).toContain(
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
      settings: { ...roleSettings(), window: 1 },
    });
    const campaign = await createWorkflowCampaign(path, workflow, 2);
    const drive = dependencies([
      dispatchExplorer(),
      {
        submission: {
          solution: false,
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
        ? [verdictsOf("correctness", ["n1"]), sourceOf(["n1"], verdict)]
        : [verdictsOf("correctness", ["n1"], verdict)]),
      ...passes("n4"),
    ]);
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, workflow.settings, drive),
    );
    expect(phase).toMatchObject({
      kind: "accepted",
      turns: 2,
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
      campaign
        .records()
        .filter(
          (entry) =>
            entry.kind === "call" && entry.label === "xean-solve/verification",
        ),
    ).toHaveLength(2);
    expect(drive.codexCalls).toHaveLength(verifier === "source" ? 2 : 1);
    campaign.close();
  },
);

test("an interrupted later verification batch resumes on its own verification without replaying the first batch", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), window: 1 },
  });
  let campaign = await createWorkflowCampaign(path, workflow, 2);
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
      submission: coordination(["n1", "n2"], {
        verify: [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: all },
        ],
      }),
    },
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n2"]),
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
  const verifications = campaign
    .records()
    .filter(
      (entry) =>
        entry.kind === "call" && entry.label === "xean-solve/verification",
    );
  expect(verifications).toHaveLength(2);
  expect(paused.verification).toBe(verifications[1]!.seq);
  campaign.close();

  campaign = openCampaign(path);
  const rest = dependencies(passes("n2").slice(2));
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, rest),
  );
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 2,
    verification: paused.verification,
    note: { id: "n2" },
  });
  expect(rest.codexCalls).toHaveLength(0);
  expect(rest.calls.map(({ label }) => label)).toEqual([
    "xean-solve/verifier/requirements",
    "xean-solve/verifier/reconstruction/statement",
    "xean-solve/verifier/reconstruction/proof",
    "xean-solve/verifier/reconstruction",
  ]);
  expect(
    campaign
      .records()
      .filter(
        (entry) =>
          entry.kind === "call" && entry.label === "xean-solve/verification",
      ),
  ).toHaveLength(2);
  campaign.close();
});

test("later batches can use verified support that failed task completion", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), window: 1 },
  });
  const campaign = await createWorkflowCampaign(path, workflow, 2);
  const drive = dependencies([
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
      submission: coordination(["n1", "n2"], {
        verify: [
          { note: "n1", verifiers: all },
          { note: "n2", verifiers: all },
        ],
      }),
    },
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n1"]),
    verdictsOf("requirements", ["n1"], "FAIL"),
    ...passes("n2"),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
  );
  expect(phase).toMatchObject({
    kind: "accepted",
    turns: 2,
    note: { id: "n2" },
  });
  if (phase.kind !== "accepted") throw new Error("expected acceptance");
  expect(phase.notes[0]).toMatchObject({ verified: true, dead: false });
  expect(shorthand([phase.notes[0]!])).toEqual([
    ["correctness:PASS", "source:PASS", "requirements:FAIL"],
  ]);
  campaign.close();
});

test("the next coordinator starts only after all requested partial-result batches settle", async () => {
  const path = campaignPath();
  const workflow = workflowConfiguration({
    task,
    settings: { ...roleSettings(), window: 1 },
  });
  const campaign = await createWorkflowCampaign(path, workflow, 3);
  const drive = dependencies([
    dispatchExplorer(),
    {
      submission: {
        solution: false,
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
    verdictsOf("correctness", ["n1"]),
    sourceOf(["n1"]),
    verdictsOf("correctness", ["n2"]),
    sourceOf(["n2"]),
  ]);
  const phase = await runWorkflow(
    campaign,
    createPiRoles(campaign, workflow.settings, drive),
    { pauseRequested: () => drive.calls.length === 5 },
  );
  expect(phase.kind).toBe("coordinator");
  if (phase.kind !== "coordinator") throw new Error("expected coordinator");
  expect(phase.input.notes.map(({ verified }) => verified)).toEqual([
    true,
    true,
  ]);
  expect(drive.codexCalls).toHaveLength(2);
  expect(drive.calls.filter(({ role }) => role === "explorer")).toHaveLength(1);
  campaign.close();
});
