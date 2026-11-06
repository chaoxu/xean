import { expect, test } from "bun:test";
import type { Respond } from "./worker-fixture.ts";
import { project } from "../src/state.ts";
import { acceptedArgument } from "../src/report.ts";
import { submitNotes } from "../src/inputs.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import { fixture, complete, note, checks } from "./worker-fixture.ts";

const all = [...verifierNames];
const local = ["source", "correctness", "reconstruction"] as const;

test("conditional root checks finish first and composed acceptance waits for the dependency graph", async () => {
  const run = await fixture((request): ReturnType<Respond> => {
    const { descriptor } = request;
    if (descriptor.kind === "explorer") {
      const prefix = descriptor.input.namespace;
      return {
        notes: [
          note("PRIVATE_L_PROOF"),
          note("PRIVATE_M_PROOF", [`${prefix}.1`]),
          note("Complete P assuming M.", [`${prefix}.2`]),
          note("Unrelated alternative."),
        ],
      };
    }
    return complete(request);
  });
  await run.run({ kind: "explorer" });
  const [l, m, root, unrelated] = [1, 2, 3, 4].map((n) => `w1.${n}`) as [
    string,
    string,
    string,
    string,
  ];
  await run.run({ kind: "verifier", verify: [{ note: root, verifiers: all }] });
  const provisional = await run.book();
  expect(
    provisional.checks.flatMap((check) =>
      check.values.map((value) => value.note),
    ),
  ).toEqual([root, root, root, root]);
  expect(project(provisional).accepted).toEqual([]);
  const extraction = run.requests.find(
    ({ descriptor }) => descriptor.kind === "statement",
  )!.descriptor;
  if (extraction.kind !== "statement")
    throw new Error("Missing statement extraction");
  expect(extraction.input.notes.map((note) => note.id)).toEqual([root]);
  expect(extraction.input.support.map((note) => note.id)).toEqual([m]);
  const blind = run.requests.find(
    ({ descriptor }) => descriptor.kind === "proof",
  )!;
  expect(JSON.stringify(blind.transcript)).toContain(`Exact claim ${m}.`);
  expect(JSON.stringify(blind.transcript)).not.toContain("PRIVATE_M_PROOF");
  expect(JSON.stringify(blind.transcript)).not.toContain("PRIVATE_L_PROOF");
  await run.run({
    kind: "verifier",
    verify: [{ note: m, verifiers: [...local] }],
  });
  expect(project(await run.book()).accepted).toEqual([]);
  await run.run({
    kind: "verifier",
    verify: [{ note: l, verifiers: [...local] }],
  });
  const book = await run.book();
  expect(project(book).accepted).toEqual([root]);
  expect(
    book.checks.filter((check) =>
      check.values.some((value) => value.note === root),
    ),
  ).toEqual(provisional.checks);
  expect(
    book.checks.some((check) =>
      check.values.some((value) => value.note === unrelated),
    ),
  ).toBe(false);
  const argument = acceptedArgument(project(book).notes, root);
  expect(argument).toContain("PRIVATE_L_PROOF");
  expect(argument).toContain("PRIVATE_M_PROOF");
  expect(argument).not.toContain("Unrelated alternative.");
});

test.each([
  { stage: "source", verdict: "FAIL", dead: true },
  { stage: "correctness", verdict: "FAIL", dead: true },
  { stage: "requirements", verdict: "FAIL", dead: false },
  { stage: "requirements", verdict: "INCONCLUSIVE", dead: false },
  { stage: "reconstruction", verdict: "FAIL", dead: true },
  { stage: "reconstruction", verdict: "INCONCLUSIVE", dead: false },
])(
  "own $stage $verdict gives dead=$dead and never accepts",
  async ({ stage, verdict, dead }) => {
    const run = await fixture((request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "verifier" && descriptor.name === stage)
        return checks(descriptor.judged, verdict);
      if (descriptor.kind === "reconstruction" && stage === "reconstruction")
        return {
          statements: [],
          ...checks(
            descriptor.input.notes.map((note) => note.id),
            verdict,
          ),
        };
      return complete(request);
    });
    await run.run({ kind: "explorer" });
    await run.run({
      kind: "verifier",
      verify: [{ note: "w1.1", verifiers: all }],
    });
    const book = await run.book();
    expect(project(book).accepted).toEqual([]);
    expect(project(book).notes[0]!.dead).toBe(dead);
    expect(book.checks.flatMap((check) => check.values)).toContainEqual(
      expect.objectContaining({ verifier: stage, verdict }),
    );
    const expected =
      stage === "requirements"
        ? all
        : all.slice(0, all.indexOf(stage as (typeof all)[number]) + 1);
    expect(
      book.checks.flatMap((check) =>
        check.values.map((value) => value.verifier),
      ),
    ).toEqual(expected);
  },
);

