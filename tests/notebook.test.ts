import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Notebook as NoteStore, ConflictError } from "@chaoxu/notebook-store";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { inspect, open, solveSettings } from "../src/index.ts";
import {
  DefinitionDoc,
  Notebook,
  admitNotes,
  appendNotes,
  initializeNotebook,
  project,
  readNotebook,
  type StoredNote,
} from "../src/state.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import { acceptedArgument } from "../src/report.ts";
import { fauxModels } from "./faux-models.ts";
import { submitNotes } from "../src/inputs.ts";

const directories: string[] = [],
  handles: Harness[] = [];
const task = { problem: "Prove P.", completionCriteria: "Prove P." };
const profile = { provider: "test", model: "test", reasoning: "high" };
const settings = solveSettings.parse(
  Object.fromEntries(
    ["explorer", ...verifierNames].map((name) => [name, profile]),
  ),
);
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close(context);
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function path() {
  const directory = await mkdtemp(join(tmpdir(), "xean-notebook-"));
  directories.push(directory);
  return join(await realpath(directory), "campaign.sqlite");
}
async function fixture(file = "") {
  file ||= await path();
  const harness = await Harness.open(
    await openNodeSqliteStorage(file),
    {
      registry: createRegistry(),
      models: fauxModels().models,
    },
    context,
  );
  handles.push(harness);
  const root = await harness.root(context, {
    init: async (tx, id) => {
      Object.assign(await tx.doc(DefinitionDoc, id), { task, settings });
      await initializeNotebook(tx, id, `${file}.notes.sqlite`);
    },
  });
  const snapshot = () =>
    root.commit(
      async (tx) =>
        JSON.parse(
          JSON.stringify(readNotebook(await tx.doc(Notebook, root.id))),
        ),
      context,
    );
  const publish = (notes: StoredNote[], id: string, fail = false) =>
    root.commit(async (tx) => {
      const version = appendNotes(
        tx,
        await tx.doc(Notebook, root.id),
        notes,
        id,
      );
      if (fail) throw new Error("after external commit");
      return version;
    }, context);
  return { file, harness, root, snapshot, publish };
}

test("A rollback, B publication and A recovery retain both immutable batches in publication order", async () => {
  let f = await fixture();
  const a = [
    { id: "w100.1", text: "Exact original body names w100.1.\n", support: [] },
    { id: "w100.2", text: "Use w100.1 literally.", support: ["w100.1"] },
  ];
  const b = [{ id: "w2.1", text: "Independent B.", support: [] }];
  using store = new NoteStore(`${f.file}.notes.sqlite`);
  await expect(f.publish(a, "worker/100", true)).rejects.toThrow(
    "after external commit",
  );
  expect(store.snapshot()).toBe(1);
  expect((await f.snapshot()).notes).toEqual([]);
  expect(await f.publish(b, "worker/2")).toBe(2);
  store.commit(
    2,
    { "w100.1": { ...a[0]!, text: "Outside replacement." }, "w100.2": null },
    "outside",
  );
  await f.harness.close(context);
  f = await fixture(f.file);
  expect(await f.publish(a, "worker/100")).toBe(1);
  expect(store.snapshot()).toBe(3);
  expect((await f.snapshot()).notes).toEqual([...a, ...b]);
  const pins = (await f.harness.snapshot(Notebook, f.root.id, context))!
    .publications;
  expect(pins).toEqual([
    { id: "worker/2", version: 2, notes: ["w2.1"] },
    { id: "worker/100", version: 1, notes: ["w100.1", "w100.2"] },
  ]);
  expect(await f.publish(a, "worker/100")).toBe(1);
  expect(
    (await f.harness.snapshot(Notebook, f.root.id, context))!.publications,
  ).toEqual(pins);
  await expect(
    f.publish([{ ...a[0]!, text: "Changed retry." }, a[1]!], "worker/100"),
  ).rejects.toBeInstanceOf(ConflictError);
  await expect(f.publish(a, "different-publication")).rejects.toBeInstanceOf(
    ConflictError,
  );
  await expect(f.publish([...a].reverse(), "worker/100")).rejects.toThrow(
    "different note order",
  );
  const c = [
    { id: "w1.1", text: "Build on A and B.", support: ["w2.1", "w100.2"] },
  ];
  expect(await f.publish(c, "worker/1")).toBe(4);
  const current = await f.snapshot();
  expect(current.notes).toEqual([...a, ...b, ...c]);
  expect(project(current).notes.at(-1)!.support).toEqual(["w100.2", "w2.1"]);
  expect(store.read().notes["w100.1"]!.text).toBe("Outside replacement.");
});

