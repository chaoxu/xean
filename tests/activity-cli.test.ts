import { expect, test } from "bun:test";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const cli = (...args: string[]) =>
  Bun.spawn([process.execPath, "--no-env-file", "apps/cli/index.ts", ...args], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, XEAN_ACTIVITY_TOKEN: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

test("activity CLI rejects incomplete opt-in and unauthenticated remote binding", async () => {
  for (const args of [
    ["run", "missing.sqlite", "--activity-url", "http://localhost:3480"],
    ["resume", "missing.sqlite", "--activity-owner", "agent"],
    ["activity-serve", "--hostname", "0.0.0.0"],
  ]) {
    const child = cli(...args);
    expect(await child.exited).toBe(1);
    const error = await new Response(child.stderr).text();
    expect(error).toMatch(/Activity requires|requires XEAN_ACTIVITY_TOKEN/);
  }
});

test("activity CLI serves a scoped observation and closes on SIGTERM", async () => {
  const child = cli("activity-serve", "--port", "0");
  const lines = createInterface({
    input: Readable.from(child.stdout),
  });
  try {
    let output = "";
    for await (const line of lines) {
      output += line;
      if (line === "}") break;
    }
    const { url } = JSON.parse(output) as { url: string };
    const response = await fetch(new URL("v1/activities?scope=cli-test", url));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "available",
      scope: "cli-test",
      activities: [],
    });
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  } finally {
    lines.close();
    child.kill();
    await child.exited;
  }
}, 10_000);
