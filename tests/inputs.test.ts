import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { guide, submitNotes } from "../src/inputs.ts";
import {
  DefinitionDoc,
  Notebook,
  initializeNotebook,
  readNotebook,
  saveNotebook,
} from "../src/state.ts";
import { solveSettings } from "../src/policy/settings.ts";
import { open, inspect, readReport } from "../src/index.ts";
import { fauxModels } from "./faux-models.ts";

const directories: string[] = [],
  close: (() => Promise<unknown>)[] = [];
const profile = { provider: "test", model: "test", reasoning: "high" };
const settings = solveSettings.parse(
  Object.fromEntries(
    [
      "explorer",
      "coordinator",
      "source",
      "correctness",
      "requirements",
      "reconstruction",
    ].map((name) => [name, profile]),
  ),
);
const task = { problem: "Prove P.", completionCriteria: "Prove all of P." };
const supplied = { notes: [{ text: "  Caller proof.\n", support: [] }] };
afterEach(async () => {
  for (const dispose of close.splice(0)) await dispose();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function path() {
  const directory = await mkdtemp(join(tmpdir(), "xean-inputs-"));
  directories.push(directory);
  return join(directory, "research.sqlite");
}
async function fixture(initialized = true) {
  const file = await path();
  const harness = await Harness.open(
    await openNodeSqliteStorage(file),
    {
      registry: createRegistry(),
      models: builtinModels(),
    },
    context,
  );
  close.push(() => harness.close(context));
  const root = await harness.root(context, {
    init: async (tx, id) => {
      if (initialized)
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
  return { root, snapshot };
}

test("caller admission keeps exact text, assigns no IDs and is idempotent and atomic", async () => {
  const { root, snapshot } = await fixture();
  const receipt = await root.commit(
    (tx) => submitNotes(tx, root.id, "one", supplied),
    context,
  );
  expect(receipt).toEqual({ id: "one", ...supplied });
  expect((await snapshot()).notes).toEqual([]);
  expect((await snapshot()).inputs).toEqual([
    { id: "one", ...supplied, consumed: false },
  ]);
  expect(
    await root.commit(
      (tx) => submitNotes(tx, root.id, "one", supplied),
      context,
    ),
  ).toEqual(receipt);
  await expect(
    root.commit(
      (tx) =>
        submitNotes(tx, root.id, "one", {
          notes: [{ text: "Different", support: [] }],
        }),
      context,
    ),
  ).rejects.toThrow("different submission");
  for (const input of [
    { notes: [] },
    { notes: [{ ...supplied.notes[0], id: "n9" }] },
    { notes: [{ text: " ", support: [] }] },
  ])
    await expect(
      root.commit(
        (tx) => submitNotes(tx, root.id, "invalid", input as never),
        context,
      ),
    ).rejects.toThrow();
  expect((await snapshot()).inputs).toHaveLength(1);
});

test("support must already exist and be live; pending, same-batch and dead references cannot partially append", async () => {
  const { root, snapshot } = await fixture();
  await root.commit(async (tx) => {
    const ref = await tx.doc(Notebook, root.id);
    const book = readNotebook(ref);
    book.notes.push(
      { id: "n1", text: "Live", support: [] },
      { id: "n2", text: "Dead", support: [] },
      { id: "n3", text: "Depends on dead", support: ["n2"] },
    );
    book.checks.push({
      candidate: 1,
      call: 1,
      values: [
        {
          note: "n2",
          verifier: "correctness",
          verdict: "FAIL",
          report: "False.",
        },
      ],
    });
    saveNotebook(tx, ref, book);
  }, context);
  await root.commit(
    (tx) => submitNotes(tx, root.id, "pending", supplied),
    context,
  );
  for (const support of [["n2"], ["n3"], ["n4"], ["n1", "n1"]])
    await expect(
      root.commit(
        (tx) =>
          submitNotes(tx, root.id, "invalid", {
            notes: [
              { text: "Valid first", support: ["n1"] },
              { text: "Invalid second", support },
            ],
          }),
        context,
      ),
    ).rejects.toThrow();
  expect((await snapshot()).inputs).toHaveLength(1);
  const value = {
    notes: [
      {
        text: "Provenance n999 is not support.",
        support: ["n1"],
        verification: { source: "Caller", report: "Checked." },
      },
    ],
  };
  const receipt = await root.commit(
    (tx) => submitNotes(tx, root.id, "dependent", value),
    context,
  );
  await root.commit(async (tx) => {
    const book = await tx.doc(Notebook, root.id);
    book.inputs.find((value) => value.id === "dependent")!.consumed = true;
    book.checks.push({
      candidate: 2,
      call: 2,
      values: [
        {
          note: "n1",
          verifier: "source",
          verdict: "FAIL",
          report: "Source mismatch.",
        },
      ],
    });
  }, context);
  expect(
    await root.commit(
      (tx) => submitNotes(tx, root.id, "dependent", value),
      context,
    ),
  ).toEqual(receipt);
});

test("guidance preserves bytes and has independent idempotency and nonblank validation", async () => {
  const { root, snapshot } = await fixture();
  const text = "  Try a construction.\n";
  expect(
    await root.commit((tx) => guide(tx, root.id, "one", text), context),
  ).toEqual({ id: "one", text });
  expect(
    await root.commit((tx) => guide(tx, root.id, "one", text), context),
  ).toEqual({ id: "one", text });
  await root.commit((tx) => submitNotes(tx, root.id, "one", supplied), context);
  await expect(
    root.commit((tx) => guide(tx, root.id, "one", "Different"), context),
  ).rejects.toThrow("different text");
  for (const [id, value] of [
    [" ", text],
    ["two", "\n"],
  ])
    await expect(
      root.commit((tx) => guide(tx, root.id, id!, value!), context),
    ).rejects.toThrow();
  await expect(
    root.commit((tx) => submitNotes(tx, root.id, " ", supplied), context),
  ).rejects.toThrow();
  expect((await snapshot()).guidance).toEqual([{ id: "one", text }]);
  expect((await snapshot()).inputs).toHaveLength(1);
});

test("uninitialized research rejects both admissions without a queued payload", async () => {
  const { root, snapshot } = await fixture(false);
  await expect(
    root.commit((tx) => submitNotes(tx, root.id, "one", supplied), context),
  ).rejects.toThrow("not initialized");
  await expect(
    root.commit((tx) => guide(tx, root.id, "one", "Advice"), context),
  ).rejects.toThrow("not initialized");
  expect((await snapshot()).inputs).toEqual([]);
  expect((await snapshot()).guidance).toEqual([]);
});

test("terminal input remains pending without changing the completed result", async () => {
  const file = await path();
  const native = fauxModels([
    supplied,
    {
      filings: [{ note: "n1", summary: "Partial result." }],
      explorerGuidance: "Continue.",
      support: [],
      verify: [],
    },
  ]);
  const owner = await open(file, {
    create: { task, settings: { ...settings, maxExplorerTurns: 1 } },
    models: native.models,
  });
  close.push(owner.close);
  await owner.root.waitForIdle(context);
  const before = await inspect(file, readReport);
  expect(before.status).toMatchObject({ outcome: "turn-limit" });
  await owner.root.commit(async (tx) => {
    await submitNotes(tx, owner.root.id, "late", supplied);
    await guide(tx, owner.root.id, "late", "Late advice");
  }, context);
  await owner.root.waitForIdle(context);
  const after = await inspect(file, readReport);
  expect(after.status).toEqual(before.status);
  expect(after.notes).toEqual(before.notes);
  expect(native.provider.state.callCount).toBe(2);
  expect(
    await owner.root.commit(
      async (tx) =>
        (await tx.doc(Notebook, owner.root.id)).inputs.map(
          ({ id, consumed }) => ({ id, consumed }),
        ),
      context,
    ),
  ).toEqual([{ id: "late", consumed: false }]);
});
