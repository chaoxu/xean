import { Database, SQLiteError } from "bun:sqlite";
import { closeSync, constants, existsSync, openSync, rmSync } from "node:fs";
import { lstatSync, readSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";

import {
  ENTRY_KINDS,
  copyJson,
  entry as entrySchema,
  entryId,
} from "./schemas";
import type { Entry, EntryDraft, EntryId, Json, RecordQuery } from "./types";

const SCHEMA_VERSION = 3;
const APPLICATION_ID = 0x7865616e; // SQLite product identity: ASCII "xean".
const ENTRY_KIND_SQL = Object.values(ENTRY_KINDS)
  .map((kind) => `'${kind}'`)
  .join(", ");
const SCHEMA = `
  CREATE TABLE entries (
    seq INTEGER PRIMARY KEY,
    at_ms INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN (${ENTRY_KIND_SQL})),
    body TEXT NOT NULL CHECK(json_valid(body) AND json_type(body) = 'object'),
    label TEXT GENERATED ALWAYS AS (json_extract(body, '$.label')) STORED,
    call_id INTEGER GENERATED ALWAYS AS (json_extract(body, '$.call')) STORED,
    parent_id INTEGER GENERATED ALWAYS AS (json_extract(body, '$.parent')) STORED
  ) STRICT;
  CREATE UNIQUE INDEX one_campaign ON entries(kind) WHERE kind = 'campaign';
  CREATE UNIQUE INDEX one_result ON entries(json_extract(body, '$.parent')) WHERE kind IN ('call-result', 'tool-result');
  CREATE UNIQUE INDEX one_evidence_call ON entries(call_id) WHERE kind = 'evidence';
  CREATE INDEX entries_kind_seq ON entries(kind, seq);
  CREATE INDEX entries_label_seq ON entries(label, seq);
  CREATE INDEX entries_call_seq ON entries(call_id, seq);
  CREATE INDEX entries_parent_seq ON entries(parent_id, seq);
  CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
  CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
  CREATE TABLE payloads (
    digest TEXT PRIMARY KEY CHECK(length(digest) = 64),
    body TEXT NOT NULL CHECK(json_valid(body))
  ) STRICT;
  CREATE TRIGGER payloads_no_update BEFORE UPDATE ON payloads BEGIN SELECT RAISE(ABORT, 'payloads are append-only'); END;
  CREATE TRIGGER payloads_no_delete BEFORE DELETE ON payloads BEGIN SELECT RAISE(ABORT, 'payloads are append-only'); END;
  PRAGMA application_id = ${APPLICATION_ID};
  PRAGMA user_version = ${SCHEMA_VERSION};
`;

interface EntryRow {
  readonly seq: number | bigint;
  readonly atMs: number | bigint;
  readonly kind: string;
  readonly body: string;
}
const payloadDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
const recordQuery = z.strictObject({
  kinds: z
    .array(z.enum(Object.values(ENTRY_KINDS)))
    .readonly()
    .optional(),
  labels: z.array(z.string().min(1)).readonly().optional(),
  excludeLabels: z.array(z.string().min(1)).readonly().optional(),
  call: entryId.optional(),
  parent: entryId.optional(),
  after: z.number().int().nonnegative().optional(),
  through: z.number().int().nonnegative().optional(),
});

function parsedRow(row: EntryRow): Entry {
  return entrySchema.parse({
    seq: Number(row.seq),
    atMs: Number(row.atMs),
    kind: row.kind,
    ...JSON.parse(row.body),
  });
}
function configure(database: Database): void {
  database.run("PRAGMA synchronous = FULL");
  database.run("PRAGMA journal_mode = DELETE");
}

function validatePath(path: string): void {
  if (typeof path !== "string") {
    throw new TypeError("campaign path must be a nonempty filesystem path");
  }
  const leaf = basename(path).toLowerCase();
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path === ":memory:" ||
    path.toLowerCase().startsWith("file:") ||
    ["-wal", "-shm", "-journal"].some((suffix) => leaf.endsWith(suffix))
  ) {
    throw new TypeError("campaign path must be a nonempty filesystem path");
  }
}

function storedVersion(path: string): number {
  for (const suffix of ["-wal", "-shm"])
    if (lstatSync(path + suffix, { throwIfNoEntry: false }))
      throw new Error("unsupported campaign WAL state");
  const descriptor = openSync(path, constants.O_RDONLY);
  const header = Buffer.alloc(72);
  try {
    const invalid =
      readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header.toString("utf8", 0, 16) !== "SQLite format 3\0";
    if (invalid) throw new Error("invalid campaign artifact");
    if (header[18] === 2 || header[19] === 2)
      throw new Error("unsupported campaign WAL mode");
    const application = header.readUInt32BE(68);
    if (application !== APPLICATION_ID)
      throw new Error(`unsupported campaign application: ${application}`);
    return header.readUInt32BE(60);
  } finally {
    closeSync(descriptor);
  }
}

function open(path: string, create: boolean, readonly = false): Database {
  validatePath(path);
  if (!create && !existsSync(path))
    throw new Error(`campaign does not exist: ${path}`);
  const version = create ? SCHEMA_VERSION : storedVersion(path);
  if (version !== SCHEMA_VERSION)
    throw new Error(`unsupported campaign schema: ${version}`);
  const database = new Database(path, {
    create,
    readonly,
    readwrite: !readonly,
    strict: true,
    safeIntegers: true,
  });
  try {
    database.run("PRAGMA busy_timeout = 5000");
    if (!create) {
      const campaign = database
        .query<{ readonly count: number | bigint }, []>(
          "SELECT COUNT(*) AS count FROM entries WHERE seq = 1 AND kind = 'campaign'",
        )
        .get();
      if (Number(campaign?.count ?? 0) !== 1) {
        throw new Error("invalid campaign artifact");
      }
    }
    if (!readonly) configure(database);
    return database;
  } catch (error) {
    database.close(true);
    throw error;
  }
}

