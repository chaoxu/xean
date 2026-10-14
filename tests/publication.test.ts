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
import type { Exploration, Note } from "../src/core/math/contracts.ts";
import { readCommand } from "../src/core/math/commands.ts";
import { publicationResult } from "../src/core/math/results.ts";
import {
  Events,
  noteIdPrefix,
  publishCommand,
  publishExploration,
  readSnapshot,
  readView,
  seedNotebook,
} from "../src/core/math/state.ts";

const draft = (
  id: string,
  text: string,
  support: string[] = [],
): Exploration["notes"][number] => ({
  id,
  summary: text,
  detailedSummary: text,
  text,
  support,
});

async function fixture(seed: string[] = []) {
  const Worker = defineTask<Record<string, never>, { phase: "run" }, null>({
    name: "publication.fixture",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: { run: async () => {} },
    abort: async () => {},
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "publication.fixture", tasks: [Worker] }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    context,
  );
  const root = await harness.root(context);
  await root.commit(
    (tx) =>
      seedNotebook(
        tx,
        root.id,
        seed.map((id): Note => ({
          ...draft(id, `Supplied ${id}`),
          revision: 0,
          checks: {},
          candidate: false,
          retired: false,
          verified: false,
          accepted: false,
          dead: false,
        })),
      ),
    context,
  );
  const worker = await root.commit(
    (tx) => tx.createTask(Worker, {}, { ownership: { kind: "conversation" } }),
    context,
  );
  const view = () => root.commit((tx) => readView(tx, root.id), context);
  const observed = Object.fromEntries(
    (await view()).notes.map(({ id, revision }) => [id, revision]),
  );
  const publish = (value: Exploration) =>
    root.commit(
      (tx) => publishExploration(tx, root.id, worker, value, observed),
      context,
    );
  const publications = () =>
    root.commit(async (tx) => {
      const page = await tx.scanEntries({ conversationId: root.id }, 100);
      return page.items.filter(
        (entry) => Events.is(entry) && entry.data.type === "result",
      );
    }, context);
  return {
    harness,
    id: (name: string) => `${noteIdPrefix(worker)}${name}`,
    view,
    publish,
    snapshot: (at: number) =>
      readSnapshot(
        {
          snapshotAsOf: harness.snapshotAsOf.bind(harness),
          getTask: (id) => root.commit((tx) => tx.task(id), context),
          entry: (id) => root.commit((tx) => tx.entry(id), context),
        },
        root.id,
        at as EntryId,
        context,
      ),
    command: (value: unknown) =>
      root.commit(
        (tx) => publishCommand(tx, root.id, readCommand(value)),
        context,
      ),
    async reject(value: Exploration) {
      const before = await view();
      const committed = await publications();
      await expect(publish(value)).rejects.toThrow();
      expect(await view()).toEqual(before);
      expect(await publications()).toEqual(committed);
    },
  };
}

test("permanent note names and references survive publication, edits, and historical reads", async () => {
  const current = await fixture();
  try {
    const lemma = current.id("square-bound");
    const conclusion = current.id("consequence");
    const first = {
      notes: [
        draft(lemma, "For real n1, n1 squared is nonnegative."),
        draft(conclusion, `Apply ${lemma}; the symbol n1 is unchanged.`, [
          lemma,
        ]),
      ],
    };
    const receipt = await current.publish(first);
    expect(receipt.notes.map(({ id }) => id)).toEqual([lemma, conclusion]);
    const original = await current.view();
    expect(original.notes).toMatchObject(first.notes);
    const cutoff = receipt.notes[0]!.revision;
    const later = {
      notes: [
        draft(current.id("further-result"), `Use ${conclusion}.`, [conclusion]),
      ],
    };
    await current.publish(later);
    const edit = {
      notes: [],
      edits: [
        { ...receipt.notes[0]!, text: "Revised authoritative argument." },
      ],
    };
    const edited = await current.publish(edit);
    await current.publish({
      notes: [],
      edits: [{ ...edited.edits[0]!, retired: true }],
    });
    expect((await current.view()).notes[0]).toMatchObject({
      id: lemma,
      text: "Revised authoritative argument.",
      retired: true,
    });
    expect(await current.snapshot(cutoff)).toEqual(original);
    expect(publicationResult([first, later, edit])).toEqual({
      kind: "published",
      notes: [lemma, conclusion, current.id("further-result")],
      edits: [lemma],
    });
  } finally {
    await current.harness.close(context);
  }
});

