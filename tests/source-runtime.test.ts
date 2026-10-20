import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexExec } from "../src/source-runtime.ts";

const roots: string[] = [];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (existsSync(join(root, "pids")))
      for (const pid of JSON.parse(
        await readFile(join(root, "pids"), "utf8"),
      ) as number[])
        if (alive(pid)) process.kill(pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
const request = {
  protocol: "xean/codex-exec/v1" as const,
  model: "fixture",
  reasoning: "low" as const,
  search: false,
  developerInstructions: "Original instructions",
  prompt: "Exact prompt.\n☃\n",
  outputSchema: { type: "object", properties: { verdicts: { type: "array" } } },
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xean-source-contract-"));
  roots.push(root);
  await mkdir(join(root, ".codex"));
  await writeFile(join(root, ".codex/auth.json"), "{}");
  const fake = join(root, "codex-fixture");
  await writeFile(
    fake,
    `#!${process.execPath}
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('codex-cli fixture');process.exit(0);}
const input=await Bun.stdin.text(), home=process.env.HOME, mode=await readFile(home+'/mode','utf8');
await writeFile(home+'/capture.json',JSON.stringify({args,input,home:process.env.CODEX_HOME,
  auth:await realpath(process.env.CODEX_HOME+'/auth.json'),keys:Object.keys(process.env),
  schema:JSON.parse(await readFile(args[args.indexOf('--output-schema')+1],'utf8'))}));
console.error('fixture-stderr');
if(mode==='overflow') {process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(17*1024*1024));setInterval(()=>{},1000);}
else if(mode==='cancel') {
  const child=spawn(process.execPath,['-e',
    'process.on("SIGTERM",()=>{});await Bun.write(process.env.HOME+"/child-ready","ready");setInterval(()=>{},1000)'],{stdio:'ignore'});
  process.on('SIGTERM',()=>process.exit(0));await writeFile(home+'/pids',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);
} else {
  console.log('fixture-output');
  if(mode!=='missing') await writeFile(args[args.indexOf('--output-last-message')+1],mode==='invalid'?'{':JSON.stringify({verdicts:[]}));
  process.exitCode=mode==='fail'?17:0;
}
`,
  );
  await chmod(fake, 0o700);
  const execute = codexExec({
    command: fake,
    environment: {
      HOME: root,
      PATH: process.env.PATH,
      OPENAI_API_KEY: "fixture-only",
      CODEX_API_KEY: "fixture-only",
      UNRELATED_SECRET: "fixture-only",
    },
  });
  return {
    root,
    execute,
    mode: (value: string) => writeFile(join(root, "mode"), value),
    capture: async () =>
      JSON.parse(await readFile(join(root, "capture.json"), "utf8")),
  };
}

test("source executor preserves the request, enforces search selection and removes ambient credentials", async () => {
  const f = await fixture();
  await f.mode("ok");
  for (const search of [false, true]) {
    const result = await f.execute({ ...request, search });
    expect(result).toEqual({
      state: "succeeded",
      codexVersion: "codex-cli fixture",
      output: { verdicts: [] },
      stdout: "fixture-output\n",
      stderr: "fixture-stderr\n",
    });
    const capture = await f.capture();
    expect(capture.input).toBe(request.prompt);
    expect(capture.schema).toEqual(request.outputSchema);
    expect(capture.args.includes("--search")).toBe(search);
    expect(capture.args.includes('web_search="disabled"')).toBe(!search);
    for (const flag of [
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "agents.enabled=false",
      `developer_instructions=${JSON.stringify(request.developerInstructions)}`,
    ])
      expect(capture.args).toContain(flag);
    expect(capture.args[capture.args.indexOf("--sandbox") + 1]).toBe(
      "read-only",
    );
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "UNRELATED_SECRET"])
      expect(capture.keys).not.toContain(key);
    expect(capture.auth).toBe(await realpath(join(f.root, ".codex/auth.json")));
    expect(existsSync(capture.home)).toBe(false);
    expect(existsSync(join(f.root, ".codex/auth.json"))).toBe(true);
  }
});

test.each(["missing", "invalid"])(
  "source rejects a %s final JSON file and retains logs",
  async (mode) => {
    const f = await fixture();
    await f.mode(mode);
    expect(await f.execute(request)).toMatchObject({
      state: "failed",
      exitCode: 0,
      stdout: "fixture-output\n",
      stderr: "fixture-stderr\n",
    });
    expect(existsSync((await f.capture()).home)).toBe(false);
  },
);

test("source failure retains output and a producer exceeding the capture bound is stopped", async () => {
  const f = await fixture();
  await f.mode("fail");
  expect(await f.execute(request)).toMatchObject({
    state: "failed",
    exitCode: 17,
    stdout: "fixture-output\n",
    stderr: "fixture-stderr\n",
  });
  expect(existsSync((await f.capture()).home)).toBe(false);
  await f.mode("overflow");
  const result = await f.execute(request);
  expect(result.state).toBe("failed");
  expect(result.state === "failed" && result.error).toContain("capture limit");
  expect(result.stdout.length).toBeGreaterThan(0);
  expect(result.stdout.length).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(existsSync((await f.capture()).home)).toBe(false);
});

test("cancellation removes a cooperative parent and its SIGTERM-resistant descendant", async () => {
  const f = await fixture();
  await f.mode("cancel");
  const controller = new AbortController(),
    pending = f.execute(request, controller.signal);
  try {
    for (let i = 0; i < 500 && !existsSync(join(f.root, "child-ready")); i++)
      await Bun.sleep(10);
    expect(existsSync(join(f.root, "child-ready"))).toBe(true);
  } finally {
    controller.abort();
  }
  const result = await pending;
  expect(result.state).toBe("cancelled");
  expect(result.stderr).toBe("fixture-stderr\n");
  const pids = JSON.parse(
    await readFile(join(f.root, "pids"), "utf8"),
  ) as number[];
  for (let i = 0; i < 100 && pids.some(alive); i++) await Bun.sleep(10);
  expect(pids.filter(alive)).toEqual([]);
  expect(existsSync((await f.capture()).home)).toBe(false);
}, 10_000);
