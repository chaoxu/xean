import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { fauxModels } from "./faux-models.ts";
import {
  open,
  inspect,
  readReport,
  ResearchOwnedError,
  solveSettings,
  Notebook,
} from "../src/index.ts";

const directories: string[] = [];
const owners: Awaited<ReturnType<typeof open>>[] = [];
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
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
    ].map((role) => [role, profile]),
  ),
);
const digest = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "xean4-host-"));
  directories.push(directory);
  return { directory, path: join(directory, "campaign.sqlite") };
}
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("inspection returns detached snapshots, rejects mutation, and never runs pending work", async () => {
  const { path } = await fixture();
  const native = fauxModels();
  const owner = await open(path, {
    create: { task, settings },
    models: native.models,
  });
  owners.push(owner);
  const before = await inspect(path, readReport);
  expect(before.task).toEqual(task);
  expect(before.settings).toEqual(settings);
  expect(before.notes).toEqual([]);
  expect(before.checks).toEqual([]);
  expect(before.status.status).toBe("pending");
  await expect(
    inspect(path, async (tx, root) => {
      (await tx.doc(Notebook, root)).guidance.push({
        id: "forbidden",
        text: "Should not persist.",
      });
    }),
  ).rejects.toThrow();
  await expect(
    inspect(path, (tx, root) =>
      tx.appendEntry(root, { kind: "forbidden", data: null }),
    ),
  ).rejects.toThrow();
  expect(await inspect(path, readReport)).toEqual(before);
  expect(native.provider.state.callCount).toBe(0);
});

test("old native Pi campaigns are rejected before any database rewrite", async () => {
  const { path } = await fixture();
  const storage = await openNodeSqliteStorage(path);
  const harness = await Harness.open(
    storage,
    { registry: createRegistry(), models: builtinModels() },
    context,
  );
  const OldDefinition = defineDoc({
    kind: "xean.definition",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ task, settings }),
  });
  await harness.root(context, {
    init: async (tx, root) => {
      await tx.doc(OldDefinition, root);
    },
  });
  await harness.close(context);
  const before = await digest(path);
  await expect(inspect(path, readReport)).rejects.toThrow();
  await expect(open(path)).rejects.toThrow();
  await expect(open(path, { create: { task, settings } })).rejects.toThrow();
  expect(await digest(path)).toBe(before);
});

test("unrelated SQLite databases remain byte-identical after rejection", async () => {
  const { path } = await fixture();
  const database = new Database(path);
  database.exec(
    "CREATE TABLE historical(value TEXT); INSERT INTO historical VALUES ('preserve me')",
  );
  database.close();
  const before = await digest(path);
  await expect(open(path, { create: { task, settings } })).rejects.toThrow(
    "Not a Pi Durable",
  );
  expect(await digest(path)).toBe(before);
});

test("symlink aliases share one owner and hard-linked database paths are refused", async () => {
  const { path, directory } = await fixture();
  const owner = await open(path, { create: { task, settings } });
  owners.push(owner);
  const alias = join(directory, "alias.sqlite");
  await symlink(path, alias);
  await expect(open(alias)).rejects.toBeInstanceOf(ResearchOwnedError);
  expect((await inspect(alias, readReport)).task).toEqual(task);
  await owner.close();
  const hard = join(directory, "hard.sqlite");
  await link(path, hard);
  await expect(open(hard)).rejects.toThrow("Hard-linked");
  await expect(inspect(hard, readReport)).rejects.toThrow("Hard-linked");
  await rm(hard);
});

test("continuation-on rejects before creating a campaign database", async () => {
  const { path } = await fixture();
  await expect(
    open(path, {
      create: {
        task,
        // @ts-expect-error Exercise rejection of unsupported persisted input.
        settings: { ...settings, explorerContinuation: true },
      },
    }),
  ).rejects.toThrow("requires Explorer continuation to be off");
  expect(await Bun.file(path).exists()).toBe(false);
});