export class Journal {
  readonly #database: Database;

  private constructor(database: Database) {
    this.#database = database;
  }

  static create(path: string, application: string, config: Json): Journal {
    validatePath(path);
    const sidecars = ["-journal", "-wal", "-shm"].map(
      (suffix) => path + suffix,
    );
    if (sidecars.some((file) => lstatSync(file, { throwIfNoEntry: false })))
      throw new Error(`campaign auxiliary file already exists: ${path}`);
    let descriptor: number;
    try {
      descriptor = openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
    } catch (error) {
      if (existsSync(path)) throw new Error(`campaign already exists: ${path}`);
      throw error;
    }
    closeSync(descriptor);
    let database: Database | undefined;
    try {
      const created = open(path, true);
      database = created;
      const journal = new Journal(created);
      created
        .transaction(() => {
          created.run(SCHEMA);
          journal.append({ kind: "campaign", application, config });
        })
        .immediate();
      return journal;
    } catch (error) {
      database?.close(true);
      rmSync(path, { force: true });
      throw error;
    }
  }

  static open(path: string, access: "read" | "write"): Journal {
    if (access === "write") return new Journal(open(path, false));
    try {
      return new Journal(open(path, false, true));
    } catch (error) {
      if (
        error instanceof SQLiteError &&
        error.code === "SQLITE_READONLY_ROLLBACK"
      ) {
        throw new Error(
          "campaign recovery required: reopen it for writing before reading",
          { cause: error },
        );
      }
      throw error;
    }
  }

  append(draft: EntryDraft): Entry {
    const atMs = Date.now();
    const checked = entrySchema.parse({ ...draft, seq: 1, atMs });
    const body: Record<string, unknown> = { ...checked };
    delete body.kind;
    delete body.seq;
    delete body.atMs;
    const result = this.#database.run(
      "INSERT INTO entries(at_ms, kind, body) VALUES (?, ?, ?)",
      [atMs, checked.kind, JSON.stringify(body)],
    );
    return {
      ...checked,
      seq: Number(result.lastInsertRowid),
    };
  }

  records(options: RecordQuery = {}): readonly Entry[] {
    const query = recordQuery.parse(options);
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (query.kinds !== undefined) {
      if (query.kinds.length === 0) return [];
      where.push(`e.kind IN (${query.kinds.map(() => "?").join(",")})`);
      values.push(...query.kinds);
    }
    for (const [field, column] of [
      ["call", "call_id"],
      ["parent", "parent_id"],
      ["after", "seq"],
      ["through", "seq"],
    ] as const) {
      const value = query[field];
      if (value === undefined) continue;
      where.push(
        `e.${column} ${field === "after" ? ">" : field === "through" ? "<=" : "="} ?`,
      );
      values.push(value);
    }
    for (const [labels, exclude] of [
      [query.labels, false],
      [query.excludeLabels, true],
    ] as const) {
      if (labels === undefined) continue;
      if (labels.length === 0) {
        if (!exclude) return [];
        continue;
      }
      const slots = labels.map(() => "?").join(",");
      const matches = `e.seq IN (SELECT labelled.seq FROM entries labelled WHERE labelled.label IN (${slots}) UNION ALL SELECT result.seq FROM entries result JOIN entries labelled ON labelled.seq = result.parent_id WHERE result.kind = 'call-result' AND labelled.label IN (${slots}))`;
      where.push(exclude ? `NOT (${matches})` : matches);
      values.push(...labels, ...labels);
    }
    const sql = `SELECT e.seq, e.at_ms AS atMs, e.kind, e.body FROM entries e${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY e.seq`;
    const records: Entry[] = [];
    for (const row of this.#database
      .query<EntryRow, (string | number)[]>(sql)
      .iterate(...values)) {
      records.push(parsedRow(row));
    }
    return records;
  }

  record(seq: EntryId): Entry | undefined {
    const row = this.#database
      .query<EntryRow, [EntryId]>(
        "SELECT seq, at_ms AS atMs, kind, body FROM entries WHERE seq = ?",
      )
      .get(entryId.parse(seq));
    return row === null ? undefined : parsedRow(row);
  }

  lastSequence(): number {
    return Number(
      this.#database
        .query<{ seq: number | bigint | null }, []>(
          "SELECT max(seq) AS seq FROM entries",
        )
        .get()?.seq ?? 0,
    );
  }

  /** Saves exact JSON serialization semantics under the content digest. */
  storePayload(value: Json): string {
    // Validate the public JSON value, then preserve the serializer's own keys.
    // Zod's defensive record copy omits a literal "__proto__" property.
    copyJson(value);
    return this.storePayloadJson(JSON.stringify(value));
  }

  storePayloadJson(encoded: string): string {
    const body = JSON.stringify(JSON.parse(z.string().parse(encoded)));
    const hash = digest(body);
    this.#database.run(
      "INSERT OR IGNORE INTO payloads(digest, body) VALUES (?, ?)",
      [hash, body],
    );
    return hash;
  }

  payload(value: string): Json {
    const hash = payloadDigest.parse(value);
    const row = this.#database
      .query<{ readonly body: string }, [string]>(
        "SELECT body FROM payloads WHERE digest = ?",
      )
      .get(hash);
    if (row === null) throw new Error(`payload not found: ${hash}`);
    if (digest(row.body) !== hash) throw new Error("payload digest mismatch");
    return JSON.parse(row.body) as Json;
  }

  close(): void {
    this.#database.close(true);
  }
}
