import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI loads native custom providers and builtin models without credentials or network", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-cli-models-"));
  try {
    await writeFile(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:1/v1",
            models: [{ id: "proof" }],
          },
        },
      }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
        globalThis.fetch = () => { throw new Error("Unexpected network access"); };
        const { cliModels } = await import(${JSON.stringify(new URL("../apps/cli/models.ts", import.meta.url).href)});
        const models = await cliModels();
        console.log(JSON.stringify([
          models.getModel("local", "proof")?.baseUrl,
          models.getModel("openai", "gpt-6-astra")?.id,
        ]));
        await Bun.write(process.env.PI_CODING_AGENT_DIR + "/models.json", "{");
        const { rejects } = await import("node:assert/strict");
        await rejects(cliModels, /Failed to parse models.json/);
      `,
      ],
      { env: { PI_CODING_AGENT_DIR: directory, PI_OFFLINE: "1" } },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual([
      "http://127.0.0.1:1/v1",
      "gpt-6-astra",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
