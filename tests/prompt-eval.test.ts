import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { matchesCase } from "../scripts/prompt-eval.ts";
import type { SolverResult } from "xean/solve";

const root = resolve(import.meta.dir, "..");
const script = resolve(root, "scripts/prompt-eval.ts");
const args = [process.execPath, "--no-install", "--no-env-file"];
const settings = {
  profiles: {
    default: {
      provider: "openai",
      model: "gpt-6-astra",
      reasoning: "max",
      apiKeyEnv: "PROMPT_EVAL_FIXTURE_KEY",
    },
  },
};

async function fixture(directory: string, childSource: string) {
  const child = join(directory, "child.ts");
  await writeFile(child, childSource);
  let wrapper = (await readFile(script, "utf8"))
    .replace(
      'const root = resolve(import.meta.dir, "..");',
      `const root = ${JSON.stringify(root)};`,
    )
    .replace(
      'resolve(root, "packages/cli/src/index.ts")',
      JSON.stringify(child),
    );
  for (const [specifier, path] of Object.entries({
    xean: "packages/core/src/index.ts",
    "xean/solve": "packages/core/src/solve/index.ts",
    "xean/report": "packages/core/src/report.ts",
    "../examples/prompt-cases.json": "examples/prompt-cases.json",
    "./dependencies.ts": "scripts/dependencies.ts",
  }))
    wrapper = wrapper.replace(
      JSON.stringify(specifier),
      JSON.stringify(resolve(root, path)),
    );
  const path = join(directory, "prompt-eval.ts");
  await writeFile(path, wrapper);
  await writeFile(join(directory, "settings.json"), JSON.stringify(settings));
  return [
    ...args,
    path,
    join(directory, "settings.json"),
    join(directory, "output"),
    "--run",
  ];
}

test("prompt screening distinguishes unresolved checks and changed proofs", () => {
  const result: Extract<SolverResult, { kind: "verification" }> = {
    kind: "verification",
    checks: [
      {
        noteId: "n1",
        correctness: {
          verdict: "INCONCLUSIVE",
          report: "Unresolved",
          premises: [],
        },
      },
    ],
  };
  const expected = { verdict: "PASS", correction: true };
  expect(matchesCase(expected, "Proof", result)).toBe(false);
  result.checks[0]!.correctness!.verdict = "PASS";
  result.checks[0]!.correction = {
    revision: 0,
    summary: "Qualified claim",
    detailedSummary: "Qualified claim",
    text: "Repaired proof",
  };
  expect(matchesCase(expected, "Proof", result)).toBe(false);
  result.checks[0]!.correction!.text = "Proof";
  expect(matchesCase(expected, "Proof", result)).toBe(true);
  result.checks[0]!.correctness!.premises = ["Unproved external result"];
  expect(matchesCase(expected, "Proof", result)).toBe(false);
});

test("prompt preparation freezes selected settings and separates expectations from model input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-prompt-prepare-"));
  try {
    const selected = JSON.stringify(settings);
    const output = join(directory, "new-parent", "output");
    await writeFile(join(directory, "settings.json"), selected);
    const command = [...args, script, join(directory, "settings.json"), output];
    const prepared = Bun.spawnSync(command);
    expect(prepared.exitCode).toBe(0);
    const manifest = await Bun.file(join(output, "manifest.json")).json();
    expect(manifest).toMatchObject({
      executed: false,
      semanticValidation: "not-performed",
      profiles: settings.profiles,
    });
    expect(manifest.settingsSha256).toBe(
      createHash("sha256").update(selected).digest("hex"),
    );
    expect(await Bun.file(join(output, "results.json")).exists()).toBe(false);
    const examples = await Bun.file(join(output, "cases.json")).json();
    expect(examples).toHaveLength(3);
    for (const example of examples) {
      const input = await Bun.file(
        join(output, example.id, "input.json"),
      ).json();
      expect(input.notes[0].text).toBe(example.text);
      expect(JSON.stringify(input)).not.toContain(example.expected.reason);
      expect(input).not.toHaveProperty("expected");
      expect(
        await Bun.file(join(output, example.id, "campaign.sqlite")).exists(),
      ).toBe(false);
    }
    expect(Bun.spawnSync(command).exitCode).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("prompt child failures retain a row without a database and changed inputs stop later cases", async () => {
  for (const drift of [false, true]) {
    const directory = await mkdtemp(join(tmpdir(), "xean-prompt-failure-"));
    try {
      const command = await fixture(
        directory,
        `${drift ? 'await Bun.write(process.argv[6]!, "{}\\n");' : ""}\nconsole.error("fixture failed before storage"); process.exit(7);`,
      );
      const failed = Bun.spawnSync(command);
      expect(failed.exitCode).toBe(1);
      const rows = await Bun.file(
        join(directory, "output/results.json"),
      ).json();
      expect(rows).toHaveLength(drift ? 1 : 3);
      expect(rows[0]).toMatchObject({
        exitCode: 7,
        result: null,
        status: null,
        matched: false,
        provenanceUnchanged: !drift,
      });
      expect(rows[0].errors.join("\n")).toContain("Inspection failed");
      if (drift)
        expect(rows[0].errors.join("\n")).toContain("Frozen input changed");
      expect(
        await Bun.file(
          join(directory, "output/valid-inequality/stderr.log"),
        ).text(),
      ).toContain("fixture failed before storage");
    } finally {
      await rm(directory, { recursive: true });
    }
  }
});

test("prompt cancellation drains its child and skips subsequent cases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-prompt-cancel-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const ready = join(directory, "ready");
    const drained = join(directory, "drained");
    const command = await fixture(
      directory,
      `
const stopped = Promise.withResolvers<void>();
process.on("SIGINT", () => stopped.resolve());
await Bun.write(${JSON.stringify(ready)}, "ready");
await stopped.promise;
await Bun.sleep(50);
await Bun.write(${JSON.stringify(drained)}, "drained");
`,
    );
    child = Bun.spawn(command, { stdout: "ignore", stderr: "pipe" });
    while (!(await Bun.file(ready).exists())) {
      expect(child.exitCode).toBeNull();
      await Bun.sleep(5);
    }
    child.kill("SIGTERM");
    expect(await child.exited).toBe(130);
    expect(await Bun.file(drained).text()).toBe("drained");
    const rows = await Bun.file(join(directory, "output/results.json")).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      interrupted: true,
      exitCode: 0,
      matched: false,
    });
    expect(
      await Bun.file(
        join(directory, "output/false-inequality/stdout.json"),
      ).exists(),
    ).toBe(false);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await child.exited;
    }
    await rm(directory, { recursive: true });
  }
});
