import assert from "node:assert/strict";
import { resolve } from "node:path";
import { smokeSetup } from "./smoke.ts";

const { root, bun, env, credential, runId, directory } =
  await smokeSetup("solver");
const settings = await Bun.file(
  resolve(root, "examples/solver-settings.json"),
).json();
settings.profiles.default = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "max",
  baseUrl: "https://codex-lb.lab/backend-api/codex",
  transport: "websocket-cached",
};
settings.usagePrefix = `xean-solver/${runId}`;
settings.limits = {
  concurrency: 2,
  attempts: 1,
};
const settingsPath = resolve(directory, "settings.json");
await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n");
const taskPath = resolve(root, "examples/tree-task.json");
const campaignPath = resolve(directory, "campaign.sqlite");
const key = credential.toString().trim();
const cli = resolve(root, "packages/cli/src/index.ts");
const run = async (name: string, args: string[], authenticated = false) => {
  const child = Bun.spawn([...bun, cli, ...args], {
    env,
    stdin: authenticated ? credential : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.ok(
    !stdout.includes(key) && !stderr.includes(key),
    "Credential must not reach artifacts",
  );
  await Bun.write(resolve(directory, `${name}.json`), stdout);
  await Bun.write(resolve(directory, `${name}.stderr`), stderr);
  assert.equal(code, 0, `${name} failed: ${stderr}`);
  return JSON.parse(stdout);
};
const initialized = await run("init", [
  "init",
  taskPath,
  campaignPath,
  settingsPath,
]);
assert.equal(initialized.providerCalls, 0);
const args = ["run", campaignPath];
const receipt = await run("live", [...args, "--key-stdin"], true);
const inspect = ["inspect", campaignPath, "--records"];
const live = await run("inspection", inspect);
assert.equal(receipt.providerCalls, live.campaign.providerCalls);
assert.equal(
  live.campaign.status,
  "completed",
  live.campaign.error ?? "Solver did not accept an argument",
);
assert.ok(live.notes.some((note: { accepted: boolean }) => note.accepted));
await run("reopened", args);
const reopened = await run("reopened-inspection", inspect);
assert.deepEqual(
  reopened,
  live,
  "Completed reopen must make no calls or change records",
);
await Bun.write(
  resolve(directory, "argument.md"),
  live.campaign.result.argument + "\n",
);
console.log(
  JSON.stringify({
    directory,
    status: live.campaign.status,
    calls: live.campaign.providerCalls,
    notes: live.notes.length,
    noteId: live.campaign.result.noteId,
    reopenedUnchanged: true,
  }),
);
