import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { createCampaign, openCampaign, openReader } from "../src";
import { Journal } from "../src/db";

const directories: string[] = [];

function temporaryPath(name = "campaign.db"): string {
  const directory = mkdtempSync(join(tmpdir(), "xean-database-"));
  directories.push(directory);
  return join(directory, name);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe("campaign database", () => {
  test("creates schema three with an explicit Xean SQLite identity", () => {
    const path = temporaryPath();
    createCampaign(path, "test", null).close();
    const header = readFileSync(path);
    expect(header.readUInt32BE(60)).toBe(3);
    expect(header.readUInt32BE(68)).toBe(0x7865616e);
    const reader = openReader(path);
    expect(reader.records()).toHaveLength(1);
    reader.close();
  });

  test.each([
    [0, 1],
    [0x74657374, 1],
  ])(
    "rejects foreign application %i schema %i without mutation",
    (identity, version) => {
      const path = temporaryPath();
      createCampaign(path, "test", null).close();
      const database = new Database(path, { create: false, readwrite: true });
      database.run(`PRAGMA application_id = ${identity}`);
      database.run(`PRAGMA user_version = ${version}`);
      database.close(true);
      const before = readFileSync(path);
      const files = readdirSync(dirname(path));
      const modified = statSync(path).mtimeMs;
      for (const opener of [openReader, openCampaign]) {
        expect(() => opener(path)).toThrow(
          `unsupported campaign application: ${identity}`,
        );
        expect(readFileSync(path)).toEqual(before);
        expect(readdirSync(dirname(path))).toEqual(files);
        expect(statSync(path).mtimeMs).toBe(modified);
      }
    },
  );

  test("queries exact ordered records with intersected filters and captured boundaries", () => {
    const path = temporaryPath();
    const journal = Journal.create(path, "query-test", null);
    const a = journal.append({
      kind: "call",
      label: "work",
      role: "explorer",
      request: null,
      tools: [],
    });
    const b = journal.append({
      kind: "call",
      label: "checkpoint",
      request: null,
      tools: [],
    });
    const checkpointResult = journal.append({
      kind: "call-result",
      parent: b.seq,
      state: "returned",
      output: null,
    });
    const tool = journal.append({
      kind: "tool-call",
      call: a.seq,
      tool: "submit",
      source: "remote-1",
      input: { notes: [] },
    });
    const toolResult = journal.append({
      kind: "tool-result",
      parent: tool.seq,
      state: "returned",
      output: { noteIds: [] },
    });
    const result = journal.append({
      kind: "call-result",
      parent: a.seq,
      state: "returned",
      output: { done: true },
    });
    const all = journal.records();
    expect(journal.record(a.seq)).toEqual(a);
    expect(journal.record(result.seq + 1)).toBeUndefined();
    expect(journal.lastSequence()).toBe(result.seq);
    expect(journal.records({ labels: ["checkpoint"] })).toEqual([
      b,
      checkpointResult,
    ]);
    expect(journal.records({ excludeLabels: ["checkpoint"] })).toEqual(
      all.filter((e) => e.seq !== b.seq && e.seq !== checkpointResult.seq),
    );
    expect(
      journal.records({
        kinds: ["tool-call"],
        call: a.seq,
        after: b.seq,
        through: tool.seq,
      }),
    ).toEqual([tool]);
    expect(
      journal.records({ kinds: ["tool-result"], parent: tool.seq }),
    ).toEqual([toolResult]);
    expect(journal.records({ kinds: ["call-result"], parent: a.seq })).toEqual([
      result,
    ]);
    expect(
      journal.records({
        labels: ["work"],
        kinds: ["call-result"],
        through: tool.seq,
      }),
    ).toEqual([]);
    expect(journal.records({ kinds: [] })).toEqual([]);
    expect(journal.records({ labels: [] })).toEqual([]);
    expect(journal.records({ excludeLabels: [] })).toEqual(all);
    expect(journal.records({ after: 0, through: 0 })).toEqual([]);
    expect(journal.records({ after: result.seq, through: a.seq })).toEqual([]);
    expect(() => journal.records({ after: -1 })).toThrow();
    expect(() => journal.record(0)).toThrow();
    expect(() => journal.records({ kinds: ["unknown"] } as never)).toThrow();
    journal.close();
    const reader = openReader(path);
    expect(reader.record(a.seq)).toEqual(a);
    expect(reader.lastSequence()).toBe(result.seq);
    expect(reader.records({ labels: ["work"] })).toEqual([a, result]);
    reader.close();
  });

  test("SQL filters leave an unrelated large invalid entry unparsed", () => {
    const path = temporaryPath();
    const journal = Journal.create(path, "selective-query", null);
    const owner = journal.append({
      kind: "call",
      label: "owner",
      request: null,
      tools: [],
    });
    const tool = journal.append({
      kind: "tool-call",
      call: owner.seq,
      tool: "submit",
      input: { notes: [] },
    });
    journal.close();
    const database = new Database(path, { readwrite: true, create: false });
    database.run("INSERT INTO entries(at_ms,kind,body) VALUES(?,?,?)", [
      Date.now(),
      "call",
      JSON.stringify({
        label: "large-invalid",
        request: { text: "x".repeat(2 * 1024 * 1024) },
        tools: [],
        unexpected: true,
      }),
    ]);
    const indexNames = database
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='index'",
      )
      .all()
      .map((r) => r.name);
    expect(indexNames).toContain("entries_call_seq");
    expect(indexNames).toContain("entries_parent_seq");
    expect(indexNames).toContain("entries_label_seq");
    database.close();
    const reader = openReader(path);
    expect(reader.records({ kinds: ["tool-call"], call: owner.seq })).toEqual([
      tool,
    ]);
    expect(reader.records({ excludeLabels: ["large-invalid"] })).toHaveLength(
      3,
    );
    expect(reader.record(owner.seq)).toEqual(owner);
    expect(reader.lastSequence()).toBe(4);
    expect(() => reader.records()).toThrow();
    reader.close();
  });

  test("recordEvidence reads only its call and result", async () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "targeted-evidence", null);
    const call = await campaign.call(
      { label: "audit", request: null },
      async () => ({ state: "succeeded" }),
    );
    const db = new Database(path, { readwrite: true });
    db.run("INSERT INTO entries(at_ms,kind,body) VALUES(?,?,?)", [
      Date.now(),
      "call",
      JSON.stringify({
        label: "unrelated-large-invalid",
        request: { text: "x".repeat(2 * 1024 * 1024) },
        tools: [],
        unexpected: true,
      }),
    ]);
    db.close();
    const evidence = campaign.recordEvidence(call.call, { verdict: "PASS" });
    expect(campaign.record(evidence)).toMatchObject({
      kind: "evidence",
      call: call.call,
      evidence: { verdict: "PASS" },
    });
    expect(() => campaign.records()).toThrow();
    campaign.close();
  });

  test("creates a private file without overwriting an existing campaign", () => {
    const path = temporaryPath();
    const campaign = createCampaign(path, "first", null);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => createCampaign(path, "second", null)).toThrow(
      "already exists",
    );
    expect(campaign.records()[0]).toMatchObject({
      kind: "campaign",
      application: "first",
    });
  });

  test("opens a copied closed campaign as one file", () => {
    const path = temporaryPath("source.db");
    const copy = join(dirname(path), "copy.db");
    createCampaign(path, "test", null).close();
    copyFileSync(path, copy);
    const reader = openReader(copy);
    expect(reader.records()).toHaveLength(1);
    reader.close();
  });

  test("leaves hot-journal recovery to a writer", async () => {
    const path = temporaryPath();
    const marker = join(dirname(path), "ready");
    createCampaign(path, "test", null).close();
    const fixture = resolve("tests/fixtures/hot-journal.ts");
    const child = Bun.spawn([process.execPath, fixture, path, marker], {
      stdout: "pipe",
      stderr: "pipe",
    });
    for (
      let attempt = 0;
      !existsSync(marker) && attempt < 1_000;
      attempt += 1
    ) {
      await Bun.sleep(5);
    }
    if (!existsSync(marker)) {
      child.kill(9);
      throw new Error("hot-journal fixture did not start");
    }
    child.kill(9);
    await child.exited;
    expect(existsSync(`${path}-journal`)).toBe(true);

    const rawReader = new Database(path, { create: false, readonly: true });
    expect(() => rawReader.query("SELECT * FROM entries").all()).toThrow();
    rawReader.close(true);

    const databaseBefore = readFileSync(path);
    const journalBefore = readFileSync(`${path}-journal`);
    expect(() => openReader(path)).toThrow("campaign recovery required");
    expect(readFileSync(path)).toEqual(databaseBefore);
    expect(readFileSync(`${path}-journal`)).toEqual(journalBefore);

    const writer = openCampaign(path);
    expect(writer.records().map(({ kind }) => kind)).toEqual(["campaign"]);
    writer.close();
    expect(existsSync(`${path}-journal`)).toBe(false);

    const reader = openReader(path);
    expect(reader.records().map(({ kind }) => kind)).toEqual(["campaign"]);
    reader.close();
  });

  test("reopens one campaign for later appends", async () => {
    const path = temporaryPath();
    const first = createCampaign(path, "test", null);
    await first.call({ label: "before-close", request: null }, async () => ({
      done: true,
    }));
    first.close();
    const reopened = openCampaign(path);
    await reopened.call({ label: "after-reopen", request: null }, async () => ({
      done: true,
    }));
    expect(reopened.records().map((entry) => entry.kind)).toEqual([
      "campaign",
      "call",
      "call-result",
      "call",
      "call-result",
    ]);
    reopened.close();
  });

  test("removes an artifact when initial validation fails", () => {
    const path = temporaryPath();
    expect(() => createCampaign(path, "test", undefined as never)).toThrow();
    expect(existsSync(path)).toBe(false);
    const campaign = createCampaign(path, "retry", null);
    expect(campaign.records()).toHaveLength(1);
  });

  test("preserves pre-existing auxiliary files", () => {
    const path = temporaryPath();
    writeFileSync(`${path}-journal`, "not ours");
    expect(() => createCampaign(path, "test", null)).toThrow(
      "auxiliary file already exists",
    );
    expect(readFileSync(`${path}-journal`, "utf8")).toBe("not ours");
    expect(existsSync(path)).toBe(false);

    const dangling = temporaryPath("dangling.db");
    symlinkSync("missing-target", `${dangling}-journal`);
    expect(() => createCampaign(dangling, "test", null)).toThrow(
      "auxiliary file already exists",
    );
    expect(lstatSync(`${dangling}-journal`).isSymbolicLink()).toBe(true);
  });

  test("rejects SQLite URI and auxiliary filenames", () => {
    for (const path of [
      "file:campaign.db",
      "FILE:campaign.db",
      ":memory:",
      temporaryPath("campaign.db-wal"),
      temporaryPath("campaign.db-SHM"),
      temporaryPath("campaign.db-journal"),
    ]) {
      expect(() => createCampaign(path, "test", null)).toThrow(TypeError);
    }
  });

  test("database triggers reject record mutation", () => {
    const path = temporaryPath();
    const campaign = createCampaign(path, "test", null);
    campaign.close();
    const database = new Database(path, { create: false, readwrite: true });
    expect(() => database.run("UPDATE entries SET body = body")).toThrow(
      "entries are append-only",
    );
    expect(() => database.run("DELETE FROM entries")).toThrow(
      "entries are append-only",
    );
    database.close(true);
  });

  test.each([0, 2, 4])(
    "refuses schema %i without changing its files",
    (version) => {
      const path = temporaryPath();
      const database = new Database(path, { create: true });
      database.run("PRAGMA application_id = 2019909998");
      database.run(`PRAGMA user_version = ${version}`);
      database.close(true);
      const before = readFileSync(path);
      const files = readdirSync(dirname(path));
      const modified = statSync(path).mtimeMs;
      for (const open of [openReader, openCampaign]) {
        expect(() => open(path)).toThrow(
          `unsupported campaign schema: ${version}`,
        );
        expect(readFileSync(path)).toEqual(before);
        expect(readdirSync(dirname(path))).toEqual(files);
        expect(statSync(path).mtimeMs).toBe(modified);
      }
    },
  );

  test("does not recover an unsupported database", async () => {
    const path = temporaryPath();
    const marker = join(dirname(path), "unsupported-ready");
    createCampaign(path, "test", null).close();
    const database = new Database(path, { create: false, readwrite: true });
    database.run("PRAGMA user_version = 999");
    database.close(true);
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("tests/fixtures/hot-journal.ts"),
        path,
        marker,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    for (let attempt = 0; !existsSync(marker) && attempt < 1_000; attempt += 1)
      await Bun.sleep(5);
    if (!existsSync(marker)) {
      child.kill(9);
      await child.exited;
      throw new Error("hot-journal fixture did not start");
    }
    child.kill(9);
    await child.exited;
    const databaseBefore = readFileSync(path);
    const journalBefore = readFileSync(`${path}-journal`);
    expect(() => openCampaign(path)).toThrow(
      "unsupported campaign schema: 999",
    );
    expect(readFileSync(path)).toEqual(databaseBefore);
    expect(readFileSync(`${path}-journal`)).toEqual(journalBefore);
  });

  test("rejects committed WAL state without changing its files", async () => {
    const path = temporaryPath();
    const marker = join(dirname(path), "wal-ready");
    createCampaign(path, "test", null).close();
    const child = Bun.spawn(
      [process.execPath, resolve("tests/fixtures/wal-schema.ts"), path, marker],
      { stdout: "pipe", stderr: "pipe" },
    );
    for (let attempt = 0; !existsSync(marker) && attempt < 1_000; attempt += 1)
      await Bun.sleep(5);
    if (!existsSync(marker)) {
      child.kill(9);
      await child.exited;
      throw new Error("WAL fixture did not start");
    }
    child.kill(9);
    await child.exited;
    const files = [path, `${path}-wal`, `${path}-shm`];
    expect(files.every(existsSync)).toBe(true);
    const before = files.map((file) => readFileSync(file));
    for (const opener of [openReader, openCampaign]) {
      expect(() => opener(path)).toThrow("unsupported campaign WAL state");
      expect(files.map((file) => readFileSync(file))).toEqual(before);
    }
  });

  test("rejects a clean WAL-format header without changing it", () => {
    const path = temporaryPath();
    createCampaign(path, "test", null).close();
    const database = new Database(path, { create: false, readwrite: true });
    database.run("PRAGMA journal_mode = WAL");
    database.run("PRAGMA wal_checkpoint(TRUNCATE)");
    database.close(true);
    rmSync(`${path}-wal`, { force: true });
    rmSync(`${path}-shm`, { force: true });
    const before = readFileSync(path);
    expect([before[18], before[19]]).toEqual([2, 2]);
    for (const opener of [openReader, openCampaign]) {
      expect(() => opener(path)).toThrow("unsupported campaign WAL mode");
      expect(readFileSync(path)).toEqual(before);
    }
  });

  test("preserves normal and dangling WAL auxiliary entries on open", () => {
    for (const suffix of ["-wal", "-shm"]) {
      const normal = temporaryPath(`normal${suffix}.db`);
      createCampaign(normal, "test", null).close();
      writeFileSync(normal + suffix, "not ours");
      expect(() => openReader(normal)).toThrow(
        "unsupported campaign WAL state",
      );
      expect(readFileSync(normal + suffix, "utf8")).toBe("not ours");

      const dangling = temporaryPath(`dangling${suffix}.db`);
      createCampaign(dangling, "test", null).close();
      symlinkSync("missing-target", dangling + suffix);
      expect(() => openCampaign(dangling)).toThrow(
        "unsupported campaign WAL state",
      );
      expect(lstatSync(dangling + suffix).isSymbolicLink()).toBe(true);
    }
  });

  test("refuses an artifact without its campaign identity", () => {
    const path = temporaryPath();
    createCampaign(path, "test", null).close();
    const database = new Database(path, { create: false, readwrite: true });
    database.run("DROP TRIGGER entries_no_delete");
    database.run("DELETE FROM entries");
    database.close(true);
    expect(() => openReader(path)).toThrow("invalid campaign artifact");
  });

  test("persists a call start before an interrupted external effect", () => {
    const path = temporaryPath();
    const fixture = resolve("tests/fixtures/crash-call.ts");
    const child = Bun.spawnSync([process.execPath, fixture, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const reader = openReader(path);
    expect(reader.records().map((entry) => entry.kind)).toEqual([
      "campaign",
      "call",
    ]);
  });

  test("persists tool intent before an interrupted tool effect", () => {
    const path = temporaryPath();
    const marker = join(dirname(path), "effect.json");
    const fixture = resolve("tests/fixtures/crash-tool.ts");
    const child = Bun.spawnSync([process.execPath, fixture, path, marker], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);
    const reader = openReader(path);
    const records = reader.records();
    expect(records.map((entry) => entry.kind)).toEqual([
      "campaign",
      "call",
      "tool-call",
    ]);
    expect(records.at(-1)).toMatchObject({
      source: "provider-effect-1",
      input: { value: "durable" },
    });
    const call = records.find((entry) => entry.kind === "call")!;
    const toolCall = records.find((entry) => entry.kind === "tool-call")!;
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
      call: call.seq,
      toolCall: toolCall.seq,
      source: "provider-effect-1",
    });
    reader.close();
  });
  test("a completed tool does not settle its interrupted parent call", () => {
    const path = temporaryPath();
    const child = Bun.spawnSync(
      [process.execPath, resolve("tests/fixtures/crash-after-tool.ts"), path],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(child.exitCode).toBe(0);
    const campaign = openCampaign(path);
    try {
      const records = campaign.records();
      expect(records.map(({ kind }) => kind)).toEqual([
        "campaign",
        "call",
        "tool-call",
        "tool-result",
      ]);
      expect(records.at(-1)).toMatchObject({
        state: "returned",
        output: "durable submission",
      });
      expect(() => campaign.recordEvidence(records[1]!.seq, null)).toThrow(
        "returned call",
      );
      expect(campaign.records()).toEqual(records);
    } finally {
      campaign.close();
    }
  });
});
