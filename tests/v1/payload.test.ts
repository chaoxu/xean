import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCampaign, openCampaign, openReader, type Json } from "../../src";

const directories: string[] = [];
function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "elenx-payload-"));
  directories.push(directory);
  return join(directory, "campaign.db");
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});

describe("immutable request payloads", () => {
  test("reconstructs captured JSON key order and literal reference-like values", async () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    const payload: Json = {
      model: "synthetic",
      input: [
        { type: "reasoning", encrypted_content: "abc", summary: [] },
        {
          payloadRef: "a".repeat(64),
          $ref: "literal",
          input_hashes: ["ordinary data"],
        },
        null,
        false,
        7,
        "Unicode α and a literal \\u0000",
      ],
      tools: [],
      instructions: "after input",
    };
    const captured = JSON.stringify(payload);
    const digest = campaign.storePayload(payload);
    expect(digest).toBe(
      new Bun.CryptoHasher("sha256").update(captured).digest("hex"),
    );
    expect(JSON.stringify(campaign.payload(digest))).toBe(captured);
    expect(campaign.storePayload(payload)).toBe(digest);
    const receipt = await campaign.call(
      { label: "reference", request: { payloadRef: digest } },
      async () => ({ payloadRef: "literal" }),
    );
    const entry = campaign.record(receipt.call);
    expect(entry?.kind === "call" ? entry.request : null).toEqual({
      payloadRef: digest,
    });
    expect(campaign.record(receipt.call + 1)).toMatchObject({
      output: { payloadRef: "literal" },
    });
    const changed = campaign.payload(digest) as { input: Json[] };
    changed.input[0] = "changed";
    expect(JSON.stringify(campaign.payload(digest))).toBe(captured);
    campaign.close();
    const reader = openReader(path);
    expect(JSON.stringify(reader.payload(digest))).toBe(captured);
    expect(reader.record(receipt.call)).toEqual(entry);
    expect(() => reader.payload("invalid")).toThrow();
    expect(() => reader.payload("f".repeat(64))).toThrow("payload not found");
    reader.close();
  });

  test("round-trips payloads with no top-level input array", () => {
    const campaign = createCampaign(temporaryPath(), "payload", null);
    for (const value of [
      null,
      true,
      42,
      "text",
      [1, 2],
      { input: "literal", payloadRef: "literal" },
      { input: [] },
    ] satisfies Json[]) {
      expect(campaign.payload(campaign.storePayload(value))).toEqual(value);
      expect(
        campaign.payload(campaign.storePayloadJson(JSON.stringify(value))),
      ).toEqual(value);
    }
    campaign.close();
  });

  test("serialized payloads normalize JSON syntax and preserve literal keys", () => {
    const campaign = createCampaign(temporaryPath(), "payload", null);
    const encoded =
      ' { "model": "old", "input": [1e400, -0, 1.0, {"__proto__": {"safe": true}}], "model": "new", "__proto__": {"safe": true} } ';
    const canonical = JSON.stringify(JSON.parse(encoded));
    const hash = campaign.storePayloadJson(encoded);
    expect(hash).toBe(
      new Bun.CryptoHasher("sha256").update(canonical).digest("hex"),
    );
    expect(JSON.stringify(campaign.payload(hash))).toBe(canonical);
    expect(campaign.storePayload(JSON.parse(canonical))).toBe(hash);
    expect(campaign.storePayloadJson(canonical)).toBe(hash);
    expect(({} as { safe?: unknown }).safe).toBeUndefined();
    campaign.close();
  });

  test("malformed serialized payloads cannot write items or manifests", () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    for (const encoded of ["{", "undefined", "NaN", '{"input": [1,]}'])
      expect(() => campaign.storePayloadJson(encoded)).toThrow();
    campaign.close();
    const database = new Database(path, { readonly: true });
    for (const table of ["payloads", "payload_items", "payload_inputs"])
      expect(database.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({
        n: 0,
      });
    database.close();
  });

  test("object payloads retain validation and snapshot mutable input", () => {
    const campaign = createCampaign(temporaryPath(), "payload", null);
    for (const value of [NaN, Infinity, { input: [NaN] }])
      expect(() => campaign.storePayload(value)).toThrow();
    let reads = 0;
    const captured = campaign.storePayload({
      get input() {
        return [{ read: ++reads }];
      },
    });
    expect(reads).toBe(2);
    expect(campaign.payload(captured)).toEqual({ input: [{ read: 2 }] });
    const input = [{ text: "original" }];
    const hash = campaign.storePayload({ input });
    input[0]!.text = "changed";
    input.push({ text: "added" });
    expect(campaign.payload(hash)).toEqual({ input: [{ text: "original" }] });
    campaign.close();
  });

  test("round-trips a large ordered input manifest in one bounded read", () => {
    const campaign = createCampaign(temporaryPath(), "payload", null);
    const input = Array.from({ length: 1_200 }, (_, index) => ({
      index,
      text: `item-${index}`,
    }));
    const value = { before: true, input, after: true } satisfies Json;
    const digest = campaign.storePayload(value);
    expect(campaign.payload(digest)).toEqual(value);
    campaign.close();
  });

  test("preserves literal prototype and reference keys without interpreting them", () => {
    const campaign = createCampaign(temporaryPath(), "payload", null);
    const captured =
      '{"__proto__":{"safe":true},"input":[{"__proto__":{"safe":true},"$ref":"literal","payloadRef":"literal"}],"constructor":"literal"}';
    const hash = campaign.storePayload(JSON.parse(captured));
    expect(JSON.stringify(campaign.payload(hash))).toBe(captured);
    expect(
      Object.prototype.hasOwnProperty.call(campaign.payload(hash), "__proto__"),
    ).toBe(true);
    expect(({} as { safe?: unknown }).safe).toBeUndefined();
    campaign.close();
  });

  test("a thousand related requests share items and branching prefixes", () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    const shared = [
      { type: "reasoning", id: "one", encrypted_content: "a".repeat(16384) },
      { type: "reasoning", id: "two", encrypted_content: "b".repeat(16384) },
    ];
    let originalBytes = 0;
    const hashes: string[] = [];
    for (let n = 0; n < 1000; n++) {
      const payload = {
        model: "synthetic",
        input: [...shared, { type: "user", text: `next ${n}` }],
        request: n,
      };
      originalBytes += Buffer.byteLength(JSON.stringify(payload));
      hashes.push(campaign.storePayload(payload));
    }
    expect(campaign.payload(hashes[0]!)).toEqual({
      model: "synthetic",
      input: [...shared, { type: "user", text: "next 0" }],
      request: 0,
    });
    expect(campaign.payload(hashes[999]!)).toEqual({
      model: "synthetic",
      input: [...shared, { type: "user", text: "next 999" }],
      request: 999,
    });
    campaign.close();
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT count(*) n FROM payload_items").get()).toEqual({
      n: 1002,
    });
    expect(db.query("SELECT count(*) n FROM payload_inputs").get()).toEqual({
      n: 1002,
    });
    expect(db.query("SELECT count(*) n FROM payloads").get()).toEqual({
      n: 1000,
    });
    expect(statSync(path).size).toBeLessThan(originalBytes / 10);
    db.close();
  }, 20_000);

  test("growing requests store each prefix once instead of complete hash lists", () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    const input: Json[] = [{ text: "r".repeat(16384) }];
    const hashes: string[] = [];
    for (let request = 0; request < 256; request++) {
      input.push(...[0, 1, 2].map((part) => ({ request, part })));
      hashes.push(campaign.storePayload({ input, request }));
    }
    expect(campaign.payload(hashes[0]!)).toEqual({
      input: input.slice(0, 4),
      request: 0,
    });
    expect(campaign.payload(hashes.at(-1)!)).toEqual({ input, request: 255 });
    campaign.close();
    const db = new Database(path, { readonly: true });
    for (const table of ["payload_items", "payload_inputs"])
      expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({
        n: 769,
      });
    expect(db.query("SELECT count(*) n FROM payloads").get()).toEqual({
      n: 256,
    });
    // Complete lists alone would exceed 6 MiB for these 98,944 item hashes.
    expect(statSync(path).size).toBeLessThan(2 * 1024 * 1024);
    db.close();
  });

  test("writers share exact prefixes across branches, reordering, and reopening", () => {
    const path = temporaryPath(),
      first = createCampaign(path, "payload", null),
      second = openCampaign(path);
    const inputs = [
      ["a", "b", "c"],
      ["a", "b", "d"],
      ["a", "a", "b"],
      ["c", "b", "a"],
      ["a", "b"],
      [],
    ];
    const hashes = inputs.map((input, index) =>
      (index % 2 === 0 ? first : second).storePayload({ input }),
    );
    expect(second.storePayload({ input: inputs[0]! })).toBe(hashes[0]!);
    first.close();
    second.close();
    const resumed = openCampaign(path);
    const extension = { input: ["a", "b", "c", "e"] };
    const extended = resumed.storePayload(extension);
    resumed.close();
    const reader = openReader(path);
    expect(hashes.map((hash) => reader.payload(hash))).toEqual(
      inputs.map((input) => ({ input })),
    );
    expect(reader.payload(extended)).toEqual(extension);
    reader.close();
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT count(*) n FROM payload_inputs").get()).toEqual({
      n: 10,
    });
    db.close();
  });

  test("payload and item insertion is atomic and existing bytes are immutable", () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    const saved = campaign.storePayload({ input: [{ text: "saved" }] });
    const db = new Database(path, { readwrite: true });
    db.run(
      "CREATE TRIGGER reject_payload BEFORE INSERT ON payloads BEGIN SELECT RAISE(ABORT, 'test rejection'); END",
    );
    expect(() =>
      campaign.storePayload({ input: [{ text: "saved" }, { text: "atomic" }] }),
    ).toThrow("test rejection");
    for (const table of ["payloads", "payload_items", "payload_inputs"])
      expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({
        n: 1,
      });
    expect(campaign.payload(saved)).toEqual({ input: [{ text: "saved" }] });
    db.run("DROP TRIGGER reject_payload");
    campaign.storePayload({ input: [{ text: "atomic" }] });
    for (const table of ["payloads", "payload_items", "payload_inputs"]) {
      const field = table === "payload_inputs" ? "parent_id" : "body";
      expect(() => db.run(`UPDATE ${table} SET ${field}=${field}`)).toThrow(
        "append-only",
      );
      expect(() => db.run(`DELETE FROM ${table}`)).toThrow("append-only");
    }
    db.close();
    campaign.close();
  });

  test("rejects missing, corrupt, and reordered stored items", () => {
    for (const corruption of ["missing", "body", "order"] as const) {
      const path = temporaryPath(),
        campaign = createCampaign(path, "payload", null);
      const hash = campaign.storePayload({
        before: 1,
        input: [{ text: "first" }, { text: "second" }],
        after: 2,
      });
      campaign.close();
      const db = new Database(path, { readwrite: true });
      if (corruption === "missing") {
        db.run("DROP TRIGGER payload_items_no_delete");
        db.run(
          "DELETE FROM payload_items WHERE digest=(SELECT digest FROM payload_items LIMIT 1)",
        );
      } else if (corruption === "body") {
        db.run("DROP TRIGGER payload_items_no_update");
        db.run(
          "UPDATE payload_items SET body='null' WHERE digest=(SELECT digest FROM payload_items LIMIT 1)",
        );
      } else {
        const rows = db
          .query<{ item_digest: string }, []>(
            "SELECT item_digest FROM payload_inputs ORDER BY id",
          )
          .all();
        db.run("DROP TRIGGER payload_inputs_no_update");
        db.run(
          "UPDATE payload_inputs SET item_digest=CASE id WHEN 1 THEN ? ELSE ? END",
          [rows[1]!.item_digest, rows[0]!.item_digest],
        );
      }
      db.close();
      const reader = openReader(path);
      expect(() => reader.payload(hash)).toThrow(
        corruption === "missing"
          ? "payload item not found"
          : corruption === "body"
            ? "payload item digest mismatch"
            : "payload digest mismatch",
      );
      reader.close();
    }
  });

  test("rejects missing, truncated, and cyclic prefix chains", () => {
    for (const corruption of [
      "missing",
      "parent",
      "cycle",
      "tail",
      "length",
    ] as const) {
      const path = temporaryPath(),
        campaign = createCampaign(path, "payload", null);
      const hash = campaign.storePayload({
        input: ["first", "middle", "last"],
      });
      campaign.close();
      const db = new Database(path, { readwrite: true });
      if (corruption === "missing") {
        db.run("DROP TRIGGER payload_inputs_no_delete");
        db.run("DELETE FROM payload_inputs WHERE id=2");
      } else if (corruption === "parent" || corruption === "cycle") {
        db.run("DROP TRIGGER payload_inputs_no_update");
        if (corruption === "cycle")
          db.run("PRAGMA ignore_check_constraints=ON");
        db.run("UPDATE payload_inputs SET parent_id=? WHERE id=2", [
          corruption === "cycle" ? 3 : 0,
        ]);
      } else {
        db.run("DROP TRIGGER payloads_no_update");
        db.run(
          corruption === "tail"
            ? "UPDATE payloads SET input_tail=999999"
            : "UPDATE payloads SET input_length=999999",
        );
      }
      db.close();
      const reader = openReader(path);
      expect(() => reader.payload(hash)).toThrow();
      reader.close();
    }
  });
});