test("duplicate, retired, and foreign note names reject whole mixed batches", async () => {
  const current = await fixture();
  try {
    const live = current.id("live");
    const retired = current.id("retired");
    const receipt = await current.publish({
      notes: [draft(live, "Keep this"), draft(retired, "Old approach")],
    });
    await current.publish({
      notes: [],
      edits: [{ ...receipt.notes[1]!, retired: true }],
    });
    for (const invalid of [
      draft(live, "Duplicate live note"),
      draft(retired, "Duplicate retired note"),
      draft("999999/foreign", "Wrong worker"),
      draft("input/other/foreign", "Caller namespace"),
      draft("short-name", "Missing namespace"),
      draft(current.id("retired-consumer"), "Uses retired support", [retired]),
    ])
      await current.reject({
        notes: [draft(current.id("must-not-leak"), "Must not leak"), invalid],
        edits: [{ ...receipt.notes[0]!, text: "Must not replace live text" }],
      });
    await current.reject({
      notes: [
        draft(current.id("same-name"), "First"),
        draft(current.id("same-name"), "Second"),
      ],
    });
  } finally {
    await current.harness.close(context);
  }
});

test("support and edits use exact IDs without translating short names", async () => {
  const current = await fixture(["n1"]);
  try {
    const lemma = current.id("lemma");
    const supplied = (await current.view()).notes[0]!;
    const first = await current.publish({
      notes: [draft(lemma, "Uses the supplied note n1.", ["n1"])],
    });
    await current.reject({
      notes: [draft(current.id("consumer"), "Missing exact ID", ["lemma"])],
    });
    await current.reject({
      notes: [],
      edits: [
        { id: "lemma", revision: first.notes[0]!.revision, text: "Wrong ID" },
      ],
    });
    await current.reject({
      notes: [
        draft(current.id("new-lemma"), "New lemma"),
        draft(current.id("new-consumer"), "No same-batch alias", ["new-lemma"]),
      ],
    });
    const corrected = {
      notes: [draft(current.id("consumer"), `Uses ${lemma}.`, [lemma])],
      edits: [
        { ...first.notes[0]!, text: "Edited own note." },
        {
          id: "n1",
          revision: supplied.revision,
          text: "Edited supplied note.",
        },
      ],
    };
    const receipt = await current.publish(corrected);
    expect(receipt.edits.map(({ id }) => id)).toEqual([lemma, "n1"]);
    expect((await current.view()).notes).toMatchObject([
      { id: "n1", text: "Edited supplied note." },
      { id: lemma, text: "Edited own note.", support: ["n1"] },
      { id: current.id("consumer"), support: [lemma] },
    ]);
  } finally {
    await current.harness.close(context);
  }
});

test("caller permanent names preserve exact references and request replay", async () => {
  const current = await fixture(["n1"]);
  try {
    const before = await current.view();
    for (const id of [
      "bare",
      "input/other/wrong-request",
      current.id("wrong-owner"),
    ]) {
      await expect(
        current.command({
          kind: "submit",
          id: "first",
          notes: [
            draft("input/first/valid", "Must not leak"),
            draft(id, "Invalid"),
          ],
        }),
      ).rejects.toThrow();
      expect(await current.view()).toEqual(before);
    }
    const first = {
      kind: "submit",
      id: "first",
      notes: [
        draft("input/first/lemma", "First result", ["n1"]),
        draft("input/first/consequence", "Uses input/first/lemma.", [
          "input/first/lemma",
        ]),
      ],
    };
    const receipt = await current.command(first);
    await current.command({
      kind: "submit",
      id: "second",
      notes: [
        draft("input/second/lemma", "Second result", ["input/first/lemma"]),
      ],
    });
    expect(await current.command(first)).toEqual({
      ...receipt,
      created: false,
    });
    const published = await current.view();
    expect(published.notes.map(({ id, support }) => ({ id, support }))).toEqual(
      [
        { id: "n1", support: [] },
        { id: "input/first/lemma", support: ["n1"] },
        { id: "input/first/consequence", support: ["input/first/lemma"] },
        { id: "input/second/lemma", support: ["input/first/lemma"] },
      ],
    );
    await expect(
      current.command({
        ...first,
        notes: [draft("input/first/lemma", "Changed replay")],
      }),
    ).rejects.toThrow("Input ID already has another value");
    expect(await current.view()).toEqual(published);
  } finally {
    await current.harness.close(context);
  }
});
