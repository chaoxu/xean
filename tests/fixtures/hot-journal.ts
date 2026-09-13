import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const [path, marker] = process.argv.slice(2);
if (path === undefined || marker === undefined) {
  throw new Error("missing fixture arguments");
}

const database = new Database(path, { create: false, readwrite: true });
database.run("PRAGMA cache_size = 10");
database.run("PRAGMA cache_spill = ON");
database.run("BEGIN IMMEDIATE");
database.run(
  "INSERT INTO entries(at_ms, kind, body, material) VALUES (?, ?, ?, ?)",
  [
    Date.now(),
    "candidate",
    JSON.stringify({ requiredVerifiers: ["audit/v1"] }),
    new Uint8Array(2 * 1024 * 1024),
  ],
);
writeFileSync(marker, "ready");
setInterval(() => {}, 1_000);
