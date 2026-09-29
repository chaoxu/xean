import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { Xean, openXeanStorage } from "../../packages/core/src/index.ts";
import {
  campaignOptions,
  declarationVersion,
  piRuntime,
  readDeclaration,
  readSettings,
  type SolverInput,
} from "../../packages/core/src/solve/index.ts";
import {
  decode,
  editingSchema,
  type Editing,
} from "../../packages/core/src/solve/contracts.ts";
import {
  closure,
  materializeNotes,
  retainedNotes,
} from "../../packages/core/src/solve/notes.ts";
import { ask } from "../../packages/core/src/solve/pi.ts";
import { fullNote } from "../../packages/core/src/solve/reader.ts";
import { editorContinuation } from "../../packages/core/src/solve/roles.ts";
import { json } from "../../packages/core/src/json.ts";
import { verifyInstall } from "../../scripts/dependencies.ts";

const [promptFile, outputArg] = process.argv.slice(2);
assert(
  promptFile && outputArg && process.argv.length === 4,
  "Usage: run.ts PROMPT.md ABSOLUTE_OUTPUT_DIRECTORY",
);
const output = resolve(outputArg);
assert.equal(output, outputArg, "Output directory must be absolute");
assert.equal(
  dirname(resolve(promptFile)),
  resolve(import.meta.dir, "prompts"),
  "Select a prompt from experiments/editor/prompts",
);
await mkdir(output, { recursive: true });
for (const name of [
  "campaign.sqlite",
  "manifest.json",
  "result.json",
  "records.json",
  "replacement.json",
  "proposals.json",
])
  assert(
    !(await Bun.file(resolve(output, name)).exists()),
    "Use a fresh output directory",
  );
