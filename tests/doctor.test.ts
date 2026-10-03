import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../packages/cli/src/index.ts");

test("doctor validates local setup without requests, command execution, writes, or secret output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-doctor-"));
  const settings = join(directory, "settings.json");
  const command = join(directory, "codex");
  const preload = join(directory, "local-only.ts");
  const secret = "doctor-secret-must-not-appear";
  try {
    await writeFile(
      command,
      `#!${process.execPath}\nawait Bun.write("invoked", "called");\n`,
      { mode: 0o700 },
    );
    await writeFile(
      preload,
      `
      globalThis.fetch = () => { throw new Error("Doctor attempted HTTP"); };
      if (process.env.XEAN_DOCTOR_TEST_RUNTIME)
        Object.defineProperty(process, "arch", { value: "doctor-fixture" });
    `,
    );
    const configured = {
      profiles: {
        default: {
          provider: "openai",
          model: "gpt-6-astra",
          apiKeyEnv: "XEAN_DOCTOR_TEST_KEY",
        },
        explorer: {
          provider: "codex-chatgpt-web",
          model: "chatgpt-web/gpt-6-pro",
        },
      },
      research: { model: "fixture", command },
      codex: { model: "fixture", command, workspace: join(directory, "code") },
    };
    const run = async (
      value: unknown,
      env: Record<string, string | undefined> = {},
    ) => {
      await writeFile(
        settings,
        typeof value === "string" ? value : JSON.stringify(value),
      );
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--no-install",
          "--no-env-file",
          "--preload",
          preload,
          cli,
          "doctor",
          settings,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            OPENAI_API_KEY: undefined,
            XEAN_DOCTOR_TEST_KEY: secret,
            XEAN_DOCTOR_TEST_RUNTIME: undefined,
            ...env,
          },
        },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).not.toContain(secret);
      const report = JSON.parse(result.stdout.toString());
      expect(result.exitCode).toBe(report.ok ? 0 : 1);
      return report;
    };
    expect((await run(configured)).ok).toBe(true);
    expect(
      (await run(configured, { XEAN_DOCTOR_TEST_RUNTIME: "mismatch" })).message,
    ).toContain("Run bun run setup");
    expect(
      (await run(configured, { XEAN_DOCTOR_TEST_KEY: undefined })).message,
    ).toContain("Missing provider credential environment variable");
    const ambient = {
      ...configured,
      profiles: { default: { provider: "openai", model: "gpt-6-astra" } },
    };
    expect((await run(ambient, { OPENAI_API_KEY: secret })).ok).toBe(true);
    expect((await run(ambient)).message).toContain("No openai credential");
    expect(
      (
        await run({
          ...configured,
          profiles: { default: { provider: "openai", model: "unavailable" } },
        })
      ).message,
    ).toContain("Unknown Pi model");
    for (const missing of [join(directory, "absent"), settings, directory])
      expect(
        (
          await run({
            ...configured,
            research: { model: "fixture", command: missing },
          })
        ).message,
      ).toContain("Codex executable was not found");
    expect((await run(`{"apiKey":"${secret}"`)).message).toContain(
      "Cannot read settings JSON",
    );
    expect((await readdir(directory)).sort()).toEqual([
      "codex",
      "local-only.ts",
      "settings.json",
    ]);
  } finally {
    await rm(directory, { recursive: true });
  }
});
