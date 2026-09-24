import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCampaign, openCampaign, openReader, type Json } from "../src";

const directories: string[] = [];
function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xean-payload-"));
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

  test("round-trips scalar, array, and object payloads", () => {
    const campaign = createCampaign(temporaryPath(), "payload", null);
    for (const value of [
      null,
      true,
      42,
      "text",
      'Unicode α, control \u0000, quotes " and a lone surrogate \ud800',
      [1, 2],
      { input: "literal", payloadRef: "literal" },
      { input: [] },
    ] satisfies Json[]) {
      expect(campaign.storePayload(value)).toBe(
        campaign.storePayloadJson(JSON.stringify(value)),
      );
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

  test("malformed serialized payloads write nothing", () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    for (const encoded of ["{", "undefined", "NaN", '{"input": [1,]}'])
      expect(() => campaign.storePayloadJson(encoded)).toThrow();
    campaign.close();
    const database = new Database(path, { readonly: true });
    expect(database.query("SELECT count(*) n FROM payloads").get()).toEqual({
      n: 0,
    });
    database.close();
  });

  test("object payloads retain validation and snapshot mutable input", () => {
    const campaign = createCampaign(temporaryPath(), "payload", null);
    for (const value of [NaN, Infinity, { input: [NaN] }])
      expect(() => campaign.storePayload(value)).toThrow();
    const input = [{ text: "original" }];
    const hash = campaign.storePayload({ input });
    input[0]!.text = "changed";
    input.push({ text: "added" });
    expect(campaign.payload(hash)).toEqual({ input: [{ text: "original" }] });
    campaign.close();
  });

  test("writers share identical payloads and a reopened campaign reads them", () => {
    const path = temporaryPath(),
      first = createCampaign(path, "payload", null),
      second = openCampaign(path);
    const payload = { input: ["a", "b", "c"] };
    const hash = first.storePayload(payload);
    expect(second.storePayload(payload)).toBe(hash);
    first.close();
    second.close();
    const resumed = openCampaign(path);
    const extension = { input: ["a", "b", "c", "e"] };
    const extended = resumed.storePayload(extension);
    resumed.close();
    const reader = openReader(path);
    expect(reader.payload(hash)).toEqual(payload);
    expect(reader.payload(extended)).toEqual(extension);
    reader.close();
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT count(*) n FROM payloads").get()).toEqual({
      n: 2,
    });
    db.close();
  });

  test("stored payloads are immutable", () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    campaign.storePayload({ input: [{ text: "saved" }] });
    campaign.close();
    const db = new Database(path, { readwrite: true });
    expect(() => db.run("UPDATE payloads SET body=body")).toThrow(
      "append-only",
    );
    expect(() => db.run("DELETE FROM payloads")).toThrow("append-only");
    db.close();
  });

  test("rejects a corrupt stored payload body", () => {
    const path = temporaryPath(),
      campaign = createCampaign(path, "payload", null);
    const hash = campaign.storePayload({
      instructions: "original",
      input: [1],
    });
    campaign.close();
    const db = new Database(path, { readwrite: true });
    db.run("DROP TRIGGER payloads_no_update");
    db.run("UPDATE payloads SET body='null' WHERE digest=?", [hash]);
    db.close();
    const reader = openReader(path);
    expect(() => reader.payload(hash)).toThrow("payload digest mismatch");
    reader.close();
  });
});
