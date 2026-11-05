import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guide, submitNotes } from "../src/inputs.ts";
import { readNotebook, appendNotes } from "../src/state.ts";
import { solveSettings } from "../src/policy/settings.ts";
import { open, inspect, readReport } from "../src/index.ts";
import { fauxModels } from "./faux-models.ts";

const directories: string[] = [],
  close: (() => Promise<unknown>)[] = [];
const profile = { provider: "test", model: "test", reasoning: "high" };
const settings = solveSettings.parse(
  Object.fromEntries(
    ["explorer", "source", "correctness", "requirements", "reconstruction"].map(
      (name) => [name, profile],
    ),
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
  const owner = await open(await path(), { create: { task, settings } });
  close.push(owner.close);
  if (!initialized)
    await owner.change((data) => {
      data.definition = null;
    });
  return {
    change: owner.change,
    snapshot: () => readNotebook(owner.snapshot().notebook),
  };
}

test("caller admission keeps exact text and a stable namespace across retries", async () => {
  const { change, snapshot } = await fixture();
  const receipt = await change((data) => submitNotes(data, "one", supplied));
  expect(receipt).toEqual({ id: "one", ...supplied });
  expect(snapshot().notes).toEqual([]);
  expect(snapshot().inputs).toEqual([
    {
      id: "one",
      namespace: expect.stringMatching(/^i[0-9a-f-]{36}$/),
      ...supplied,
      consumed: false,
    },
  ]);
  const before = snapshot();
  expect(await change((data) => submitNotes(data, "one", supplied))).toEqual(
    receipt,
  );
  expect(snapshot()).toEqual(before);
  await expect(
    change((data) =>
      submitNotes(data, "one", {
        notes: [{ text: "Different", support: [] }],
      }),
    ),
  ).rejects.toThrow("different submission");
  for (const input of [
    { notes: [] },
    { notes: [{ ...supplied.notes[0], id: "n9" }] },
    { notes: [{ text: " ", support: [] }] },
  ])
    await expect(
      change((data) => submitNotes(data, "invalid", input as never)),
    ).rejects.toThrow();
  expect(snapshot().inputs).toHaveLength(1);
});

test("support must already exist and be live; pending, same-batch and dead references cannot partially append", async () => {
  const { change, snapshot } = await fixture();
  await change((data) => {
    appendNotes(
      data.notebook,
      [
        { id: "n1", text: "Live", support: [] },
        { id: "n2", text: "Dead", support: [] },
        { id: "n3", text: "Depends on dead", support: ["n2"] },
      ],
      "fixtures",
    );
    data.notebook.checks.push({
      candidate: "one",
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
  });
  await change((data) => submitNotes(data, "pending", supplied));
  for (const support of [["n2"], ["n3"], ["n4"], ["n1", "n1"]])
    await expect(
      change((data) =>
        submitNotes(data, "invalid", {
          notes: [
            { text: "Valid first", support: ["n1"] },
            { text: "Invalid second", support },
          ],
        }),
      ),
    ).rejects.toThrow();
  expect(snapshot().inputs).toHaveLength(1);
  const value = {
    notes: [
      {
        text: "Provenance n999 is not support.",
        support: ["n1"],
        verification: { source: "Caller", report: "Checked." },
      },
    ],
  };
  const receipt = await change((data) => submitNotes(data, "dependent", value));
  await change((data) => {
    data.notebook.inputs.find((value) => value.id === "dependent")!.consumed =
      true;
    data.notebook.checks.push({
      candidate: "two",
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
  });
  expect(await change((data) => submitNotes(data, "dependent", value))).toEqual(
    receipt,
  );
});

test("guidance preserves bytes and has independent idempotency and nonblank validation", async () => {
  const { change, snapshot } = await fixture();
  const text = "  Try a construction.\n";
  expect(await change((data) => guide(data, "one", text))).toEqual({
    id: "one",
    text,
  });
  expect(await change((data) => guide(data, "one", text))).toEqual({
    id: "one",
    text,
  });
  await change((data) => submitNotes(data, "one", supplied));
  await expect(
    change((data) => guide(data, "one", "Different")),
  ).rejects.toThrow("different text");
  for (const [id, value] of [
    [" ", text],
    ["two", "\n"],
  ])
    await expect(change((data) => guide(data, id!, value!))).rejects.toThrow();
  await expect(
    change((data) => submitNotes(data, " ", supplied)),
  ).rejects.toThrow();
  expect(snapshot().guidance).toEqual([{ id: "one", text }]);
  expect(snapshot().inputs).toHaveLength(1);
});

test("uninitialized research rejects both admissions without a queued payload", async () => {
  const { change, snapshot } = await fixture(false);
  await expect(
    change((data) => submitNotes(data, "one", supplied)),
  ).rejects.toThrow("not initialized");
  await expect(change((data) => guide(data, "one", "Advice"))).rejects.toThrow(
    "not initialized",
  );
  expect(snapshot().inputs).toEqual([]);
  expect(snapshot().guidance).toEqual([]);
});

test("terminal input remains pending without changing the completed result", async () => {
  const file = await path();
  const native = fauxModels([
    { notes: [{ ...supplied.notes[0]!, summary: "Partial result." }] },
    { verify: [] },
  ]);
  const owner = await open(file, {
    create: { task, settings: { ...settings, maxExplorerTurns: 1 } },
    execute: true,
    models: native.models,
  });
  close.push(owner.close);
  await owner.wait();
  const before = await inspect(file, readReport);
  expect(before.status).toMatchObject({ outcome: "turn-limit" });
  await owner.change((data) => {
    submitNotes(data, "late", supplied);
    guide(data, "late", "Late advice");
  });
  await owner.wait();
  const after = await inspect(file, readReport);
  expect(after.status).toEqual(before.status);
  expect(after.notes).toEqual(before.notes);
  expect(native.provider.state.callCount).toBe(2);
  expect(
    owner
      .snapshot()
      .notebook.inputs.map(({ id, consumed }) => ({ id, consumed })),
  ).toEqual([{ id: "late", consumed: false }]);
});
