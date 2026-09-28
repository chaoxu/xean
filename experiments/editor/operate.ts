import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readDeclaration } from "../../packages/core/src/solve/campaign.ts";
import { readSettings } from "../../packages/core/src/solve/config.ts";
import { declarationVersion } from "../../packages/core/src/solve/contracts.ts";

const [action, id, selection, inputFile, settingsFile] = process.argv.slice(2);
const role =
  selection === "editor" ||
  selection === "verifier" ||
  selection === "editionReview" ||
  selection === "edit"
    ? selection
    : "";
const prompt = role ? undefined : selection;
assert(action && ["launch", "status", "collect", "cancel"].includes(action));
assert(
  id && /^editor-golden-[a-z0-9-]+$/.test(id),
  "Expected editor-golden-<attempt>",
);
const root = resolve(import.meta.dir, "../..");
const fleet = resolve(root, "../fleet-infra");
const local = resolve(root, "runs", id);
const remoteRoot = `/srv/xean-lab/runs/_xean/${id}`;
const jobId = `xean-${id}`;
const runtime =
  "/srv/xean-lab/runs/_yean/hard-problems-resume-20260926/runtime/bun";
const image =
  "sha256:f485d12d01a1a65e12bc01ebc09fa978d958ad416ec34f1392f02b6b67885c4e";
