import { afterEach, expect, test } from "bun:test";

import { openReader } from "xean";

import { inspectCampaign, submitNotes } from "../role-cli";
import { init, run } from "../runner";
import {
  explorerResultFor,
  verifierNames,
  type Note,
  type Verification,
} from "../roles";
import { workflowSchemaVersion } from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const externalText = "A separately supplied lemma with its full proof.";
const attestation = {
  source: "Independent human proof review",
  report: "The stated lemma and its hypotheses were checked in full.",
};
const partial = { text: "An independent partial result.", support: [] };
const lemmaVerifiers: Verification["verifiers"] = ["correctness", "source"];

async function setup(turns = 1) {
  const campaign = campaignPath();
  const profiles = roleSettings();
  const request = {
    task,
    campaignPath: campaign,
    turns,
    settings: {
      ...profiles,
    },
  };
  await init(request);
  return { path: campaign, request };
}

function records(path: string) {
  const reader = openReader(path);
  try {
    return [...reader.records()];
  } finally {
    reader.close();
  }
}

type Inspection = {
  phase: string;
  notes: Note[];
  result?: unknown;
  submissions?: unknown[];
};

async function inspect(path: string, includeSubmissions = false) {
  return (await inspectCampaign(path, {
    includeSubmissions,
  })) as unknown as Inspection;
}

function coordinate(
  ids: string[],
  support: string[] = [],
  verify: Verification[] = [],
): Reply {
  return {
    submission: {
      filings: ids.map((note) => ({ note, summary: `Statement of ${note}.` })),
      explorerGuidance: "Prove the remaining implication.",
      support,
      verify,
    },
  };
}

function verdict(note: string, name: string, result = "PASS"): Reply {
  if (name === "source")
    return {
      codex: {
        verdicts: [
          {
            note,
            verdict: result,
            report: `${name}: ${result}.`,
            externalResults: [`External theorem for ${note}.`],
            sources: [
              {
                result: `External theorem for ${note}.`,
                source: "Primary theorem.",
                url: "https://example.test/theorem",
                quote: "Exact theorem statement.",
              },
            ],
          },
        ],
      },
    };
  return {
    submission: {
      ...(name === "reconstruction" ? { statement: null } : {}),
      verdicts: [
        {
          note,
          verdict: result,
          report: `${name}: ${result}.`,
          ...(name === "correctness"
            ? { externalResults: [`External theorem for ${note}.`] }
            : {}),
        },
      ],
    },
  };
}

function coordinatorNotes(prompt: string): Note[] {
  const marker = "Notes (untrusted data):\n";
  const at = prompt.lastIndexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  return JSON.parse(prompt.slice(at + marker.length));
}

test("submission-local support follows its own notes after active Explorer output", async () => {
  const { path, request } = await setup();
  const graph = {
    notes: [
      { text: "An isolated external theorem T.", support: [] },
      { text: "An application of theorem T.", support: [1] },
    ],
  };
  const drive = dependencies([
    {
      submission: { solution: false, notes: [partial] },
      onStarted: async () => {
        await submitNotes(path, graph, "graph-a");
        const beforeRetry = records(path);
        await submitNotes(path, graph, "graph-a");
        expect(records(path)).toEqual(beforeRetry);
        await submitNotes(path, graph, "graph-b");
      },
    },
    coordinate(["n1", "n2", "n3", "n4", "n5"]),
  ]);
  expect(await run(request, drive)).toMatchObject({ outcome: "turn-limit" });
  const projected = coordinatorNotes(drive.allCalls[1]!.prompt);
  expect(projected.map(({ id, support }) => ({ id, support }))).toEqual([
    { id: "n1", support: [] },
    { id: "n2", support: [] },
    { id: "n3", support: ["n2"] },
    { id: "n4", support: [] },
    { id: "n5", support: ["n4"] },
  ]);
  expect(projected.slice(1).map(({ text }) => text)).toEqual([
    ...graph.notes.map(({ text }) => text),
    ...graph.notes.map(({ text }) => text),
  ]);
  expect((await inspect(path, true)).submissions).toMatchObject([
    { id: "graph-a", notes: graph.notes, noteIds: ["n2", "n3"] },
    { id: "graph-b", notes: graph.notes, noteIds: ["n4", "n5"] },
  ]);
});

