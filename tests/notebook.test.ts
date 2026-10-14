import { expect, test } from "bun:test";
import { temporaryDirectory } from "./directory.ts";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { readCommand } from "../src/core/math/commands.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type EntryId,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import {
  noteIdPrefix,
  publishCommand,
  publishResult,
  readSnapshot,
  readView,
  type MathView,
  type SnapshotReader,
} from "../src/core/math/state.ts";
import {
  pendingChecks,
  stagePending,
  validatePlan,
} from "../src/core/math/notes.ts";
import type { Check, Note, SolverResult } from "../src/core/math/contracts.ts";

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
type FixtureResult = SolverResult | ((prefix: string) => SolverResult);
async function fixture(storage: Storage = new MemoryStorage()) {
  const builders = new Map<TaskId, (prefix: string) => SolverResult>();
  const Worker = defineTask<
    { value: SolverResult | null; frozen: MathView },
    { phase: "run" },
    SolverResult
  >({
    name: "notebook.fixture",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, ctx) {
        const value =
          task.input.value ?? builders.get(task.id)!(noteIdPrefix(task.id));
        await runtime.commit(async (tx) => {
          await publishResult(
            tx,
            task.conversationId,
            value,
            task.id,
            task.input.frozen,
          );
          return {
            status: "terminal",
            outcome: { status: "completed", result: value },
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
    storage,
    { registry, models: createModels(), settings: { documentRetentionMs: 0 } },
    context,
  );
  const root = await harness.root(context);
  const reader: SnapshotReader = {
    snapshotAsOf: harness.snapshotAsOf.bind(harness),
    getTask: (id) => root.commit((tx) => tx.task(id), context),
    entry: (id) => root.commit((tx) => tx.entry(id), context),
  };
  const view = () => root.commit((tx) => readView(tx, root.id), context);
  const run = async (value: FixtureResult, prior?: MathView) => {
    const frozen = prior ?? (await view());
    const id = await root.commit(async (tx) => {
      const id = await tx.createTask(
        Worker,
        { value: typeof value === "function" ? null : value, frozen },
        { ownership: { kind: "conversation" } },
      );
      if (typeof value === "function") builders.set(id, value);
      return id;
    }, context);
    return (await harness.waitForTask(id, context)).state.outcome;
  };
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
    run,
    async publish(value: FixtureResult, prior?: MathView) {
      const outcome = await run(value, prior);
      if (outcome.status !== "completed")
        throw new Error(JSON.stringify(outcome));
    },
    command: (value: unknown) =>
      root.commit(
        (tx) => publishCommand(tx, root.id, readCommand(value)),
        context,
      ),
  };
}
async function seed(owner: Awaited<ReturnType<typeof fixture>>) {
  await owner.publish((prefix) => ({
    kind: "notes",
    notes: [
      { id: prefix + "n1", ...content("Lemma proof"), support: [] },
      {
        id: prefix + "n2",
        ...content("Consumer proof"),
        support: [prefix + "n1"],
        candidate: true,
      },
    ],
  }));
  const notes = (await owner.view()).notes;
  await owner.publish({
    kind: "verification",
    checks: notes.map((note) => checked(note)),
  });
  return (await owner.view()).notes;
}

test("note-only snapshots retain evidence without replaying caller inputs", async () => {
  const owner = await fixture();
  try {
    await seed(owner);
    await owner.command({
      kind: "guide",
      id: "hint",
      text: "Review the proof",
    });
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

test("proof repairs invalidate only their dependency chain and retain stable note identities", async () => {
  const owner = await fixture();
  try {
    const [base, consumer] = await seed(owner);
    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [
        { id: prefix + "n1", ...content("Unrelated lemma"), support: [] },
      ],
    }));
    const independent = (await owner.view()).notes[2]!;
    await owner.publish({
      kind: "verification",
      checks: [checked(independent)],
    });
    const at = await owner.marker();
    const old = await owner.snapshot(at);
    expect(consumer!.accepted).toBe(true);

    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        { id: base!.id, revision: base!.revision, summary: "Clearer summary" },
      ],
    });
    const summarized = (await owner.view()).notes[0]!;
    expect(summarized.revision).toBeGreaterThan(base!.revision);
    expect(summarized.checks).toEqual({});
    expect((await owner.view()).notes[1]!.accepted).toBe(false);
    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        {
          id: base!.id,
          revision: summarized.revision,
          text: "A repaired proof of the same lemma",
        },
      ],
    });
    const edited = (await owner.view()).notes;
    expect(edited.map((note) => note.id)).toEqual(
      old.notes.map((note) => note.id),
    );
    expect(edited[0]!.checks).toEqual({});
    expect(edited[1]).toMatchObject({
      checks: {},
      accepted: false,
      text: consumer!.text,
      support: [base!.id],
    });
    expect(edited[2]).toEqual(old.notes[2]);
    await owner.publish({
      kind: "verification",
      checks: [checked(edited[0]!, base!.id)],
    });
    expect((await owner.view()).notes[1]).toMatchObject({
      accepted: false,
      checks: {},
    });
    const currentConsumer = (await owner.view()).notes[1]!;
    await owner.publish({
      kind: "verification",
      checks: [checked(currentConsumer)],
    });
    expect((await owner.view()).notes[1]!.accepted).toBe(true);

    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [
        { id: prefix + "n1", ...content("Replacement lemma"), support: [] },
      ],
      edits: [
        {
          id: consumer!.id,
          revision: currentConsumer.revision,
          support: [prefix + "n1"],
        },
      ],
    }));
    const repaired = (await owner.view()).notes;
    expect(repaired[1]).toMatchObject({
      id: consumer!.id,
      support: [repaired[3]!.id],
      checks: {},
      accepted: false,
    });
    expect(await owner.snapshot(at)).toEqual(old);
  } finally {
    await owner.harness.close(context);
  }
});

