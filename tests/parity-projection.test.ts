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
const reconstructed = (candidate: number, ids: string[]): Check => ({
  candidate,
  call: candidate,
  values: ids.map((id) => checked(candidate, id, "reconstruction").values[0]!),
});

test("generated support needs an earlier successful reconstruction or the same batch, not task completion", () => {
  const value = book(
    [note("n1"), note("n2", ["n1"])],
    [
      checked(10, "n1", "source"),
      checked(10, "n1", "correctness"),
      checked(20, "n1", "requirements", "FAIL"),
      ...verifierNames.map((name) => checked(20, "n2", name)),
    ],
  );
  expect(project(value).notes.map(({ verified }) => verified)).toEqual([
    true,
    true,
  ]);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(checked(30, "n1", "reconstruction", "INCONCLUSIVE"));
  expect(project(value).accepted).toEqual([]);
  value.checks.push(checked(40, "n1", "reconstruction"));
  expect(project(value).accepted).toEqual([]);
  // Later evidence cannot retroactively justify the earlier descendant PASS.
  value.checks.push(reconstructed(20, ["n2", "n1"]));
  expect(project(value).accepted).toEqual(["n2"]);
  expect(project(value).notes[0]).toMatchObject({
    verified: true,
    dead: false,
  });
});

test("an older dependency PASS survives INCONCLUSIVE and requirements FAIL, while the root still needs reconstruction", () => {
  const value = book(
    [note("n1"), note("n2", ["n1"])],
    [
      checked(10, "n1", "source"),
      checked(10, "n1", "correctness"),
      checked(10, "n1", "reconstruction"),
      checked(10, "n1", "requirements", "FAIL"),
      checked(20, "n1", "reconstruction", "INCONCLUSIVE"),
      ...verifierNames.slice(0, 3).map((name) => checked(20, "n2", name)),
    ],
  );
  expect(project(value).notes.every(({ verified }) => verified)).toBe(true);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(reconstructed(20, ["n2"]));
  expect(project(value).accepted).toEqual(["n2"]);
  expect(project(value).reconstructed).toEqual({ n1: 10, n2: 20 });
});

test("multihop reuse is dependency closed and later failures still block acceptance", () => {
  const value = book(
    [
      note("n1"),
      note("n2", ["n1"]),
      note("n3", ["n1"]),
      note("n4", ["n2", "n3"]),
    ],
    [
      ...["n1", "n2", "n3"].flatMap((id) => [
        checked(10, id, "source"),
        checked(10, id, "correctness"),
      ]),
      checked(20, "n2", "reconstruction"),
      checked(20, "n3", "reconstruction"),
      ...verifierNames.map((name) => checked(20, "n4", name)),
    ],
  );
  expect(project(value).accepted).toEqual([]);
  value.checks.push(checked(40, "n1", "reconstruction"));
  expect(project(value).accepted).toEqual([]);
  expect(project(value).reconstructed).toEqual({ n1: 40 });
  value.checks.push(reconstructed(41, ["n3", "n2"]));
  expect(project(value).accepted).toEqual([]);
  value.checks.push(reconstructed(20, ["n4"]));
  expect(project(value).accepted).toEqual(["n4"]);
  expect(project(value).reconstructed).toEqual({
    n1: 40,
    n2: 41,
    n3: 41,
    n4: 20,
  });
  value.checks.push(
    checked(50, "n2", "reconstruction", "FAIL"),
    checked(60, "n2", "reconstruction"),
  );
  expect(project(value).accepted).toEqual([]);
  expect(project(value).notes.map(({ dead }) => dead)).toEqual([
    false,
    true,
    false,
    true,
  ]);
});

test("caller-verified sources end reconstruction traversal but still need live verified support", () => {
  const value = book(
    [note("n1"), { ...note("n2", ["n1"]), verification }, note("n3", ["n2"])],
    [
      checked(10, "n1", "source"),
      checked(10, "n1", "correctness"),
      ...verifierNames.map((name) => checked(20, "n3", name)),
    ],
  );
  expect(project(value).accepted).toEqual(["n3"]);
  value.checks.push(checked(30, "n1", "correctness", "FAIL"));
  expect(project(value).accepted).toEqual([]);
  expect(project(value).notes.every(({ dead }) => dead)).toBe(true);
});

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

test("a caller-verified acceptance root still needs its generated support reconstructed", () => {
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
  expect(project(value).accepted).toEqual([]);
  value.checks.push(reconstructed(20, ["n2", "n1"]));
  expect(project(value).accepted).toEqual(["n2"]);
});

test.each(["source", "correctness", "reconstruction"] as const)(
  "historical %s FAIL stays authoritative after a later PASS and kills descendants",
  (name) => {
    const value = book(
      [note("n1"), note("n2", ["n1"]), note("n3", ["n2"])],
      [
        ...["n1", "n2"].flatMap((id) => [
          checked(10, id, "source"),
          checked(10, id, "correctness"),
        ]),
        reconstructed(10, ["n1"]),
        reconstructed(20, ["n2"]),
        ...verifierNames.slice(0, 3).map((name) => checked(30, "n3", name)),
        reconstructed(30, ["n3"]),
      ],
    );
    expect(project(value).accepted).toEqual(["n3"]);
    value.checks.push(checked(40, "n1", name, "FAIL"), checked(50, "n1", name));
    expect(
      project(value).notes.map(({ verified, dead }) => ({ verified, dead })),
    ).toEqual([
      { verified: false, dead: true },
      { verified: false, dead: true },
      { verified: false, dead: true },
    ]);
    expect(project(value).accepted).toEqual([]);
    expect(project(value).reconstructed).toEqual({});
  },
);
