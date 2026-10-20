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
    async record(call, values) {
      batches.push({ call, values: structuredClone(values) });
      recorded.push(...values);
    },
  };
  return { calls, recorded, batches, deps, replies };
}
const labels = (calls: CallDescriptor[]) =>
  calls.map((call) => (call.kind === "verifier" ? call.name : call.kind));

test("a lemma without requirements and its root share exactly three reconstruction calls and one verdict batch", async () => {
  const batch = checks(verdict("n1"), verdict("n2"));
  const request = input([note("n1"), note("n2", ["n1"])]);
  request.verify[0]!.verifiers = ["source", "correctness"];
  const drive = scripted([
    batch,
    batch,
    checks(verdict("n2")),
    statements("n1", "n2"),
    proof,
    comparison(verdict("n1"), verdict("n2")),
  ]);
  await verify(request, settings, drive.deps);
  expect(labels(drive.calls)).toEqual([
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  expect(drive.recorded).toHaveLength(7);
  expect(drive.batches.at(-1)).toEqual({
    call: 6,
    values: ["n1", "n2"].map((id) => ({
      ...verdict(id),
      verifier: "reconstruction",
    })),
  });
  for (const call of drive.calls.slice(3))
    expect(call.input.notes.map(({ id }) => id)).toEqual(["n1", "n2"]);
  const independent = drive.calls.find((call) => call.kind === "proof")!;
  expect((await resolveCall(independent)).prompt).not.toContain(
    "ORIGINAL_PROOF",
  );
  expect((await resolveCall(independent)).prompt).toContain("Claim n2 holds.");
});

test.each([false, true])(
  "reconstruction respects source cutoffs unless selected as a root: %s",
  async (sourceRoot) => {
    const trusted = {
      ...note("n2", ["n1"]),
      verified: true,
      verification: { source: "Supplied theorem", report: "Granted." },
    };
    const lemma = {
      ...note("n3", ["n2"]),
      verified: true,
      verdicts: [
        { ...verdict("n3"), verifier: "source" as const },
        { ...verdict("n3"), verifier: "correctness" as const },
        { ...verdict("n3", "FAIL"), verifier: "requirements" as const },
      ],
    };
    const batch = input([
      ...(sourceRoot ? [trusted] : []),
      note("n10", ["n3"]),
      note("n11", ["n2", "n3"]),
    ]);
    batch.support = [
      { ...note("n1"), verified: true },
      ...(sourceRoot ? [] : [trusted]),
      lemma,
    ];
    const targets = [...(sourceRoot ? ["n1", "n2"] : []), "n3", "n10", "n11"];
    const pass = checks(...batch.notes.map(({ id }) => verdict(id)));
    const drive = scripted([
      pass,
      pass,
      pass,
      statements(...targets),
      proof,
      comparison(...targets.map((id) => verdict(id))),
    ]);
    const before = structuredClone(batch);
    await verify(batch, settings, drive.deps);
    expect(batch).toEqual(before);
    expect(labels(drive.calls).slice(3)).toEqual([
      "statement",
      "proof",
      "reconstruction",
    ]);
    for (const call of drive.calls.slice(3)) {
      expect(call.input.notes.map(({ id }) => id)).toEqual(targets);
      expect(
        "support" in call.input && call.input.support.map(({ id }) => id),
      ).toEqual(sourceRoot ? [] : ["n2"]);
    }
    expect(
      drive.recorded
        .filter((value) => value.verifier === "reconstruction")
        .map(({ note }) => note),
    ).toEqual(targets);
  },
);

test("inconclusive supporting correctness blocks requirements without killing the candidate", async () => {
  const batch = input([note("n1"), note("n2", ["n1"])]);
  batch.verify[0]!.verifiers = ["source", "correctness"];
  const drive = scripted([
    checks(verdict("n1"), verdict("n2")),
    checks(verdict("n1", "INCONCLUSIVE"), verdict("n2")),
  ]);
  await verify(batch, settings, drive.deps);
  expect(drive.recorded).toHaveLength(4);
  expect(labels(drive.calls)).toEqual(["source", "correctness"]);
  expect(drive.recorded.some((value) => value.verdict === "FAIL")).toBe(false);
});

test("a lemma's requirements failure does not exclude it; mixed reconstruction results settle the whole batch", async () => {
  const batch = checks(verdict("n1"), verdict("n2"), verdict("n3"));
  const drive = scripted([
    batch,
    batch,
    checks(verdict("n1", "FAIL"), verdict("n2"), verdict("n3")),
    statements("n1", "n2", "n3"),
    proof,
    comparison(
      verdict("n1", "FAIL"),
      verdict("n2", "INCONCLUSIVE"),
      verdict("n3"),
    ),
  ]);
  const value = input([note("n1"), note("n2", ["n1"]), note("n3")]);
  await verify(value, settings, drive.deps);
  const result = structuredClone(drive.recorded);
  expect(
    drive.calls
      .filter((call) => call.kind === "statement")
      .map((call) => call.input.notes.map(({ id }) => id)),
  ).toEqual([["n1", "n2", "n3"]]);
  expect(result.filter((value) => value.verifier === "reconstruction")).toEqual(
    [
      { verifier: "reconstruction", ...verdict("n1", "FAIL") },
      { verifier: "reconstruction", ...verdict("n2", "INCONCLUSIVE") },
      { verifier: "reconstruction", ...verdict("n3") },
    ],
  );
  expect(drive.batches).toHaveLength(4);
  const before = structuredClone(drive.calls);
  await verify(value, settings, drive.deps);
  expect(drive.recorded).toEqual(result);
  expect(drive.calls).toEqual(before);
  expect(drive.batches).toHaveLength(4);
});

test("a corrected statement array reruns the whole proof and comparison without changing original notes", async () => {
  const batch = input([note("n1"), note("n2", ["n1"])]);
  const before = structuredClone(batch);
  const pass = checks(verdict("n1"), verdict("n2"));
  const corrected = {
    statements: [
      { note: "n1", statement: "The precise first claim." },
      { note: "n2", statement: "The precise second claim." },
    ],
  };
  const drive = scripted([
    pass,
    pass,
    pass,
    statements("n1", "n2"),
    proof,
    correction(corrected),
    { proof: "A joint proof of the precise claims." },
    comparison(verdict("n1"), verdict("n2")),
  ]);
  await verify(batch, settings, drive.deps);
  expect(drive.recorded).toHaveLength(8);
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
    statement: corrected,
  });
  expect((await resolveCall(drive.calls[6]!)).prompt).not.toContain(
    "ORIGINAL_PROOF",
  );
  expect(drive.calls[7]).toMatchObject({
    kind: "reconstruction",
    proof: "A joint proof of the precise claims.",
  });
  expect(drive.batches).toHaveLength(4);
  expect(drive.batches.at(-1)?.call).toBe(8);
});

