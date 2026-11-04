import { expect, test } from "bun:test";
import type { Respond } from "./worker-fixture.ts";
import { project } from "../src/state.ts";
import { acceptedArgument } from "../src/report.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import { fixture, complete, note, checks } from "./worker-fixture.ts";

const all = [...verifierNames];
const lemma = ["source", "correctness"] as const;

test("a selected root reconstructs its generated dependency closure without checking unrelated work", async () => {
  const run = await fixture((request): ReturnType<Respond> => {
    const { descriptor } = request;
    if (descriptor.kind === "explorer") {
      const prefix = descriptor.input.namespace;
      return {
        notes: [
          note("Lemma L."),
          note("Lemma M from L.", [`${prefix}.1`]),
          note("Complete P from M.", [`${prefix}.2`]),
          note("Unrelated alternative."),
        ],
      };
    }
    return complete(request);
  });
  const explored = await run.run({ kind: "explorer" });
  const ids = [1, 2, 3, 4].map((n) => `w${explored.id}.${n}`);
  const result = await run.run({
    kind: "verifier",
    verify: [
      { note: ids[0]!, verifiers: [...lemma] },
      { note: ids[1]!, verifiers: [...lemma] },
      { note: ids[2]!, verifiers: all },
    ],
  });
  expect(result.outcome.status).toBe("completed");
  const book = await run.book();
  expect(project(book).accepted).toEqual([ids[2]!]);
  const projected = project(book).notes;
  expect(
    projected.map((note) => note.verdicts.map((verdict) => verdict.verifier)),
  ).toEqual([
    [...lemma, "reconstruction"],
    [...lemma, "reconstruction"],
    all,
    [],
  ]);
  const statements = run.requests.find(
    ({ descriptor }) => descriptor.kind === "statement",
  )!.descriptor;
  if (statements.kind !== "statement") throw new Error("Missing statements");
  expect(statements.input.notes.map((note) => note.id)).toEqual(
    ids.slice(0, 3),
  );
  expect(
    book.checks.filter((check) =>
      check.values.some((value) => value.verifier === "reconstruction"),
    ),
  ).toHaveLength(1);
  const argument = acceptedArgument(projected, ids[2]!);
  for (const text of ["Lemma L.", "Lemma M from L.", "Complete P from M."])
    expect(argument).toContain(text);
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
  "$stage $verdict stops its attempt with dead=$dead",
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
    const explored = await run.run({ kind: "explorer" });
    expect(
      (
        await run.run({
          kind: "verifier",
          verify: [{ note: `w${explored.id}.1`, verifiers: all }],
        })
      ).outcome.status,
    ).toBe("completed");
    const book = await run.book();
    expect(project(book).accepted).toEqual([]);
    expect(project(book).notes[0]!.dead).toBe(dead);
    expect(book.checks.at(-1)!.values[0]).toMatchObject({
      verifier: stage,
      verdict,
    });
    const stages = book.checks.flatMap((check) =>
      check.values.map((value) => value.verifier),
    );
    expect(stages).toEqual(
      all.slice(0, all.indexOf(stage as (typeof all)[number]) + 1),
    );
  },
);

test("a later root reuses an ancestor's corrected reconstruction statement while its own proof stays blind", async () => {
  let round = 0;
  let ancestor = "";
  let initialRoot = "";
  let corrected = false;
  const run = await fixture((request): ReturnType<Respond> => {
    const { descriptor } = request;
    if (descriptor.kind === "explorer") {
      if (++round === 1) {
        ancestor = `${descriptor.input.namespace}.1`;
        initialRoot = `${descriptor.input.namespace}.2`;
        return {
          notes: [
            note("PRIVATE_ORIGINAL_LEMMA_PROOF"),
            note("First candidate.", [ancestor]),
          ],
        };
      }
      return { notes: [note("Repaired candidate.", [ancestor])] };
    }
    if (
      descriptor.kind === "statement" &&
      descriptor.input.notes.some((note) => note.id === ancestor)
    )
      return {
        statements: descriptor.input.notes.map((note) => ({
          note: note.id,
          statement: note.id === ancestor ? "INITIAL_WRONG_SCOPE" : "P holds.",
        })),
      };
    if (
      descriptor.kind === "reconstruction" &&
      descriptor.input.notes.some((note) => note.id === initialRoot)
    ) {
      if (!corrected) {
        corrected = true;
        return {
          statements: [
            {
              note: ancestor,
              statement: "Exact lemma with corrected hypotheses.",
            },
            { note: initialRoot, statement: "P holds." },
          ],
          verdicts: [],
        };
      }
      return {
        statements: [],
        verdicts: [
          ...checks([ancestor]).verdicts,
          ...checks([initialRoot], "INCONCLUSIVE").verdicts,
        ],
      };
    }
    return complete(request);
  });
  await run.run({ kind: "explorer" });
  await run.run({
    kind: "verifier",
    verify: [
      { note: ancestor, verifiers: [...lemma] },
      { note: initialRoot, verifiers: all },
    ],
  });
  expect(project(await run.book()).accepted).toEqual([]);
  await run.reopen();
  const next = await run.run({ kind: "explorer" });
  const root = `w${next.id}.1`;
  const boundary = run.requests.length;
  expect(
    (
      await run.run({
        kind: "verifier",
        verify: [{ note: root, verifiers: all }],
      })
    ).outcome.status,
  ).toBe("completed");
  const proof = run.requests
    .slice(boundary)
    .find(({ descriptor }) => descriptor.kind === "proof")!;
  if (proof.descriptor.kind !== "proof") throw new Error("Missing blind proof");
  expect(proof.descriptor.input.notes.map((note) => note.id)).toEqual([root]);
  expect(proof.descriptor.input.premises).toMatchObject([
    { note: ancestor, statement: "Exact lemma with corrected hypotheses." },
  ]);
  const wire = JSON.stringify(proof.transcript);
  expect(wire).toContain("Exact lemma with corrected hypotheses.");
  expect(wire).not.toContain("PRIVATE_ORIGINAL_LEMMA_PROOF");
  expect(wire).not.toContain("INITIAL_WRONG_SCOPE");
  expect(wire).not.toContain("Repaired candidate.");
  expect(project(await run.book()).accepted).toEqual([root]);
});

