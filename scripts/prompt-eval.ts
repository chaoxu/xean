import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readSettings, type Note } from "xean/solve";
import cases from "../examples/prompt-cases.json";
import { verifyInstall } from "./dependencies.ts";

const root = resolve(import.meta.dir, "..");
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

assert.equal(
  process.argv.length,
  4,
  "Usage: scripts/prompt-eval.ts SETTINGS.json NEW_OUTPUT_DIRECTORY",
);
await verifyInstall(root);
const settingsBytes = await readFile(resolve(process.argv[2]!));
readSettings(JSON.parse(settingsBytes.toString()));
const casesBytes = await readFile(resolve(root, "examples/prompt-cases.json"));
// Source hashes also identify clean source archives without Git metadata.
const source: Record<string, string> = {};
const sourceFiles = [
  "packages/core/**/*.ts",
  "packages/cli/**/*.ts",
  "packages/*/package.json",
  "scripts/prompt-eval.ts",
  "package.json",
  "bun.lock",
  "vendor/pi/provenance.json",
  "patches/*",
].flatMap((pattern) => [
  ...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true }),
]);
for (const file of sourceFiles.sort())
  source[file] = digest(await readFile(resolve(root, file)));
const output = resolve(process.argv[3]!);
await mkdir(dirname(output), { recursive: true });
await mkdir(output); // A preparation never overwrites a prior experiment.
await writeFile(resolve(output, "settings.json"), settingsBytes);
await writeFile(resolve(output, "cases.json"), casesBytes);
const commands = [];
for (const example of cases) {
  const directory = resolve(output, example.id);
  await mkdir(directory);
  const note: Note = {
    id: "n1",
    summary: example.summary,
    detailedSummary: example.summary,
    text: example.text,
    support: [],
    revision: 0,
    imported: false,
    checks: [],
    verified: false,
    dead: false,
    accepted: false,
    candidate: true,
  };
  const input = json({
    task: {
      problem: "For every real x >= 1, prove x squared >= x.",
      completionCriteria:
        "Give a self-contained proof using elementary real arithmetic.",
    },
    notes: [note],
    targets: [{ id: note.id, through: "correctness" }],
  });
  const inputPath = resolve(directory, "input.json");
  const database = resolve(directory, "campaign.sqlite");
  await writeFile(inputPath, input);
  const cli = [
    process.execPath,
    "--no-install",
    "--no-env-file",
    resolve(root, "packages/cli/src/index.ts"),
  ];
  commands.push({
    id: example.id,
    inputSha256: digest(input),
    argv: [
      ...cli,
      "role",
      "verifier",
      inputPath,
      database,
      resolve(output, "settings.json"),
    ],
    statusArgv: [...cli, "status", database],
  });
}
await writeFile(
  resolve(output, "manifest.json"),
  json({
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    settingsSha256: digest(settingsBytes),
    casesSha256: digest(casesBytes),
    source,
    sourceSha256: digest(JSON.stringify(source)),
    executed: false,
    semanticValidation: "not-performed",
    commands,
  }),
);
console.log(
  JSON.stringify({ output, executed: false, cases: commands.length }),
);
