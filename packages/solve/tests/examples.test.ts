import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { builtinPi } from "xean/pi";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

import { piProfileNames, solveSettings } from "../pi-roles";
import { task } from "../roles";

const directory = new URL("../examples/", import.meta.url);
const read = (name: string) =>
  JSON.parse(readFileSync(new URL(name, directory), "utf8"));

test("shipped settings are valid and public examples resolve without private infrastructure", () => {
  task.parse(read("task-even-sum.json"));
  const models = builtinPi();
  const files = readdirSync(directory).filter(
    (name) => name.startsWith("settings-") && name.endsWith(".json"),
  );
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    const settings = solveSettings.parse(read(name));
    if (!["settings-openai.json", "settings-openai-codex.json"].includes(name))
      continue;
    for (const role of piProfileNames) {
      const profile = settings[role];
      expect(profile.provider).toBe(
        name.slice("settings-".length, -".json".length),
      );
      const model = models.getModel(profile.provider, profile.model);
      expect(model, `${name}: ${role}`).toBeDefined();
      expect(getSupportedThinkingLevels(model!)).toContain(profile.reasoning);
    }
  }
});
