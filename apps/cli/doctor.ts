import { resolve } from "node:path";
import { createRuntime, readSettings } from "../../src/config.ts";
import { verifyInstall } from "../../scripts/dependencies.ts";

/** Local setup only: never creates a campaign or invokes a provider or Codex. */
export async function doctor(settingsPath: string) {
  try {
    await verifyInstall();
    let value: unknown;
    try {
      value = await Bun.file(resolve(settingsPath)).json();
    } catch {
      // JSON parser errors can quote the input, including credential material.
      throw new Error(`Cannot read settings JSON: ${resolve(settingsPath)}`);
    }
    const settings = readSettings(value);
    const { models, profiles } = createRuntime(settings);
    for (const [name, { model, checkAuth }] of Object.entries(profiles)) {
      if (name === "explorer" && settings.chatgpt) continue;
      if (!models.getModel(model.provider, model.modelId))
        throw new Error(`Unknown Pi model: ${model.provider}/${model.modelId}`);
      const available = await checkAuth!().catch(() => {
        throw new Error(
          `Could not check ${model.provider} credential availability.`,
        );
      });
      if (!available)
        throw new Error(`No ${model.provider} credential is available.`);
    }
    const commands = new Set([
      ...(settings.research === false
        ? []
        : [settings.research?.command ?? "codex"]),
      ...(settings.codex ? [settings.codex.command ?? "codex"] : []),
    ]);
    for (const command of commands)
      if (!Bun.which(command))
        throw new Error(`Codex executable was not found: ${command}`);
    return {
      ok: true,
      message:
        "Pinned artifacts, Pi versions, settings, models, credential configuration, and Codex executables are available. Provider authentication, browser sessions, and Codex login were not checked.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Setup check failed",
    };
  }
}
