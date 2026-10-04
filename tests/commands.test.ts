import { expect, test } from "bun:test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Xean } from "../packages/core/src/index.ts";
import { declarationVersion } from "../packages/core/src/solve/contracts.ts";
import {
  guidance,
  submitCommand,
  validateCommand,
} from "../packages/core/src/solve/commands.ts";
import {
  acceptedArgument,
  closure,
  completion,
  noteInfo,
  project,
  refresh,
} from "../packages/core/src/solve/notes.ts";

test("solver imports are trusted over verified support, preserve corrections, and replay safely", async () => {
  const pass = { verdict: "PASS" as const, report: "Checked." };
  const fixtures = {
    base: {
      kind: "notes",
      candidate: false,
      notes: [
        {
          id: "n1",
          text: "Checked lemma.",
          summary: "Lemma",
          detailedSummary: "Checked lemma.",
          support: [],
        },
      ],
    },
    checks: {
      kind: "verification",
      checks: [
        {
          noteId: "base/n1",
          correctness: { ...pass, premises: [] },
          source: pass,
        },
      ],
    },
  };
  const engine = await Xean.open(new MemoryStorage(), {
    task: { kind: "xean.solve", version: declarationVersion },
    roles: [
      {
        name: "fixture",
        run: (input) => input,
      },
    ],
    validateInput: validateCommand,
    coordinator: {
      name: "coordinate",
      run(signal) {
        return {
          state: null,
          dispatch:
            signal.kind === "start"
              ? Object.entries(fixtures).map(([id, input]) => ({
                  id,
                  role: "fixture",
                  input,
                }))
              : [],
        };
      },
    },
  });
  try {
    await engine.run();
    const original = await engine.inspect();
    const established = project(original)[0]!;
    expect(established.verified).toBe(true);
    await submitCommand(engine, {
      kind: "submit",
      id: "external",
      candidate: true,
      notes: [
        {
          id: "n1",
          text: "Imported lemma.",
          summary: "Import",
          detailedSummary: "Imported lemma over established support.",
          support: [established.id],
        },
        {
          id: "n2",
          text: "Imported proof.",
          summary: "Proof",
          detailedSummary: "Imported proof using the lemma.",
          support: ["n1"],
        },
      ],
    });
    const beforeCorrection = await engine.inspect();
    const beforeBytes = JSON.stringify(beforeCorrection);
    const notes = project(beforeCorrection);
    expect(
      notes.map((note) => [
        note.id,
        note.verified,
        note.candidate,
        note.revision,
      ]),
    ).toEqual([
      ["base/n1", true, false, 0],
      ["input/external/n1", true, false, 0],
      ["input/external/n2", true, true, 0],
    ]);
    expect(notes[2]!.checks).toEqual([]);
    expect(noteInfo(notes[2]!)).toMatchObject({
      imported: true,
      passed: ["correctness", "source"],
    });
    expect(completion(notes)).toBeUndefined();
    expect(() => acceptedArgument(notes, notes[2]!.id)).toThrow(
      "No accepted argument",
    );
    expect(() => acceptedArgument(notes, "missing")).toThrow(
      "No accepted argument",
    );
    const unsupported = structuredClone(notes);
    unsupported[0]!.checks = [];
    expect(refresh(unsupported).map((note) => note.verified)).toEqual([
      false,
      false,
      false,
    ]);
    const failed = structuredClone(notes);
    failed[1]!.checks.push({
      noteId: failed[1]!.id,
      source: { verdict: "FAIL", report: "Imported claim is false." },
    });
    expect(refresh(failed).map((note) => [note.dead, note.verified])).toEqual([
      [false, true],
      [true, false],
      [true, false],
    ]);
    expect(closure(["input/external/n2"], notes).map(({ id }) => id)).toEqual(
      notes.map(({ id }) => id),
    );

    const correction = {
      kind: "correct",
      id: "typo",
      note: established.id,
      revision: 0,
      text: "Checked lemma, with corrected typography.",
      summary: "Corrected lemma",
      detailedSummary: "Checked lemma with corrected typography.",
    };
    await expect(
      engine.input({ ...correction, revision: "0" }, correction.id),
    ).rejects.toThrow("Command values must be normalized before input");
    const rejected = await engine.inspect();
    expect(rejected.inputs).toEqual(beforeCorrection.inputs);
    expect(project(rejected)).toEqual(notes);
    expect(() =>
      submitCommand(engine, { ...correction, revision: "0" }),
    ).toThrow("/revision");
    const receipt = await submitCommand(engine, correction);
    const candidate = notes[2]!;
    await submitCommand(engine, {
      kind: "correct",
      id: "format",
      note: candidate.id,
      revision: 0,
      text: "Imported proof, with corrected formatting.",
      summary: candidate.summary,
      detailedSummary: candidate.detailedSummary,
    });
    const corrected = project(await engine.inspect());
    expect(corrected[0]).toEqual({
      ...established,
      text: correction.text,
      summary: correction.summary,
      detailedSummary: correction.detailedSummary,
      revision: 1,
    });
    expect(corrected[2]).toEqual({
      ...candidate,
      text: "Imported proof, with corrected formatting.",
      revision: 1,
    });
    const accepted = structuredClone(corrected);
    for (const note of [accepted[0]!, accepted[2]!])
      note.checks.push({
        noteId: note.id,
        ...(note.candidate ? { requirements: pass } : {}),
        reconstruction: {
          ...pass,
          statement: note.summary,
          proof: "Independent proof.",
        },
      });
    refresh(accepted);
    expect(completion(accepted)).toEqual({ noteId: candidate.id });
    expect(acceptedArgument(accepted, candidate.id)).toBe(
      "## base/n1\n\nChecked lemma, with corrected typography.\n\n## input/external/n1\n\nImported lemma.\n\n## input/external/n2\n\nImported proof, with corrected formatting.",
    );
    expect(await submitCommand(engine, correction)).toEqual(receipt);
    await expect(
      submitCommand(engine, { ...correction, id: "stale" }),
    ).rejects.toThrow("Stale note revision");
    await expect(
      submitCommand(engine, { ...correction, id: "missing", note: "unknown" }),
    ).rejects.toThrow("Unknown note");

    for (const support of [["missing"], [established.id, established.id]]) {
      await expect(
        submitCommand(engine, {
          kind: "submit",
          id: "bad-support",
          candidate: false,
          notes: [
            {
              id: "n1",
              text: "Claim",
              summary: "Claim",
              detailedSummary: "Claim",
              support,
            },
          ],
        }),
      ).rejects.toThrow();
    }
    for (const field of ["text", "summary", "detailedSummary"])
      expect(() =>
        submitCommand(engine, {
          kind: "submit",
          id: "blank",
          candidate: false,
          notes: [
            {
              id: "n1",
              text: "Claim",
              summary: "Claim",
              detailedSummary: "Claim",
              support: [],
              [field]: " ",
            },
          ],
        }),
      ).toThrow();
    expect(() =>
      submitCommand(engine, { ...correction, detailedSummary: undefined }),
    ).toThrow();
    expect(() =>
      submitCommand(engine, {
        kind: "submit",
        id: "empty",
        candidate: false,
        notes: [],
      }),
    ).toThrow();
    expect(() =>
      submitCommand(engine, {
        ...correction,
        id: "extra",
        support: [],
      }),
    ).toThrow();

    const advice = ["Try induction.", "Use the stronger invariant."];
    for (const [index, text] of advice.entries())
      await submitCommand(engine, { kind: "guide", id: `g${index}`, text });
    const latest = await engine.inspect();
    expect(guidance(latest)).toEqual(advice);
    expect(latest.inputs).toHaveLength(5);
    expect(latest.pendingSignals).toBe(5);
    expect(JSON.stringify(beforeCorrection)).toBe(beforeBytes);
    expect(latest.work).toEqual(original.work);
    corrected[0]!.checks[0]!.source!.report = "Caller mutation";
    expect(project(await engine.inspect())[0]!.checks).toEqual(
      established.checks,
    );
  } finally {
    await engine.close();
  }
});

