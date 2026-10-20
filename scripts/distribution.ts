import assert from "node:assert/strict";
import {
  access,
  mkdtempDisposable,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json";

const root = resolve(import.meta.dir, "..");
for (const file of ["LICENSE", "vendor/pi/LICENSE"])
  assert.match(
    await readFile(join(root, file), "utf8"),
    /MIT License[\s\S]*Permission is hereby granted/,
  );
for (const file of [
  ...Object.values(manifest.exports),
  ...Object.values(manifest.bin),
  "bun.lock",
])
  await access(join(root, file));
const { open, inspect, readStatus } = await import(manifest.name);
assert.equal(typeof open, "function");
await using temporary = await mkdtempDisposable(
  join(tmpdir(), "xean-distribution-"),
);
async function cli(...args: string[]) {
  const child = Bun.spawn([join(root, manifest.bin.xean), ...args], {
    cwd: temporary.path,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, stderr);
  return stdout;
}
assert.equal((await cli("--version")).trim(), manifest.version);
assert.match(await cli("--help"), /resume/);
const path = join(temporary.path, "campaign.sqlite");
const initialized = JSON.parse(
  await cli(
    "init",
    join(root, "examples/task.json"),
    path,
    join(root, "examples/settings.json"),
  ),
);
assert.equal(initialized.outcome, "running");
assert.equal(initialized.turns, 0);
assert.equal(initialized.accepted, null);
assert.deepEqual(JSON.parse(await cli("status", path)), initialized);
assert.deepEqual(await inspect(path, readStatus), initialized);
const report = JSON.parse(await cli("inspect", path));
assert.deepEqual(
  report.task,
  await Bun.file(join(root, "examples/task.json")).json(),
);
assert.deepEqual(report.notes, []);
assert.equal(report.settings.verifyOnSolution, undefined);
const deferredPath = join(temporary.path, "deferred.sqlite");
await cli(
  "init",
  join(root, "examples/task.json"),
  deferredPath,
  join(root, "examples/settings.json"),
  "--verify-on-solution",
);
assert.equal(
  JSON.parse(await cli("inspect", deferredPath)).settings.verifyOnSolution,
  true,
);
const notesPath = join(temporary.path, "notes.json");
const guidancePath = join(temporary.path, "guidance.txt");
await writeFile(
  notesPath,
  JSON.stringify({ notes: [{ text: "A caller lemma.", support: [] }] }),
);
await writeFile(guidancePath, "Try an elementary argument.");
const submitted = JSON.parse(
  await cli("submit", path, notesPath, "--id", "notes"),
);
assert.deepEqual(
  JSON.parse(await cli("submit", path, notesPath, "--id", "notes")),
  submitted,
);
const guidance = JSON.parse(
  await cli("guide", path, guidancePath, "--id", "guidance"),
);
assert.equal(guidance.text, "Try an elementary argument.");
const queued = JSON.parse(await cli("inspect", path));
assert.equal(queued.inputs.length, 1);
assert.equal(queued.inputs[0].consumed, false);
assert.equal(queued.guidance.length, 1);
assert.deepEqual(queued.status, initialized);
console.log(
  "Source distribution: public import, CLI identity, credential-free initialization, input admission, and inspection, licenses, and pinned dependencies passed.",
);
