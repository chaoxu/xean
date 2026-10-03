import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectCampaign } from "../packages/core/src/index.ts";
import { offlineResearch } from "../scripts/bounded-solve.ts";
import {
  declarationVersion,
  readDeclaration,
} from "../packages/core/src/solve/campaign.ts";

test("closed-book research cannot retrieve or clear unresolved premises", async () => {
  const results = await offlineResearch.source(
    {
      task: { problem: "Prove a statement", completionCriteria: "A proof" },
      notes: [
        {
          id: "proved",
          summary: "Self-contained",
          detailedSummary: "Self-contained proof",
          text: "Self-contained proof",
          premises: [],
        },
        {
          id: "external",
          summary: "External theorem",
          detailedSummary: "Uses an external theorem",
          text: "Uses a theorem",
          premises: ["External claim"],
        },
      ],
    },
    null!,
    null!,
  );
  expect(results.map(({ result }) => result.verdict)).toEqual([
    "PASS",
    "INCONCLUSIVE",
  ]);
  await expect(offlineResearch.literature(null!, null!, null!)).rejects.toThrow(
    "disabled",
  );
  await expect(offlineResearch.review(null!, null!, null!)).rejects.toThrow(
    "disabled",
  );
  const declaration = {
    kind: "xean.solve",
    version: declarationVersion,
    task: { problem: "Prove a statement", completionCriteria: "A proof" },
    settings: {
      profiles: { default: { provider: "openai", model: "fixture" } },
    },
  };
  expect(() => readDeclaration(declaration)).not.toThrow();
  expect(() =>
    readDeclaration({ ...declaration, kind: "xean.solve.offline" }),
  ).toThrow();
});

test("closed-book runner honors omitted literature defaults and reopens without calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-offline-"));
  try {
    await writeFile(
      join(directory, "task.json"),
      JSON.stringify({
        problem: "Fixture",
        completionCriteria: "Exact result",
      }),
    );
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        profiles: { default: { provider: "openai", model: "unavailable" } },
      }),
    );
    const invoke = () =>
      Bun.spawnSync(
        [
          process.execPath,
          "--no-install",
          "--no-env-file",
          resolve(import.meta.dir, "../scripts/bounded-solve.ts"),
          directory,
          "--offline",
          "--round-limit",
          "0",
        ],
        { timeout: 5000, env: { ...process.env, OPENAI_API_KEY: "" } },
      );
    const run = async () => {
      const result = invoke();
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      return {
        result: await Bun.file(join(directory, "result.json")).json(),
        inspection: await inspectCampaign(
          join(directory, "campaign.sqlite"),
          true,
        ),
      };
    };
    const first = await run();
    expect(first.result).toMatchObject({
      outcome: "round_limit",
      rounds: 0,
      status: "paused",
      providerCalls: 0,
    });
    expect(first.inspection.records!.length).toBeGreaterThan(0);
    expect(first.result.campaign).toBeUndefined();
    expect(first.result.notes).toBeUndefined();
    expect(await Bun.file(join(directory, "records.json")).exists()).toBe(
      false,
    );
    const reopened = await run();
    expect(reopened.result.outcome).toBe("paused");
    expect(reopened.inspection).toEqual(first.inspection);
    expect(await Bun.file(join(directory, "observation.json")).exists()).toBe(
      false,
    );
    // Browser-native retrieval cannot be disabled by the offline role tools.
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        profiles: {
          default: { provider: "openai", model: "unavailable" },
          explorer: {
            provider: "codex-chatgpt-web",
            model: "chatgpt-web/gpt-6-pro",
          },
        },
      }),
    );
    const rejected = invoke();
    expect(rejected.exitCode).not.toBe(0);
    expect(rejected.stderr.toString()).toContain(
      "ChatGPT Web cannot enforce closed-book execution",
    );
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        profiles: { default: { provider: "openai", model: "unavailable" } },
        codex: { model: "unused", workspace: directory },
      }),
    );
    const codexRejected = invoke();
    expect(codexRejected.exitCode).not.toBe(0);
    expect(codexRejected.stderr.toString()).toContain(
      "Codex worker cannot enforce closed-book execution",
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});
