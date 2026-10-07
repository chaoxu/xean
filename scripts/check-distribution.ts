import assert from "node:assert/strict";
import { $ } from "bun";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import manifest from "../package.json";
import { verifyInstall } from "./dependencies.ts";
import { api } from "../apps/observe/server.ts";

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

const { inspect } = await import(manifest.name);
const { readReport } = await import(`${manifest.name}/report`);
const directory = await mkdtemp(join(tmpdir(), "xean-package-smoke-"));
async function run(file: string, ...args: string[]) {
  return $`${process.execPath} --no-install --no-env-file ${join(root, file)} ${args} < /dev/null`
    .cwd(directory)
    .text();
}

try {
  assert.equal(
    (await run(manifest.bin.xean, "--version")).trim(),
    manifest.version,
  );
  assert.match(await run(manifest.bin.xean, "--help"), /inspect/);
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
  assert.equal(initialized.calls.recordedResponses, 0);
  assert.equal(initialized.calls.codexInvocations, 0);
  const quickstart = join(directory, ".xean/quickstart/campaign.sqlite");
  const inspected = JSON.parse(
    await run(manifest.bin.xean, "inspect", "quickstart"),
  );
  assert.deepEqual(inspected.task, await Bun.file(task).json());
  assert.deepEqual(inspected.status, initialized);
  assert.deepEqual(inspected, await inspect(quickstart, readReport));
  for (const [command, expected] of [
    ["pause", "paused"],
    ["cancel", "cancelled"],
  ] as const) {
    const changed = JSON.parse(
      await run(manifest.bin.xean, command, "quickstart"),
    );
    assert.equal(changed.status, expected);
    assert.deepEqual(changed.calls, initialized.calls);
    assert.deepEqual((await inspect(quickstart, readReport)).status, changed);
  }
  const path = join(directory, "campaign.sqlite");
  const result = JSON.parse(
    await run("examples/model-free.ts", "campaign.sqlite"),
  );
  assert.equal(result.status, "completed");
  assert.match(result.acceptedNoteId, /^\d+\/n1$/);
  assert.deepEqual(result.calls, initialized.calls);
  assert.equal(
    JSON.parse(await run(manifest.bin.xean, "status", "campaign.sqlite"))
      .acceptedNoteId,
    result.acceptedNoteId,
  );
  assert.equal(
    await run(manifest.bin.xean, "export", "campaign.sqlite"),
    `## ${result.acceptedNoteId}\n\n1 = 1.\n\nBy reflexivity, 1 = 1.\n`,
  );
  const observation = await (
    await api([{ id: "smoke", database: path }])(
      new Request("http://localhost/api/runs/smoke"),
    )
  ).json();
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
    `Source distribution ${manifest.version}: public imports, credential-free init/pause/cancel, model-free solve, CLI inspection/export outside the source directory, browser assets, licenses, and pinned dependencies passed.`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
