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
import { verify, type VerificationDependencies } from "../src/verification.ts";

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
const note = (id: string, support: string[] = []): Note => ({
  id,
  text: `ORIGINAL_PROOF_${id}`,
  summary: `Claim ${id}.`,
  support,
  verdicts: [],
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
const statement = { statement: "P holds." };
const comparison = (note = "n1", value: Verdict["verdict"] = "PASS") => ({
  statement: null,
  verdicts: [verdict(note, value)],
});
const correction = (statement: string) => ({ statement, verdicts: [] });

function scripted(replies: (JsonValue | Error)[]) {
  const calls: CallDescriptor[] = [],
    recorded: Verdict[] = [];
  const receipts = new Map<string, { call: number; value: JsonValue }>();
  const deps: VerificationDependencies = {
    async call(key, descriptor) {
      const saved = receipts.get(key);
      if (saved) return { ...saved, fresh: false };
      calls.push(structuredClone(descriptor));
      const value = replies.shift();
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`Unexpected call ${key}`);
      const result = { call: calls.length, value };
      receipts.set(key, result);
      return { ...result, fresh: true };
    },
    async recorded() {
      return structuredClone(recorded);
    },
    async record(_call, values) {
      recorded.push(...values);
    },
  };
  return { calls, recorded, deps, replies };
}
const labels = (calls: CallDescriptor[]) =>
  calls.map((call) => (call.kind === "verifier" ? call.name : call.kind));

test("v1 verifier order accepts the first completed candidate without reconstructing unrelated notes", async () => {
  const batch = checks(verdict("n1"), verdict("n2"));
  const drive = scripted([batch, batch, batch, statement, proof, comparison()]);
  const result = await verify(
    input([note("n1"), note("n2")]),
    settings,
    drive.deps,
  );
  expect(labels(drive.calls)).toEqual([
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  expect(result).toHaveLength(7);
  expect(result.at(-1)).toMatchObject({
    verifier: "reconstruction",
    note: "n1",
    verdict: "PASS",
  });
  expect(
    result.some(
      (value) => value.verifier === "reconstruction" && value.note === "n2",
    ),
  ).toBe(false);
  const independent = drive.calls.find((call) => call.kind === "proof")!;
  expect((await resolveCall(independent)).prompt).not.toContain(
    "ORIGINAL_PROOF",
  );
  expect((await resolveCall(independent)).prompt).toContain("P holds.");
});

test("inconclusive supporting correctness blocks requirements without killing the candidate", async () => {
  const batch = input([note("n1"), note("n2", ["n1"])]);
  batch.verify[0]!.verifiers = ["source", "correctness"];
  const drive = scripted([
    checks(verdict("n1"), verdict("n2")),
    checks(verdict("n1", "INCONCLUSIVE"), verdict("n2")),
  ]);
  expect(await verify(batch, settings, drive.deps)).toHaveLength(4);
  expect(labels(drive.calls)).toEqual(["source", "correctness"]);
  expect(drive.recorded.some((value) => value.verdict === "FAIL")).toBe(false);
});

test("reconstruction failure blocks dependents but continues to unrelated candidates", async () => {
  const batch = checks(verdict("n1"), verdict("n2"), verdict("n3"));
  const drive = scripted([
    batch,
    batch,
    batch,
    statement,
    proof,
    comparison("n1", "FAIL"),
    statement,
    proof,
    comparison("n3"),
  ]);
  const result = await verify(
    input([note("n1"), note("n2", ["n1"]), note("n3")]),
    settings,
    drive.deps,
  );
  expect(
    drive.calls
      .filter((call) => call.kind === "statement")
      .map((call) => call.note.id),
  ).toEqual(["n1", "n3"]);
  expect(result.filter((value) => value.verifier === "reconstruction")).toEqual(
    [
      { verifier: "reconstruction", ...verdict("n1", "FAIL") },
      { verifier: "reconstruction", ...verdict("n3") },
    ],
  );
});

test("a corrected statement reuses source, correctness and requirements without changing the original note", async () => {
  const batch = input();
  const before = structuredClone(batch);
  const pass = checks(verdict());
  const drive = scripted([
    pass,
    pass,
    pass,
    statement,
    proof,
    correction("The precise P."),
    { proof: "A proof of the precise P." },
    comparison(),
  ]);
  expect(await verify(batch, settings, drive.deps)).toHaveLength(4);
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
  expect(drive.calls[6]).toMatchObject({
    kind: "proof",
    statement: { statement: "The precise P." },
    previous: 6,
  });
  expect((await resolveCall(drive.calls[6]!)).prompt).not.toContain(
    "ORIGINAL_PROOF",
  );
  expect(drive.calls[7]).toMatchObject({
    kind: "reconstruction",
    proof: "A proof of the precise P.",
  });
});

test("two fresh statement corrections stop automatic retry; resume replays them and uses the latest correction", async () => {
  const pass = checks(verdict());
  const drive = scripted([
    pass,
    pass,
    pass,
    statement,
    proof,
    correction("Precise P, first try."),
    proof,
    correction("Precise P, second try."),
  ]);
  await expect(verify(input(), settings, drive.deps)).rejects.toThrow(
    "statement remains unresolved",
  );
  expect(drive.recorded.map((value) => value.verifier)).toEqual([
    "source",
    "correctness",
    "requirements",
  ]);
  const boundary = drive.calls.length;
  drive.replies.push(proof, comparison());
  expect(await verify(input(), settings, drive.deps)).toHaveLength(4);
  expect(labels(drive.calls.slice(boundary))).toEqual([
    "proof",
    "reconstruction",
  ]);
  expect(drive.calls[boundary]).toMatchObject({
    statement: { statement: "Precise P, second try." },
    previous: 8,
  });
});

test("a disconnected reconstruction retries only its missing comparison", async () => {
  const pass = checks(verdict());
  const drive = scripted([
    pass,
    pass,
    pass,
    statement,
    proof,
    new Error("provider disconnected"),
  ]);
  await expect(verify(input(), settings, drive.deps)).rejects.toThrow(
    "provider disconnected",
  );
  expect(drive.recorded).toHaveLength(3);
  drive.replies.push(comparison());
  expect(await verify(input(), settings, drive.deps)).toHaveLength(4);
  expect(labels(drive.calls)).toEqual([
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
    "reconstruction",
  ]);
});

test("a batch naming the wrong note cannot record even a partial verdict", async () => {
  const drive = scripted([checks(verdict("n1"), verdict("n99"))]);
  await expect(
    verify(input([note("n1"), note("n2")]), settings, drive.deps),
  ).rejects.toThrow("one verdict per note");
  expect(drive.recorded).toEqual([]);
  expect(labels(drive.calls)).toEqual(["source"]);
});