test("operator recheck withdraws evidence atomically without editing notes or accepting stale work", async () => {
  const owner = await fixture();
  try {
    const [base, consumer] = await seed(owner);
    await owner.command({
      kind: "submit",
      id: "grants",
      notes: [
        { id: "input/grants/n1", ...content("Imported theorem"), support: [] },
        { id: "input/grants/n2", ...content("Unrelated theorem"), support: [] },
      ],
    });
    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [
        {
          id: prefix + "n1",
          ...content("Transitive consumer"),
          support: [consumer!.id],
        },
      ],
    }));
    await owner.publish({
      kind: "verification",
      checks: (await owner.view()).notes.slice(2).map((note) => checked(note)),
    });
    const before = await owner.view();
    const at = await owner.marker();
    const imported = before.notes[2]!;
    const unrelated = before.notes[3]!;
    const command = {
      kind: "recheck" as const,
      id: "unsupported-pass",
      notes: [base!, imported].map(({ id, revision }) => ({ id, revision })),
      reason: "The verifier relied on an unsupported trust assumption.",
    };
    for (const invalid of [
      { ...command, reason: " " },
      { ...command, notes: [] },
      { ...command, notes: [...command.notes, command.notes[0]] },
      { ...command, notes: [...command.notes, { id: "missing", revision: 0 }] },
      {
        ...command,
        notes: [...command.notes, { id: consumer!.id, revision: 0 }],
      },
    ]) {
      await expect(owner.command(invalid)).rejects.toThrow();
      expect(await owner.view()).toEqual(before);
    }
    const receipt = await owner.command(command);
    const after = await owner.view();
    for (const old of before.notes) {
      const note = after.notes.find((note) => note.id === old.id)!;
      const { sourceChanged: _sourceChanged, ...prior } = old;
      expect(note).toEqual(
        old.id === unrelated.id
          ? old
          : {
              ...prior,
              revision: old.id === unrelated.id ? old.revision : receipt.entry,
              checks: {},
              verified: false,
              accepted: false,
            },
      );
    }
    expect(after.inputs.at(-1)).toEqual({ id: receipt.entry, command });
    expect(await owner.snapshot(at)).toEqual(before);
    expect((await owner.command(command)).entry).toBe(receipt.entry);
    await expect(
      owner.command({ ...command, reason: "Different reason" }),
    ).rejects.toThrow("Input ID already");
    await expect(owner.command({ ...command, id: "stale" })).rejects.toThrow(
      "Stale note revision",
    );
    for (const result of [
      { kind: "verification", checks: [checked(base!)] },
      (prefix: string) => ({
        kind: "notes",
        notes: [
          {
            id: prefix + "n1",
            ...content("Stale derived result"),
            support: [consumer!.id],
          },
        ],
      }),
    ] satisfies FixtureResult[]) {
      const outcome = await owner.run(result, before);
      expect(outcome.status).toBe("faulted");
      expect(JSON.stringify(outcome)).toContain("Stale mathematical input");
    }
    expect(await owner.view()).toEqual(after);
    await owner.publish({
      kind: "verification",
      checks: after.notes
        .filter((note) => note.id !== unrelated.id)
        .map((note) => checked(note)),
    });
    const reassessed = await owner.view();
    expect(reassessed.notes.every((note) => note.verified)).toBe(true);
    await owner.command(command);
    expect(await owner.view()).toEqual(reassessed);
  } finally {
    await owner.harness.close(context);
  }
});