const save = (name: string, value: unknown) =>
  writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const size = (notes: SolverInput["notes"]) => {
  const text = notes.map((note) => note.text).join("\n");
  const mathematics = JSON.stringify(
    notes.map(({ id, summary, detailedSummary, text, support }) => ({
      id,
      summary,
      detailedSummary,
      text,
      support,
    })),
  );
  return {
    notes: notes.length,
    bodyBytes: Buffer.byteLength(text),
    bodyUtf16Chars: text.length,
    mathematicalPayloadBytes: Buffer.byteLength(mathematics),
  };
};
const startedAt = new Date().toISOString();
const started = performance.now();
const proposals: Editing[] = [];
const outcome: Record<string, unknown> = {
  status: "failed",
  error: null,
  result: null,
  calls: null,
  usage: null,
  verification: "not_run",
};
let engine: Xean | undefined;
let cancelled = false;
const redact = (error: unknown) => {
  const key = process.env.XEAN_API_KEY;
  return key ? String(error).replaceAll(key, "[redacted]") : String(error);
};
const stop = () => {
  cancelled = true;
  void engine?.cancel().catch((error) => {
    outcome.error = redact(error);
  });
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await verifyInstall(resolve(import.meta.dir, "../.."));
  const inputText = await readFile(
    resolve(import.meta.dir, "input.json"),
    "utf8",
  );
  const prompt = await readFile(resolve(promptFile), "utf8");
  assert(prompt.trim(), "Prompt must not be empty");
  const input = JSON.parse(inputText) as SolverInput;
  assert.deepEqual(Object.keys(input).sort(), ["notes", "task"]);
  assert(input.notes.length > 0, "The fixed corpus must contain notes");
  closure(
    input.notes.map((note) => note.id),
    input.notes,
  );
  outcome.before = size(input.notes);
  const settingsText = await readFile(
    resolve(import.meta.dir, "settings.json"),
    "utf8",
  );
  const settings = readSettings(JSON.parse(settingsText));
  const responseAllowance = settings.limits?.providerCalls;
  assert(
    responseAllowance === 1 || responseAllowance === 2,
    "Generation admits one or two model calls",
  );
  assert.deepEqual(settings.limits, {
    concurrency: 1,
    attempts: 1,
    providerCalls: responseAllowance,
  });
  settings.usagePrefix =
    process.env.XEAN_USAGE_TAG ?? `editor-golden/${basename(dirname(output))}`;
  readSettings(settings);
  const runtime = piRuntime(settings);
  const profile = runtime.profiles.editor;
  assert.equal(profile.options?.reasoning, "max");
  await save("manifest.json", {
    startedAt,
    sourceCommit: process.env.XEAN_SOURCE_COMMIT ?? null,
    bun: Bun.version,
    settingsSha256: hash(settingsText),
    inputSha256: hash(inputText),
    promptSha256: hash(prompt),
    modelSha256: hash(JSON.stringify(profile.model)),
    model: profile.model.id,
    reasoning: profile.options.reasoning,
    usagePrefix: settings.usagePrefix,
    responseAllowance,
  });
  const options = campaignOptions(
    readDeclaration({
      version: declarationVersion,
      kind: "xean.role",
      role: "editor",
      task: input.task,
      input,
      settings,
    }),
    runtime,
  );
  // The optional second response refines the same draft within Pi's transcript.
  options.roles = [
    {
      name: "editor",
      async run(_input, execution, context) {
        return json(
          await ask(
            runtime,
            "editor",
            prompt,
            { task: input.task, notes: input.notes.map(fullNote) },
            editingSchema,
            execution,
            context,
            {
              maxResponses: responseAllowance,
              continuation:
                responseAllowance === 2 ? editorContinuation : undefined,
              submit(proposal) {
                retainedNotes(proposal, input.notes);
                proposals.push(structuredClone(proposal));
                return {
                  done: responseAllowance === 1,
                  receipt: { validated: true },
                };
              },
            },
          ),
        );
      },
    },
  ];
  engine = await Xean.open(
    await openXeanStorage(resolve(output, "campaign.sqlite")),
    options,
  );
  const campaign = cancelled ? await engine.cancel() : await engine.run();
  const records = await engine.records();
  await save("records.json", records);
  const settled = records.filter(
    (record) => record.kind === "xean.call.settled",
  );
  const usage = settled.map(
    (record) => (record.data as { usage: Usage | null }).usage,
  );
  const known = usage.filter((value): value is Usage => value != null);
  Object.assign(outcome, {
    calls: campaign.providerCalls,
    usage: {
      knownCalls: known.length,
      unknownCalls: settled.length - known.length,
      input: known.reduce((sum, value) => sum + value.input, 0),
      output: known.reduce((sum, value) => sum + value.output, 0),
      cacheRead: known.reduce((sum, value) => sum + value.cacheRead, 0),
      cacheWrite: known.reduce((sum, value) => sum + value.cacheWrite, 0),
      reportedCostUsd: known.reduce((sum, value) => sum + value.cost.total, 0),
    },
  });
  assert.equal(
    records.filter((record) => record.kind === "xean.call.started").length,
    settled.length,
  );
  assert(
    campaign.providerCalls <= responseAllowance,
    "Generation exceeded its frozen call allowance",
  );
  Object.assign(outcome, {
    status: campaign.status,
    error:
      campaign.error ?? campaign.work.find((work) => work.error)?.error ?? null,
    result: campaign.result,
  });
  if (campaign.status === "completed") {
    const proposal = decode(editingSchema, campaign.result);
    const attempt = campaign.work.find(
      (work) => work.role === "editor",
    )?.attemptId;
    assert(attempt, "The completed Editor must have an attempt identity");
    const notes = [
      ...retainedNotes(proposal, input.notes),
      ...materializeNotes(`edit/${attempt}`, proposal.notes),
    ];
    closure(
      notes.map((note) => note.id),
      notes,
    );
    await save("replacement.json", { task: input.task, notes });
    outcome.after = size(notes);
  }
} catch (error) {
  outcome.status = "failed";
  outcome.error = redact(error);
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  try {
    await engine?.close();
  } catch (error) {
    outcome.status = "failed";
    outcome.error = redact(error);
  }
  Object.assign(outcome, {
    validProposals: proposals.length,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - started),
  });
  await save("proposals.json", proposals);
  await save("result.json", outcome);
  console.log(JSON.stringify({ output, ...outcome, result: undefined }));
}
if (outcome.status !== "completed") process.exitCode = 1;
