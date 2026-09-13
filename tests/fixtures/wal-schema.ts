import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";

const [path, marker] = process.argv.slice(2);
if (path === undefined || marker === undefined) throw new Error("missing path");

const database = new Database(path, { create: false, readwrite: true });
database.run("PRAGMA journal_mode = WAL");
database.run("PRAGMA wal_autocheckpoint = 0");
database.run("PRAGMA user_version = 999");
writeFileSync(marker, "ready");
await Bun.sleep(30_000);