test("changed edits reopen checks and stale publications fail atomically", async () => {
  const owner = await fixture();
  try {
    const [base] = await seed(owner);
    const frozen = await owner.view();
    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        {
          id: base!.id,
          revision: base!.revision,
          summary: "A clearer summary",
          text: "Changed proof",
        },
      ],
    });
    const changed = (await owner.view()).notes[0]!;
    expect(changed.revision).toBeGreaterThan(base!.revision);
    expect(changed.checks).toEqual({});
    expect(changed.accepted).toBe(false);
    const afterEdit = await owner.view();
    const stale = await owner.run(
      { kind: "verification", checks: [checked(base!)] },
      frozen,
    );
    expect(stale.status).toBe("faulted");
    expect(await owner.view()).toEqual(afterEdit);
    const assessed = (await owner.view()).notes[0]!;
    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        {
          id: assessed.id,
          revision: assessed.revision,
          text: assessed.text,
        },
      ],
    });
    const unchanged = (await owner.view()).notes[0]!;
    expect(unchanged.revision).toBe(assessed.revision);
    expect(unchanged.checks).toEqual({});
  } finally {
    await owner.harness.close(context);
  }
});

test("all changed imported edits revoke trust and checks", async () => {
  const owner = await fixture();
  try {
    await owner.command({
      kind: "submit",
      id: "grant",
      notes: [
        { id: "input/grant/n1", ...content("Caller theorem"), support: [] },
      ],
    });
    await owner.publish({
      kind: "verification",
      checks: (await owner.view()).notes.map((note) => checked(note)),
    });
    for (const actor of ["caller", "explorer"]) {
      const before = (await owner.view()).notes[0]!;
      const edit = {
        id: before.id,
        revision: before.revision,
        text: `${before.text}\n`,
      };
      if (actor === "caller") {
        await owner.command({
          kind: "submit",
          id: "format",
          notes: [],
          edits: [edit],
        });
      } else {
        await owner.publish({
          kind: "notes",
          notes: [],
          edits: [edit],
        });
      }
      const after = (await owner.view()).notes[0]!;
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.checks).toEqual(
        actor === "caller" ? { external: { entry: after.revision } } : {},
      );
      expect(after.verified).toBe(actor === "caller");
    }
    const before = (await owner.view()).notes[0]!;
    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [{ id: prefix + "n2", ...content("New dependency"), support: [] }],
      edits: [
        {
          id: before.id,
          revision: before.revision,
          support: [prefix + "n2"],
        },
      ],
    }));
    const after = (await owner.view()).notes[0]!;
    expect(after.checks).toEqual({});
    expect(after.verified).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test("caller notes carry individual trust and untrusted claims require source checks", async () => {
  const owner = await fixture();
  try {
    const command = {
      kind: "submit" as const,
      id: "mixed",
      notes: [false, true, undefined].map((trusted, index) => ({
        id: `input/mixed/n${index + 1}`,
        ...content("Claim under P"),
        support: [],
        ...(trusted === undefined ? {} : { trusted }),
      })),
    };
    const receipt = await owner.command(command);
    expect(await owner.command(command)).toEqual({
      ...receipt,
      created: false,
    });
    await expect(
      owner.command({
        ...command,
        notes: command.notes.map((note) => ({ ...note, trusted: true })),
      }),
    ).rejects.toThrow("Input ID already has another value");
    const initial = await owner.view();
    expect(initial.inputs[0]!.command).toEqual(command);
    expect(initial.notes.map((n) => !!n.checks.external)).toEqual([
      false,
      true,
      true,
    ]);
    await owner.publish({
      kind: "verification",
      checks: [
        {
          noteId: initial.notes[0]!.id,
          correctness: { ...pass, statement: "Claim under P", premises: ["P"] },
        },
      ],
    });
    const assessed = (await owner.view()).notes;
    expect(assessed.map((note) => note.verified)).toEqual([false, true, true]);
    expect(stagePending(assessed[0]!, "source")).toBe(true);
    await owner.publish({
      kind: "verification",
      checks: [{ noteId: assessed[0]!.id, source: pass }],
    });
    expect((await owner.view()).notes[0]!.verified).toBe(true);
  } finally {
    await owner.harness.close(context);
  }
});

