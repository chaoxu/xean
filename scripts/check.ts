import { resolve } from "node:path";
import { verifyInstall } from "./dependencies.ts";

if (!process.argv.includes("--write"))
  await verifyInstall(resolve(import.meta.dir, ".."));

const formatPaths = [
  "tests",
  "examples",
  "experiments",
  "scripts",
  "packages",
  "vendor",
  "README.md",
  "CHANGELOG.md",
  "AGENTS.md",
  "docs",
  "package.json",
  "tsconfig.json",
];
const format = [
  "node_modules/prettier/bin/prettier.cjs",
  "--no-error-on-unmatched-pattern",
  process.argv.includes("--write") ? "--write" : "--check",
  ...formatPaths,
];
const commands = process.argv.includes("--write")
  ? [format]
  : [
      ["node_modules/typescript/bin/tsc", "--noEmit"],
      format,
      ["scripts/check-distribution.ts"],
      ["test", "tests"],
    ];

let failed = false;
for (const args of commands) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd: import.meta.dir + "/..",
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) failed = true;
}
if (failed) process.exit(1);
