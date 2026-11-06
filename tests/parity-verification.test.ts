import { expect, test } from "bun:test";
import type { JsonValue } from "@earendil-works/chord";
import {
  verifierNames,
  type Note,
  type Verdict,
  type VerifierInput,
} from "../src/policy/contracts.ts";
import { resolveCall, type CallDescriptor } from "../src/policy/prompts.ts";
import { solveSettings } from "../src/policy/settings.ts";
import { reconstructionInput } from "../src/policy/support.ts";
import { verify, type VerificationDependencies } from "../src/verification.ts";

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const profile = { provider: "test", model: "math", reasoning: "high" };
const settings = solveSettings.parse(
  Object.fromEntries(
    ["explorer", ...verifierNames].map((role) => [role, profile]),
  ),
);
const note = (id: string, support: string[] = []): Note => ({
  id,
  text: `ORIGINAL_PROOF_${id}`,
  summary: `Claim ${id}.`,
  support,
  verdicts: [],
  checked: false,
  verified: false,
  dead: false,
});
const input = (notes = [note("n1")]): VerifierInput => ({
  task,
  notes,
  support: [],
  verify: notes.map(({ id }) => ({ note: id, verifiers: [...verifierNames] })),
});
const verdict = (note = "n1", verdict: Verdict["verdict"] = "PASS") => ({
  note,
  verdict,
  report: `Check ${verdict.toLowerCase()}.`,
});
const checks = (...values: ReturnType<typeof verdict>[]) => ({
  verdicts: values,
});
const proof = { proof: "An independent proof." };
const statements = (...ids: string[]) => ({
  statements: ids.map((note) => ({ note, statement: `Claim ${note} holds.` })),
});
const comparison = (...values: ReturnType<typeof verdict>[]) => ({
  statements: [],
  verdicts: values,
});
const correction = (value: ReturnType<typeof statements>) => ({
  ...value,
  verdicts: [],
});

function scripted(replies: (JsonValue | Error)[]) {
  const calls: CallDescriptor[] = [],
    recorded: Verdict[] = [];
  const batches: { call: number; values: Verdict[] }[] = [];
  const receipts = new Map<string, { call: number; value: JsonValue }>();
  const deps: VerificationDependencies = {
    async call(key, descriptor) {
      const saved = receipts.get(key);
      if (saved) return saved;
      calls.push(structuredClone(descriptor));
      const value = replies.shift();
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`Unexpected call ${key}`);
      const result = { call: calls.length, value };
      receipts.set(key, result);
      return result;
    },
    async recorded() {
      return structuredClone(recorded);
    },
    async record(call, values) {
      batches.push({ call, values: structuredClone(values) });
      recorded.push(...values);
    },
  };
  return { calls, recorded, batches, deps, replies };
}
const labels = (calls: CallDescriptor[]) =>
  calls.map((call) => (call.kind === "verifier" ? call.name : call.kind));

test.each([false, true])(
  "only selected roots are reconstructed, assuming their direct dependency statements; dependency dead=%s",
  async (dead) => {
    const a = note("A"),
      b = { ...note("B", ["A"]), dead },
      c = note("C", ["B"]);
    const batch = { ...input([c]), support: [a, b] };
    const pass = checks(verdict("C"));
    const drive = scripted([
      pass,
      pass,
      pass,
      statements("B", "C"),
      proof,
      comparison(verdict("C")),
    ]);
    const frozen = structuredClone(batch);
    await verify(batch, settings, drive.deps);
    expect(batch).toEqual(frozen);
    expect(labels(drive.calls)).toEqual([
      "source",
      "correctness",
      "requirements",
      "statement",
      "proof",
      "reconstruction",
    ]);
    for (const call of drive.calls.slice(3)) {
      expect(call.input.notes.map((note) => note.id)).toEqual(["C"]);
      expect(
        "support" in call.input && call.input.support.map((note) => note.id),
      ).toEqual(["B"]);
    }
    expect(drive.recorded.map((value) => value.note)).toEqual([
      "C",
      "C",
      "C",
      "C",
    ]);
    const blind = resolveCall(drive.calls[4]!).prompt;
    expect(blind).toContain("Claim B holds.");
    expect(blind).toContain("Claim C holds.");
    expect(blind).not.toContain("ORIGINAL_PROOF");
    expect(blind).not.toContain("Claim A holds.");
  },
);