test("an imported theorem graph reaches focused source checking without flattening proofs", async () => {
  const { path, request } = await setup();
  const theorem = "External theorem T: its exact hypotheses and conclusion.";
  const application =
    "The application proves P using T with matching hypotheses.";
  await submitNotes(
    path,
    {
      notes: [
        { text: theorem, support: [] },
        { text: application, support: [1] },
        { text: "A self-contained elementary proof.", support: [] },
      ],
    },
    "imported-graph",
  );
  expect(
    records(path)
      .filter((e) => e.kind === "call")
      .map((e) => e.label),
  ).toEqual(["xean-solve/allowance", "xean-solve/notes"]);
  const drive = dependencies([
    coordinate(
      ["n1", "n2", "n3"],
      ["n2"],
      ["n1", "n2", "n3"].map((note) => ({ note, verifiers: lemmaVerifiers })),
    ),
    {
      submission: {
        verdicts: [
          {
            note: "n1",
            verdict: "PASS",
            report: "The isolated theorem is conditional on its source.",
            externalResults: ["External theorem for n1."],
          },
          {
            note: "n2",
            verdict: "PASS",
            report: "The application uses its declared theorem support.",
            externalResults: [],
          },
          {
            note: "n3",
            verdict: "PASS",
            report: "The proof is self-contained.",
            externalResults: [],
          },
        ],
      },
    },
    verdict("n1", "source"),
  ]);
  expect(
    await run(request, {
      ...drive,
      pauseRequested: () => drive.allCalls.length === 3,
    }),
  ).toMatchObject({ outcome: "paused", at: "explorer" });
  const packet = JSON.parse(drive.codexCalls[0]!.prompt);
  expect(packet.notes.map((n: { id: string }) => n.id)).toEqual(["n1"]);
  expect(drive.codexCalls[0]!.prompt).toContain(theorem);
  expect(drive.codexCalls[0]!.prompt).not.toContain(application);
  expect(drive.allCalls[1]!.prompt).toContain(theorem);
  expect(drive.allCalls[1]!.prompt).toContain(application);
  expect(
    (await inspect(path)).notes.map(({ id, support, verified }) => ({
      id,
      support,
      verified,
    })),
  ).toEqual([
    { id: "n1", support: [], verified: true },
    { id: "n2", support: ["n1"], verified: true },
    { id: "n3", support: [], verified: true },
  ]);
  const before = records(path);
  await inspect(path, true);
  expect(records(path)).toEqual(before);
});

test("invalid local support is rejected before appending a submission", async () => {
  const { path } = await setup();
  const before = records(path);
  for (const support of [[0], [-1], [1], [2], [1.5]]) {
    await expect(
      submitNotes(path, { notes: [{ text: "First note.", support }] }),
    ).rejects.toThrow();
  }
  for (const support of [[1, 1], [2], [3], ["n1"]]) {
    await expect(
      submitNotes(path, {
        notes: [partial, { text: "Second note.", support }],
      }),
    ).rejects.toThrow();
  }
  expect(records(path)).toEqual(before);
});

test("init creates a declaration and allowance without resolving test-only providers", async () => {
  const { path, request } = await setup();
  expect(workflowSchemaVersion).toBe(17);
  const before = records(path);
  expect(before).toHaveLength(3);
  expect(before[0]).toMatchObject({
    kind: "campaign",
    application: "xean-solve",
    config: { schemaVersion: 17, task },
  });
  await init(request);
  expect(records(path)).toEqual(before);
  expect((await inspect(path)).phase).toBe("explorer");
  await expect(
    init({ ...request, task: { ...task, problem: "A different task." } }),
  ).rejects.toThrow();
  expect(records(path)).toEqual(before);
});

