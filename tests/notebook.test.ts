import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type EntryId,
} from "@earendil-works/pi-durable";
import {
  publishCommand,
  publishResult,
  readSnapshot,
  readView,
  type MathView,
  type SnapshotReader,
} from "../src/math/state.ts";
import {
  pendingChecks,
  stagePending,
  validatePlan,
} from "../src/math/notes.ts";
import type { Check, Note, SolverResult } from "../src/math/contracts.ts";

const pass = { verdict: "PASS" as const, report: "Checked." };
const content = (text: string) => ({
  summary: text,
  detailedSummary: text,
  text,
});
const checked = (note: Note, statement = note.id): Check => ({
  noteId: note.id,
  correctness: { ...pass, statement, premises: [] },
  source: pass,
  requirements: pass,
  reconstruction: { ...pass, proof: `Independent proof of ${statement}` },
});
async function fixture() {
  const Worker = defineTask<
    { value: SolverResult; frozen: MathView },
    { phase: "run" },
    SolverResult
  >({
    name: "notebook.fixture",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, ctx) {
        await runtime.commit(async (tx) => {
          await publishResult(
            tx,
            task.conversationId,
            task.input.value,
            task.id,
            task.input.frozen,
          );
          return {
            status: "terminal",
            outcome: { status: "completed", result: task.input.value },
          };
        }, ctx);
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "notebook.fixture", tasks: [Worker] }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    context,
  );
  const root = await harness.root(context);
  const reader: SnapshotReader = {
    snapshotAsOf: harness.snapshotAsOf.bind(harness),
    getTask: (id) => root.commit((tx) => tx.task(id), context),
    entry: (id) => root.commit((tx) => tx.entry(id), context),
  };
  const view = () => root.commit((tx) => readView(tx, root.id), context);
  return {
    root,
    harness,
    view,
    snapshot: (at: EntryId) => readSnapshot(reader, root.id, at, context),
    marker: () =>
      root.commit(
        async (tx) =>
          (await tx.appendEntry(root.id, { kind: "notebook.marker" })).id,
        context,
      ),
    async run(value: SolverResult, prior?: MathView) {
      const frozen = prior ?? (await view());
      const id = await root.commit(
        (tx) =>
          tx.createTask(
            Worker,
            { value, frozen },
            { ownership: { kind: "conversation" } },
          ),
        context,
      );
      return (await harness.waitForTask(id, context)).state.outcome;
    },
  };
}
async function seed(owner: Awaited<ReturnType<typeof fixture>>) {
  expect(
    (
      await owner.run({
        kind: "notes",
        candidate: true,
        notes: [
          { id: "n1", ...content("Lemma proof"), support: [] },
          { id: "n2", ...content("Consumer proof"), support: ["n1"] },
        ],
      })
    ).status,
  ).toBe("completed");
  const notes = (await owner.view()).notes;
  expect(
    (
      await owner.run({
        kind: "verification",
        checks: notes.map((note) => checked(note)),
      })
    ).status,
  ).toBe("completed");
  return (await owner.view()).notes;
}

test("note-only snapshots retain evidence without replaying caller inputs", async () => {
  const owner = await fixture();
  try {
    await seed(owner);
    await owner.root.commit(
      (tx) =>
        publishCommand(tx, owner.root.id, {
          kind: "guide",
          id: "hint",
          text: "Review the proof",
        }),
      context,
    );
    const at = await owner.marker();
    const full = await owner.snapshot(at);
    const lean = await readSnapshot(
      {
        snapshotAsOf: owner.harness.snapshotAsOf.bind(owner.harness),
        getTask: (id) => owner.root.commit((tx) => tx.task(id), context),
        entry: async () => {
          throw new Error("Note reads must not replay input entries");
        },
      },
      owner.root.id,
      at,
      context,
      { inputs: false },
    );
    expect(lean.notes).toEqual(full.notes);
    expect(lean.inputs).toEqual([]);
    expect(lean.guidance).toEqual([]);
    expect(full.guidance).toEqual(["Review the proof"]);
  } finally {
    await owner.harness.close(context);
  }
});