const hash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
async function invoke(argv: string[], input?: string): Promise<string> {
  const child = Bun.spawn(argv, {
    cwd: root,
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(code, 0, `${argv[0]} failed: ${stderr.slice(-1500)}`);
  return stdout;
}
const nomad = (...args: string[]) =>
  invoke([resolve(fleet, "bin/fleet-nomad"), ...args]);
const remote = (code: string) =>
  invoke(
    [
      "ssh",
      "-oBatchMode=yes",
      "jupiter",
      runtime,
      "--no-install",
      "--no-env-file",
      "run",
      "-",
    ],
    `
import assert from "node:assert/strict";
import {readFile,writeFile,mkdir,readdir} from "node:fs/promises";
import {createHash} from "node:crypto";
const root=${JSON.stringify(remoteRoot)};
assert.equal(Bun.version,"1.4.2");
assert.equal((await readFile("/etc/lab-host","utf8")).trim(),"jupiter");
${code}`,
  );
const save = (name: string, value: unknown) =>
  writeFile(resolve(local, name), json(value), { flag: "wx", mode: 0o600 });
assert.equal(Bun.version, "1.4.2");

if (action === "launch") {
  let roleFiles: Record<string, string> | undefined;
  let callAllowance: number;
  if (role) {
    assert(inputFile && settingsFile && process.argv.length === 7);
    const input = JSON.parse(await readFile(resolve(inputFile), "utf8"));
    const settings = JSON.parse(await readFile(resolve(settingsFile), "utf8"));
    settings.usagePrefix = `editor-golden/${id}`;
    readDeclaration({
      version: declarationVersion,
      kind: role === "edit" ? "xean.edit" : "xean.role",
      ...(role === "edit" ? {} : { role }),
      task: input.task,
      input,
      settings,
    });
    callAllowance = settings.limits?.providerCalls;
    assert(
      Number.isSafeInteger(callAllowance) && callAllowance > 0,
      "Native editing requires a finite positive providerCalls allowance",
    );
    assert.deepEqual(settings.limits, {
      concurrency: 1,
      attempts: 1,
      providerCalls: role === "edit" ? callAllowance : 1,
    });
    roleFiles = { "input.json": json(input), "settings.json": json(settings) };
  } else {
    assert.equal(process.argv.length, 5);
    assert(prompt && /^[a-z0-9-]+$/.test(prompt), "Supply a prompt name");
    assert(
      await Bun.file(
        resolve(import.meta.dir, "prompts", `${prompt}.md`),
      ).exists(),
    );
    const settings = readSettings(
      JSON.parse(
        await readFile(resolve(import.meta.dir, "settings.json"), "utf8"),
      ),
    );
    const allowance = settings.limits?.providerCalls;
    assert.equal(allowance, 1);
    callAllowance = allowance;
  }
  await invoke(["git", "diff", "--exit-code", "HEAD"]);
  assert.equal(
    (
      await invoke(["git", "ls-files", "--others", "--exclude-standard"])
    ).trim(),
    "",
    "Commit experiment inputs before launch",
  );
  const commit = (await invoke(["git", "rev-parse", "HEAD"])).trim();
  assert(
    (
      await invoke([
        "git",
        "ls-remote",
        "--heads",
        "ssh://git@jupiter:2222/chaoxu/xean.git",
      ])
    )
      .split("\n")
      .some((line) => line.startsWith(commit + "\t")),
    "Push the experiment commit before launch",
  );
  const jobs = JSON.parse(await nomad("job", "status", "-json"));
  assert(
    !jobs.some((job: any) => (job.ID ?? job.Summary?.JobID) === jobId),
    "Run ID already exists; inspect it instead of resubmitting",
  );
  const nodes = JSON.parse(await nomad("node", "status", "-json"));
  assert(
    nodes.some(
      (node: any) =>
        node.Name === "jupiter" &&
        node.Status === "ready" &&
        node.SchedulingEligibility === "eligible",
    ),
  );
  await mkdir(resolve(root, "runs"), { recursive: true });
  await mkdir(local, { mode: 0o700 });
  const archive = resolve(local, "source.tar");
  await invoke([
    "git",
    "archive",
    "--format=tar",
    `--output=${archive}`,
    commit,
  ]);
  const archiveHash = hash(await readFile(archive));
  await save("intent.json", {
    id,
    prompt,
    role,
    kind: role === "edit" ? "xean.edit" : "xean.role",
    callAllowance,
    roleFiles: roleFiles
      ? Object.fromEntries(
          Object.entries(roleFiles).map(([name, bytes]) => [name, hash(bytes)]),
        )
      : undefined,
    commit,
    archiveHash,
    image,
    at: new Date().toISOString(),
    usagePrefix: `editor-golden/${id}`,
  });
  await remote(`
const check=Bun.spawnSync(["docker","image","inspect","--format","{{.Id}}",${JSON.stringify(image)}],{stdout:"pipe",stderr:"pipe"});
assert.equal(check.exitCode,0);assert.equal(check.stdout.toString().trim(),${JSON.stringify(image)});
assert.equal(createHash("sha256").update(await readFile(${JSON.stringify(runtime)})).digest("hex"),"616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1");
await mkdir(root,{mode:0o755});await mkdir(root+"/source",{mode:0o755});await mkdir(root+"/output",{mode:0o755});`);
  if (roleFiles) {
    for (const [name, bytes] of Object.entries(roleFiles))
      await writeFile(resolve(local, name), bytes, { flag: "wx", mode: 0o600 });
    await remote(`
for(const [name,bytes]of Object.entries(${JSON.stringify(roleFiles)}))await writeFile(root+"/"+name,bytes,{flag:"wx",mode:0o644});`);
  }
  await invoke(["scp", archive, `jupiter:${remoteRoot}/source.tar`]);
  await remote(`
assert.equal(createHash("sha256").update(await readFile(root+"/source.tar")).digest("hex"),${JSON.stringify(archiveHash)});
for(const [args,cwd]of [[["tar","-xf",root+"/source.tar","-C",root+"/source"],root],[[process.execPath,"install","--ignore-scripts","--frozen-lockfile"],root+"/source"]]){
const child=Bun.spawn(args,{cwd,stdout:"pipe",stderr:"pipe"});const error=new Response(child.stderr).text();await new Response(child.stdout).text();assert.equal(await child.exited,0,await error);}
const {recordInstall,verifyInstall}=await import(root+"/source/scripts/dependencies.ts");await recordInstall(root+"/source");await verifyInstall(root+"/source");`);
  const payload = JSON.parse(
    await invoke(
      [
        resolve(fleet, "bin/fleet-nomad"),
        "job",
        "run",
        "-output",
        `-var=run_id=${id}`,
        `-var=source_commit=${commit}`,
        `-var=prompt=${prompt ?? ""}`,
        `-var=role=${role}`,
        `-var=call_allowance=${callAllowance}`,
        `-var=image=${image}`,
        "-",
      ],
      await readFile(resolve(import.meta.dir, "job.nomad.hcl"), "utf8"),
    ),
  );
  payload.Job.ID = payload.Job.Name = jobId;
  const env = payload.Job.TaskGroups[0].Tasks[0].Env;
  env.XEAN_USAGE_TAG = `editor-golden/${id}`;
  env.XEAN_SOURCE_COMMIT = commit;
  await invoke(
    [resolve(fleet, "bin/fleet-nomad"), "job", "validate", "-json", "-"],
    json(payload),
  );
  await save("job.public.json", payload);
  const secret = Bun.spawnSync(
    [
      process.execPath,
      "--no-install",
      "--no-env-file",
      "/usr/local/share/fleet-infra/apps/openbao/bin/fleet-secret.ts",
      "get",
      "codex-lb/xean",
      "--field=key",
    ],
    {
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: "/etc/fleet/ca/fleet-lab-root.pem",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  assert.equal(secret.exitCode, 0, "OpenBao field read failed");
  env.XEAN_API_KEY = secret.stdout.toString().trim();
  assert(env.XEAN_API_KEY, "Missing API credential");
  const receipt = await invoke(
    [
      resolve(fleet, "bin/fleet-nomad"),
      "job",
      "run",
      "-check-index=0",
      "-detach",
      "-json",
      "-",
    ],
    json(payload),
  );
  await save("submission.json", {
    jobId,
    callAllowance,
    at: new Date().toISOString(),
    receipt,
  });
  console.log(
    json({
      jobId,
      commit,
      prompt,
      role,
      callAllowance,
      local,
      cancellation: `operate.ts cancel ${id}`,
    }),
  );
} else if (action === "cancel") {
  console.log(await nomad("job", "stop", jobId));
} else {
  const allocations = JSON.parse(await nomad("job", "allocs", "-json", jobId));
  console.log(
    json(
      allocations.map((a: any) => ({
        id: a.ID,
        status: a.ClientStatus,
        desired: a.DesiredStatus,
      })),
    ),
  );
  if (action === "collect") {
    const files = JSON.parse(
      await remote(`
const files={};for(const name of await readdir(root+"/output"))if(name.endsWith(".json"))files[name]=await readFile(root+"/output/"+name,"utf8");console.log(JSON.stringify(files));`),
    );
    const intent = JSON.parse(
      await readFile(resolve(local, "intent.json"), "utf8"),
    );
    if (intent.role) {
      files["snapshot.json"] = await remote(`
const {inspectCampaign}=await import(root+"/source/packages/core/src/index.ts");
console.log(JSON.stringify(await inspectCampaign(root+"/output/campaign.sqlite")));`);
    }
    await mkdir(local, { recursive: true, mode: 0o700 });
    for (const [name, bytes] of Object.entries(files)) {
      assert(/^[a-zA-Z0-9.-]+\.json$/.test(name));
      await writeFile(resolve(local, name), bytes as string, { mode: 0o600 });
    }
    console.log(json({ collected: Object.keys(files), local }));
  }
}