test("unselected and inconclusive dependencies do not block a selected note's own checks", async () => {
  const batch = input([note("A"), note("B", ["A"])]);
  batch.verify[0]!.verifiers = ["source", "correctness"];
  const drive = scripted([
    checks(verdict("A"), verdict("B")),
    checks(verdict("A", "INCONCLUSIVE"), verdict("B")),
    checks(verdict("B")),
    statements("A", "B"),
    proof,
    comparison(verdict("B")),
  ]);
  await verify(batch, settings, drive.deps);
  expect(labels(drive.calls)).toEqual([
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  expect(
    drive.recorded
      .filter((value) => value.note === "B")
      .map((value) => value.verifier),
  ).toEqual([...verifierNames]);
  expect(drive.recorded.filter((value) => value.note === "A")).toHaveLength(2);
});

test("a supporting lemma can request reconstruction without requirements", async () => {
  const batch = input([note("B", ["A"])]);
  batch.support = [note("A")];
  batch.verify[0]!.verifiers = ["source", "correctness", "reconstruction"];
  const pass = checks(verdict("B"));
  const drive = scripted([
    pass,
    pass,
    statements("A", "B"),
    proof,
    comparison(verdict("B")),
  ]);
  await verify(batch, settings, drive.deps);
  expect(labels(drive.calls)).toEqual([
    "source",
    "correctness",
    "statement",
    "proof",
    "reconstruction",
  ]);
  expect(drive.recorded.map((value) => value.verifier)).toEqual([
    "source",
    "correctness",
    "reconstruction",
  ]);
});

test("own source or correctness failure blocks reconstruction, while a requirements failure does not", async () => {
  const batch = input([note("A"), note("B"), note("C")]);
  const drive = scripted([
    checks(verdict("A", "FAIL"), verdict("B"), verdict("C")),
    checks(verdict("B", "FAIL"), verdict("C")),
    checks(verdict("C", "FAIL")),
    statements("C"),
    proof,
    comparison(verdict("C")),
  ]);
  await verify(batch, settings, drive.deps);
  expect(
    drive.calls
      .filter((call) => call.kind === "statement")
      .map((call) => call.input.notes.map((note) => note.id)),
  ).toEqual([["C"]]);
  expect(
    drive.recorded.filter((value) => value.verifier === "reconstruction"),
  ).toEqual([{ verifier: "reconstruction", ...verdict("C") }]);
});

test("mixed reconstruction results publish the selected batch atomically and replay without partial duplication", async () => {
  const batch = input([note("B", ["A"]), note("C", ["A"])]);
  batch.support = [note("A")];
  const pass = checks(verdict("B"), verdict("C"));
  const drive = scripted([
    pass,
    pass,
    pass,
    statements("A", "B", "C"),
    proof,
    comparison(verdict("B", "FAIL"), verdict("C")),
  ]);
  await verify(batch, settings, drive.deps);
  expect(drive.batches).toHaveLength(4);
  expect(drive.batches.at(-1)!.values).toEqual([
    { verifier: "reconstruction", ...verdict("B", "FAIL") },
    { verifier: "reconstruction", ...verdict("C") },
  ]);
  const recorded = structuredClone(drive.recorded),
    calls = structuredClone(drive.calls);
  await verify(batch, settings, drive.deps);
  expect(drive.recorded).toEqual(recorded);
  expect(drive.calls).toEqual(calls);
  expect(drive.batches).toHaveLength(4);
});

test("a corrected statement array replaces both targets and assumptions before a fresh blind proof", async () => {
  const batch = {
    ...input([note("B", ["A"])]),
    support: [note("A")],
  };
  const before = structuredClone(batch);
  const pass = checks(verdict("B"));
  const corrected = {
    statements: [
      { note: "A", statement: "For x >= 1, A(x) holds with exact hypotheses." },
      { note: "B", statement: "For x >= 1, B(x) follows." },
    ],
  };
  const drive = scripted([
    pass,
    pass,
    pass,
    statements("A", "B"),
    proof,
    correction(corrected),
    { proof: "A conditional proof from the corrected assumption." },
    comparison(verdict("B")),
  ]);
  await verify(batch, settings, drive.deps);
  expect(batch).toEqual(before);
  expect(labels(drive.calls)).toEqual([
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
    "proof",
    "reconstruction",
  ]);
  expect(drive.calls[6]).toMatchObject({ kind: "proof", statement: corrected });
  const blind = resolveCall(drive.calls[6]!).prompt;
  expect(blind).toContain(corrected.statements[0]!.statement);
  expect(blind).not.toContain("ORIGINAL_PROOF");
  expect(drive.batches.at(-1)!.call).toBe(8);
  expect(drive.recorded).toHaveLength(4);
});

test("three fresh corrections continue and recovery replays the latest full statement array", async () => {
  const batch = {
    ...input([note("B", ["A"])]),
    support: [note("A")],
  };
  const pass = checks(verdict("B"));
  const first = statements("A", "B");
  const second = {
    statements: first.statements.map((entry) => ({
      ...entry,
      statement: `Precise ${entry.note}, second try.`,
    })),
  };
  const latest = {
    statements: second.statements.map((entry) => ({
      ...entry,
      statement: `Precise ${entry.note}, third correction.`,
    })),
  };
  const drive = scripted([
    pass,
    pass,
    pass,
    first,
    proof,
    correction(first),
    proof,
    correction(second),
    proof,
    correction(latest),
    new Error("Provider interrupted after the third correction"),
  ]);
  await expect(verify(batch, settings, drive.deps)).rejects.toThrow(
    "Provider interrupted after the third correction",
  );
  expect(drive.recorded).toHaveLength(3);
  const boundary = drive.calls.length;
  drive.replies.push(proof, comparison(verdict("B")));
  await verify(batch, settings, drive.deps);
  expect(labels(drive.calls.slice(boundary))).toEqual([
    "proof",
    "reconstruction",
  ]);
  expect(drive.calls[boundary]).toMatchObject({ statement: latest });
  expect(drive.recorded).toHaveLength(4);
});

test.each([["A", "B"], ["A"], ["B", "B"], ["missing"]].map((ids) => ({ ids })))(
  "comparison IDs %j cannot publish verdicts for assumptions or a partial target batch",
  async ({ ids }) => {
    const batch = {
      ...input([note("B", ["A"])]),
      support: [note("A")],
    };
    const pass = checks(verdict("B"));
    const drive = scripted([
      pass,
      pass,
      pass,
      statements("A", "B"),
      proof,
      comparison(...ids.map((id) => verdict(id))),
    ]);
    await expect(verify(batch, settings, drive.deps)).rejects.toThrow();
    expect(
      drive.recorded.filter(({ verifier }) => verifier === "reconstruction"),
    ).toEqual([]);
    expect(drive.batches).toHaveLength(3);
  },
);

test("a correction omitting a dependency statement is rejected before another proof call", async () => {
  const batch = {
    ...input([note("B", ["A"])]),
    support: [note("A")],
  };
  const pass = checks(verdict("B"));
  const drive = scripted([
    pass,
    pass,
    pass,
    statements("A", "B"),
    proof,
    correction(statements("B")),
  ]);
  await expect(verify(batch, settings, drive.deps)).rejects.toThrow();
  expect(drive.calls.filter((call) => call.kind === "proof")).toHaveLength(1);
  expect(drive.batches).toHaveLength(3);
});

test("a selected dependency remains a target while unselected ancestors stay outside the reconstruction", () => {
  const a = note("A"),
    b = note("B", ["A"]),
    c = note("C", ["B"]),
    d = note("D", ["C"]);
  const result = reconstructionInput({ task, notes: [b, d], support: [a, c] }, [
    "B",
    "D",
  ]);
  expect(result.notes.map((note) => note.id)).toEqual(["B", "D"]);
  expect(result.support.map((note) => note.id)).toEqual(["A", "C"]);
});
