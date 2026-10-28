import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Notebook as NoteStore, ConflictError } from "@chaoxu/notebook-store";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  open,
  inspect,
  readReport,
  exportAccepted,
  solveSettings,
} from "../src/index.ts";
import {
  DefinitionDoc,
  Notebook,
  initializeNotebook,
  readNotebook,
  saveNotebook,
} from "../src/state.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import { fauxModels } from "./faux-models.ts";
import { submitNotes } from "../src/inputs.ts";

const directories: string[] = [],
  owners: Awaited<ReturnType<typeof open>>[] = [];
const task = { problem: "Prove P.", completionCriteria: "Prove P." };
const profile = { provider: "test", model: "test", reasoning: "high" };
const settings = solveSettings.parse(
  Object.fromEntries(
    ["explorer", "coordinator", ...verifierNames].map((name) => [
      name,
      profile,
    ]),
  ),
);
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function path() {
  const directory = await mkdtemp(join(tmpdir(), "xean-notebook-"));
  directories.push(directory);
  return join(directory, "campaign.sqlite");
}

test("publication survives Pi rollback and replays after reopening and an external edit", async () => {
  const file = await path(),
    native = fauxModels();
  let owner = await open(file, {
    create: { task, settings },
    models: native.models,
  });
  owners.push(owner);
  const note = { id: "n1", text: "Exact original body.\n", support: [] };
  using store = new NoteStore(`${file}.notes.sqlite`);
  const publish = async (fail: boolean) =>
    owner.root.commit(async (tx) => {
      const ref = await tx.doc(Notebook, owner.root.id);
      const book = readNotebook(ref);
      book.notes.push(note);
      saveNotebook(tx, ref, book);
      if (fail) throw new Error("after external commit");
    }, context);
  await expect(publish(true)).rejects.toThrow("after external commit");
  expect(store.snapshot()).toBe(1);
  expect(store.read(1).notes).toEqual({ n1: note });
  expect((await inspect(file, readReport)).notes).toEqual([]);
  await expect(
    owner.root.commit(async (tx) => {
      const ref = await tx.doc(Notebook, owner.root.id);
      const book = readNotebook(ref);
      book.notes.push({ ...note, text: "Different retry." });
      saveNotebook(tx, ref, book);
    }, context),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(store.read(1).notes).toEqual({ n1: note });
  expect((await inspect(file, readReport)).notes).toEqual([]);
  await owner.close();
  store.commit(
    1,
    { n1: { ...note, text: "External revision." } },
    "human-edit",
  );
  owner = await open(file, { models: native.models });
  owners.push(owner);
  await publish(false);
  expect(store.snapshot()).toBe(2);
  expect(
    (await owner.harness.snapshot(Notebook, owner.root.id, context))!.version,
  ).toBe(1);
  const report = await inspect(relative(process.cwd(), file), readReport);
  expect(report.notes[0]!.text).toBe(note.text);
  expect(report.notes[0]!.verified).toBe(false);
  expect(store.read().notes.n1!.text).toBe("External revision.");
  await expect(
    owner.root.commit(async (tx) => {
      const ref = await tx.doc(Notebook, owner.root.id);
      const book = readNotebook(ref);
      book.notes.push({ id: "n2", text: "Another note.", support: ["n1"] });
      saveNotebook(tx, ref, book);
    }, context),
  ).rejects.toBeInstanceOf(ConflictError);
  expect(await inspect(file, readReport)).toEqual(report);
  expect(store.snapshot()).toBe(2);
  expect(native.provider.state.callCount).toBe(0);
});

test("new input cannot change a pending publication before exact recovery", async () => {
  const file = await path(),
    native = fauxModels();
  let owner = await open(file, {
    create: { task, settings },
    models: native.models,
  });
  owners.push(owner);
  const input = { notes: [{ text: "Caller result.", support: [] }] };
  const submit = (id: string) =>
    owner.root.commit(
      (tx) => submitNotes(tx, owner.root.id, id, input),
      context,
    );
  const first = await submit("first");
  const publish = (fail: boolean) =>
    owner.root.commit(async (tx) => {
      const ref = await tx.doc(Notebook, owner.root.id);
      const book = readNotebook(ref);
      book.notes.push({ ...book.inputs[0]!.notes[0]!, id: "n1" });
      book.inputs[0]!.consumed = true;
      saveNotebook(tx, ref, book);
      if (fail) throw new Error("after intake publication");
    }, context);
  await expect(publish(true)).rejects.toThrow("after intake publication");
  const before = await inspect(file, readReport);
  await expect(submit("second")).rejects.toThrow("pending publication");
  expect(await submit("first")).toEqual(first);
  expect(await inspect(file, readReport)).toEqual(before);
  await owner.close();
  owner = await open(file, { models: native.models });
  owners.push(owner);
  await publish(false);
  await submit("second");
  const after = await inspect(file, readReport);
  expect(after.notes.map(({ id, text }) => ({ id, text }))).toEqual([
    { id: "n1", text: "Caller result." },
  ]);
  expect(after.inputs.map(({ id, consumed }) => ({ id, consumed }))).toEqual([
    { id: "first", consumed: true },
    { id: "second", consumed: false },
  ]);
  using store = new NoteStore(`${file}.notes.sqlite`, { readonly: true });
  expect(store.snapshot()).toBe(1);
  expect(native.provider.state.callCount).toBe(0);
});

test("read-only inspection rejects external publication before writing either database", async () => {
  const file = await path();
  const owner = await open(file, {
    create: { task, settings },
    models: fauxModels().models,
  });
  owners.push(owner);
  using store = new NoteStore(`${file}.notes.sqlite`);
  const before = store.read();
  using database = new Database(`${file}.notes.sqlite`, { readonly: true });
  const rows = () =>
    ["commits", "revisions"].map((table) =>
      database.query(`SELECT * FROM ${table}`).all(),
    );
  const stored = rows();
  await expect(
    inspect(file, async (tx, root) => {
      const ref = await tx.doc(Notebook, root);
      const book = readNotebook(ref);
      book.notes.push({
        id: "n1",
        text: "Forbidden external write.",
        support: [],
      });
      saveNotebook(tx, ref, book);
    }),
  ).rejects.toThrow("read-only");
  const other = `${file}.other.sqlite`;
  await expect(
    inspect(file, (tx, root) => initializeNotebook(tx, root, other)),
  ).rejects.toThrow("read-only");
  expect(await Bun.file(other).exists()).toBe(false);
  expect(store.read()).toEqual(before);
  expect(rows()).toEqual(stored);
  expect((await inspect(file, readReport)).notes).toEqual([]);
});

test("external changes cannot retarget accepted proof text, support, or verdicts", async () => {
  const file = await path();
  const checked = {
    verdicts: [{ note: "n1", verdict: "PASS", report: "Checked." }],
  };
  const native = fauxModels([
    {
      notes: [
        { text: "Original proof of P.", summary: "P holds.", support: [] },
      ],
    },
    {
      filings: [],
      explorerGuidance: "Verify the claim.",
      support: [],
      verify: [{ note: "n1", verifiers: [...verifierNames] }],
    },
    checked,
    checked,
    checked,
    { statements: [{ note: "n1", statement: "P holds." }] },
    { proof: "Independent proof." },
    { statements: [], ...checked },
  ]);
  const owner = await open(file, {
    create: { task, settings },
    models: native.models,
  });
  owners.push(owner);
  await owner.root.waitForIdle(context);
  const before = await inspect(file, readReport);
  expect(before.status.outcome).toBe("accepted");
  const proof = await exportAccepted(file);
  const ref = (await owner.harness.snapshot(Notebook, owner.root.id, context))!;
  using store = new NoteStore(ref.path);
  store.commit(
    ref.version,
    {
      n1: { id: "n1", text: "Different false claim.", support: ["n999"] },
      external: { text: "Not admitted." },
    },
    "outside",
  );
  expect(await inspect(file, readReport)).toEqual(before);
  expect(await exportAccepted(file)).toBe(proof);
  expect(
    (await owner.harness.snapshot(Notebook, owner.root.id, context))!.notes,
  ).toEqual(["n1"]);
  expect(native.provider.state.callCount).toBe(8);
});

test("initialization preserves an existing nonempty notebook", async () => {
  const file = await path();
  using store = new NoteStore(`${file}.notes.sqlite`);
  store.commit(0, { n1: { text: "Existing knowledge." } }, "independent");
  const before = store.read();
  await expect(
    open(file, { create: { task, settings }, models: fauxModels().models }),
  ).rejects.toThrow("empty notebook");
  expect(store.read()).toEqual(before);
});

test("closed-store 4.3 campaigns are rejected without mutation or automatic migration", async () => {
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
  await expect(inspect(file, readReport)).rejects.toThrow(
    "fresh campaigns only",
  );
  expect(await Bun.file(file).bytes()).toEqual(before);
  expect(
    (await readdir(directories.at(-1)!)).some((name) =>
      name.includes(".notes.sqlite"),
    ),
  ).toBe(false);
});
