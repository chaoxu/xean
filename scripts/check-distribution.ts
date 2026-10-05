import assert from "node:assert/strict";
import { $ } from "bun";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json";
import { verifyInstall } from "./dependencies.ts";
import { readRun } from "../apps/observe/read.ts";

const root = resolve(import.meta.dir, "..");
await verifyInstall(root);
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
for (const file of [
  "bun.lock",
  "apps/cli/prompt-cases.json",
  "apps/observe/web/chao-ui.css",
])
  await access(join(root, file));

async function run(file: string, ...args: string[]) {
  return $`${process.execPath} --no-install --no-env-file ${join(root, file)} ${args} < /dev/null`
    .cwd(root)
    .text();
}

const directory = await mkdtemp(join(tmpdir(), "xean-package-smoke-"));
try {
  assert.equal(
    (await run(manifest.bin.xean, "--version")).trim(),
    manifest.version,
  );
  assert.match(await run(manifest.bin.xean, "--help"), /inspect/);
  const path = join(directory, "campaign.sqlite");
  const result = JSON.parse(await run("examples/model-free.ts", path));
  assert.equal(result.status, "completed");
  assert.match(result.acceptedNoteId, /^\d+\/n1$/);
  assert.equal(
    JSON.parse(await run(manifest.bin.xean, "status", path)).acceptedNoteId,
    result.acceptedNoteId,
  );
  assert.equal(
    await run(manifest.bin.xean, "export", path),
    `## ${result.acceptedNoteId}\n\n1 = 1.\n\nBy reflexivity, 1 = 1.\n`,
  );
  const observation = await readRun({ id: "smoke", database: path });
  assert.equal(
    observation.snapshot?.status.acceptedNoteId,
    result.acceptedNoteId,
  );
  const built = await Bun.build({
    entrypoints: [join(root, "apps/observe/web/index.html")],
    outdir: join(directory, "web"),
    target: "browser",
  });
  assert.ok(built.success, built.logs.join("\n"));
  assert.ok(built.outputs.some((output) => output.path.endsWith(".html")));
  console.log(
    `Distribution ${manifest.version}: library, CLI, local inspection, browser assets, licenses, and pinned dependencies passed.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