test("root acceptance never combines requirements and reconstruction from different attempts", async () => {
  const run = await fixture();
  await run.run({ kind: "explorer" });
  const root = "w1.1";
  await run.run({
    kind: "verifier",
    verify: [
      { note: root, verifiers: ["source", "correctness", "requirements"] },
    ],
  });
  await run.run({
    kind: "verifier",
    verify: [{ note: root, verifiers: [...local] }],
  });
  const partial = await run.book();
  expect(new Set(partial.checks.map((check) => check.candidate)).size).toBe(2);
  expect(project(partial).accepted).toEqual([]);
  await run.run({ kind: "verifier", verify: [{ note: root, verifiers: all }] });
  expect(project(await run.book()).accepted).toEqual([root]);
});

test("an externally attested direct premise supplies a statement without leaking its proof to reconstruction", async () => {
  const run = await fixture((request): ReturnType<Respond> => {
    if (request.descriptor.kind === "explorer") {
      const premise = request.descriptor.input.notes[0]!.id;
      return { notes: [note("Root applying the theorem.", [premise])] };
    }
    return complete(request);
  });
  await run.owner.change((data) =>
    submitNotes(data, "theorem", {
      notes: [
        {
          ...note("PRIVATE_IMPORTED_PROOF"),
          verification: {
            source: "Checked theorem",
            report: "Exact scope checked.",
          },
        },
      ],
    }),
  );
  await run.run({ kind: "explorer" });
  const root = "w2.1";
  const premise = (await run.notes()).find(
    (note) => note.verification !== undefined,
  )!.id;
  await run.run({ kind: "verifier", verify: [{ note: root, verifiers: all }] });
  expect(project(await run.book()).accepted).toEqual([root]);
  const proof = run.requests.find(
    ({ descriptor }) => descriptor.kind === "proof",
  )!;
  expect(JSON.stringify(proof.transcript)).toContain(`Exact claim ${premise}.`);
  expect(JSON.stringify(proof.transcript)).not.toContain(
    "PRIVATE_IMPORTED_PROOF",
  );
  expect(
    (await run.book()).checks
      .flatMap((check) => check.values)
      .every((value) => value.note === root),
  ).toBe(true);
});

test("a same-batch source failure leaves the dependency statement available for the surviving conditional target", async () => {
  let a = "",
    b = "";
  const run = await fixture((request): ReturnType<Respond> => {
    const { descriptor } = request;
    if (descriptor.kind === "explorer") {
      a = `${descriptor.input.namespace}.1`;
      b = `${descriptor.input.namespace}.2`;
      return {
        notes: [note("PRIVATE_BODY_A"), note("B follows from A.", [a])],
      };
    }
    if (descriptor.kind === "verifier" && descriptor.name === "source")
      return {
        verdicts: descriptor.judged.map((id) => ({
          note: id,
          verdict: id === a ? "FAIL" : "PASS",
          report: "Checked source.",
        })),
      };
    if (descriptor.kind === "verifier" && descriptor.name === "correctness") {
      expect(descriptor.judged).toEqual([b]);
      expect(JSON.stringify(request.transcript)).toContain("PRIVATE_BODY_A");
    }
    return complete(request);
  });
  await run.run({ kind: "explorer" });
  const result = await run.run({
    kind: "verifier",
    verify: [
      { note: a, verifiers: [...local] },
      { note: b, verifiers: all },
    ],
  });
  expect(result.outcome.kind).toBe("done");
  const book = await run.book();
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === b)
      .map((value) => value.verifier),
  ).toEqual(all);
  expect(project(book).notes.find((note) => note.id === b)).toMatchObject({
    checked: true,
    verified: false,
    dead: true,
  });
  expect(project(book).accepted).toEqual([]);
  const proof = run.requests.find(
    ({ descriptor }) => descriptor.kind === "proof",
  )!;
  expect(JSON.stringify(proof.transcript)).toContain(`Exact claim ${a}.`);
  expect(JSON.stringify(proof.transcript)).not.toContain("PRIVATE_BODY_A");
});
