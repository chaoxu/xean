import { expect, test } from "bun:test";
import { verifierNames, type Verdict } from "../src/policy/contracts.ts";
import {
  project,
  type Check,
  type NotebookState,
  type StoredNote,
} from "../src/state.ts";

const note = (id: string, support: string[] = []): StoredNote => ({
  id,
  text: `Claim ${id}.`,
  support,
});
const check = (
  candidate: number,
  note: string,
  verifier: Verdict["verifier"],
  verdict: Verdict["verdict"] = "PASS",
): Check => ({
  candidate: String(candidate),
  call: candidate,
  values: [{ note, verifier, verdict, report: "Check report." }],
});
const proof = (candidate: number, id: string) =>
  verifierNames
    .filter((name) => name !== "requirements")
    .map((name) => check(candidate, id, name));
const book = (notes: StoredNote[], checks: Check[] = []): NotebookState => ({
  notes,
  checks,
  guidance: [],
  inputs: [],
});
const flags = (value: NotebookState) =>
  project(value).notes.map(({ checked, verified, dead }) => ({
    checked,
    verified,
    dead,
  }));
const verification = { source: "caller", report: "Checked proof." };

test("a locally checked child becomes verified when its dependency later passes, without new child checks", () => {
  const child = verifierNames.map((name) => check(20, "B", name));
  const value = book([note("A"), note("B", ["A"])], child.slice());
  expect(flags(value)).toEqual([
    { checked: false, verified: false, dead: false },
    { checked: true, verified: false, dead: false },
  ]);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(...proof(10, "A"));
  expect(flags(value)).toEqual([
    { checked: true, verified: true, dead: false },
    { checked: true, verified: true, dead: false },
  ]);
  expect(project(value).accepted).toEqual(["B"]);
  expect(value.checks.filter(({ candidate }) => candidate === "20")).toEqual(
    child,
  );
});

test("support needs no requirements PASS, while a solution needs all four checks", () => {
  const value = book(
    [note("A"), note("B", ["A"])],
    [
      ...proof(10, "A"),
      check(10, "A", "requirements", "FAIL"),
      check(20, "A", "reconstruction", "INCONCLUSIVE"),
      ...proof(30, "B"),
    ],
  );
  expect(
    project(value).notes.every(({ checked, verified }) => checked && verified),
  ).toBe(true);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(check(30, "B", "requirements"));
  expect(project(value).accepted).toEqual(["B"]);
});

test("multihop dependencies verify independently of check order and retain local evidence after an ancestor fails", () => {
  const value = book(
    [note("A"), note("B", ["A"]), note("C", ["A"]), note("D", ["B", "C"])],
    [
      ...proof(20, "B"),
      ...proof(30, "C"),
      ...verifierNames.map((name) => check(40, "D", name)),
    ],
  );
  const earlier = structuredClone(value.checks);
  expect(
    project(value)
      .notes.slice(1)
      .every(({ checked }) => checked),
  ).toBe(true);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(...proof(50, "A"));
  expect(project(value).accepted).toEqual(["D"]);
  value.checks.push(check(60, "A", "correctness", "FAIL"));
  expect(flags(value)).toEqual([
    { checked: false, verified: false, dead: true },
    { checked: true, verified: false, dead: true },
    { checked: true, verified: false, dead: true },
    { checked: true, verified: false, dead: true },
  ]);
  expect(project(value).accepted).toEqual([]);
  expect(value.checks.slice(0, earlier.length)).toEqual(earlier);
});

test("external attestation is local evidence and does not discharge unverified dependencies or solution requirements", () => {
  const value = book([note("A"), { ...note("B", ["A"]), verification }]);
  expect(flags(value)).toEqual([
    { checked: false, verified: false, dead: false },
    { checked: true, verified: false, dead: false },
  ]);
  value.checks.push(...proof(10, "A"));
  expect(project(value).notes.every(({ verified }) => verified)).toBe(true);
  expect(project(value).accepted).toEqual([]);
  value.checks.push(...verifierNames.map((name) => check(20, "B", name)));
  expect(project(value).accepted).toEqual(["B"]);
  value.checks.push(check(30, "B", "source", "FAIL"));
  expect(project(value).notes[1]).toMatchObject({
    checked: false,
    verified: false,
    dead: true,
  });
});

test("local proof checks and final acceptance cannot combine different attempts", () => {
  const value = book(
    [note("A"), note("B")],
    [
      check(10, "A", "source"),
      check(20, "A", "correctness"),
      check(10, "A", "reconstruction"),
      check(10, "B", "source"),
      check(10, "B", "correctness"),
      check(20, "B", "reconstruction"),
      check(20, "B", "requirements"),
    ],
  );
  expect(project(value).notes.every(({ checked }) => !checked)).toBe(true);
  value.checks.push(check(10, "B", "reconstruction"));
  expect(project(value).notes[1]).toMatchObject({
    checked: true,
    verified: true,
  });
  expect(project(value).accepted).toEqual([]);
  value.checks.push(check(10, "B", "requirements"));
  expect(project(value).accepted).toEqual(["B"]);
});

test.each(["source", "correctness", "reconstruction"] as const)(
  "historical %s FAIL remains authoritative after later PASS checks, requiring a corrected note ID",
  (name) => {
    const value = book(
      [note("A"), note("B", ["A"])],
      [...proof(10, "A"), ...verifierNames.map((name) => check(20, "B", name))],
    );
    expect(project(value).accepted).toEqual(["B"]);
    value.checks.push(check(30, "A", name, "FAIL"), ...proof(40, "A"));
    expect(flags(value)).toEqual([
      { checked: false, verified: false, dead: true },
      { checked: true, verified: false, dead: true },
    ]);
    expect(project(value).accepted).toEqual([]);
    value.notes.push(note("corrected A"));
    value.checks.push(...proof(50, "corrected A"));
    expect(project(value).notes.at(-1)).toMatchObject({
      checked: true,
      verified: true,
      dead: false,
    });
    expect(value.notes[1]!.support).toEqual(["A"]);
  },
);

test("publication order governs opaque identities and shared ancestor invalidation", () => {
  const ids = ["__proto__", "constructor", "w2.1"];
  const value = book(
    [note(ids[0]!), note(ids[1]!, [ids[0]!]), note(ids[2]!, [ids[1]!])],
    [...ids.flatMap((id) => proof(10, id)), check(10, ids[2]!, "requirements")],
  );
  expect(project(value).notes.map(({ id }) => id)).toEqual(ids);
  expect(project(value).accepted).toEqual([ids[2]!]);
  expect(() =>
    project({ ...value, notes: [...value.notes].reverse() }),
  ).toThrow("must precede");
  value.checks.push(check(20, ids[0]!, "correctness", "FAIL"));
  expect(project(value).accepted).toEqual([]);
  expect(project(value).notes.every(({ dead }) => dead)).toBe(true);
});