test("caller trust edits invalidate the note and its consumers", async () => {
  const owner = await fixture();
  try {
    await seed(owner);
    for (const trusted of [true, false]) {
      const before = (await owner.view()).notes;
      const command = {
        kind: "submit" as const,
        id: `trust-${trusted}`,
        notes: [],
        edits: [{ id: before[0]!.id, revision: before[0]!.revision, trusted }],
      };
      const receipt = await owner.command(command);
      const changed = (await owner.view()).notes;
      expect(changed.map((note) => note.checks)).toEqual([
        trusted ? { external: { entry: receipt.entry } } : {},
        {},
      ]);
      expect(changed.map((note) => note.text)).toEqual(
        before.map((note) => note.text),
      );
      expect(
        changed.every((note, i) => note.revision > before[i]!.revision),
      ).toBe(true);
      expect(await owner.command(command)).toEqual({
        ...receipt,
        created: false,
      });
      await owner.publish({
        kind: "verification",
        checks: changed.map((note) => checked(note)),
      });
      const assessed = (await owner.view()).notes;
      await owner.command({
        ...command,
        id: `same-${trusted}`,
        edits: [{ ...command.edits[0]!, revision: assessed[0]!.revision }],
      });
      expect((await owner.view()).notes).toEqual(assessed);
    }
  } finally {
    await owner.harness.close(context);
  }
});

test("caller mathematical edits preserve external grants; Explorer edits revoke them", async () => {
  const owner = await fixture();
  try {
    await owner.command({
      kind: "submit",
      id: "grant",
      notes: [
        {
          id: "input/grant/n1",
          ...content("Caller theorem"),
          support: [],
          candidate: true,
        },
      ],
    });
    const imported = (await owner.view()).notes[0]!;
    expect(!!imported.checks.external).toBe(true);
    await owner.command({
      kind: "submit",
      id: "change",
      notes: [],
      edits: [
        {
          id: imported.id,
          revision: imported.revision,
          ...content("Revised theorem"),
        },
      ],
    });
    const revised = (await owner.view()).notes[0]!;
    expect(revised.checks).toEqual({ external: { entry: revised.revision } });
    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        {
          id: revised.id,
          revision: revised.revision,
          text: "Explorer proof",
        },
      ],
    });
    expect(!!(await owner.view()).notes[0]!.checks.external).toBe(false);
  } finally {
    await owner.harness.close(context);
  }
});

