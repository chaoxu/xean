import { expect, test } from "bun:test";
import type { Entry } from "xean";

import { Projection } from "../projection";
import {
  verifierNames,
  judgedBy,
  journalVerdicts,
  verificationLabel,
  verifierLabels,
  verificationComplete,
  type Note,
  type JournalVerdict,
  type VerifierName,
  type Verdict,
} from "../roles";

const note = (id: string, support: string[] = []) => ({
  id,
  text: `${id} result.`,
  support,
});
const verification = { source: "caller", report: "Checked proof." };
const evidence = (
  seq: number,
  verification: number,
  note: string,
  verifier: VerifierName,
  verdict: Verdict["verdict"] = "PASS",
): JournalVerdict => ({
  seq,
  call: verification,
  verification,
  verdict: { note, verifier, verdict, report: "Check report." },
});

test("verification and acceptance reuse completed checks across dispatches", () => {
  const projection = new Projection([
    evidence(11, 10, "n1", "source"),
    evidence(22, 20, "n1", "correctness"),
    evidence(11, 10, "n2", "source"),
    evidence(12, 10, "n2", "correctness"),
    evidence(23, 20, "n2", "requirements"),
    evidence(24, 20, "n2", "reconstruction"),
    evidence(31, 30, "n1", "source"),
    evidence(32, 30, "n1", "correctness"),
    evidence(33, 30, "n1", "requirements"),
    evidence(34, 30, "n1", "reconstruction"),
  ]);
  projection.add([note("n1"), note("n2")], 2);
  expect(projection.at(24).map(({ verified }) => verified)).toEqual([
    true,
    true,
  ]);
  expect(projection.accepted(24)).toEqual(["n2"]);
  expect(projection.accepted(34)).toEqual(["n1", "n2"]);
  expect(projection.at(24)[0]!.verified).toBe(true);
});

test("external verification needs verified support and every normal check for acceptance", () => {
  const projection = new Projection([
    evidence(11, 10, "n1", "source"),
    evidence(12, 10, "n1", "correctness"),
    evidence(13, 10, "n1", "requirements", "FAIL"),
    ...verifierNames.map((verifier, i) => evidence(21 + i, 20, "n2", verifier)),
  ]);
  projection.add([note("n1"), { ...note("n2", ["n1"]), verification }], 2);
  expect(projection.at(2).map(({ verified }) => verified)).toEqual([
    false,
    false,
  ]);
  expect(
    projection.at(13).map(({ verified, dead }) => ({ verified, dead })),
  ).toEqual([
    { verified: true, dead: false },
    { verified: true, dead: false },
  ]);
  expect(projection.accepted(13)).toEqual([]);
  expect(projection.accepted(24)).toEqual(["n2"]);
});

test("an approved correction clears its stale summary and preserves historical filings", () => {
  const correction = evidence(11, 10, "n1", "correctness");
  const projection = new Projection([
    {
      ...correction,
      verdict: { ...correction.verdict, correctedText: "Corrected proof." },
    },
  ]);
  projection.add([note("n1")], 2);
  projection.file([{ note: "n1", summary: "Old gap." }], 3);
  expect(projection.at(11)[0]).toMatchObject({ text: "Corrected proof." });
  expect(projection.at(11)[0]!.summary).toBeUndefined();
  projection.file([{ note: "n1", summary: "Corrected result." }], 12);
  expect(projection.at(12)[0]!.summary).toBe("Corrected result.");
  expect(projection.at(3)[0]).toMatchObject({
    text: "n1 result.",
    summary: "Old gap.",
  });
});

test.each(["source", "correctness", "reconstruction"] as const)(
  "a historical %s FAIL remains authoritative after a later PASS and propagates to descendants",
  (verifier) => {
    const projection = new Projection([
      evidence(21, 20, "n1", verifier, "FAIL"),
      evidence(31, 30, "n1", verifier),
      ...verifierNames.map((name, i) => evidence(11 + i, 10, "n1", name)),
    ]);
    projection.add(
      [
        { ...note("n1"), verification },
        { ...note("n2", ["n1"]), verification },
        { ...note("n3", ["n2"]), verification },
      ],
      2,
    );
    expect(projection.accepted(14)).toEqual(["n1"]);
    expect(
      projection.at(31).every(({ dead, verified }) => dead && !verified),
    ).toBe(true);
    expect(projection.accepted(31)).toEqual([]);
    expect(
      projection.at(14).every(({ dead, verified }) => !dead && verified),
    ).toBe(true);
    expect(projection.accepted(14)).toEqual(["n1"]);
  },
);