test("import identities and receipts survive rollback while later input remains independently admissible", async () => {
  let f = await fixture();
  const input = { notes: [{ text: "Caller result.\n", support: [] }] };
  const submit = (id: string) =>
    f.root.commit((tx) => submitNotes(tx, f.root.id, id, input), context);
  const first = await submit("first");
  const namespace = (await f.snapshot()).inputs[0].namespace;
  const entries = await f.root.commit(
    (tx) => tx.scanEntries({ conversationId: f.root.id }, 128),
    context,
  );
  expect(namespace).toBe(
    `i${entries.items.find((entry) => entry.kind === "xean.note-input")!.id}`,
  );
  await expect(
    f.root.commit(async (tx) => {
      expect(await admitNotes(tx, f.root.id)).toBe(true);
      throw new Error("after intake publication");
    }, context),
  ).rejects.toThrow("after intake publication");
  expect((await f.snapshot()).inputs[0].consumed).toBe(false);
  await submit("second");
  expect(await submit("first")).toEqual(first);
  expect((await f.snapshot()).inputs[0].namespace).toBe(namespace);
  await f.harness.close(context);
  f = await fixture(f.file);
  expect(await f.root.commit((tx) => admitNotes(tx, f.root.id), context)).toBe(
    true,
  );
  expect(await f.root.commit((tx) => admitNotes(tx, f.root.id), context)).toBe(
    false,
  );
  const after = await f.snapshot();
  expect(after.notes).toEqual(
    after.inputs.map((queued: { namespace: string }) => ({
      ...input.notes[0],
      id: `${queued.namespace}.1`,
    })),
  );
  expect(
    after.inputs.map((queued: { id: string; consumed: boolean }) => ({
      id: queued.id,
      consumed: queued.consumed,
    })),
  ).toEqual([
    { id: "first", consumed: true },
    { id: "second", consumed: true },
  ]);
  using store = new NoteStore(`${f.file}.notes.sqlite`, { readonly: true });
  expect(store.snapshot()).toBe(2);
});

test("read-only inspection rejects append before changing either database", async () => {
  const f = await fixture();
  using store = new NoteStore(`${f.file}.notes.sqlite`);
  using database = new Database(`${f.file}.notes.sqlite`, { readonly: true });
  const rows = () =>
    ["commits", "revisions"].map((table) =>
      database.query(`SELECT * FROM ${table}`).all(),
    );
  const before = rows();
  await expect(
    inspect(f.file, async (tx, root) => {
      appendNotes(
        tx,
        await tx.doc(Notebook, root),
        [{ id: "forbidden", text: "No write.", support: [] }],
        "forbidden",
      );
    }),
  ).rejects.toThrow("read-only");
  const other = `${f.file}.other.sqlite`;
  await expect(
    inspect(f.file, (tx, root) => initializeNotebook(tx, root, other)),
  ).rejects.toThrow("read-only");
  expect(await Bun.file(other).exists()).toBe(false);
  expect(store.snapshot()).toBe(0);
  expect(rows()).toEqual(before);
});

test("external edits cannot retarget accepted text, support or verdicts in admitted snapshots", async () => {
  const f = await fixture();
  const note = { id: "w9.1", text: "Original proof of P.", support: [] };
  await f.publish([note], "worker/9");
  await f.root.commit(async (tx) => {
    (await tx.doc(Notebook, f.root.id)).checks.push({
      candidate: 9,
      call: 20,
      values: verifierNames.map((verifier) => ({
        note: note.id,
        verifier,
        verdict: "PASS",
        report: "Checked.",
      })),
    });
  }, context);
  const before = project(await f.snapshot());
  const proof = acceptedArgument(before.notes, note.id);
  expect(before.accepted).toEqual([note.id]);
  using store = new NoteStore(`${f.file}.notes.sqlite`);
  store.commit(
    store.snapshot(),
    {
      [note.id]: {
        ...note,
        text: "Different false claim.",
        support: ["unknown"],
      },
      external: { text: "Not admitted." },
    },
    "outside",
  );
  const after = project(await f.snapshot());
  expect(after).toEqual(before);
  expect(acceptedArgument(after.notes, note.id)).toBe(proof);
});

test("initialization preserves an existing nonempty notebook", async () => {
  const file = await path();
  using store = new NoteStore(`${file}.notes.sqlite`);
  store.append("independent", { n1: { text: "Existing knowledge." } });
  const before = store.read();
  await expect(
    open(file, { create: { task, settings }, models: fauxModels().models }),
  ).rejects.toThrow("empty notebook");
  expect(store.read()).toEqual(before);
});

test("historical closed-store campaigns reject without mutation or migration", async () => {
  const file = await path();
  const harness = await Harness.open(
    await openNodeSqliteStorage(file),
    { registry: createRegistry(), models: fauxModels().models },
    context,
  );
  const LegacyNotebook = defineDoc({
    kind: "xean.notebook",
    version: 1,
    checkpointWhen: () => false,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ notes: [], checks: [], guidance: [], inputs: [] }),
  });
  await harness.root(context, {
    init: async (tx, root) => {
      Object.assign(await tx.doc(DefinitionDoc, root), { task, settings });
      await tx.doc(LegacyNotebook, root);
    },
  });
  await harness.close(context);
  const before = await Bun.file(file).bytes();
  await expect(open(file)).rejects.toThrow("fresh campaigns only");
  expect(await Bun.file(file).bytes()).toEqual(before);
  expect(
    (await readdir(directories.at(-1)!)).some((name) =>
      name.includes(".notes.sqlite"),
    ),
  ).toBe(false);
});
