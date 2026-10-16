import { expect, test } from "bun:test";
import { verifierNames, type Verdict } from "../src/policy/contracts.ts";
import {
  project,
  type Check,
  type NotebookState,
  type StoredNote,
} from "../src/state.ts";

// These evidence cases are from v1.0.0's projection tests.
const note = (id: string, support: string[] = []): StoredNote => ({
  id,
  text: `Claim ${id}.`,
  support,
});
const checked = (
  candidate: number,
  note: string,
  verifier: Verdict["verifier"],
  verdict: Verdict["verdict"] = "PASS",
): Check => ({
  candidate,
  call: candidate,
  values: [{ note, verifier, verdict, report: "Check report." }],
});
const book = (notes: StoredNote[], checks: Check[] = []): NotebookState => ({
  notes,
  checks,
  guidance: [],
  inputs: [],
});
const verification = { source: "caller", report: "Checked proof." };

test("verification and acceptance require their PASS checks on one candidate", () => {
  const value = book(
    [note("n1"), note("n2")],
    [
      checked(10, "n1", "source"),
      checked(20, "n1", "correctness"),
      checked(10, "n2", "source"),
      checked(10, "n2", "correctness"),
      checked(20, "n2", "requirements"),
      checked(20, "n2", "reconstruction"),
    ],
  );
  expect(project(value).notes.map(({ verified }) => verified)).toEqual([
    false,
    true,
  ]);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(...verifierNames.map((name) => checked(30, "n1", name)));
  expect(project(value).accepted).toEqual(["n1"]);
});

test("caller verification needs verified support and every normal check for acceptance", () => {
  const value = book([note("n1"), { ...note("n2", ["n1"]), verification }]);
  expect(project(value).notes.map(({ verified }) => verified)).toEqual([
    false,
    false,
  ]);
  value.checks.push(
    checked(10, "n1", "source"),
    checked(10, "n1", "correctness"),
    checked(10, "n1", "requirements", "FAIL"),
  );
  expect(
    project(value).notes.map(({ verified, dead }) => ({ verified, dead })),
  ).toEqual([
    { verified: true, dead: false },
    { verified: true, dead: false },
  ]);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(...verifierNames.map((name) => checked(20, "n2", name)));
  expect(project(value).accepted).toEqual(["n2"]);
});

test.each(["source", "correctness", "reconstruction"] as const)(
  "historical %s FAIL stays authoritative after a later PASS and kills descendants",
  (name) => {
    const value = book(
      [
        { ...note("n1"), verification },
        { ...note("n2", ["n1"]), verification },
        { ...note("n3", ["n2"]), verification },
      ],
      verifierNames.map((name) => checked(10, "n1", name)),
    );
    expect(project(value).accepted).toEqual(["n1"]);
    value.checks.push(checked(20, "n1", name, "FAIL"), checked(30, "n1", name));
    expect(
      project(value).notes.map(({ verified, dead }) => ({ verified, dead })),
    ).toEqual([
      { verified: false, dead: true },
      { verified: false, dead: true },
      { verified: false, dead: true },
    ]);
    expect(project(value).accepted).toEqual([]);
  },
);
