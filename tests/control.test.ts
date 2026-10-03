import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { Xean, inspectCampaign, openXeanStorage } from "xean";
import { serveControl, socketPath } from "../packages/cli/src/control.ts";

async function cli(...args: string[]) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-install",
      "--no-env-file",
      resolve(import.meta.dir, "../packages/cli/src/index.ts"),
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("control clients reject untrusted socket paths before sending commands", async () => {
  // Isolate path and UID fixtures from live per-user sockets and other tests.
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-install",
      "--no-env-file",
      "--eval",
      `import assert from "node:assert/strict";
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
const { join } = path;
const { lstat } = fs;
const root = await fs.mkdtemp("/tmp/xean-trust-");
const directory = join(root, "owner");
const backup = join(root, "backup");
const uid = process.getuid();
let foreignPath;
mock.module("node:path", () => ({ ...path, join: (...parts) =>
  parts[0] === "/tmp" && parts[1] === "xean-" + uid
    ? join(directory, ...parts.slice(2)) : join(...parts) }));
mock.module("node:fs/promises", () => ({ ...fs, lstat: async (file) => {
  const stat = await lstat(file);
  if (file === foreignPath) stat.uid = uid + 1;
  return stat;
} }));
const { requestOwner, socketPath } = await import(${JSON.stringify(
        new URL("../packages/cli/src/control.ts", import.meta.url).href,
      )});
const socket = socketPath("fixture");
const command = { kind: "guide", id: "fixture", text: "private guidance" };
let requests = 0;
let server;
const request = (owner) => requestOwner("fixture", command, owner);
const reject = async (message) => {
  await assert.rejects(request(), message);
  assert.equal(requests, 1);
};
try {
  await fs.mkdir(directory, { mode: 0o700 });
  server = Bun.serve({ unix: socket, async fetch(request) {
    requests++;
    assert.deepEqual(await request.json(), command);
    return Response.json({ accepted: true });
  } });
  assert.deepEqual(await request(), { accepted: true });
  for (const mode of [0o755, 0o777]) {
    await fs.chmod(directory, mode);
    await reject(/directory must be private/);
    assert.equal((await lstat(directory)).mode & 0o777, mode);
  }
  await fs.chmod(directory, 0o700);
  for (foreignPath of [directory, socket]) await reject(/belong to the current user/);
  foreignPath = undefined;
  for (const target of [directory, socket]) {
    await fs.rename(target, backup);
    for (const kind of ["file", "symlink", ...(target === socket ? ["directory"] : [])]) {
      if (kind === "file") await fs.writeFile(target, "not a socket");
      else if (kind === "symlink") await fs.symlink(backup, target);
      else await fs.mkdir(target);
      await reject(target === directory ? /directory must be private/ : /not a socket/);
      await fs.rm(target, { recursive: true });
    }
    assert.equal(await request(), undefined);
    await assert.rejects(request("expected"), /Expected campaign owner is unavailable/);
    assert.equal(requests, 1);
    await fs.rename(backup, target);
  }
  assert.deepEqual(await request(), { accepted: true });
  assert.equal(requests, 2);
} finally {
  if (server) await server.stop(true);
  await fs.rm(root, { recursive: true, force: true });
}`,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});

test("conditional controls reject foreign owners and wait for admitted lifecycle work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-control-"));
  const database = join(directory, "campaign.sqlite");
  const ownerId = " successor/数学 ";
  const engine = await Xean.open(await openXeanStorage(database), {
    task: null,
    roles: [],
    coordinator: { name: "fixture", run: () => ({ state: null }) },
  });
  const server = await serveControl(await realpath(database), engine, ownerId);
  try {
    const response = await fetch("http://xean/command", {
      unix: socketPath(await realpath(database)),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "pause",
        records: false,
        expectedOwnerId: "predecessor",
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "owner_changed",
        message: "Campaign owner changed",
      },
    });
    const malformed = await fetch("http://xean/command", {
      unix: socketPath(await realpath(database)),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "unknown" }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "command_rejected", message: expect.any(String) },
    });
    const rejected = await cli(
      "pause",
      database,
      "--expected-owner-id",
      "predecessor",
    );
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("Campaign owner changed");
    expect((await engine.inspect()).status).toBe("running");
    const pause = engine.pause.bind(engine);
    engine.pause = async () => {
      await Bun.sleep(12_000);
      return pause();
    };
    const paused = await cli("pause", database, "--expected-owner-id", ownerId);
    expect(paused.code).toBe(0);
    expect(JSON.parse(paused.stdout)).toEqual({
      status: "paused",
      error: null,
      providerCalls: 0,
      pendingSignals: 1,
    });
    expect((await engine.inspect()).status).toBe("paused");
    await server.close();
    await engine.close();
    const missing = await cli(
      "cancel",
      database,
      "--expected-owner-id",
      ownerId,
    );
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("Expected campaign owner is unavailable");
    expect((await inspectCampaign(database)).campaign.status).toBe("paused");
  } finally {
    await server.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);

test("inspection distinguishes interrupted initialization from foreign or unreadable databases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-uninitialized-"));
  const database = join(directory, "campaign.sqlite");
  const inspect = () => cli("inspect", database, "--allow-uninitialized");
  try {
    const empty = new Database(database, { create: true });
    empty.run("VACUUM");
    empty.close();
    const bytes = await readFile(database);
    expect((await cli("inspect", database)).code).not.toBe(0);
    expect(JSON.parse((await inspect()).stdout)).toEqual({ campaign: null });
    expect(await readFile(database)).toEqual(bytes);
    const storage = await openXeanStorage(database);
    await storage.close(BACKGROUND_CONTEXT);
    expect(JSON.parse((await inspect()).stdout)).toEqual({ campaign: null });
    const foreign = await openXeanStorage(database);
    await foreign.commit(
      [{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }],
      BACKGROUND_CONTEXT,
    );
    await foreign.close(BACKGROUND_CONTEXT);
    expect((await inspect()).code).not.toBe(0);
    expect(
      (
        await cli(
          "inspect",
          join(directory, "missing.sqlite"),
          "--allow-uninitialized",
        )
      ).code,
    ).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
