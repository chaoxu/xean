import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  open,
  inspect,
  readReport,
  exportAccepted,
  solveSettings,
  Notebook,
} from "../src/index.ts";
import {
  verifierNames,
  type Verdict,
  type Verification,
} from "../src/policy/contracts.ts";
import { resolveCall, type CallDescriptor } from "../src/policy/prompts.ts";
import { defineDoc, ToolResultEntry } from "@earendil-works/pi-durable";
import { fauxModels } from "./faux-models.ts";

const Assignment = defineDoc({
  kind: "xean.role.assignment",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): { descriptor?: CallDescriptor } => ({}),
});

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const profile = { provider: "test", model: "math", reasoning: "high" };
const settings = solveSettings.parse(
  Object.fromEntries(
    ["explorer", "coordinator", ...verifierNames].map((role) => [
      role,
      profile,
    ]),
  ),
);
const all = [...verifierNames];
const lemma: Verification["verifiers"] = ["source", "correctness"];
const check = (note: string, verdict: Verdict["verdict"] = "PASS") => ({
  verdicts: [{ note, verdict, report: `Check ${verdict.toLowerCase()}.` }],
});
const reconstruction = (ids: string[]): JsonValue[] => [
  { statements: ids.map((note) => ({ note, statement: `Claim ${note}.` })) },
  { proof: "Independent proof." },
  {
    statements: [],
    verdicts: ids.flatMap((id) => check(id).verdicts),
  },
];
const pass = (id: string, ancestors: string[] = []): JsonValue[] => [
  check(id),
  check(id),
  check(id),
  ...reconstruction([...ancestors, id]),
];
const note = (text: string, support: string[] = []) => ({ text, support });
const coordinate = (
  ids: string[],
  verify: Verification[],
  support: string[] = [],
) => ({
  filings: ids.map((note) => ({ note, summary: `Summary ${note}.` })),
  explorerGuidance: "Use the selected results.",
  support,
  verify,
});
const labels = (calls: CallDescriptor[]) =>
  calls.map((call) => (call.kind === "verifier" ? call.name : call.kind));
const owners: Awaited<ReturnType<typeof open>>[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture(
  replies: (JsonValue | Error)[],
  overrides = {},
  observe?: (
    descriptor: CallDescriptor,
    owner: Awaited<ReturnType<typeof open>>,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "xean-v1-parity-"));
  directories.push(directory);
  const path = join(directory, "research.sqlite"),
    calls: CallDescriptor[] = [];
  let owner: Awaited<ReturnType<typeof open>>;
  const native = fauxModels(replies, async () => {
    const descriptor = await owner.root.commit(async (tx) => {
      const child = (await tx.scanConversations({ order: "descending" }, 1))
        .items[0]!;
      return JSON.parse(
        JSON.stringify((await tx.doc(Assignment, child.id)).descriptor),
      ) as CallDescriptor;
    }, BACKGROUND_CONTEXT);
    calls.push(descriptor);
    await observe?.(descriptor, owner);
  });
  const create = {
    task,
    settings: solveSettings.parse({ ...settings, ...overrides }),
  };
  owner = await open(path, { create, models: native.models });
  owners.push(owner);
  return {
    get owner() {
      return owner;
    },
    path,
    calls,
    replies: native.replies,
    create,
    models: native.models,
    async settle() {
      await owner.root.waitForIdle(BACKGROUND_CONTEXT);
      return inspect(path, readReport);
    },
    async reopen() {
      await owner.close();
      owner = await open(path, { models: native.models });
      owners.push(owner);
      return owner;
    },
  };
}

