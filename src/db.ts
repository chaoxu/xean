import { Database, SQLiteError } from "bun:sqlite";
import { closeSync, constants, existsSync, openSync, rmSync } from "node:fs";
import { lstatSync, readSync } from "node:fs";
import { basename } from "node:path";
import { isUint8Array } from "node:util/types";
import { z } from "zod";

import {
  ENTRY_KINDS,
  copyJson,
  entry as entrySchema,
  entryId,
} from "./schemas";
import type { Entry, EntryDraft, EntryId, Json, RecordQuery } from "./types";

const SCHEMA_VERSION = 8;
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
    parent_id INTEGER GENERATED ALWAYS AS (json_extract(body, '$.parent')) STORED,
    material BLOB CHECK((kind = 'candidate') = (material IS NOT NULL))
  ) STRICT;
  CREATE UNIQUE INDEX one_campaign ON entries(kind) WHERE kind = 'campaign';
  CREATE UNIQUE INDEX one_result ON entries(json_extract(body, '$.parent')) WHERE kind IN ('call-result', 'tool-result');
  CREATE UNIQUE INDEX one_verdict_call ON entries(json_extract(body, '$.call')) WHERE kind = 'verdict';
  CREATE INDEX entries_kind_seq ON entries(kind, seq);
  CREATE INDEX entries_label_seq ON entries(label, seq);
  CREATE INDEX entries_call_seq ON entries(call_id, seq);
  CREATE INDEX entries_parent_seq ON entries(parent_id, seq);
  CREATE TRIGGER entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
  CREATE TRIGGER entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT, 'entries are append-only'); END;
  CREATE TABLE payload_items (
    digest TEXT PRIMARY KEY CHECK(length(digest) = 64),
    body TEXT NOT NULL CHECK(json_valid(body))
  ) STRICT;
  CREATE TABLE payload_inputs (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER NOT NULL CHECK(parent_id >= 0 AND parent_id < id),
    item_digest TEXT NOT NULL CHECK(length(item_digest) = 64),
    UNIQUE(parent_id, item_digest)
  ) STRICT;
  CREATE TABLE payloads (
    digest TEXT PRIMARY KEY CHECK(length(digest) = 64),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    input_tail INTEGER CHECK(input_tail >= 0),
    input_length INTEGER NOT NULL CHECK(input_length >= 0),
    CHECK((coalesce(input_tail, 0) = 0) = (input_length = 0))
  ) STRICT;
  CREATE TRIGGER payload_items_no_update BEFORE UPDATE ON payload_items BEGIN SELECT RAISE(ABORT, 'payload items are append-only'); END;
  CREATE TRIGGER payload_items_no_delete BEFORE DELETE ON payload_items BEGIN SELECT RAISE(ABORT, 'payload items are append-only'); END;
  CREATE TRIGGER payload_inputs_no_update BEFORE UPDATE ON payload_inputs BEGIN SELECT RAISE(ABORT, 'payload inputs are append-only'); END;
  CREATE TRIGGER payload_inputs_no_delete BEFORE DELETE ON payload_inputs BEGIN SELECT RAISE(ABORT, 'payload inputs are append-only'); END;
  CREATE TRIGGER payloads_no_update BEFORE UPDATE ON payloads BEGIN SELECT RAISE(ABORT, 'payloads are append-only'); END;
  CREATE TRIGGER payloads_no_delete BEFORE DELETE ON payloads BEGIN SELECT RAISE(ABORT, 'payloads are append-only'); END;
  PRAGMA user_version = ${SCHEMA_VERSION};
