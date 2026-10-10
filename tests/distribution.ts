import assert from "node:assert/strict";
import { $ } from "bun";
import { access, mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json";

const root = resolve(import.meta.dir, "..");
assert.equal(manifest.license, "MIT");
for (const file of ["LICENSE", "vendor/pi/LICENSE"])
  assert.match(
    await readFile(join(root, file), "utf8"),
    /MIT License[\s\S]*Permission is hereby granted/,
  );
for (const file of Object.values(manifest.exports))
  await access(join(root, file));
for (const file of Object.values(manifest.bin))
  assert.match(
    await readFile(join(root, file), "utf8"),
    /^#!\/usr\/bin\/env bun\n/,
  );
await access(join(root, "bun.lock"));

const { inspect } = await import(manifest.name);
const { readReport, readStatus } = await import(`${manifest.name}/report`);
await using temporary = await mkdtempDisposable(
  join(tmpdir(), "xean-package-smoke-"),
);
const directory = temporary.path;
async function run(file: string, ...args: string[]) {
  return $`${process.execPath} --no-install --no-env-file ${join(root, file)} ${args} < /dev/null`
    .cwd(directory)
    .text();
}

assert.equal(
  (await run(manifest.bin.xean, "--version")).trim(),
  manifest.version,
);
assert.match(await run(manifest.bin.xean, "--help"), /inspect/);
assert.match(
  await $`${process.execPath} run pi --help`.cwd(root).quiet().text(),
  /auth/,
);
const task = join(root, "examples/task.json");
const initialized = JSON.parse(
  await run(
    manifest.bin.xean,
    "init",
    task,
    "quickstart",
    join(root, "examples/settings.json"),
  ),
);
assert.equal(initialized.status, "running");
assert.equal(initialized.acceptedNoteId, null);
assert.equal(initialized.calls, undefined);
assert.equal(initialized.usageNote, undefined);
const quickstart = join(directory, ".xean/quickstart/campaign.sqlite");
const inspected = JSON.parse(
  await run(manifest.bin.xean, "inspect", "quickstart"),
);
assert.deepEqual(inspected.task, await Bun.file(task).json());
assert.deepEqual(await inspect(quickstart, readStatus), initialized);
assert.equal(inspected.status.calls.recordedResponses, 0);
assert.equal(inspected.status.calls.codexInvocations, 0);
assert.deepEqual(inspected, await inspect(quickstart, readReport));
for (const [command, expected] of [
  ["pause", "paused"],
  ["cancel", "cancelled"],
] as const) {
  const changed = JSON.parse(
    await run(manifest.bin.xean, command, "quickstart"),
  );
  assert.equal(changed.status, expected);
  assert.deepEqual(await inspect(quickstart, readStatus), changed);
  assert.deepEqual(
    (await inspect(quickstart, readReport)).status.calls,
    inspected.status.calls,
  );
}
const result = JSON.parse(
  await run("examples/model-free.ts", "campaign.sqlite"),
);
assert.equal(result.status, "completed");
assert.match(result.acceptedNoteId, /^\d+\/n1$/);
assert.deepEqual(result.calls, inspected.status.calls);
const completed = JSON.parse(
  await run(manifest.bin.xean, "run", "campaign.sqlite"),
);
assert.deepEqual(
  completed,
  await inspect(join(directory, "campaign.sqlite"), readStatus),
);
assert.equal(
  JSON.parse(await run(manifest.bin.xean, "status", "campaign.sqlite"))
    .acceptedNoteId,
  result.acceptedNoteId,
);
assert.equal(
  await run(manifest.bin.xean, "export", "campaign.sqlite"),
  `## ${result.acceptedNoteId}\n\n1 = 1.\n\nBy reflexivity, 1 = 1.\n`,
);
console.log(
  `Source distribution ${manifest.version}: public imports, credential-free init/pause/cancel, model-free solve, CLI inspection/export outside the source directory, licenses, and pinned dependencies passed.`,
);
