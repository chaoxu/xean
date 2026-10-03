import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { version } from "../package.json";
import { declarationVersion } from "xean/solve";

const runtimeArgs = [process.execPath, "--no-install", "--no-env-file"];
const cliArgs = [
  ...runtimeArgs,
  resolve(import.meta.dir, "../packages/cli/src/index.ts"),
];

test("CA restart preserves process identity and drains after terminal SIGINT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-cli-signal-"));
  const script = join(directory, "index.ts");
  const ca = join(directory, "ca.pem");
  // Exercise the real bootstrap with a fixture CA and a slow-draining command.
  await writeFile(ca, "fixture");
  await writeFile(
    script,
    (await readFile(cliArgs.at(-1)!, "utf8"))
      .replace('"/etc/fleet/ca/fleet-lab-root.pem"', JSON.stringify(ca))
      .replace(
        'await import("./commands.ts");',
        `const input = await Bun.stdin.text();
const stopped = Promise.withResolvers<void>();
process.once("SIGINT", () => {
  void Bun.sleep(50).then(() => stopped.resolve());
});
console.log("ready");
await stopped.promise;
console.log(JSON.stringify({ pid: process.pid, ca: process.env.NODE_EXTRA_CA_CERTS, args: process.argv.slice(2), input }));`,
      ),
  );
  const child = Bun.spawn([...runtimeArgs, script, "literal argument"], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: undefined },
    detached: true,
    stdin: Buffer.from("input"),
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    let result: unknown;
    for await (const line of createInterface({
      input: Readable.from(child.stdout),
    })) {
      if (line === "ready") process.kill(-child.pid, "SIGINT");
      else result = JSON.parse(line);
    }
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(result).toEqual({
      pid: child.pid,
      ca,
      args: ["literal argument"],
      input: "input",
    });
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("standalone research runs without Pi credentials and preserves usage attribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-cli-research-"));
  const task = {
    problem: "Prove 1 = 1",
    completionCriteria: "Use reflexivity",
  };
  const command = join(directory, "codex");
  const invocations = join(directory, "invocations.jsonl");
  const environment = { ...process.env };
  delete environment.XEAN_TEST_UNUSED_PI_KEY;
  try {
    await writeFile(
      command,
      `#!${process.execPath}
import { appendFile } from "node:fs/promises";
const input = await Bun.stdin.json();
await appendFile(${JSON.stringify(invocations)}, JSON.stringify(process.env.XEAN_CODEX_USAGE_TAG) + "\\n");
const value = "query" in input ? { notes: [], candidate: false } : { verdict: "PASS", report: "Reflexivity proves the exact claim.", premises: [], passages: [] };
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0 } }));
`,
      { mode: 0o700 },
    );
    await writeFile(join(directory, "task.json"), JSON.stringify(task));
    await writeFile(join(directory, "argument.md"), "Equality is reflexive.");
    await writeFile(
      join(directory, "input.json"),
      JSON.stringify({ task, notes: [], query: "Find references" }),
    );
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        profiles: {
          default: {
            provider: "openai",
            model: "gpt-6-astra",
            apiKeyEnv: "XEAN_TEST_UNUSED_PI_KEY",
          },
        },
        research: { model: "fixture", command },
        literature: true,
        usagePrefix: "frozen",
        limits: { attempts: 1 },
      }),
    );
    const run = (...args: string[]) => {
      const result = Bun.spawnSync(
        [...cliArgs, "--usage-prefix", "override", ...args],
        { cwd: directory, env: environment },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()).campaign;
    };
    for (const args of [
      ["review", "task.json", "argument.md", "review.sqlite", "settings.json"],
      [
        "role",
        "literature",
        "input.json",
        "literature.sqlite",
        "settings.json",
      ],
    ]) {
      const campaign = run(...args);
      expect(campaign.status).toBe("completed");
      expect(campaign.providerCalls).toBe(1);
      expect(campaign.task.settings.usagePrefix).toBe("frozen");
      expect(run(...args)).toEqual(campaign);
    }
    const tags = (await Bun.file(invocations).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(tags).toHaveLength(2);
    expect(tags.every((tag) => tag.startsWith("override/"))).toBe(true);
    const ordinary = run(
      "role",
      "explorer",
      "input.json",
      "explorer.sqlite",
      "settings.json",
    );
    expect(ordinary.status).toBe("blocked");
    expect(ordinary.providerCalls).toBe(0);
    expect(ordinary.error).toContain("XEAN_TEST_UNUSED_PI_KEY");
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("CLI metadata stays model-free, shares flags, and releases ownership after failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-cli-"));
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([...cliArgs, ...args], {
      cwd: directory,
      timeout: 5000,
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
  try {
    // Package scripts must keep the invoking Bun even when PATH finds an older one.
    await writeFile(join(directory, "bun"), "#!/bin/sh\nexit 99\n", {
      mode: 0o755,
    });
    const packageRun = Bun.spawnSync(
      [process.execPath, "run", "xean", "--version"],
      {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        timeout: 5000,
      },
    );
    expect(packageRun.exitCode).toBe(0);
    expect(packageRun.stdout.toString().trim()).toBe(version);
    const versionResult = run("--version");
    expect(versionResult.code).toBe(0);
    expect(versionResult.stdout.trim()).toBe(version);
    const task = { problem: "P", completionCriteria: "Prove P" };
    await writeFile(join(directory, "task.json"), JSON.stringify(task));
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        profiles: { default: { provider: "openai", model: "unavailable" } },
        limits: { attempts: 1 },
      }),
    );
    const init = ["init", "task.json", "example", "settings.json"];
    for (const args of [
      ["--records", "--usage-prefix", "lab/attempt-1", ...init],
      [...init, "--records"],
    ]) {
      const result = run(...args);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(Array.isArray(report.records)).toBe(true);
      expect(report.campaign.providerCalls).toBe(0);
      expect(report.campaign.task.settings.usagePrefix).toBeUndefined();
    }
    const plain = run(...init);
    expect(plain.code).toBe(0);
    expect(JSON.parse(plain.stdout).records).toBeUndefined();

    await writeFile(
      join(directory, "notes.json"),
      JSON.stringify({
        candidate: false,
        notes: [
          {
            id: "n1",
            text: "Note",
            summary: "Summary",
            detailedSummary: "Note",
            support: [],
          },
        ],
      }),
    );
    await writeFile(join(directory, "guidance.txt"), "Try induction.\n");
    for (const args of [
      ["submit", "example", "notes.json", "--id", "import"],
      ["guide", "example", "guidance.txt", "--id", "initial"],
    ])
      expect(run(...args).code).toBe(0);
    const report = JSON.parse(run("inspect", "example").stdout);
    expect(report.campaign).toMatchObject({
      providerCalls: 0,
    });
    expect(report.notes[0].text).toBe("Note");
    expect(report.campaign.inputs.at(-1).value).toEqual({
      kind: "guide",
      id: "initial",
      text: "Try induction.\n",
    });

    const rejected = run("export", "example");
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("No accepted argument");
    await writeFile(
      join(directory, "task.json"),
      JSON.stringify({ ...task, problem: "Different task" }),
    );
    const mismatch = run(...init);
    expect(mismatch.code).not.toBe(0);
    expect(mismatch.stderr).toContain("Task differs");
    await writeFile(join(directory, "task.json"), JSON.stringify(task));
    expect(run(...init).code).toBe(0);

    const help = run("run", "--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--records");
    expect(help.stdout).toContain("--key-stdin");
    expect(help.stdout).toContain("--usage-prefix");
  } finally {
    await rm(directory, { recursive: true });
  }
}, 15_000);