test("automatic corrections follow commit order and stale proposals retain checks", async () => {
  const storage = new MemoryStorage();
  const release = Promise.withResolvers<void>();
  const published = Promise.withResolvers<void>();
  const pass = { verdict: "PASS", report: "Checked." };
  const engine = await Xean.open(storage, {
    task: { kind: "xean.solve", version: declarationVersion },
    validateInput: validateCommand,
    roles: [
      {
        name: "fixture",
        async run(input) {
          if (input === "slow") await release.promise;
          return {
            kind: "verification",
            checks: [
              {
                noteId: "input/import/n1",
                ...(input === "slow"
                  ? { source: pass }
                  : { correctness: { ...pass, premises: [] } }),
                correction: {
                  revision: 0,
                  summary: input === "slow" ? "Stale lemma" : "Corrected lemma",
                  detailedSummary:
                    input === "slow" ? "Stale detail" : "Corrected detail",
                  text:
                    input === "slow"
                      ? "Stale typography."
                      : "Corrected typography.",
                },
              },
            ],
          };
        },
      },
    ],
    coordinator: {
      name: "coordinate",
      run(signal) {
        if (
          signal.kind === "completed" &&
          (signal.value as { workId: string }).workId === "fast"
        )
          published.resolve();
        return {
          state: null,
          dispatch:
            signal.kind === "start"
              ? ["slow", "fast"].map((id) => ({
                  id,
                  role: "fixture",
                  input: id,
                }))
              : [],
        };
      },
    },
  });
  try {
    await submitCommand(engine, {
      kind: "submit",
      id: "import",
      candidate: false,
      notes: [
        {
          id: "n1",
          text: "Original typography.",
          summary: "Lemma",
          detailedSummary: "Original detailed lemma.",
          support: [],
        },
      ],
    });
    const running = engine.run();
    await published.promise;
    const frozen = await engine.inspect();
    const frozenBytes = JSON.stringify(frozen);
    expect(project(frozen)[0]!.revision).toBe(1);
    await submitCommand(engine, {
      kind: "correct",
      id: "editor",
      note: "input/import/n1",
      revision: 1,
      text: "Editor's typography.",
      summary: "Editor's summary.",
      detailedSummary: "Editor's detailed summary.",
    });
    release.resolve();
    const note = project(await running)[0]!;
    expect([
      note.text,
      note.summary,
      note.detailedSummary,
      note.revision,
      note.verified,
    ]).toEqual([
      "Editor's typography.",
      "Editor's summary.",
      "Editor's detailed summary.",
      2,
      true,
    ]);
    expect(note.checks).toHaveLength(2);
    expect(note.checks.every((check) => check.correction === undefined)).toBe(
      true,
    );
    expect(project(frozen)[0]).toMatchObject({
      text: "Corrected typography.",
      summary: "Corrected lemma",
      detailedSummary: "Corrected detail",
    });
    expect(JSON.stringify(frozen)).toBe(frozenBytes);
    expect(frozenBytes).toContain('"correction"');
  } finally {
    release.resolve();
    await engine.close();
  }
});