`;

interface EntryRow {
  readonly seq: number | bigint;
  readonly atMs: number | bigint;
  readonly kind: string;
  readonly body: string;
}
interface MaterialRow {
  readonly material: Uint8Array;
}
interface PayloadRow {
  readonly bodyDigest: string;
  readonly inputTail: bigint | null;
  readonly inputLength: bigint;
}
const payloadDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const digest = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");
function object(value: Json): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
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

function copyBytes(value: Uint8Array): Uint8Array {
  if (!isUint8Array(value)) throw new TypeError("candidate must be Uint8Array");
  return new Uint8Array(value);
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
  const header = Buffer.alloc(64);
  try {
    const invalid =
      readSync(descriptor, header, 0, header.length, 0) !== header.length ||
      header.toString("utf8", 0, 16) !== "SQLite format 3\0";
    if (invalid) throw new Error("invalid campaign artifact");
    if (header[18] === 2 || header[19] === 2)
      throw new Error("unsupported campaign WAL mode");
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

  append(draft: EntryDraft, material?: Uint8Array): Entry {
    const atMs = Date.now();
    const checked = entrySchema.parse({ ...draft, seq: 1, atMs });
    const body: Record<string, unknown> = { ...checked };
    delete body.kind;
    delete body.seq;
    delete body.atMs;
    const storedMaterial = material === undefined ? null : copyBytes(material);
    const result = this.#database.run(
      "INSERT INTO entries(at_ms, kind, body, material) VALUES (?, ?, ?, ?)",
      [atMs, checked.kind, JSON.stringify(body), storedMaterial],
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

  /** Saves exact JSON serialization semantics, deduplicating top-level input items. */
  storePayload(value: Json): string {
    // Validate the public JSON value, then preserve the serializer's own keys.
    // Zod's defensive record copy omits a literal "__proto__" property.
    copyJson(value);
    return this.storePayloadJson(JSON.stringify(value));
  }

  storePayloadJson(encoded: string): string {
    const checked = JSON.parse(z.string().parse(encoded)) as Json;
    const full = JSON.stringify(checked);
    const hash = digest(full);
    const input =
      object(checked) && Array.isArray(checked.input)
        ? checked.input
        : undefined;
    const parts = input?.map((item) => {
      const body = JSON.stringify(item);
      return { body, digest: digest(body) };
    });
    // Replacing an existing property preserves its original JSON key order.
    const body =
      input === undefined
        ? full
        : JSON.stringify({ ...(checked as object), input: [] });
    const bodyDigest = digest(body);
    this.#database
      .transaction(() => {
        const prefix = this.#database
          .query<{ id: bigint; length: bigint }, [string]>(
            `WITH RECURSIVE
              requested AS MATERIALIZED (SELECT key AS position, value AS digest FROM json_each(?)),
              prefix(id, length) AS (
                VALUES(0, 0)
                UNION ALL
                SELECT step.id, prefix.length + 1
                FROM prefix CROSS JOIN requested CROSS JOIN payload_inputs AS step
                WHERE requested.position = prefix.length
                  AND step.parent_id = prefix.id AND step.item_digest = requested.digest
              ) SELECT id, length FROM prefix ORDER BY length DESC LIMIT 1`,
          )
          .get(JSON.stringify(parts?.map((part) => part.digest) ?? []))!;
        let tail = parts === undefined ? null : prefix.id;
        const length = parts?.length ?? 0;
        for (let at = Number(prefix.length); at < length; at++) {
          const part = parts![at]!;
          this.#database.run(
            "INSERT OR IGNORE INTO payload_items(digest,body) VALUES(?,?)",
            [part.digest, part.body],
          );
          tail = BigInt(
            this.#database.run(
              "INSERT INTO payload_inputs(parent_id,item_digest) VALUES(?,?)",
              [tail, part.digest],
            ).lastInsertRowid,
          );
        }
        const previous = this.#database
          .query<PayloadRow, [string]>(
            "SELECT body_digest AS bodyDigest, input_tail AS inputTail, input_length AS inputLength FROM payloads WHERE digest = ?",
          )
          .get(hash);
        if (previous !== null) {
          if (
            previous.bodyDigest !== bodyDigest ||
            previous.inputTail !== tail ||
            previous.inputLength !== BigInt(length)
          )
            throw new Error("stored payload disagrees with its digest");
          return;
        }
        this.#database.run(
          "INSERT OR IGNORE INTO payload_items(digest,body) VALUES(?,?)",
          [bodyDigest, body],
        );
        this.#database.run(
          "INSERT INTO payloads(digest,body_digest,input_tail,input_length) VALUES(?,?,?,?)",
          [hash, bodyDigest, tail, length],
        );
      })
      .immediate();
    return hash;
  }

  payload(value: string): Json {
    const hash = payloadDigest.parse(value);
    const row = this.#database
      .query<PayloadRow & { body: string | null }, [string]>(
        "SELECT payload.body_digest AS bodyDigest, content.body, payload.input_tail AS inputTail, payload.input_length AS inputLength FROM payloads AS payload LEFT JOIN payload_items AS content ON content.digest = payload.body_digest WHERE payload.digest = ?",
      )
      .get(hash);
    if (row === null) throw new Error(`payload not found: ${hash}`);
    if (row.body === null)
      throw new Error(`payload body not found: ${row.bodyDigest}`);
    if (digest(row.body) !== row.bodyDigest)
      throw new Error("payload body digest mismatch");
    let valueJson: Json = JSON.parse(row.body);
    if (row.inputTail !== null) {
      if (
        !object(valueJson) ||
        !Array.isArray(valueJson.input) ||
        valueJson.input.length !== 0
      )
        throw new Error("invalid stored payload input manifest");
      const items = this.#database
        .query<
          { id: bigint; parent: bigint; digest: string; body: string | null },
          [bigint, bigint]
        >(
          `WITH RECURSIVE chain(id, parent_id, item_digest, depth) AS (
            SELECT id, parent_id, item_digest, 1 FROM payload_inputs WHERE id = ?
            UNION ALL
            SELECT step.id, step.parent_id, step.item_digest, chain.depth + 1
            FROM chain JOIN payload_inputs AS step ON step.id = chain.parent_id
            WHERE step.id < chain.id AND chain.depth < ?
          ) SELECT chain.id, chain.parent_id AS parent, chain.item_digest AS digest, item.body
            FROM chain LEFT JOIN payload_items AS item ON item.digest = chain.item_digest
            ORDER BY chain.id`,
        )
        .all(row.inputTail, row.inputLength);
      if (BigInt(items.length) !== row.inputLength)
        throw new Error("invalid stored payload input chain");
      let parent = 0n;
      const values = items.map(
        ({ id, parent: previous, digest: partHash, body }) => {
          if (previous !== parent || id <= parent)
            throw new Error("invalid stored payload input chain");
          parent = id;
          if (body === null)
            throw new Error(`payload item not found: ${partHash}`);
          if (digest(body) !== partHash)
            throw new Error("payload item digest mismatch");
          return JSON.parse(body) as Json;
        },
      );
      if (parent !== row.inputTail)
        throw new Error("invalid stored payload input chain");
      valueJson = { ...valueJson, input: values };
    }
    if (digest(JSON.stringify(valueJson)) !== hash)
      throw new Error("payload digest mismatch");
    return valueJson;
  }

  material(value: EntryId): Uint8Array {
    const candidate = entryId.parse(value);
    const row = this.#database
      .query<MaterialRow, [EntryId]>(
        "SELECT material FROM entries WHERE kind = 'candidate' AND seq = ?",
      )
      .get(candidate);
    if (row === null) throw new Error(`candidate not found: ${candidate}`);
    return copyBytes(row.material);
  }

  close(): void {
    this.#database.close(true);
  }
}