test("stale and cyclic create-and-edit batches publish nothing", async () => {
  const owner = await fixture();
  try {
    await owner.command({
      kind: "submit",
      id: "grant",
      notes: [
        { id: "input/grant/n1", ...content("Imported lemma"), support: [] },
        {
          id: "input/grant/n2",
          ...content("Consumer"),
          support: ["input/grant/n1"],
        },
      ],
    });
    const [base, consumer] = (await owner.view()).notes;
    await owner.publish({
      kind: "verification",
      checks: [checked(base!), checked(consumer!)],
    });
    const before = await owner.view();
    for (const { support, edit, error } of [
      {
        support: [],
        edit: () => ({ revision: base!.revision + 1, summary: "Stale" }),
        error: "Stale note revision",
      },
      {
        support: [],
        edit: () => ({ revision: base!.revision, support: [consumer!.id] }),
        error: "Cyclic support",
      },
      {
        support: [base!.id],
        edit: (prefix: string) => ({
          revision: base!.revision,
          support: [prefix + "n1"],
        }),
        error: "Cyclic support",
      },
    ]) {
      const outcome = await owner.run((prefix) => ({
        kind: "notes",
        notes: [{ id: prefix + "n1", ...content("Must not leak"), support }],
        edits: [{ id: base!.id, ...edit(prefix) }],
      }));
      expect(outcome).toMatchObject({
        status: "faulted",
        error: { message: expect.stringContaining(error) },
      });
      expect(await owner.view()).toEqual(before);
    }
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
      await owner.publish({
        kind: "notes",
        notes: [],
        edits: [
          {
            id: base!.id,
            revision: base!.revision,
            text: "Different supporting theorem",
          },
        ],
      });
      const notes = (await owner.view()).notes;
      await owner.publish({
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
      });
      let current = (await owner.view()).notes[1]!;
      expect(current.checks.correctness?.verdict).toBe(
        uncertain ? "INCONCLUSIVE" : undefined,
      );
      expect(current.checks.source).toBeUndefined();
      expect(current.checks.requirements).toBeUndefined();
      expect(current.checks.reconstruction).toBeUndefined();
      await owner.publish({
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
      });
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
    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [
        { id: prefix + "n1", ...content("Supporting lemma"), support: [] },
        {
          id: prefix + "n2",
          ...content("Candidate"),
          support: [prefix + "n1"],
          candidate: true,
        },
      ],
    }));
    const [base, consumer] = (await owner.view()).notes;
    await owner.publish({
      kind: "verification",
      checks: [base!, consumer!].map((note) => ({
        noteId: note.id,
        correctness: { ...pass, statement: note.id, premises: [] },
        source: pass,
      })),
    });
    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        {
          id: base!.id,
          revision: (await owner.view()).notes[0]!.revision,
          retired: true,
        },
      ],
    });
    await owner.publish({
      kind: "verification",
      checks: [{ noteId: consumer!.id, requirements: pass }],
    });
    const notes = (await owner.view()).notes;
    expect(notes[0]).toMatchObject({
      id: base!.id,
      text: base!.text,
      retired: true,
      dead: false,
    });
    expect(stagePending(notes[0]!, "reconstruction")).toBe(true);
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
        { literature: false, implementation: false },
      ),
    ).toThrow("Retired note");
    expect(
      pendingChecks(
        [consumer!.id],
        "reconstruction",
        notes,
      )("reconstruction").map((note) => note.id),
    ).toEqual([base!.id, consumer!.id]);
    await owner.publish({
      kind: "verification",
      checks: [base!, consumer!].map((note) => ({
        noteId: note.id,
        reconstruction: {
          ...pass,
          proof: `Independent proof of ${note.id}`,
        },
      })),
    });
    expect((await owner.view()).notes[1]!.accepted).toBe(true);
  } finally {
    await owner.harness.close(context);
  }
});

