import { resolve } from "node:path";
import { piRuntime, readSettings } from "xean/solve";

/** Local setup only: never creates a campaign or invokes a provider or Codex. */
export async function doctor(
  settingsPath: string,
  verifyInstallation: () => Promise<void>,
) {
  try {
    await verifyInstallation();
    let value: unknown;
    try {
      value = await Bun.file(resolve(settingsPath)).json();
    } catch {
      // JSON parser errors can quote the input, including credential material.
      throw new Error(`Cannot read settings JSON: ${resolve(settingsPath)}`);
    }
    const settings = readSettings(value);
    const { models, profiles } = piRuntime(settings);
    const providers = new Set(
      Object.values(profiles)
        .filter((profile) => !profile.options?.apiKey)
        .map((profile) => profile.model.provider),
    );
    for (const provider of providers) {
      const available = await models.checkAuth(provider).catch(() => {
        throw new Error(`Could not check ${provider} credential availability.`);
      });
      if (!available)
        throw new Error(
          `No ${provider} credential is available. Set the profile's apiKeyEnv to a populated environment variable.`,
        );
    }
    const commands = new Set([
      settings.research?.command ?? "codex",
      ...(settings.codex ? [settings.codex.command ?? "codex"] : []),
    ]);
    for (const command of commands)
      if (!Bun.which(command))
        throw new Error(`Codex executable was not found: ${command}`);
    return {
      ok: true,
      message:
        "Installation, settings, models, credential configuration, and Codex executables are available. Provider authentication, browser sessions, and Codex login were not checked.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Setup check failed",
    };
  }
}