test("mathematical proof edits invalidate consumers even when the statement is retained", async () => {
  const owner = await fixture();
  try {
    const [base, consumer] = await seed(owner);
    const at = await owner.marker();
    const old = await owner.snapshot(at);
    expect(consumer!.accepted).toBe(true);
    expect(
      (
        await owner.run({
          kind: "notes",
          notes: [],
          candidate: false,
          edits: [
            {
              id: base!.id,
              revision: base!.revision,
              text: "A repaired proof of the same lemma",
            },
          ],
        })
      ).status,
    ).toBe("completed");
    const edited = (await owner.view()).notes;
    expect(edited[0]!.checks).toEqual({});
    expect(edited[1]!.checks).toEqual({});
    expect(edited[1]!.verified).toBe(false);
    expect(
      (
        await owner.run({
          kind: "verification",
          checks: [checked(edited[0]!, base!.id)],
        })
      ).status,
    ).toBe("completed");
    const repaired = await owner.view();
    expect(repaired.notes[1]!.accepted).toBe(false);
    expect(repaired.notes[1]!.checks).toEqual({});
    await owner.run({
      kind: "verification",
      checks: [checked(consumer!)],
    });
    expect((await owner.view()).notes[1]!.accepted).toBe(true);
    expect(await owner.snapshot(at)).toEqual(old);
  } finally {
    await owner.harness.close(context);
  }
});

