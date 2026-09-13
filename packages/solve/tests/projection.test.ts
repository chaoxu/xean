import { expect, test } from "bun:test";

import { Projection } from "../projection";
import {
  verifierNames,
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
  candidate: number,
  note: string,
  verifier: VerifierName,
  verdict: Verdict["verdict"] = "PASS",
): JournalVerdict => ({
  seq,
  candidate,
  verdict: { note, verifier, verdict, report: "Check report." },
});

test("verification and acceptance require the respective PASS checks on one candidate", () => {
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
    false,
    true,
  ]);
  expect(projection.accepted(24)).toEqual([]);
  expect(projection.accepted(34)).toEqual(["n1"]);
  expect(projection.at(24)[0]!.verified).toBe(false);
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
