import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctor } from "../packages/cli/src/doctor.ts";

const cli = resolve(import.meta.dir, "../packages/cli/src/index.ts");

test("doctor checks local setup without model requests, executable invocation, writes, or secret output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-doctor-"));
  const settings = join(directory, "settings.json");
  const command = join(directory, "codex");
  const differentRuntime = join(directory, "different-runtime.ts");
  const preload = join(directory, "deny-network.ts");
  const secret = "doctor-secret-must-not-appear";
  try {
    await writeFile(
      command,
      `#!${process.execPath}\nawait Bun.write(${JSON.stringify(join(directory, "invoked"))}, "called");\nprocess.exit(99);\n`,
      { mode: 0o700 },
    );
    await writeFile(
      differentRuntime,
      'Object.defineProperty(process, "arch", { value: "doctor-fixture" });',
    );
    await writeFile(
      preload,
      'globalThis.fetch = () => { throw new Error("Doctor attempted HTTP"); };',
    );
    const configured = {
      profiles: {
        default: {
          provider: "openai",
          model: "gpt-6-astra",
          apiKeyEnv: "XEAN_DOCTOR_TEST_KEY",
          baseUrl: "http://127.0.0.1:1",
        },
        explorer: {
          provider: "codex-chatgpt-web",
          model: "chatgpt-web/gpt-6-pro",
          apiKeyEnv: "XEAN_DOCTOR_TEST_KEY",
        },
      },
      research: { model: "fixture", command },
      codex: { model: "fixture", command, workspace: join(directory, "code") },
    };
    await writeFile(settings, JSON.stringify(configured));
    const before = await readdir(directory);
    const run = (
      key: string | undefined,
      ambient = false,
      mismatch = false,
    ) => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--no-install",
          "--no-env-file",
          "--preload",
          preload,
          ...(mismatch ? ["--preload", differentRuntime] : []),
          cli,
          "doctor",
          settings,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            XEAN_DOCTOR_TEST_KEY: key,
            OPENAI_API_KEY: ambient ? secret : undefined,
          },
        },
      );
      expect(result.stderr.toString()).toBe("");
      expect(result.stdout.toString()).not.toContain(secret);
      return { code: result.exitCode, ...JSON.parse(result.stdout.toString()) };
    };
    const ready = run(secret);
    expect(ready.code).toBe(0);
    expect(ready.ok).toBe(true);
    expect(ready.checks).toContainEqual({
      name: "credentials:codex-chatgpt-web",
      status: "unchecked",
      message: "The external browser session was not checked.",
    });
    const stale = run(secret, false, true);
    expect(stale.code).toBe(1);
    expect(stale.checks).toContainEqual(
      expect.objectContaining({
        name: "installation",
        status: "error",
        message: expect.stringContaining("Run bun run setup"),
      }),
    );
    const missing = run(undefined);
    expect(missing.code).toBe(1);
    expect(missing.ok).toBe(false);
    expect(missing.checks).toContainEqual({
      name: "profiles",
      status: "error",
      message:
        "Missing provider credential environment variable: XEAN_DOCTOR_TEST_KEY",
    });
    await writeFile(
      settings,
      JSON.stringify({
        ...configured,
        profiles: { default: { provider: "openai", model: "gpt-6-astra" } },
      }),
    );
    expect(run(undefined, true).ok).toBe(true);
    const absent = run(undefined);
    expect(absent.code).toBe(1);
    expect(absent.checks).toContainEqual(
      expect.objectContaining({
        name: "credentials:openai",
        status: "error",
      }),
    );
    expect(await readdir(directory)).toEqual(before);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("doctor aggregates installation, model, command, and directory failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-doctor-failures-"));
  const settings = join(directory, "settings.json");
  try {
    await writeFile(
      settings,
      JSON.stringify({
        profiles: { default: { provider: "openai", model: "unavailable" } },
        research: {
          model: "fixture",
          command: join(directory, "missing-codex"),
        },
        codex: { model: "fixture", command: settings, workspace: settings },
      }),
    );
    const campaignDirectory = join(directory, "dangling");
    await symlink(join(directory, "absent"), campaignDirectory);
    const report = await doctor(settings, campaignDirectory, async () => {
      throw new Error("Installation receipt missing. Run bun run setup.");
    });
    expect(report.ok).toBe(false);
    expect(
      report.checks
        .filter((check) => check.status === "error")
        .map((check) => check.name),
    ).toEqual([
      "installation",
      "profiles",
      `codex:${join(directory, "missing-codex")}`,
      `codex:${settings}`,
      "codex-workspace",
      "campaign-directory",
    ]);
    expect((await readdir(directory)).sort()).toEqual([
      "dangling",
      "settings.json",
    ]);
    await writeFile(settings, '{"apiKey":"private-in-malformed-json"');
    const malformed = await doctor(settings, directory, async () => {});
    expect(malformed.ok).toBe(false);
    expect(JSON.stringify(malformed)).not.toContain(
      "private-in-malformed-json",
    );
    expect(
      malformed.checks.find((check) => check.name === "settings")?.status,
    ).toBe("error");
  } finally {
    await rm(directory, { recursive: true });
  }
});