test("v1 drains requested batches at the Explorer cap and stops at the first accepted argument", async () => {
  const decision = coordinate(
    ["n1", "n2", "n3", "n4"],
    [
      { note: "n1", verifiers: lemma },
      { note: "n2", verifiers: lemma },
      { note: "n3", verifiers: all },
      { note: "n4", verifiers: all },
    ],
  );
  decision.filings[2]!.summary = "Unverified claim: Q holds unconditionally.";
  const drive = await fixture(
    [
      {
        notes: [
          note("Lemma L."),
          note("Lemma M from L.", ["n1"]),
          note("Complete P from M.", ["n2"]),
          note("Unrelated alternative."),
        ],
      },
      decision,
      check("n1"),
      check("n1"),
      check("n2"),
      check("n2"),
      ...pass("n3", ["n1", "n2"]),
    ],
    { maxExplorerTurns: 1, window: 1 },
  );
  const report = await drive.settle();
  expect(report.status).toMatchObject({
    outcome: "accepted",
    turns: 1,
    accepted: "n3",
  });
  expect(labels(drive.calls)).toEqual([
    "explorer",
    "coordinator",
    "source",
    "correctness",
    "source",
    "correctness",
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  expect(
    report.notes.map((note) => note.verdicts.map((value) => value.verifier)),
  ).toEqual([
    [...lemma, "reconstruction"],
    [...lemma, "reconstruction"],
    all,
    [],
  ]);
  expect(
    report.checks.filter((check) =>
      check.values.some((value) => value.verifier === "reconstruction"),
    ),
  ).toHaveLength(1);
  expect(new Set(report.checks.map((check) => check.candidate)).size).toBe(3);
  const third = drive.calls[6];
  expect(third?.kind).toBe("verifier");
  if (third?.kind !== "verifier")
    throw new Error("Missing third verification batch");
  expect(third.input.support.map(({ id }) => id)).toEqual(["n1", "n2"]);
  expect(third.input.support.every(({ verified }) => verified)).toBe(true);
  const argument = await exportAccepted(drive.path);
  expect(report.notes[2]?.summary).toBe(decision.filings[2]!.summary);
  expect(argument).not.toContain(decision.filings[2]!.summary);
  for (const text of ["Lemma L.", "Lemma M from L.", "Complete P from M."])
    expect(argument).toContain(text);
  expect(argument).not.toContain("Unrelated alternative.");
});

test("solution-only verification waits for a nomination, then checks its dependency batches and excludes unrelated work", async () => {
  const drive = await fixture(
    [
      { notes: [note("Lemma L."), note("Unrelated partial result.")] },
      coordinate(
        ["n1", "n2"],
        [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
        ],
      ),
      { notes: [note("Complete P from L.", ["n1"])] },
      coordinate(
        ["n3"],
        [
          { note: "n2", verifiers: lemma },
          { note: "n1", verifiers: lemma },
          { note: "n3", verifiers: all },
        ],
      ),
      check("n1"),
      check("n1"),
      ...pass("n3", ["n1"]),
    ],
    { verifyOnSolution: true, maxExplorerTurns: 2, window: 1 },
  );
  const report = await drive.settle();
  expect(report.status).toMatchObject({
    outcome: "accepted",
    turns: 2,
    accepted: "n3",
  });
  expect(labels(drive.calls)).toEqual([
    "explorer",
    "coordinator",
    "explorer",
    "coordinator",
    "source",
    "correctness",
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  const continued = drive.calls[2];
  if (continued?.kind !== "explorer")
    throw new Error("Missing continued exploration");
  expect(
    continued.input.notes.every((note) => note.verdicts.length === 0),
  ).toBe(true);
  for (const call of drive.calls)
    if (call.kind === "coordinator")
      expect(call.input.verifyOnSolution).toBe(true);
  expect(
    report.notes.map((note) => note.verdicts.map((value) => value.verifier)),
  ).toEqual([[...lemma, "reconstruction"], [], all]);
  const reconstructed = drive.calls.find((call) => call.kind === "proof");
  expect(reconstructed?.input.notes.map(({ id }) => id)).toEqual(["n1", "n3"]);
});

test("partial batches settle before Explorer receives the index and suggested support, preserving authored summaries", async () => {
  const originals = [
    {
      ...note("Lemma L."),
      summary: "L holds.",
      detailedSummary: "L under its exact conditions.",
    },
    note("Lemma M.", ["n1"]),
    note("Unselected text."),
  ];
  const drive = await fixture(
    [
      { notes: originals },
      coordinate(
        ["n2", "n3"],
        [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
        ],
        ["n2"],
      ),
      check("n1"),
      check("n1"),
      check("n2"),
      check("n2"),
      { notes: [note("A new approach from M.", ["n2"])] },
      coordinate(["n4"], []),
    ],
    { maxExplorerTurns: 2, window: 1 },
  );
  const report = await drive.settle();
  expect(report.status).toMatchObject({ outcome: "turn-limit", turns: 2 });
  expect(labels(drive.calls)).toEqual([
    "explorer",
    "coordinator",
    "source",
    "correctness",
    "source",
    "correctness",
    "explorer",
    "coordinator",
  ]);
  const second = drive.calls[6];
  if (second?.kind !== "explorer") throw new Error("Missing second Explorer");
  expect(second.input.task).toEqual(task);
  expect(second.input.notes.map(({ id }) => id)).toEqual(["n1", "n2", "n3"]);
  expect(
    second.input.notes.every(
      (note) => !("text" in note) && !("detailedSummary" in note),
    ),
  ).toBe(true);
  expect(
    second.input.support.map(({ id, text, verified }) => [id, text, verified]),
  ).toEqual([
    ["n1", "Lemma L.", true],
    ["n2", "Lemma M.", true],
  ]);
  expect(second.input.explorerGuidance).toBe("Use the selected results.");
  expect(report.notes.map(({ id }) => id)).toEqual(["n1", "n2", "n3", "n4"]);
  expect(
    report.notes.slice(0, 3).map(({ text, support }) => ({ text, support })),
  ).toEqual(originals.map(({ text, support }) => ({ text, support })));
  expect(report.notes[0]).toMatchObject(originals[0]!);
  expect(report.accepted).toEqual([]);
});

test("reconstruction sees evidence recorded earlier in the same verifier worker", async () => {
  const drive = await fixture(
    [
      {
        notes: [note("Lemma L."), note("Complete P from L.", ["n1"])],
      },
      coordinate(
        ["n1", "n2"],
        [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: all },
        ],
      ),
      check("n1"),
      check("n1"),
      check("n2"),
      check("n2"),
      check("n2"),
      ...reconstruction(["n1", "n2"]),
    ],
    { maxExplorerTurns: 1, window: 1 },
  );
  const report = await drive.settle();
  expect(report.status).toMatchObject({
    outcome: "accepted",
    accepted: "n2",
  });
  const independent = drive.calls.find((call) => call.kind === "proof");
  if (independent?.kind !== "proof") throw new Error("Missing proof call");
  expect(independent.input.support).toEqual([]);
  expect(independent.input.notes.map(({ id }) => id)).toEqual(["n1", "n2"]);
  expect(independent.input.notes[0]).toMatchObject({
    id: "n1",
    verified: true,
    dead: false,
    verdicts: [
      { verifier: "source", verdict: "PASS" },
      { verifier: "correctness", verdict: "PASS" },
    ],
  });
  expect(
    independent.input.notes[1]?.verdicts.map(({ verifier }) => verifier),
  ).toEqual(["source", "correctness", "requirements"]);
});

test.each(
  (["FAIL", "INCONCLUSIVE"] as const).flatMap((value) =>
    [false, true].map((verifyOnSolution) => ({ value, verifyOnSolution })),
  ),
)(
  "source $value returns to exploration (verifyOnSolution=$verifyOnSolution)",
  async ({ value, verifyOnSolution }) => {
    const drive = await fixture(
      [
        { notes: [note("Original proof.")] },
        coordinate(["n1"], [{ note: "n1", verifiers: all }]),
        check("n1", value),
        { notes: [note("New proof.")] },
        coordinate(["n2"], []),
      ],
      { maxExplorerTurns: 2, verifyOnSolution },
    );
    const report = await drive.settle();
    expect(report.status).toMatchObject({ outcome: "turn-limit", turns: 2 });
    expect(labels(drive.calls)).toEqual([
      "explorer",
      "coordinator",
      "source",
      "explorer",
      "coordinator",
    ]);
    expect(report.notes[0]).toMatchObject({
      id: "n1",
      text: "Original proof.",
      dead: value === "FAIL",
      verified: false,
    });
    const second = drive.calls[3];
    if (second?.kind !== "explorer") throw new Error("Missing second Explorer");
    expect(second.input.notes[0]?.verdicts).toEqual([
      { verifier: "source", ...check("n1", value).verdicts[0]! },
    ]);
    expect(report.notes[1]?.id).toBe("n2");
  },
);

test("persisted retries reuse earlier checks and preserve the original verification candidate", async () => {
  const drive = await fixture([
    { notes: [note("Original proof.")] },
    coordinate(["n1"], [{ note: "n1", verifiers: all }]),
    ...pass("n1").slice(0, -1),
    new Error("provider disconnected"),
  ]);
  const failed = await drive.settle();
  expect(failed.status).toMatchObject({
    outcome: "call-failure",
    error: "verifier failed: provider disconnected",
    turns: 1,
  });
  const workerOutcomes = await inspect(drive.path, async (tx) =>
    (
      await tx.scanTasks({ kind: "xean.worker", order: "ascending" }, 128)
    ).items.map((worker) => worker.state.outcome),
  );
  expect(workerOutcomes).toContainEqual({
    status: "failed",
    error: { message: "verifier failed: provider disconnected" },
  });
  expect(failed.notes[0]).toMatchObject({ verified: true, dead: false });
  expect(failed.checks).toHaveLength(3);
  await expect(exportAccepted(drive.path)).rejects.toThrow(
    "No accepted argument",
  );
  const boundary = drive.calls.length;
  for (const reply of [
    new Error("provider disconnected again"),
    { statements: [], ...check("n1") },
  ]) {
    drive.replies.push(reply);
    const count = drive.calls.length;
    const owner = await drive.reopen();
    await owner.root.waitForIdle(BACKGROUND_CONTEXT);
    expect(drive.calls).toHaveLength(count);
    await owner.resume();
    await owner.root.waitForIdle(BACKGROUND_CONTEXT);
    if (reply instanceof Error)
      expect((await inspect(drive.path, readReport)).checks).toEqual(
        failed.checks,
      );
  }
  const report = await inspect(drive.path, readReport);
  expect(report.status).toMatchObject({
    outcome: "accepted",
    accepted: "n1",
    turns: 1,
  });
  expect(labels(drive.calls.slice(boundary))).toEqual([
    "reconstruction",
    "reconstruction",
  ]);
  expect(new Set(report.checks.map((check) => check.candidate))).toEqual(
    new Set(failed.checks.map((check) => check.candidate)),
  );
  expect(report.notes[0]?.text).toBe("Original proof.");
});

test("a later candidate reuses the corrected lemma statement by durable receipt, including after recovery", async () => {
  const exact = "Exact lemma with its corrected hypotheses.";
  const drive = await fixture(
    [
      {
        notes: [
          {
            ...note("PRIVATE_ORIGINAL_PROOF"),
            summary: "PRIVATE_SUMMARY",
            detailedSummary: "PRIVATE_DETAIL",
          },
          note("First candidate.", ["n1"]),
        ],
      },
      coordinate(
        ["n2"],
        [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: all },
        ],
      ),
      check("n1"),
      check("n1"),
      check("n2"),
      check("n2"),
      check("n2"),
      {
        statements: [
          { note: "n1", statement: "INITIAL_WRONG_SCOPE" },
          { note: "n2", statement: "P." },
        ],
      },
      { proof: "PRIVATE_INITIAL_ARGUMENT" },
      {
        statements: [
          { note: "n1", statement: exact },
          { note: "n2", statement: "P." },
        ],
        verdicts: [],
      },
      { proof: "PRIVATE_CORRECTED_ARGUMENT" },
      {
        statements: [],
        verdicts: [
          { note: "n1", verdict: "PASS", report: "PRIVATE_LEMMA_REPORT" },
          ...check("n2", "INCONCLUSIVE").verdicts,
        ],
      },
      { notes: [note("Repaired candidate.", ["n1"])] },
      coordinate(["n3"], [{ note: "n3", verifiers: all }]),
      ...pass("n3").slice(0, -1),
      new Error("comparison disconnected"),
    ],
    { maxExplorerTurns: 2, window: 1 },
  );
  const failed = await drive.settle();
  expect(failed.status).toMatchObject({ outcome: "call-failure", turns: 2 });
  expect(failed.accepted).toEqual([]);
  const prior = failed.checks.find((check) =>
    check.values.some((value) => value.verifier === "reconstruction"),
  )!;
  const second = drive.calls.slice(
    drive.calls.findIndex(
      (call) => call.kind === "explorer" && call.input.notes.length > 0,
    ),
  );
  expect(labels(second)).toEqual([
    "explorer",
    "coordinator",
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  for (const call of second.slice(5)) {
    if (
      call.kind !== "statement" &&
      call.kind !== "proof" &&
      call.kind !== "reconstruction"
    )
      throw new Error("Missing reconstruction stage");
    expect(call.input.notes.map(({ id }) => id)).toEqual(["n3"]);
    expect(call.input.premises).toEqual([
      { note: "n1", statement: exact, support: [] },
    ]);
    const { prompt } = await resolveCall(call);
    expect(prompt).toContain(exact);
    expect(prompt).not.toContain("PRIVATE_");
    expect(prompt).not.toContain("INITIAL_WRONG_SCOPE");
  }
  drive.replies.push({ statements: [], ...check("n3") });
  const boundary = drive.calls.length;
  const owner = await drive.reopen();
  await owner.resume();
  const report = await drive.settle();
  expect(report.status).toMatchObject({
    outcome: "accepted",
    accepted: "n3",
    turns: 2,
  });
  expect(labels(drive.calls.slice(boundary))).toEqual(["reconstruction"]);
  expect(report.checks.at(-1)).toMatchObject({
    values: [{ note: "n3", verifier: "reconstruction", verdict: "PASS" }],
  });
  const attempts = await inspect(
    drive.path,
    async (tx) =>
      (await tx.scanTasks({ kind: "xean.worker", order: "descending" }, 2))
        .items,
  );
  expect(attempts).toHaveLength(2);
  for (const attempt of attempts)
    expect(attempt.input).toMatchObject({
      kind: "verify",
      input: { verify: [{ note: "n3", verifiers: all }] },
      reconstruction: [{ note: "n1", call: prior.call }],
    });
  expect(
    report.notes[0]?.verdicts.filter(
      (value) => value.verifier === "reconstruction",
    ),
  ).toHaveLength(1);
});

test.each(
  ["correctness", "requirements"].flatMap((stage) =>
    ["assignment", "placed", "receipt", "done"].map((boundary) => ({
      stage,
      boundary,
    })),
  ),
)(
  "ordinary verifier recovers at $stage $boundary without repeating completed calls",
  async ({ stage, boundary }) => {
    const drive = await fixture([
      { notes: [note("Proof of P.")] },
      coordinate(["n1"], [{ note: "n1", verifiers: all }]),
      ...pass("n1"),
    ]);
    const closed = Promise.withResolvers<void>();
    let closing = false,
      current = "";
    drive.owner.harness.subscribeCommits(({ changes }) => {
      for (const change of changes)
        if (
          change.type === "document" &&
          change.record.kind === Assignment.definition.kind
        ) {
          const { descriptor } = change.value as {
            descriptor?: CallDescriptor;
          };
          current = descriptor?.kind === "verifier" ? descriptor.name : "";
        }
      if (
        !closing &&
        current === stage &&
        changes.some((change) =>
          boundary === "assignment"
            ? change.type === "document" &&
              change.record.kind === Assignment.definition.kind
            : boundary === "receipt"
              ? change.type === "entry" && ToolResultEntry.is(change.value)
              : change.type === "submission" &&
                change.value.status === boundary,
        )
      ) {
        closing = true;
        void drive.owner.close().then(closed.resolve, closed.reject);
      }
    });
    void drive.settle().catch(() => {});
    await closed.promise;
    await drive.reopen();
    const report = await drive.settle();
    expect(report.status).toMatchObject({
      outcome: "accepted",
      accepted: "n1",
    });
    expect(labels(drive.calls)).toEqual([
      "explorer",
      "coordinator",
      "source",
      "correctness",
      "requirements",
      "statement",
      "proof",
      "reconstruction",
    ]);
    expect(report.checks).toHaveLength(4);
  },
);

test("completed reopening makes no calls and cannot change the frozen task or settings", async () => {
  const drive = await fixture(
    [{ notes: [note("Partial proof.")] }, coordinate(["n1"], [])],
    { maxExplorerTurns: 1 },
  );
  const before = await drive.settle();
  await drive.owner.close();
  await expect(
    open(drive.path, {
      create: {
        ...drive.create,
        task: { ...task, completionCriteria: "A weaker target." },
      },
      models: drive.models,
    }),
  ).rejects.toThrow("frozen");
  await expect(
    open(drive.path, {
      create: {
        ...drive.create,
        settings: { ...drive.create.settings, maxExplorerTurns: 2 },
      },
      models: drive.models,
    }),
  ).rejects.toThrow("frozen");
  const owner = await drive.reopen();
  await owner.root.waitForIdle(BACKGROUND_CONTEXT);
  expect(await inspect(drive.path, readReport)).toEqual(before);
  expect(drive.calls).toHaveLength(2);
});

test("a failed Explorer keeps its future note IDs when caller input arrives before resume", async () => {
  const drive = await fixture([new Error("Explorer disconnected")], {
    maxExplorerTurns: 1,
  });
  const failed = await drive.settle();
  expect(failed.status).toMatchObject({ outcome: "call-failure", turns: 0 });
  await drive.owner.root.commit(async (tx) => {
    const book = await tx.doc(Notebook, drive.owner.root.id);
    book.inputs.push({
      id: "caller-during-failure",
      notes: [note("Caller result.")],
      consumed: false,
    });
  }, BACKGROUND_CONTEXT);
  expect((await inspect(drive.path, readReport)).notes).toEqual([]);
  const original = [
    note("Explorer lemma."),
    note("Explorer consequence.", ["n1"]),
  ];
  drive.replies.push({ notes: original }, coordinate(["n1", "n2", "n3"], []));
  const owner = await drive.reopen();
  await owner.resume();
  await owner.root.waitForIdle(BACKGROUND_CONTEXT);
  const report = await inspect(drive.path, readReport);
  expect(report.status).toMatchObject({ outcome: "turn-limit", turns: 1 });
  expect(labels(drive.calls)).toEqual(["explorer", "explorer", "coordinator"]);
  expect(drive.calls[1]).toEqual(drive.calls[0]);
  expect(
    report.notes.map(({ id, text, support }) => ({ id, text, support })),
  ).toEqual([
    { id: "n1", ...original[0]! },
    { id: "n2", ...original[1]! },
    { id: "n3", ...note("Caller result.") },
  ]);
  const coordination = drive.calls[2];
  if (coordination?.kind !== "coordinator")
    throw new Error("Missing resumed Coordinator");
  expect(coordination.input.notes.map(({ id }) => id)).toEqual([
    "n1",
    "n2",
    "n3",
  ]);
  expect(
    await inspect(drive.path, async (tx, root) =>
      (await tx.doc(Notebook, root)).inputs.map(({ id, consumed }) => ({
        id,
        consumed,
      })),
    ),
  ).toEqual([{ id: "caller-during-failure", consumed: true }]);
});

test("caller input arriving during verification waits for every batch and reaches Coordinator before Explorer", async () => {
  const observed: {
    verifier: string;
    judged: string[];
    consumed: boolean;
    notes: string[];
  }[] = [];
  const drive = await fixture(
    [
      { notes: [note("Lemma L."), note("Lemma M.", ["n1"])] },
      coordinate(
        ["n1", "n2"],
        [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
        ],
      ),
      check("n1"),
      check("n1"),
      check("n2"),
      check("n2"),
      coordinate(["n3"], []),
      { notes: [note("Fresh Explorer result.")] },
      coordinate(["n4"], []),
    ],
    { maxExplorerTurns: 2, window: 1 },
    async (descriptor, owner) => {
      if (descriptor.kind !== "verifier") return;
      await owner.root.commit(async (tx) => {
        const book = await tx.doc(Notebook, owner.root.id);
        if (descriptor.name === "source" && descriptor.judged[0] === "n1") {
          book.inputs.push({
            id: "caller-during-verification",
            notes: [note("Caller result.")],
            consumed: false,
          });
        }
        observed.push({
          verifier: descriptor.name,
          judged: [...descriptor.judged],
          consumed: book.inputs[0]!.consumed,
          notes: book.notes.map(({ id }) => id),
        });
      }, BACKGROUND_CONTEXT);
    },
  );
  const report = await drive.settle();
  expect(report.status).toMatchObject({ outcome: "turn-limit", turns: 2 });
  expect(labels(drive.calls)).toEqual([
    "explorer",
    "coordinator",
    "source",
    "correctness",
    "source",
    "correctness",
    "coordinator",
    "explorer",
    "coordinator",
  ]);
  expect(observed).toEqual([
    {
      verifier: "source",
      judged: ["n1"],
      consumed: false,
      notes: ["n1", "n2"],
    },
    {
      verifier: "correctness",
      judged: ["n1"],
      consumed: false,
      notes: ["n1", "n2"],
    },
    {
      verifier: "source",
      judged: ["n2"],
      consumed: false,
      notes: ["n1", "n2"],
    },
    {
      verifier: "correctness",
      judged: ["n2"],
      consumed: false,
      notes: ["n1", "n2"],
    },
  ]);
  const coordination = drive.calls[6];
  if (coordination?.kind !== "coordinator")
    throw new Error("Missing caller-input Coordinator");
  expect(
    coordination.input.notes.map(({ id, verified }) => [id, verified]),
  ).toEqual([
    ["n1", true],
    ["n2", true],
    ["n3", false],
  ]);
  const explorer = drive.calls[7];
  if (explorer?.kind !== "explorer") throw new Error("Missing fresh Explorer");
  expect(explorer.input.notes.map(({ id, summary }) => [id, summary])).toEqual([
    ["n1", "Summary n1."],
    ["n2", "Summary n2."],
    ["n3", "Summary n3."],
  ]);
  expect(report.notes.map(({ id, text }) => [id, text])).toEqual([
    ["n1", "Lemma L."],
    ["n2", "Lemma M."],
    ["n3", "Caller result."],
    ["n4", "Fresh Explorer result."],
  ]);
});
