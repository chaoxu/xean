import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("prompt preparation freezes cases and settings without calls or answer leakage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-prompt-prepare-"));
  try {
    const root = resolve(import.meta.dir, "..");
    const settings = JSON.stringify({
      profiles: {
        default: {
          provider: "openai",
          model: "gpt-6-astra",
          reasoning: "max",
          apiKeyEnv: "PROMPT_EVAL_FIXTURE_KEY",
        },
      },
    });
    const output = join(directory, "new-parent/output");
    const settingsPath = join(directory, "settings.json");
    await writeFile(settingsPath, settings);
    const command = [
      process.execPath,
      "--no-install",
      "--no-env-file",
      join(root, "scripts/prompt-eval.ts"),
      settingsPath,
      output,
    ];
    const prepared = Bun.spawnSync(command);
    expect(prepared.exitCode).toBe(0);
    expect(JSON.parse(prepared.stdout.toString())).toEqual({
      output,
      executed: false,
      cases: 3,
    });
    const manifest = await Bun.file(join(output, "manifest.json")).json();
    expect(manifest).toMatchObject({
      executed: false,
      semanticValidation: "not-performed",
    });
    expect(await Bun.file(join(output, "settings.json")).text()).toBe(settings);
    expect(manifest.settingsSha256).toBe(
      createHash("sha256").update(settings).digest("hex"),
    );
    expect(manifest.source["packages/core/src/solve/roles.ts"]).toMatch(
      /^[a-f0-9]{64}$/,
    );
    const examples = await Bun.file(join(output, "cases.json")).json();
    expect(examples).toHaveLength(3);
    expect(manifest.commands).toHaveLength(3);
    for (const example of examples) {
      const inputPath = join(output, example.id, "input.json");
      const input = await Bun.file(inputPath).json();
      expect(input.notes[0].text).toBe(example.text);
      expect(input.targets).toEqual([{ id: "n1", through: "correctness" }]);
      expect(JSON.stringify(input)).not.toContain(example.expected.reason);
      expect(input).not.toHaveProperty("expected");
      const preparedCase = manifest.commands.find(
        (row: { id: string }) => row.id === example.id,
      );
      expect(preparedCase.argv.slice(4)).toEqual([
        "role",
        "verifier",
        inputPath,
        join(output, example.id, "campaign.sqlite"),
        join(output, "settings.json"),
      ]);
      expect(preparedCase.statusArgv.slice(4)).toEqual([
        "status",
        join(output, example.id, "campaign.sqlite"),
      ]);
      expect(
        await Bun.file(join(output, example.id, "campaign.sqlite")).exists(),
      ).toBe(false);
    }
    const frozen = await Bun.file(join(output, "manifest.json")).text();
    expect(Bun.spawnSync(command).exitCode).not.toBe(0);
    expect(await Bun.file(join(output, "manifest.json")).text()).toBe(frozen);
    expect(Bun.spawnSync([...command, "--run"]).exitCode).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true });
  }
});