test("a selected previously reconstructed ancestor remains a proof obligation", async () => {
  const run = await fixture((request): ReturnType<Respond> => {
    if (request.descriptor.kind === "explorer") {
      const id = `${request.descriptor.input.namespace}.1`;
      return { notes: [note("Lemma."), note("First candidate.", [id])] };
    }
    if (request.descriptor.kind === "reconstruction") {
      const ids = request.descriptor.input.notes.map((note) => note.id);
      return {
        statements: [],
        verdicts: ids.map((id, index) => ({
          note: id,
          verdict:
            index === ids.length - 1 && ids.length > 1
              ? "INCONCLUSIVE"
              : "PASS",
          report: "Checked.",
        })),
      };
    }
    return complete(request);
  });
  const explored = await run.run({ kind: "explorer" });
  const ancestor = `w${explored.id}.1`,
    root = `w${explored.id}.2`;
  await run.run({
    kind: "verifier",
    verify: [
      { note: ancestor, verifiers: [...lemma] },
      { note: root, verifiers: all },
    ],
  });
  const boundary = run.requests.length;
  await run.run({
    kind: "verifier",
    verify: [{ note: ancestor, verifiers: all }],
  });
  const proof = run.requests
    .slice(boundary)
    .find(({ descriptor }) => descriptor.kind === "proof")!.descriptor;
  if (proof.kind !== "proof") throw new Error("Missing proof");
  expect(proof.input.notes.map((note) => note.id)).toEqual([ancestor]);
  expect(proof.input.premises ?? []).toEqual([]);
  expect(project(await run.book()).accepted).toEqual([ancestor]);
});

test.each(["PASS", "FAIL"] as const)(
  "an imported premise waits for its generated prerequisite to %s",
  async (prerequisiteVerdict) => {
    let round = 0;
    let dependency = "";
    const run = await fixture((request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        if (++round === 1) return { notes: [note("Generated prerequisite.")] };
        const imported = descriptor.input.notes.find(
          (note) => note.verification !== undefined,
        )!;
        return {
          notes: [note("Root using the imported premise.", [imported.id])],
        };
      }
      if (descriptor.kind === "verifier" && descriptor.name === "correctness")
        return {
          verdicts: descriptor.judged.map((note) => ({
            note,
            verdict: note === dependency ? prerequisiteVerdict : "PASS",
            report: "Checked prerequisite.",
          })),
        };
      return complete(request);
    });
    const prerequisite = await run.run({ kind: "explorer" });
    dependency = `w${prerequisite.id}.1`;
    await run.owner.root.commit(
      async (tx) => {
        const { submitNotes } = await import("../src/inputs.ts");
        await submitNotes(tx, run.owner.root.id, "source", {
          notes: [
            {
              ...note("Imported conditional theorem.", [dependency]),
              verification: {
                source: "Checked source",
                report: "The theorem applies over its declared prerequisite.",
              },
            },
          ],
        });
      },
      (await import("./worker-fixture.ts")).context,
    );
    const explored = await run.run({ kind: "explorer" });
    const root = `w${explored.id}.1`;
    const imported = (await run.notes()).find(
      (note) => note.verification !== undefined,
    )!;
    expect(imported.verified).toBe(false);
    const verified = await run.run({
      kind: "verifier",
      verify: [
        { note: dependency, verifiers: [...lemma] },
        { note: imported.id, verifiers: [...lemma] },
        { note: root, verifiers: all },
      ],
    });
    expect(verified.outcome.status).toBe("completed");
    if (prerequisiteVerdict === "FAIL") {
      expect(project(await run.book()).accepted).toEqual([]);
      expect((await run.notes()).find((note) => note.id === root)!.dead).toBe(
        true,
      );
      expect(
        run.requests.some(
          ({ descriptor }) =>
            descriptor.kind === "statement" || descriptor.kind === "proof",
        ),
      ).toBe(false);
      return;
    }
    expect(project(await run.book()).accepted).toEqual([root]);
    const statements = run.requests.find(
      ({ descriptor }) => descriptor.kind === "statement",
    )!.descriptor;
    if (statements.kind !== "statement")
      throw new Error("Missing statement extraction");
    expect(statements.input.support.map((note) => note.id)).toEqual([
      imported.id,
    ]);
    expect(statements.input.notes.map((note) => note.id)).toEqual([root]);
  },
);