test("unchecked initial notes reach coordinator and verification before the first explorer", async () => {
  const { path, request } = await setup();
  await submitNotes(
    path,
    { notes: [{ text: externalText, support: [] }] },
    "initial-lemma",
  );
  const before = records(path);
  expect(before.some((entry) => entry.kind === "verdict")).toBe(false);
  expect((await inspect(path)).submissions).toBeUndefined();
  expect((await inspect(path, true)).submissions).toHaveLength(1);
  const drive = dependencies([
    coordinate(["n1"], ["n1"], [{ note: "n1", verifiers: lemmaVerifiers }]),
    verdict("n1", "correctness"),
    verdict("n1", "source"),
    {
      submission: {
        solution: false,
        notes: [{ text: "Using n1, another partial result.", support: ["n1"] }],
      },
    },
    coordinate(["n2"]),
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
  expect(drive.allCalls.map((call) => call.role)).toEqual([
    "coordinator",
    "verifier",
    "verifier",
    "explorer",
    "coordinator",
  ]);
  expect(coordinatorNotes(drive.allCalls[0]!.prompt)).toMatchObject([
    { id: "n1", text: externalText, verified: false, verdicts: [] },
  ]);
  expect(drive.allCalls[3]!.prompt).toContain(externalText);
  expect(drive.allCalls[3]!.prompt).toContain("Your first note is n2.");
  const report = await inspect(path);
  expect(report.notes.map((note) => [note.id, note.verified])).toEqual([
    ["n1", true],
    ["n2", false],
  ]);
  expect(records(path).slice(0, before.length)).toEqual(before);
});

test("a note arriving during explorer is numbered after explorer notes in the following coordinator", async () => {
  const { path, request } = await setup();
  const drive = dependencies([
    {
      submission: { solution: false, notes: [partial] },
      onStarted: async () => {
        const active = records(path).find(
          (entry) => entry.kind === "call" && entry.role === "explorer",
        )!;
        await submitNotes(
          path,
          { notes: [{ text: externalText, support: [] }] },
          "during-explorer",
        );
        expect(records(path).find((entry) => entry.seq === active.seq)).toEqual(
          active,
        );
      },
    },
    coordinate(["n1", "n2"]),
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
  expect(drive.allCalls.map((call) => call.role)).toEqual([
    "explorer",
    "coordinator",
  ]);
  expect(drive.allCalls[0]!.prompt).not.toContain(externalText);
  expect(
    coordinatorNotes(drive.allCalls[1]!.prompt).map((note) => [
      note.id,
      note.text,
    ]),
  ).toEqual([
    ["n1", partial.text],
    ["n2", externalText],
  ]);
  expect((await inspect(path)).notes.map((note) => note.id)).toEqual([
    "n1",
    "n2",
  ]);
  expect((await inspect(path, true)).submissions).toMatchObject([
    { id: "during-explorer", pending: false, noteIds: ["n2"] },
  ]);
});

test("a frozen coordinator retries identical input while a later note waits for the next coordinator cycle", async () => {
  const { path, request } = await setup(2);
  const initial = dependencies([
    { submission: { solution: false, notes: [partial] } },
    {
      state: "failed",
      error: "coordinator transport interrupted",
      onStarted: async () => {
        await submitNotes(
          path,
          { notes: [{ text: externalText, support: [] }] },
          "during-coordinator",
        );
      },
    },
  ]);
  expect(await run(request, initial)).toMatchObject({
    outcome: "call-failure",
    at: "coordinator",
  });
  const before = records(path);
  const rest = dependencies([
    coordinate(["n1"]),
    coordinate(["n2"], ["n2"]),
    { submission: { solution: false, notes: [partial] } },
    coordinate(["n3"]),
  ]);
  expect(await run(request, rest)).toMatchObject({
    outcome: "turn-limit",
    turns: 2,
  });
  expect(rest.allCalls.map((call) => call.role)).toEqual([
    "coordinator",
    "coordinator",
    "explorer",
    "coordinator",
  ]);
  expect(rest.allCalls[0]!.prompt).toBe(initial.allCalls[1]!.prompt);
  expect(rest.allCalls[0]!.system).toBe(initial.allCalls[1]!.system);
  expect(rest.allCalls[0]!.prompt).not.toContain(externalText);
  expect(
    coordinatorNotes(rest.allCalls[1]!.prompt).map((note) => note.id),
  ).toEqual(["n1", "n2"]);
  expect(rest.allCalls[2]!.prompt).toContain(externalText);
  expect(rest.allCalls[2]!.prompt).toContain("Your first note is n3.");
  expect(records(path).slice(0, before.length)).toEqual(before);
});

test("external verification establishes support without inventing verdicts or accepting the final result", async () => {
  const { path, request } = await setup();
  await submitNotes(
    path,
    { notes: [{ text: externalText, support: [], verification: attestation }] },
    "reviewed-lemma",
  );
  const intake = dependencies([coordinate(["n1"], ["n1"])]);
  expect(
    await run(request, {
      ...intake,
      pauseRequested: () => intake.allCalls.length === 1,
    }),
  ).toMatchObject({ outcome: "paused", at: "explorer" });
  const support = (await inspect(path)).notes[0]!;
  expect(support).toMatchObject({
    id: "n1",
    verified: true,
    dead: false,
    verdicts: [],
    verification: attestation,
  });
  expect((await inspect(path)).phase).not.toBe("accepted");
  expect(records(path).some((entry) => entry.kind === "verdict")).toBe(false);

  const drive = dependencies([
    {
      submission: {
        solution: false,
        notes: [{ text: "Using n1, complete proof of P.", support: ["n1"] }],
      },
    },
    coordinate(["n2"], ["n2"], [{ note: "n2", verifiers: [...verifierNames] }]),
    verdict("n2", "correctness"),
    verdict("n2", "source"),
    verdict("n2", "requirements"),
    { submission: { statement: "P holds." } },
    { submission: { proof: "P follows from the supplied lemma." } },
    verdict("n2", "reconstruction"),
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "accepted",
    turns: 1,
    note: { id: "n2" },
  });
  expect(
    drive.allCalls.filter(
      (call) => call.label === "xean-solve/verifier/source",
    ),
  ).toHaveLength(1);
  expect(
    drive.allCalls.filter(
      (call) => call.label === "xean-solve/verifier/correctness",
    ),
  ).toHaveLength(1);
  expect(
    drive.allCalls.find(
      (call) => call.label === "xean-solve/verifier/reconstruction/proof",
    )!.prompt,
  ).toContain(externalText);
  const notes = (await inspect(path)).notes;
  expect(notes[0]!.verdicts).toEqual([]);
  expect(
    notes[1]!.verdicts.map((entry) => [entry.verifier, entry.verdict]),
  ).toEqual(verifierNames.map((name) => [name, "PASS"]));
});

test("a supplied complete proof still needs all four checks and accepts with zero explorer turns", async () => {
  const { path, request } = await setup();
  await submitNotes(
    path,
    {
      notes: [
        {
          text: "A complete externally supplied proof of P.",
          support: [],
          verification: attestation,
        },
      ],
    },
    "complete-proof",
  );
  expect((await inspect(path)).phase).not.toBe("accepted");
  const drive = dependencies([
    coordinate(["n1"], ["n1"], [{ note: "n1", verifiers: [...verifierNames] }]),
    verdict("n1", "correctness"),
    verdict("n1", "source"),
    verdict("n1", "requirements"),
    { submission: { statement: "P holds." } },
    { submission: { proof: "Independent complete proof of P." } },
    verdict("n1", "reconstruction"),
  ]);
  expect(await run(request, drive)).toMatchObject({
    outcome: "accepted",
    turns: 0,
    note: { id: "n1" },
  });
  expect(drive.allCalls.map((call) => call.label)).toEqual([
    "xean-solve/coordinator",
    "xean-solve/verifier/correctness",
    "xean-solve/verifier/source",
    "xean-solve/verifier/requirements",
    "xean-solve/verifier/reconstruction/statement",
    "xean-solve/verifier/reconstruction/proof",
    "xean-solve/verifier/reconstruction",
  ]);
  expect((await inspect(path)).notes[0]!.verdicts).toHaveLength(4);
});

test("an explorer cannot issue its own external verification attestation", () => {
  expect(
    explorerResultFor([]).safeParse({
      solution: false,
      notes: [{ ...partial, verification: attestation }],
    }).success,
  ).toBe(false);
});

for (const result of ["PASS", "FAIL"] as const) {
  test(`external verification cannot bypass a support dependency whose check returns ${result}`, async () => {
    const { path, request } = await setup();
    await submitNotes(
      path,
      { notes: [{ text: "An unchecked prerequisite.", support: [] }] },
      "prerequisite",
    );
    const first = dependencies([coordinate(["n1"])]);
    expect(
      await run(request, {
        ...first,
        pauseRequested: () => first.allCalls.length === 1,
      }),
    ).toMatchObject({ outcome: "paused", at: "explorer" });
    await submitNotes(
      path,
      {
        notes: [
          {
            text: "A lemma depending on n1.",
            support: ["n1"],
            verification: attestation,
          },
        ],
      },
      "dependent-lemma",
    );
    const drive = dependencies([
      coordinate(["n2"], [], [{ note: "n1", verifiers: lemmaVerifiers }]),
      verdict("n1", "correctness", result),
      ...(result === "PASS" ? [verdict("n1", "source")] : []),
    ]);
    expect(
      await run(request, {
        ...drive,
        pauseRequested: () =>
          drive.allCalls.length === (result === "PASS" ? 3 : 2),
      }),
    ).toMatchObject({ outcome: "paused", at: "explorer" });
    expect(
      coordinatorNotes(drive.allCalls[0]!.prompt).find(
        (note) => note.id === "n2",
      ),
    ).toMatchObject({ verified: false, dead: false, verdicts: [] });
    expect(
      (await inspect(path)).notes.find((note) => note.id === "n2"),
    ).toMatchObject({
      verified: result === "PASS",
      dead: result === "FAIL",
      verdicts: [],
      verification: attestation,
    });
    expect(
      drive.allCalls.filter((call) => call.role === "explorer"),
    ).toHaveLength(0);
  });
}

test("caller submissions validate declared support without scanning mathematical notation", async () => {
  const { path, request } = await setup();
  const ids = Array.from({ length: 8 }, (_, index) => `n${index + 1}`);
  await run(
    request,
    dependencies([
      { submission: { solution: false, notes: ids.map(() => partial) } },
      coordinate(ids),
    ]),
  );
  const notes = ["n2^{-q}", "n4^{-L}", "n8^(-L)", "Provenance: n1"].map(
    (text) => ({ text, support: [] }),
  );
  await submitNotes(path, { notes }, "notation");
  expect((await inspect(path, true)).submissions).toMatchObject([
    { id: "notation", notes },
  ]);
  const before = records(path);
  for (const support of [["n99"], ["n1", "n1"]]) {
    await expect(
      submitNotes(path, { notes: [{ text: "a", support }] }),
    ).rejects.toThrow();
    expect(records(path)).toEqual(before);
  }
});

test("same-id submissions are idempotent and invalid fields never append journal entries", async () => {
  const { path } = await setup();
  const input = {
    notes: [{ text: externalText, support: [], verification: attestation }],
  };
  const receipt = await submitNotes(path, input, "one-note");
  const before = records(path);
  expect(await submitNotes(path, input, "one-note")).toEqual(receipt);
  await expect(
    submitNotes(path, { notes: [partial] }, "one-note"),
  ).rejects.toThrow();
  for (const invalid of [
    { notes: [] },
    { notes: [{ ...partial, id: "n99" }] },
    { notes: [{ ...partial, verified: true }] },
    { notes: [{ ...partial, support: ["n1", "n1"] }] },
    {
      notes: [{ ...partial, verification: { source: "", report: "Checked." } }],
    },
    {
      notes: [{ ...partial, verification: { source: "Reviewer", report: "" } }],
    },
    {
      notes: [
        { ...partial, verification: { ...attestation, verdict: "PASS" } },
      ],
    },
  ]) {
    await expect(
      submitNotes(path, invalid as never, "invalid"),
    ).rejects.toThrow();
    expect(records(path)).toEqual(before);
  }
  expect((await inspect(path, true)).submissions).toHaveLength(1);
});

test("reinitializing a terminal campaign neither changes its result nor resolves providers", async () => {
  const { path, request } = await setup();
  const drive = dependencies([
    { submission: { solution: false, notes: [partial] } },
    coordinate(["n1"]),
  ]);
  const result = await run(request, drive);
  expect(result).toMatchObject({ outcome: "turn-limit", turns: 1 });
  const before = records(path);
  await init(request);
  expect(
    await run(request, {
      models: async () => {
        throw new Error("terminal run must not load providers");
      },
    }),
  ).toEqual(result);
  expect(records(path)).toEqual(before);
  const terminal = await inspect(path);
  await submitNotes(
    path,
    { notes: [{ text: externalText, support: [] }] },
    "after-terminal",
  );
  const after = await inspect(path, true);
  expect(after.result).toEqual(terminal.result);
  expect(after.notes).toEqual(terminal.notes);
  expect(after.submissions).toMatchObject([
    { id: "after-terminal", pending: true },
  ]);
  expect(records(path).slice(0, before.length)).toEqual(before);
  expect(
    await run(request, {
      models: async () => {
        throw new Error("submitted notes must not reopen a terminal run");
      },
    }),
  ).toEqual(result);
});