test("two fresh statement corrections stop automatic retry; resume replays them and uses the latest correction", async () => {
  const batch = input([note("n1"), note("n2")]);
  const pass = checks(verdict("n1"), verdict("n2"));
  const first = statements("n1", "n2");
  const latest = {
    statements: first.statements.map((entry) => ({
      ...entry,
      statement: `Precise ${entry.note}, second try.`,
    })),
  };
  const drive = scripted([
    pass,
    pass,
    pass,
    statements("n1", "n2"),
    proof,
    correction(first),
    proof,
    correction(latest),
  ]);
  await expect(verify(batch, settings, drive.deps)).rejects.toThrow(
    "remains unresolved",
  );
  expect([...new Set(drive.recorded.map((value) => value.verifier))]).toEqual([
    "source",
    "correctness",
    "requirements",
  ]);
  const boundary = drive.calls.length;
  drive.replies.push(proof, comparison(verdict("n1"), verdict("n2")));
  await verify(batch, settings, drive.deps);
  expect(drive.recorded).toHaveLength(8);
  expect(labels(drive.calls.slice(boundary))).toEqual([
    "proof",
    "reconstruction",
  ]);
  expect(drive.calls[boundary]).toMatchObject({
    statement: latest,
  });
});

test("a disconnected joint reconstruction retries only its missing comparison", async () => {
  const batch = input([note("n1"), note("n2")]);
  const pass = checks(verdict("n1"), verdict("n2"));
  const drive = scripted([
    pass,
    pass,
    pass,
    statements("n1", "n2"),
    proof,
    new Error("provider disconnected"),
  ]);
  await expect(verify(batch, settings, drive.deps)).rejects.toThrow(
    "provider disconnected",
  );
  expect(drive.recorded).toHaveLength(6);
  drive.replies.push(comparison(verdict("n1"), verdict("n2")));
  await verify(batch, settings, drive.deps);
  expect(drive.recorded).toHaveLength(8);
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

test.each(["before", "after"] as const)(
  "recovery %s recording reuses the completed comparison and records one atomic batch",
  async (boundary) => {
    const batch = input([note("n1"), note("n2")]);
    const pass = checks(verdict("n1"), verdict("n2"));
    const drive = scripted([
      pass,
      pass,
      pass,
      statements("n1", "n2"),
      proof,
      comparison(verdict("n1"), verdict("n2")),
    ]);
    const record = drive.deps.record;
    let interrupt = true;
    drive.deps.record = async (call, values) => {
      if (interrupt && values[0]?.verifier === "reconstruction") {
        interrupt = false;
        if (boundary === "after") await record(call, values);
        throw new Error("Interrupted around verdict commit");
      }
      await record(call, values);
    };
    await expect(verify(batch, settings, drive.deps)).rejects.toThrow(
      "Interrupted around verdict commit",
    );
    const calls = structuredClone(drive.calls);
    await verify(batch, settings, drive.deps);
    expect(drive.recorded).toHaveLength(8);
    expect(drive.calls).toEqual(calls);
    expect(
      drive.batches.filter(
        ({ values }) => values[0]?.verifier === "reconstruction",
      ),
    ).toHaveLength(1);
  },
);

test.each([["n1", "n99"], ["n1", "n1"], ["n1"]].map((ids) => ({ ids })))(
  "invalid reconstruction IDs %j record no partial reconstruction verdicts",
  async ({ ids }) => {
    const batch = input([note("n1"), note("n2")]);
    const pass = checks(verdict("n1"), verdict("n2"));
    const drive = scripted([
      pass,
      pass,
      pass,
      statements("n1", "n2"),
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

test("a batch naming the wrong note cannot record even a partial verdict", async () => {
  const drive = scripted([checks(verdict("n1"), verdict("n99"))]);
  await expect(
    verify(input([note("n1"), note("n2")]), settings, drive.deps),
  ).rejects.toThrow("one verdict per note");
  expect(drive.recorded).toEqual([]);
  expect(labels(drive.calls)).toEqual(["source"]);
});