test("a coherent changed-claim batch installs its newly checked consumers after invalidation", async () => {
  const owner = await fixture();
  try {
    const [base] = await seed(owner);
    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        { id: base!.id, revision: base!.revision, text: "Repaired claim" },
      ],
    });
    const before = (await owner.view()).notes;
    await owner.publish({
      kind: "verification",
      checks: [checked(before[0]!, "Repaired theorem"), checked(before[1]!)],
    });
    expect((await owner.view()).notes[1]!.accepted).toBe(true);
    const stable = await owner.view();
    const rejected = await owner.run({
      kind: "verification",
      checks: [
        {
          noteId: base!.id,
          source: {
            ...pass,
            premises: ["A different premise"],
            passages: [],
            kind: "external-report",
            operationId: "wrong",
            reportedAt: "now",
          },
        },
      ],
    });
    expect(rejected.status).toBe("faulted");
    expect(await owner.view()).toEqual(stable);
  } finally {
    await owner.harness.close(context);
  }
});

test("an ignored inconclusive extraction cannot erase a consumer failure", async () => {
  const owner = await fixture();
  try {
    const [base, consumer] = await seed(owner);
    await owner.publish({
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
    await owner.publish({
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
    });
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

test("publishing candidate and retirement flags does not grant evidence", async () => {
  const owner = await fixture();
  try {
    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [
        {
          id: prefix + "n1",
          ...content("Candidate"),
          support: [],
          candidate: true,
        },
        {
          id: prefix + "n2",
          ...content("Observation"),
          support: [],
          candidate: false,
        },
        {
          id: prefix + "n3",
          ...content("Retired observation"),
          support: [],
          retired: true,
        },
      ],
    }));
    const notes = (await owner.view()).notes;
    expect(notes.map((note) => note.candidate)).toEqual([true, false, false]);
    expect(notes.map((note) => note.retired)).toEqual([false, false, true]);
    for (const note of notes) {
      expect(note.checks).toEqual({});
      expect(note.verified).toBe(false);
      expect(note.accepted).toBe(false);
    }
    const observation = notes[1]!;
    await owner.publish({
      kind: "notes",
      notes: [],
      edits: [
        {
          id: observation.id,
          revision: observation.revision,
          text: "New unchecked argument",
          candidate: true,
        },
      ],
    });
    expect((await owner.view()).notes[1]).toMatchObject({
      candidate: true,
      accepted: false,
      verified: false,
      checks: {},
    });
  } finally {
    await owner.harness.close(context);
  }
});

test("source approval cannot bind premises from an ignored correctness extraction", async () => {
  const owner = await fixture();
  try {
    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [
        {
          id: prefix + "n1",
          ...content("Argument under P"),
          support: [],
          candidate: true,
        },
      ],
    }));
    const note = (await owner.view()).notes[0]!;
    await owner.publish({
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
            kind: "external-report",
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
      await owner.publish({
        kind: "notes",
        notes: [],
        edits: reverse ? edits.reverse() : edits,
      });
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
    await owner.publish((prefix) => ({
      kind: "notes",
      notes: [
        {
          id: prefix + "n1",
          ...content("Uses premise P"),
          support: [],
          candidate: true,
        },
      ],
    }));
    const target = (await owner.view()).notes[0]!;
    const uncertain = {
      verdict: "INCONCLUSIVE" as const,
      report: "Need a source for P",
    };
    await owner.publish({
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
      await owner.publish((prefix) => ({
        kind: "notes",
        notes: [{ id: prefix + "n1", ...content("Source note"), support: [] }],
      }));
      const note = (await owner.view()).notes.at(-1)!;
      await owner.publish({
        kind: "verification",
        checks: [
          {
            noteId: note.id,
            correctness: { ...pass, statement: premise, premises: [premise] },
            source: {
              ...pass,
              kind: "external-report",
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
    await owner.publish({
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
    await owner.publish({
      kind: "notes",
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
      await owner.publish((prefix) => ({
        kind: "notes",
        notes: [
          { id: prefix + "n1", ...content("First source"), support: [] },
          { id: prefix + "n2", ...content("Second source"), support: [] },
        ],
      }));
      const [a, b] = (await owner.view()).notes;
      const check = (note: Note, quote: string): Check => ({
        noteId: note.id,
        correctness: { ...pass, statement: "P", premises: ["P"] },
        source: {
          ...pass,
          kind: "external-report",
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
        await owner.publish({
          kind: "verification",
          checks: [check(a!, "first")],
        });
      if (scenario === "activated") {
        const dormant = check(b!, "second");
        dormant.correctness!.verdict = "INCONCLUSIVE";
        await owner.publish({ kind: "verification", checks: [dormant] });
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
      await owner.publish((prefix) => ({
        kind: "notes",
        notes: [
          { id: prefix + "n1", ...content("Uses X"), support: [] },
          { id: prefix + "n2", ...content("Uses X and Y"), support: [] },
        ],
      }));
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
        kind: "external-report" as const,
        operationId: "batch",
        reportedAt: "now",
        premises: ["X"],
        passages: [passage],
      };
      await owner.publish({
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
      });
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

test("Pi snapshots survive reopen and stale verification cannot restore current checks or summaries", async () => {
  const directory = await temporaryDirectory("pi-notebook-");
  const start = async () =>
    fixture(
      await openNodeJsonlStorage(directory, context, {
        fsync: true,
      }),
    );
  let owner = await start();
  try {
    await owner.command({
      kind: "submit",
      id: "seed",
      notes: [
        {
          id: "input/seed/n1",
          ...content("Original"),
          support: [],
          candidate: true,
          trusted: false,
        },
      ],
    });
    const frozenAt = await owner.marker();
    const frozen = await owner.snapshot(frozenAt);
    await owner.command({
      kind: "submit",
      id: "edit",
      notes: [],
      edits: [
        {
          id: "input/seed/n1",
          revision: frozen.notes[0]!.revision,
          ...content("Revised"),
        },
      ],
    });
    const worker = await owner.run(
      {
        kind: "verification",
        checks: [
          {
            noteId: "input/seed/n1",
            correction: {
              revision: frozen.notes[0]!.revision,
              summary: "Stale summary",
            },
            correctness: { ...pass, statement: "Original", premises: [] },
            requirements: pass,
          },
        ],
      },
      frozen,
    );
    expect(worker).toMatchObject({
      status: "faulted",
      error: { message: expect.stringContaining("Stale mathematical input") },
    });
    // Cross the notebook catalog's 31-delta checkpoint before reopening.
    for (let index = 0; index < 32; index++)
      await owner.command({
        kind: "guide",
        id: `g-${index}`,
        text: `Guidance ${index}`,
      });
    const current = await owner.view();
    expect(current.notes[0]).toMatchObject({
      ...content("Revised"),
      checks: {},
      verified: false,
      accepted: false,
    });
    expect(current.notes[0]!.revision).toBeGreaterThan(
      frozen.notes[0]!.revision,
    );
    expect(current.guidance).toHaveLength(32);
    await owner.harness.close(context);
    owner = await start();
    expect(await owner.snapshot(frozenAt)).toEqual(frozen);
    expect(await owner.view()).toEqual(current);
  } finally {
    await owner.harness.close(context);
  }
});
