import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

import { piProfileNames } from "../pi-roles";
import { settings } from "../runner";
import { task } from "../roles";
import { builtinPi } from "xean/pi";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

const directory = new URL("../examples/", import.meta.url);

test("every example uses the shared role settings", () => {
  const files = readdirSync(directory).filter(
    (name) => name.startsWith("settings-") && name.endsWith(".json"),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const parsed = settings.safeParse(
      JSON.parse(readFileSync(new URL(name, directory), "utf8")),
    );
    expect(parsed.success, `${name}: ${parsed.error?.message}`).toBe(true);
  }
});

test.each(["openai", "openai-codex"])(
  "public %s examples use valid tasks and built-in models without private infrastructure",
  (provider) => {
    task.parse(
      JSON.parse(
        readFileSync(new URL("task-even-sum.json", directory), "utf8"),
      ),
    );
    const value = settings.parse(
      JSON.parse(
        readFileSync(new URL(`settings-${provider}.json`, directory), "utf8"),
      ),
    );
    const models = builtinPi();
    for (const name of piProfileNames) {
      const profile = value[name];
      expect(profile.provider).toBe(provider);
      const model = models.getModel(profile.provider, profile.model);
      expect(model).toBeDefined();
      expect(getSupportedThinkingLevels(model!)).toContain(profile.reasoning);
    }
  },
);

test("the all-max example uses one profile per Pi call", () => {
  const value = settings.parse(
    JSON.parse(
      readFileSync(new URL("settings-sol-max.json", directory), "utf8"),
    ),
  );
  for (const name of piProfileNames) {
    expect(value[name].model).toBe("gpt-5.6-sol");
    expect(value[name].reasoning).toBe("max");
  }
  expect(value.source.provider).toBe("codex");
});
