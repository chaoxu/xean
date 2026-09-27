import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { version } from "../package.json";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import { declarationVersion } from "xean/solve";

test("CLI metadata stays model-free, shares flags, and releases ownership after failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-cli-"));
  const entry = resolve(import.meta.dir, "../packages/cli/src/index.ts");
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(
      [process.execPath, "--no-install", "--no-env-file", entry, ...args],
      { cwd: directory, timeout: 5000 },
    );
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
        limits: { providerCalls: 0 },
      }),
    );
    const init = ["init", "task.json", "example", "settings.json"];
    for (const args of [
      ["--records", ...init],
      [...init, "--records"],
    ]) {
      const result = run(...args);
      expect(result.code).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(Array.isArray(report.records)).toBe(true);
      expect(report.campaign.providerCalls).toBe(0);
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
    for (const args of [
      ["submit", "example", "notes.json", "--id", "import"],
      ["extend", "example", "1", "--id", "grant"],
    ])
      expect(run(...args).code).toBe(0);
    const report = JSON.parse(run("inspect", "example").stdout);
    expect(report.campaign).toMatchObject({
      providerCalls: 0,
      callAllowance: 1,
    });
    expect(report.notes[0].text).toBe("Note");

    await writeFile(
      join(directory, "corpus.json"),
      JSON.stringify({ task, notes: report.notes }),
    );
    await writeFile(
      join(directory, "editor-settings.json"),
      JSON.stringify({
        profiles: { default: { provider: "openai", model: "gpt-6-astra" } },
        limits: { providerCalls: 0 },
      }),
    );
    const edited = run(
      "edit",
      "corpus.json",
      "edition",
      "editor-settings.json",
    );
    expect(edited.code, edited.stderr).toBe(0);
    expect(JSON.parse(edited.stdout).campaign).toMatchObject({
      status: "limited",
      providerCalls: 0,
      result: null,
      task: { kind: "xean.edit", input: { task, notes: report.notes } },
    });
    expect(JSON.parse(run("inspect", "example").stdout).notes).toEqual(
      report.notes,
    );

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
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("CLI drains large inspection and argument output through a slow pipe", async () => {
  // Collect earlier fixtures before this large SQLite fixture allocates its pages.
  Bun.gc(true);
  const directory = await mkdtemp(join(tmpdir(), "xean-cli-output-"));
  const database = join(directory, "campaign.sqlite");
  const argument = "For every integer n, 2n is even.\n".repeat(65_536);
  try {
    const engine = await Xean.open(await openXeanStorage(database), {
      task: { kind: "xean.solve", version: declarationVersion },
      roles: [],
      coordinator: {
        name: "output-fixture",
        run: () => ({ state: null, completion: { argument } }),
      },
      accept: () => true,
    });
    try {
      await engine.run();
    } finally {
      await engine.close();
    }
    for (const command of ["inspect", "export"]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-install",
          "--no-env-file",
          resolve(import.meta.dir, "../packages/cli/src/index.ts"),
          command,
          database,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      // Let the producer fill its pipe before the consumer starts reading.
      await Bun.sleep(100);
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(
        command === "inspect"
          ? JSON.parse(stdout).campaign.result.argument
          : stdout,
      ).toBe(command === "inspect" ? argument : argument + "\n");
    }
  } finally {
    await rm(directory, { recursive: true });
  }
});
