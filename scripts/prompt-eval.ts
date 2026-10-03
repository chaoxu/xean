import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inspectCampaign } from "xean";
import { readSettings, type Note, type SolverResult } from "xean/solve";
import { statusReport, usageRecord } from "xean/report";
import cases from "../examples/prompt-cases.json";
import { verifyInstall } from "./dependencies.ts";

const root = resolve(import.meta.dir, "..");
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function sourceHashes() {
  const files: string[] = [];
  for await (const file of new Bun.Glob(
    "{packages/{core,cli}/**/*.ts,packages/*/package.json,scripts/*.ts,examples/prompt-cases.json,package.json,bun.lock,vendor/pi/provenance.json,patches/*}",
  ).scan({ cwd: root, onlyFiles: true }))
    files.push(file);
  return Object.fromEntries(
    await Promise.all(
      files
        .sort()
        .map(async (file) => [
          file,
          digest(await readFile(resolve(root, file))),
        ]),
    ),
  );
}

/** These checks screen known cases; a match does not establish proof quality. */
export function matchesCase(
  expected: { verdict: string; correction?: boolean },
  text: string,
  result: SolverResult | null,
): boolean {
  if (result?.kind !== "verification" || result.checks.length !== 1)
    return false;
  const check = result.checks[0]!;
  return (
    check.noteId === "n1" &&
    check.correctness?.verdict === expected.verdict &&
    (expected.verdict !== "PASS" || check.correctness.premises.length === 0) &&
    (!expected.correction ||
      (check.correction?.text === text &&
        check.correction.summary.length > 0 &&
        check.correction.detailedSummary.length > 0))
  );
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { run: { type: "boolean", default: false } },
  });
  assert.equal(
    positionals.length,
    2,
    "Usage: scripts/prompt-eval.ts SETTINGS.json NEW_OUTPUT_DIRECTORY [--run]",
  );
  await verifyInstall(root);
  const settingsBytes = await readFile(resolve(positionals[0]!));
  const settings = readSettings(JSON.parse(settingsBytes.toString()));
  const output = resolve(positionals[1]!);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Refuse to overwrite or accidentally rerun a prior evaluation.
  await writeFile(resolve(output, "settings.json"), settingsBytes);
  const casesBytes = JSON.stringify(cases, null, 2) + "\n";
  await writeFile(resolve(output, "cases.json"), casesBytes);
  const inputs: Record<string, string> = {};
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
    const input = {
      task: {
        problem: "For every real x >= 1, prove x squared >= x.",
        completionCriteria:
          "Give a self-contained proof using elementary real arithmetic.",
      },
      notes: [note],
      targets: [{ id: note.id, through: "correctness" }],
    };
    const inputPath = resolve(directory, "input.json");
    const bytes = JSON.stringify(input, null, 2) + "\n";
    await writeFile(inputPath, bytes);
    inputs[`${example.id}/input.json`] = digest(bytes);
  }
  const source = await sourceHashes();
  const sourceSha256 = digest(JSON.stringify(source));
  const frozen = {
    "settings.json": digest(settingsBytes),
    "cases.json": digest(casesBytes),
    ...inputs,
  };
  const manifest = {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    settingsSha256: frozen["settings.json"],
    casesSha256: frozen["cases.json"],
    inputs,
    source,
    sourceSha256,
    profiles: settings.profiles,
    executed: values.run,
    semanticValidation: "not-performed",
  };
  await writeFile(
    resolve(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const unchanged = async () => {
    assert.equal(
      digest(JSON.stringify(await sourceHashes())),
      sourceSha256,
      "Source changed during evaluation",
    );
    for (const [file, hash] of Object.entries(frozen))
      assert.equal(
        digest(await readFile(resolve(output, file))),
        hash,
        `Frozen input changed: ${file}`,
      );
  };
  const rows = [];
  let interrupted = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    child?.kill("SIGINT");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    for (const example of values.run ? cases : []) {
      if (interrupted) break;
      const directory = resolve(output, example.id);
      const started = performance.now();
      let exitCode: number | null = null;
      let signal: string | null = null;
      let provenanceUnchanged = true;
      let result: SolverResult | null = null;
      let status: ReturnType<typeof statusReport> | null = null;
      const errors: string[] = [];
      try {
        provenanceUnchanged = false;
        await unchanged();
        provenanceUnchanged = true;
        if (interrupted) break;
        child = Bun.spawn(
          [
            process.execPath,
            "--no-install",
            "--no-env-file",
            resolve(root, "packages/cli/src/index.ts"),
            "role",
            "verifier",
            resolve(directory, "input.json"),
            resolve(directory, "campaign.sqlite"),
            resolve(output, "settings.json"),
          ],
          {
            cwd: root,
            stdin: "ignore",
            stdout: Bun.file(resolve(directory, "stdout.json")),
            stderr: Bun.file(resolve(directory, "stderr.log")),
          },
        );
        exitCode = await child.exited;
        signal = child.signalCode;
      } catch (error) {
        errors.push(String(error));
      } finally {
        child = undefined;
      }
      try {
        const snapshot = await inspectCampaign(
          resolve(directory, "campaign.sqlite"),
          usageRecord,
        );
        result = snapshot.campaign.result as SolverResult | null;
        status = statusReport(snapshot);
      } catch (error) {
        errors.push(`Inspection failed: ${String(error)}`);
      }
      try {
        await unchanged();
      } catch (error) {
        provenanceUnchanged = false;
        errors.push(String(error));
      }
      const row = {
        id: example.id,
        expected: example.expected,
        exitCode,
        signal,
        interrupted,
        durationMs: Math.round(performance.now() - started),
        provenanceUnchanged,
        matched:
          !interrupted &&
          errors.length === 0 &&
          exitCode === 0 &&
          status?.status === "completed" &&
          matchesCase(example.expected, example.text, result),
        result,
        status,
        errors,
      };
      rows.push(row);
      await writeFile(
        resolve(output, "results.json"),
        JSON.stringify(rows, null, 2) + "\n",
      );
      console.log(
        JSON.stringify({
          id: row.id,
          matched: row.matched,
          durationMs: row.durationMs,
        }),
      );
      if (interrupted || !provenanceUnchanged) break;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (interrupted) process.exitCode = 130;
  console.log(
    JSON.stringify({
      output,
      executed: values.run,
      cases: cases.length,
      matched: values.run ? rows.filter((row) => row.matched).length : null,
    }),
  );
  if (!process.exitCode && values.run && rows.some((row) => !row.matched))
    process.exitCode = 1;
}