test("CLI inspects solver campaign kinds, drains large output, and restricts execution declarations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-cli-output-"));
  const kinds = ["xean.solve", "xean.solve.offline", "xean.solve.library"];
  const argument = "For every integer n, 2n is even.\n".repeat(65_536);
  try {
    // Isolate the large SQLite fixture from native handles retained by earlier tests.
    const initializing = Bun.spawn(
      [
        ...runtimeArgs,
        "--eval",
        `import { Xean, openXeanStorage } from "xean";
import { join } from "node:path";
const { directory, kinds, argument, version } = await Bun.stdin.json();
for (const kind of kinds) {
const engine = await Xean.open(await openXeanStorage(join(directory, kind + ".sqlite")), {
  task: { kind, version,
    task: { problem: "Even integers", completionCriteria: "Prove 2n is even" },
    settings: { profiles: { default: { provider: "openai", model: "unavailable" } } },
  }, roles: [],
  coordinator: { name: "output-fixture", run: () => ({ state: null, completion: { argument } }) },
  accept: () => true,
});
try {
  await engine.input({ kind: "submit", id: "fixture", candidate: false,
    notes: [{ id: "n1", text: "2n is even.", summary: "Even", detailedSummary: "Even integer", support: [] }],
  });
  await engine.run();
} finally { await engine.close(); }
}`,
      ],
      {
        cwd: resolve(import.meta.dir, ".."),
        stdin: Buffer.from(
          JSON.stringify({
            directory,
            kinds,
            argument,
            version: declarationVersion,
          }),
        ),
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [initialError, initialCode] = await Promise.all([
      new Response(initializing.stderr).text(),
      initializing.exited,
    ]);
    expect(initialError).toBe("");
    expect(initialCode).toBe(0);
    for (const kind of kinds) {
      const database = join(directory, `${kind}.sqlite`);
      if (kind !== "xean.solve") {
        const rejected = Bun.spawnSync([...cliArgs, "run", database]);
        expect(rejected.exitCode).not.toBe(0);
        expect(rejected.stderr.toString()).toContain("Invalid value");
      }
      for (const command of ["status", "inspect", "export"]) {
        const child = Bun.spawn([...cliArgs, command, database], {
          stdout: "pipe",
          stderr: "pipe",
        });
        // Let the producer fill its pipe before the consumer starts reading.
        await Bun.sleep(100);
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(stderr).toBe("");
        expect(code).toBe(0);
        if (command === "status") {
          const report = JSON.parse(stdout);
          expect(report).toMatchObject({
            status: "completed",
            acceptedNoteId: null,
            notes: { imported: 1, generated: 0 },
          });
          expect(Date.parse(report.observedAt)).toBeGreaterThan(0);
          expect(stdout.length).toBeLessThan(4096);
          expect(stdout).not.toContain("2n is even.");
        } else if (command === "inspect") {
          const report = JSON.parse(stdout);
          expect(report.campaign.providerCalls).toBe(0);
          expect(report.notes[0].text).toBe("2n is even.");
          expect(report.campaign.result.argument).toBe(argument);
        } else expect(stdout).toBe(argument + "\n");
      }
    }
  } finally {
    await rm(directory, { recursive: true });
  }
}, 15_000);