test("a changed exported statement invalidates retained consumers before new evidence installs", async () => {
  const owner = await fixture();
  try {
    const [base] = await seed(owner);
    await owner.run({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        {
          id: base!.id,
          revision: base!.revision,
          text: "A different claim and proof",
        },
      ],
    });
    const edited = (await owner.view()).notes;
    expect(
      (
        await owner.run({
          kind: "verification",
          checks: [checked(edited[0]!, "A different theorem")],
        })
      ).status,
    ).toBe("completed");
    const current = (await owner.view()).notes;
    expect(current[1]!.checks).toEqual({});
    expect(current[1]!.verified).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test("cosmetic and no-op edits preserve diagnosis; stale mathematical publications fail atomically", async () => {
  const owner = await fixture();
  try {
    const [base] = await seed(owner);
    const frozen = await owner.view();
    await owner.run({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        {
          id: base!.id,
          revision: base!.revision,
          summary: "A clearer summary",
          text: "Lemma proof\n",
          cosmetic: true,
        },
      ],
    });
    const summaryEdited = (await owner.view()).notes[0]!;
    expect(summaryEdited.mathRevision).toBe(base!.mathRevision);
    expect(summaryEdited.checks).toEqual(base!.checks);
    expect(summaryEdited.revision).toBeGreaterThan(base!.revision);
    expect((await owner.view()).notes[1]!.accepted).toBe(true);
    expect(
      (
        await owner.run(
          { kind: "verification", checks: [checked(base!)] },
          frozen,
        )
      ).status,
    ).toBe("completed");
    await owner.run({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        { id: base!.id, revision: summaryEdited.revision, text: "New proof" },
      ],
    });
    const afterEdit = await owner.view();
    const stale = await owner.run(
      { kind: "verification", checks: [checked(base!)] },
      frozen,
    );
    expect(stale.status).toBe("faulted");
    expect(await owner.view()).toEqual(afterEdit);
    const now = afterEdit.notes[0]!;
    await owner.run({
      kind: "verification",
      checks: [
        {
          noteId: now.id,
          correctness: {
            verdict: "INCONCLUSIVE",
            report: "Missing case",
            statement: now.id,
            premises: [],
          },
        },
      ],
    });
    const assessed = (await owner.view()).notes[0]!;
    await owner.run({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        {
          id: assessed.id,
          revision: assessed.revision,
          text: assessed.text,
          cosmetic: true,
        },
      ],
    });
    const unchanged = (await owner.view()).notes[0]!;
    expect(unchanged.revision).toBe(assessed.revision);
    expect(stagePending(unchanged, "correctness")).toBe(false);
    await owner.run({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        {
          id: assessed.id,
          revision: assessed.revision,
          text: `${assessed.text}\n`,
          cosmetic: true,
        },
      ],
    });
    const formatted = (await owner.view()).notes[0]!;
    expect(formatted.revision).toBeGreaterThan(assessed.revision);
    expect(formatted.mathRevision).toBe(assessed.mathRevision);
    expect(formatted.checks).toEqual(assessed.checks);
    expect(stagePending(formatted, "correctness")).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test("caller and Explorer cosmetic edits preserve import trust, but support changes revoke it", async () => {
  const owner = await fixture();
  try {
    await owner.root.commit(
      (tx) =>
        publishCommand(tx, owner.root.id, {
          kind: "submit",
          id: "grant",
          candidate: false,
          notes: [{ id: "n1", ...content("Caller theorem"), support: [] }],
        }),
      context,
    );
    await owner.run({
      kind: "verification",
      checks: (await owner.view()).notes.map((note) => checked(note)),
    });
    const original = (await owner.view()).notes[0]!;
    for (const actor of ["caller", "explorer"]) {
      const before = (await owner.view()).notes[0]!;
      const edit = {
        id: before.id,
        revision: before.revision,
        text: `${before.text}\n`,
        cosmetic: true,
      };
      if (actor === "caller") {
        await owner.root.commit(
          (tx) =>
            publishCommand(tx, owner.root.id, {
              ...edit,
              summary: before.summary,
              detailedSummary: before.detailedSummary,
              kind: "correct",
              id: "format",
              note: before.id,
            }),
          context,
        );
      } else {
        expect(
          (
            await owner.run({
              kind: "notes",
              candidate: false,
              notes: [],
              edits: [edit],
            })
          ).status,
        ).toBe("completed");
      }
      const after = (await owner.view()).notes[0]!;
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.mathRevision).toBe(original.mathRevision);
      expect(after.checks).toEqual(original.checks);
      expect(after.imported).toBe(true);
      expect(after.verified).toBe(true);
    }
    const before = (await owner.view()).notes[0]!;
    expect(
      (
        await owner.run({
          kind: "notes",
          candidate: false,
          notes: [{ id: "n2", ...content("New dependency"), support: [] }],
          edits: [
            {
              id: before.id,
              revision: before.revision,
              support: ["n2"],
              cosmetic: true,
            },
          ],
        })
      ).status,
    ).toBe("completed");
    const after = (await owner.view()).notes[0]!;
    expect(after.mathRevision).toBeGreaterThan(original.mathRevision!);
    expect(after.checks).toEqual({});
    expect(after.imported).toBe(false);
    expect(after.verified).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test("caller corrections preserve import trust; Explorer edits revoke it and cycles publish nothing", async () => {
  const owner = await fixture();
  try {
    await owner.root.commit(
      (tx) =>
        publishCommand(tx, owner.root.id, {
          kind: "submit",
          id: "grant",
          candidate: true,
          notes: [{ id: "n1", ...content("Caller theorem"), support: [] }],
        }),
      context,
    );
    const imported = (await owner.view()).notes[0]!;
    expect(imported.imported).toBe(true);
    await owner.root.commit(
      (tx) =>
        publishCommand(tx, owner.root.id, {
          kind: "correct",
          id: "change",
          note: imported.id,
          revision: imported.revision,
          ...content("Revised theorem"),
        }),
      context,
    );
    const revised = (await owner.view()).notes[0]!;
    expect(revised.imported).toBe(true);
    expect(revised.checks).toEqual({});
    const before = await owner.view();
    const outcome = await owner.run({
      kind: "notes",
      candidate: false,
      notes: [
        { id: "n1", ...content("New dependency"), support: [revised.id] },
      ],
      edits: [{ id: revised.id, revision: revised.revision, support: ["n1"] }],
    });
    expect(outcome.status).toBe("faulted");
    expect(await owner.view()).toEqual(before);
    expect(revised.checks.source).toBeUndefined();
    expect(
      (
        await owner.run({
          kind: "notes",
          candidate: false,
          notes: [],
          edits: [
            {
              id: revised.id,
              revision: revised.revision,
              text: "Explorer proof",
            },
          ],
        })
      ).status,
    ).toBe("completed");
    expect((await owner.view()).notes[0]!.imported).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test.each([false, true])(
  "changed support cannot bind old later-stage checks to a new claim (uncertain=%s)",
  async (uncertain) => {
    const owner = await fixture();
    try {
      const [base, consumer] = await seed(owner);
      await owner.run({
        kind: "notes",
        notes: [],
        candidate: false,
        edits: [
          {
            id: base!.id,
            revision: base!.revision,
            text: "Different supporting theorem",
          },
        ],
      });
      const notes = (await owner.view()).notes;
      expect(
        (
          await owner.run({
            kind: "verification",
            checks: [
              checked(notes[0]!, "Different supporting theorem"),
              {
                noteId: consumer!.id,
                source: pass,
                requirements: pass,
                reconstruction: {
                  ...pass,
                  proof: "Proof of the old consumer statement",
                },
                ...(uncertain
                  ? {
                      correctness: {
                        verdict: "INCONCLUSIVE" as const,
                        report: "Unresolved",
                        statement: consumer!.id,
                        premises: [],
                      },
                    }
                  : {}),
              },
            ],
          })
        ).status,
      ).toBe("completed");
      let current = (await owner.view()).notes[1]!;
      expect(current.checks.correctness?.verdict).toBe(
        uncertain ? "INCONCLUSIVE" : undefined,
      );
      expect(current.checks.source).toBeUndefined();
      expect(current.checks.requirements).toBeUndefined();
      expect(current.checks.reconstruction).toBeUndefined();
      expect(
        (
          await owner.run({
            kind: "verification",
            checks: [
              {
                noteId: consumer!.id,
                correctness: {
                  ...pass,
                  statement: "A different consumer statement",
                  premises: [],
                },
                source: pass,
              },
            ],
          })
        ).status,
      ).toBe("completed");
      current = (await owner.view()).notes[1]!;
      expect(current.verified).toBe(true);
      expect(current.accepted).toBe(false);
    } finally {
      await owner.harness.close(context);
    }
  },
);

test("retirement hides direct work while existing consumers can finish verification", async () => {
  const owner = await fixture();
  try {
    await owner.run({
      kind: "notes",
      candidate: true,
      notes: [
        { id: "n1", ...content("Supporting lemma"), support: [] },
        { id: "n2", ...content("Candidate"), support: ["n1"] },
      ],
    });
    const [base, consumer] = (await owner.view()).notes;
    await owner.run({
      kind: "verification",
      checks: [base!, consumer!].map((note) => ({
        noteId: note.id,
        correctness: { ...pass, statement: note.id, premises: [] },
        source: pass,
      })),
    });
    await owner.run({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        {
          id: base!.id,
          revision: (await owner.view()).notes[0]!.revision,
          retired: true,
        },
      ],
    });
    await owner.run({
      kind: "verification",
      checks: [{ noteId: consumer!.id, requirements: pass }],
    });
    const notes = (await owner.view()).notes;
    expect(() =>
      validatePlan(
        {
          work: {
            kind: "verifier",
            notes: [base!.id],
            through: "reconstruction",
          },
        },
        notes,
        { explorer: true, literature: false, codex: false },
      ),
    ).toThrow("Retired note");
    expect(
      pendingChecks(
        [consumer!.id],
        "reconstruction",
        notes,
      )("reconstruction").map((note) => note.id),
    ).toEqual([base!.id, consumer!.id]);
    expect(
      (
        await owner.run({
          kind: "verification",
          checks: [base!, consumer!].map((note) => ({
            noteId: note.id,
            reconstruction: {
              ...pass,
              proof: `Independent proof of ${note.id}`,
            },
          })),
        })
      ).status,
    ).toBe("completed");
    expect((await owner.view()).notes[1]!.accepted).toBe(true);
  } finally {
    await owner.harness.close(context);
  }
});

test("a coherent changed-claim batch installs its newly checked consumers after invalidation", async () => {
  const owner = await fixture();
  try {
    const [base] = await seed(owner);
    await owner.run({
      kind: "notes",
      notes: [],
      candidate: false,
      edits: [
        { id: base!.id, revision: base!.revision, text: "Repaired claim" },
      ],
    });
    const before = (await owner.view()).notes;
    expect(
      (
        await owner.run({
          kind: "verification",
          checks: [
            checked(before[0]!, "Repaired theorem"),
            checked(before[1]!),
          ],
        })
      ).status,
    ).toBe("completed");
    expect((await owner.view()).notes[1]!.accepted).toBe(true);
    const stable = await owner.view();
    expect(
      (
        await owner.run({
          kind: "verification",
          checks: [
            {
              noteId: base!.id,
              source: {
                ...pass,
                premises: ["A different premise"],
                passages: [],
                kind: "codex-report",
                operationId: "wrong",
                reportedAt: "now",
              },
            },
          ],
        })
      ).status,
    ).toBe("faulted");
    expect(await owner.view()).toEqual(stable);
  } finally {
    await owner.harness.close(context);
  }
});

test("an ignored inconclusive extraction cannot erase a consumer failure", async () => {
  const owner = await fixture();
  try {
    const [base, consumer] = await seed(owner);
    await owner.run({
      kind: "verification",
      checks: [
        {
          noteId: consumer!.id,
          correctness: {
            verdict: "FAIL",
            report: "Concrete gap in this unchanged proof",
            statement: consumer!.id,
            premises: [],
          },
        },
      ],
    });
    expect((await owner.view()).notes[1]!.checks.correctness?.verdict).toBe(
      "FAIL",
    );
    expect(
      (
        await owner.run({
          kind: "verification",
          checks: [
            {
              noteId: base!.id,
              correctness: {
                verdict: "INCONCLUSIVE",
                report: "Uncertain alternate extraction",
                statement: "A different claim",
                premises: [],
              },
            },
            checked(consumer!),
          ],
        })
      ).status,
    ).toBe("completed");
    const current = (await owner.view()).notes;
    expect(current[0]!.checks.correctness?.statement).toBe(base!.id);
    expect(current[1]!.checks.correctness?.verdict).toBe("FAIL");
    expect(current[1]!.accepted).toBe(false);
    expect(current[1]!.text).toBe(consumer!.text);
  } finally {
    await owner.harness.close(context);
  }
});

test("current stage checks retain dominant evidence and workers keep their result batches", async () => {
  const owner = await fixture();
  try {
    const [base] = await seed(owner);
    let expected = base!.checks;
    for (const [index, verdict] of (
      ["INCONCLUSIVE", "PASS", "FAIL", "INCONCLUSIVE", "PASS", "FAIL"] as const
    ).entries()) {
      const { noteId, ...incoming } = structuredClone(checked(base!));
      for (const check of Object.values(incoming))
        Object.assign(check, { verdict, report: `Assessment ${index}` });
      const result: SolverResult = {
        kind: "verification",
        checks: [{ noteId, ...incoming }],
      };
      expect(await owner.run(result)).toMatchObject({
        status: "completed",
        result,
      });
      if (index === 2) expected = incoming;
      expect((await owner.view()).notes[0]!.checks).toEqual(expected);
    }
  } finally {
    await owner.harness.close(context);
  }
});

test("unchecked note edits and explicit candidate edits do not manufacture evidence", async () => {
  const owner = await fixture();
  try {
    await owner.run({
      kind: "notes",
      candidate: false,
      notes: [{ id: "n1", ...content("Unchecked argument"), support: [] }],
    });
    const note = (await owner.view()).notes[0]!;
    expect(
      (
        await owner.run({
          kind: "notes",
          candidate: false,
          notes: [],
          edits: [
            {
              id: note.id,
              revision: note.revision,
              text: "New unchecked argument",
              candidate: true,
            },
          ],
        })
      ).status,
    ).toBe("completed");
    const edited = (await owner.view()).notes[0]!;
    expect(edited.candidate).toBe(true);
    expect(edited.accepted).toBe(false);
    expect(edited.checks).toEqual({});
    expect(
      (await owner.run({ kind: "notes", candidate: true, notes: [] })).status,
    ).toBe("faulted");
  } finally {
    await owner.harness.close(context);
  }
});

test("source approval cannot bind premises from an ignored correctness extraction", async () => {
  const owner = await fixture();
  try {
    await owner.run({
      kind: "notes",
      candidate: true,
      notes: [{ id: "n1", ...content("Argument under P"), support: [] }],
    });
    const note = (await owner.view()).notes[0]!;
    await owner.run({
      kind: "verification",
      checks: [
        {
          noteId: note.id,
          correctness: { ...pass, statement: "Claim", premises: ["P"] },
        },
      ],
    });
    const before = await owner.view();
    const result = await owner.run({
      kind: "verification",
      checks: [
        {
          ...checked(note),
          correctness: {
            verdict: "INCONCLUSIVE",
            report: "Alternate extraction",
            statement: "Claim",
            premises: ["Q"],
          },
          source: {
            ...pass,
            kind: "codex-report",
            operationId: "wrong-premise",
            reportedAt: "now",
            premises: ["Q"],
            passages: [
              {
                id: "q",
                premise: 0,
                statement: "Q",
                url: "https://example.org/q",
                quote: "Q",
              },
            ],
          },
        },
      ],
    });
    expect(result.status).toBe("faulted");
    expect(await owner.view()).toEqual(before);
    expect((await owner.view()).notes[0]!.accepted).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test.each([false, true])(
  "a valid final dependency graph is independent of edit order: %s",
  async (reverse) => {
    const owner = await fixture();
    try {
      const [base, consumer] = await seed(owner);
      const edits = [
        { id: base!.id, revision: base!.revision, support: [consumer!.id] },
        { id: consumer!.id, revision: consumer!.revision, support: [] },
      ];
      expect(
        (
          await owner.run({
            kind: "notes",
            candidate: false,
            notes: [],
            edits: reverse ? edits.reverse() : edits,
          })
        ).status,
      ).toBe("completed");
      const current = (await owner.view()).notes;
      expect(current[0]!.support).toEqual([consumer!.id]);
      expect(current[1]!.support).toEqual([]);
      expect(
        current.every((note) => Object.keys(note.checks).length === 0),
      ).toBe(true);
    } finally {
      await owner.harness.close(context);
    }
  },
);

test("new relevant quotations reopen source checks but fresh receipt IDs do not", async () => {
  const owner = await fixture();
  try {
    await owner.run({
      kind: "notes",
      candidate: true,
      notes: [{ id: "n1", ...content("Uses premise P"), support: [] }],
    });
    const target = (await owner.view()).notes[0]!;
    const uncertain = {
      verdict: "INCONCLUSIVE" as const,
      report: "Need a source for P",
    };
    await owner.run({
      kind: "verification",
      checks: [
        {
          noteId: target.id,
          correctness: { ...pass, statement: "Target", premises: ["P"] },
          source: uncertain,
        },
      ],
    });
    expect(stagePending((await owner.view()).notes[0]!, "source")).toBe(false);
    const addEvidence = async (premise: string, quote: string) => {
      await owner.run({
        kind: "notes",
        candidate: false,
        notes: [{ id: "n1", ...content("Source note"), support: [] }],
      });
      const note = (await owner.view()).notes.at(-1)!;
      await owner.run({
        kind: "verification",
        checks: [
          {
            noteId: note.id,
            correctness: { ...pass, statement: premise, premises: [premise] },
            source: {
              ...pass,
              kind: "codex-report",
              operationId: note.id,
              reportedAt: "now",
              premises: [premise],
              passages: [
                {
                  id: note.id,
                  premise: 0,
                  statement: premise,
                  url: "https://example.org/source",
                  quote,
                },
              ],
            },
          },
        ],
      });
    };
    await addEvidence("P", "P holds by the source theorem.");
    expect(stagePending((await owner.view()).notes[0]!, "source")).toBe(true);
    await owner.run({
      kind: "verification",
      checks: [
        {
          noteId: target.id,
          source: uncertain,
          correctness: {
            verdict: "INCONCLUSIVE",
            report: "Ignored alternate extraction",
            statement: "Target",
            premises: ["Q"],
          },
        },
      ],
    });
    expect(stagePending((await owner.view()).notes[0]!, "source")).toBe(false);
    const evidenceNote = (await owner.view()).notes.at(-1)!;
    await owner.run({
      kind: "notes",
      candidate: false,
      notes: [],
      edits: [
        {
          id: evidenceNote.id,
          revision: evidenceNote.revision,
          text: "Source note being repaired",
        },
      ],
    });
    expect(stagePending((await owner.view()).notes[0]!, "source")).toBe(false);
    await addEvidence("P", "P holds by the source theorem.");
    await addEvidence("Q", "An unrelated quotation.");
    expect(stagePending((await owner.view()).notes[0]!, "source")).toBe(false);
    await addEvidence(
      "P",
      "A new quotation establishing P with all hypotheses.",
    );
    expect(stagePending((await owner.view()).notes[0]!, "source")).toBe(true);
    expect((await owner.view()).notes[0]!.accepted).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test.each(["conflict", "batch", "identical", "replaced", "activated"])(
  "source receipt conflicts reject atomically in final evidence: %s",
  async (scenario) => {
    const owner = await fixture();
    try {
      await owner.run({
        kind: "notes",
        candidate: false,
        notes: [
          { id: "n1", ...content("First source"), support: [] },
          { id: "n2", ...content("Second source"), support: [] },
        ],
      });
      const [a, b] = (await owner.view()).notes;
      const check = (note: Note, quote: string): Check => ({
        noteId: note.id,
        correctness: { ...pass, statement: "P", premises: ["P"] },
        source: {
          ...pass,
          kind: "codex-report",
          operationId: note.id,
          reportedAt: "now",
          premises: ["P"],
          passages: [
            {
              id: "receipt",
              premise: 0,
              statement: "P",
              url: "https://example.org",
              quote,
            },
          ],
        },
      });
      if (scenario !== "batch")
        expect(
          (
            await owner.run({
              kind: "verification",
              checks: [check(a!, "first")],
            })
          ).status,
        ).toBe("completed");
      if (scenario === "activated") {
        const dormant = check(b!, "second");
        dormant.correctness!.verdict = "INCONCLUSIVE";
        expect(
          (await owner.run({ kind: "verification", checks: [dormant] })).status,
        ).toBe("completed");
      }
      const before = await owner.view();
      const checks: Check[] = [
        scenario === "activated"
          ? { noteId: b!.id, correctness: check(b!, "second").correctness }
          : check(b!, scenario === "identical" ? "first" : "second"),
      ];
      if (scenario === "batch") checks.unshift(check(a!, "first"));
      if (scenario === "replaced")
        checks.unshift({
          noteId: a!.id,
          source: { verdict: "FAIL", report: "Withdrawn source" },
        });
      const outcome = await owner.run({ kind: "verification", checks });
      const accepted = scenario === "identical" || scenario === "replaced";
      expect(outcome.status).toBe(accepted ? "completed" : "faulted");
      const after = await owner.view();
      if (accepted) expect(after.notes[1]!.verified).toBe(true);
      else {
        expect(outcome.error?.message).toContain("Conflicting source evidence");
        expect(after).toEqual(before);
      }
    } finally {
      await owner.harness.close(context);
    }
  },
);

test.each([false, true])(
  "source assessments remember their own returned quotations: shared=%s",
  async (shared) => {
    const owner = await fixture();
    try {
      await owner.run({
        kind: "notes",
        candidate: false,
        notes: [
          { id: "n1", ...content("Uses X"), support: [] },
          { id: "n2", ...content("Uses X and Y"), support: [] },
        ],
      });
      const [a, b] = (await owner.view()).notes;
      const passage = {
        id: "same-batch-X",
        premise: 0,
        statement: "X",
        url: "https://example.org",
        quote: "X is true",
      };
      const source = {
        ...pass,
        kind: "codex-report" as const,
        operationId: "batch",
        reportedAt: "now",
        premises: ["X"],
        passages: [passage],
      };
      expect(
        (
          await owner.run({
            kind: "verification",
            checks: [
              {
                noteId: a!.id,
                correctness: { ...pass, statement: "A", premises: ["X"] },
                source,
              },
              {
                noteId: b!.id,
                correctness: { ...pass, statement: "B", premises: ["X", "Y"] },
                source: {
                  ...source,
                  verdict: "INCONCLUSIVE",
                  report: "Y is missing",
                  premises: ["X", "Y"],
                  passages: shared ? [passage] : [],
                },
              },
            ],
          })
        ).status,
      ).toBe("completed");
      const current = (await owner.view()).notes[1]!;
      expect(current.sourceChanged).toBe(!shared);
      expect(stagePending(current, "source")).toBe(!shared);
      const at = await owner.marker();
      expect(stagePending((await owner.snapshot(at)).notes[1]!, "source")).toBe(
        !shared,
      );
    } finally {
      await owner.harness.close(context);
    }
  },
);
