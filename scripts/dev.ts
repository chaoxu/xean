import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import manifest from "../package.json";

const root = resolve(import.meta.dir, "..");
const [command = "check", ...args] = process.argv.slice(2);
const formatPaths = [
  "src",
  "apps",
  "tests",
  "scripts",
  "examples",
  "docs",
  "package.json",
  "tsconfig.json",
  "README.md",
  "AGENTS.md",
];
async function run(argv: string[], cwd = root, env = process.env) {
  const code = await Bun.spawn([process.execPath, "--no-env-file", ...argv], {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
  }).exited;
  assert.equal(code, 0, `Command failed: ${argv[0]}`);
}

if (command === "check" || command === "test") {
  if (command === "check") {
    await run(["node_modules/typescript/bin/tsc", "--noEmit"]);
    await run([
      "node_modules/prettier/bin/prettier.cjs",
      "--check",
      ...formatPaths,
    ]);
    await run(["scripts/dependencies.ts"]);
  }
  await run(["test", ...(args.length ? args : ["tests"])]);
} else if (command === "format") {
  assert.equal(args.length, 0, "Usage: scripts/dev.ts format");
  await run([
    "node_modules/prettier/bin/prettier.cjs",
    "--write",
    ...formatPaths,
  ]);
} else if (command === "distribution" || command === "pack") {
  assert.ok(
    args.length <= (command === "pack" ? 1 : 0),
    "Usage: scripts/dev.ts distribution|pack [ARCHIVE]",
  );
  await using directory = await mkdtempDisposable(
    resolve(tmpdir(), "xean-package-"),
  );
  const env = {
    PATH: dirname(process.execPath),
    BUN_INSTALL_CACHE_DIR: resolve(directory.path, "cache"),
    PI_CODING_AGENT_DIR: resolve(directory.path, "pi"),
  };
  const archive = resolve(directory.path, "source.tgz");
  await run(
    ["pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive],
    root,
    env,
  );
  // Bun's npm-style packer omits its lockfile. Source releases retain it.
  const files = await new Bun.Archive(await Bun.file(archive).bytes()).files();
  const lockfile = await Bun.file(resolve(root, "bun.lock")).text();
  const bytes = await new Bun.Archive(
    {
      ...Object.fromEntries(files),
      "package/bun.lock": lockfile,
    },
    { compress: "gzip" },
  ).bytes();
  await new Bun.Archive(bytes).extract(directory.path);
  const source = resolve(directory.path, "package");
  assert.equal(await Bun.file(resolve(source, "bun.lock")).text(), lockfile);
  await run(
    ["install", "--production", "--frozen-lockfile", "--ignore-scripts"],
    source,
    env,
  );
  await run(["scripts/check-distribution.ts"], source, env);
  const output =
    command === "pack"
      ? resolve(args[0] ?? `dist/${manifest.name}-${manifest.version}.tgz`)
      : undefined;
  if (output) await Bun.write(output, bytes);
  console.log(
    JSON.stringify({
      distribution: "PASS",
      archive: output,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
    }),
  );
} else {
  throw new Error(
    "Usage: scripts/dev.ts check|test [TEST_FILES...]|format|distribution|pack [ARCHIVE]",
  );
}