test("creation, filings, and report history respect the journal sequence and numeric note order", () => {
  const projection = new Projection([
    evidence(22, 20, "n1", "correctness", "INCONCLUSIVE"),
    evidence(11, 10, "n1", "source", "PASS"),
  ]);
  projection.add([note("n10"), note("n2"), note("n1")], 2);
  projection.file([{ note: "n1", summary: "Filed result." }], 3);
  expect(projection.at(1)).toEqual([]);
  expect(projection.at(2).map(({ id }) => id)).toEqual(["n1", "n2", "n10"]);
  expect(projection.at(2)[0]!.summary).toBeUndefined();
  expect(projection.at(3)[0]!.summary).toBe("Filed result.");
  expect(projection.at(21)[0]!.verdicts.map(({ verdict }) => verdict)).toEqual([
    "PASS",
  ]);
  expect(projection.at(22)[0]!.verdicts.map(({ verdict }) => verdict)).toEqual([
    "PASS",
    "INCONCLUSIVE",
  ]);
  expect(projection.at(2)[0]!.verdicts).toEqual([]);
});

test("verifier eligibility sees only earlier stages and reconstruction's earlier-note prefix", () => {
  const notes: Note[] = [note("n1"), note("n2", ["n1"]), note("n3")].map(
    (note) => ({ ...note, verdicts: [], verified: false, dead: false }),
  );
  const input = {
    notes,
    support: [],
    verify: notes.map(({ id }) => ({
      note: id,
      verifiers: [...verifierNames],
    })),
  };
  const recorded: Verdict[] = notes.flatMap(({ id }) =>
    verifierNames.slice(0, 3).map((verifier) => ({
      note: id,
      verifier,
      verdict: "PASS" as const,
      report: "Established.",
    })),
  );
  recorded.push({
    note: "n1",
    verifier: "reconstruction",
    verdict: "FAIL",
    report: "Independent proof exposes a defect.",
  });
  expect(judgedBy(input, recorded, "source")).toEqual(["n1", "n2", "n3"]);
  expect(judgedBy(input, recorded, "reconstruction")).toEqual(["n1", "n3"]);
  expect(verificationComplete(input, recorded)).toBe(false);
  recorded.push({
    note: "n3",
    verifier: "reconstruction",
    verdict: "INCONCLUSIVE",
    report: "Independent check remains unresolved.",
  });
  expect(verificationComplete(input, recorded)).toBe(true);
});

test("admitted note evidence requires a succeeded verifier child of a frozen verification", () => {
  const opening: Entry = {
    kind: "call",
    seq: 2,
    atMs: 0,
    label: verificationLabel,
    request: null,
    tools: [],
  };
  const call: Entry = {
    kind: "call",
    seq: 3,
    atMs: 0,
    label: verifierLabels.correctness,
    role: "verifier",
    parent: 2,
    request: null,
    tools: [],
  };
  const entry: Entry = {
    kind: "evidence",
    seq: 5,
    atMs: 0,
    call: 3,
    evidence: {
      verdicts: [
        {
          note: "n1",
          verdict: "PASS",
          report: "Checked.",
          externalResults: [],
        },
      ],
    },
  };
  const result: Entry = {
    kind: "call-result",
    seq: 4,
    atMs: 0,
    parent: call.seq,
    state: "returned",
    output: { state: "succeeded" },
  };
  expect(journalVerdicts([opening, call, result, entry])).toEqual([
    {
      seq: 5,
      call: 3,
      verification: 2,
      externalResults: [],
      verdict: {
        verifier: "correctness",
        note: "n1",
        verdict: "PASS",
        report: "Checked.",
      },
    },
  ]);
  expect(() =>
    journalVerdicts([
      opening,
      call,
      result,
      {
        ...entry,
        evidence: {
          verdicts: [
            { note: "n1", verdict: "PASS", report: "Missing premises." },
          ],
        },
      },
    ]),
  ).toThrow("malformed verdict");
  for (const output of [
    null,
    { state: "failed" },
    { state: "cancelled" },
    { state: "complete" },
  ]) {
    expect(() =>
      journalVerdicts([opening, call, { ...result, output }, entry]),
    ).toThrow("malformed verdict");
  }
  expect(() => journalVerdicts([opening, call, entry])).toThrow(
    "malformed verdict",
  );
  expect(() =>
    journalVerdicts([opening, call, { ...result, seq: 6 }, entry]),
  ).toThrow("malformed verdict");
  expect(() =>
    journalVerdicts([
      opening,
      { ...call, label: verifierLabels.source },
      { ...result, output: { state: "succeeded", verdicts: [] } },
      {
        ...entry,
        evidence: {
          verdicts: [
            { note: "n1", verdict: "PASS", report: "Checked.", sources: [] },
          ],
        },
      },
    ]),
  ).toThrow("malformed verdict");
  expect(() =>
    journalVerdicts([opening, { ...call, role: "explorer" }, result, entry]),
  ).toThrow("malformed verdict");
  expect(() =>
    journalVerdicts([{ ...opening, label: "unrelated" }, call, result, entry]),
  ).toThrow("malformed verdict");
});
