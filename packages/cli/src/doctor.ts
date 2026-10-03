import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { piRuntime, readSettings } from "xean/solve";

async function writableDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  let existing = requested;
  for (;;) {
    let entry;
    try {
      entry = await lstat(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
      continue;
    }
    if (!(entry.isSymbolicLink() ? await stat(existing) : entry).isDirectory())
      throw new Error(`Expected a directory: ${existing}`);
    await access(existing, constants.W_OK | constants.X_OK);
    return existing === requested
      ? `Writable directory: ${requested}`
      : `Writable ancestor: ${existing}; ${requested} was not created.`;
  }
}

/** Local preflight only: never creates a campaign or invokes a provider. */
export async function doctor(
  settingsPath: string,
  campaignDirectory: string,
  verifyInstallation: () => Promise<void>,
) {
  const checks: {
    name: string;
    status: "ok" | "error" | "unchecked";
    message: string;
  }[] = [];
  async function check<T>(
    name: string,
    action: () => Promise<T>,
    describe: (value: T) => string = String,
  ): Promise<T | undefined> {
    try {
      const value = await action();
      checks.push({ name, status: "ok", message: describe(value) });
      return value;
    } catch (error) {
      checks.push({
        name,
        status: "error",
        message: error instanceof Error ? error.message : "Check failed",
      });
      return undefined;
    }
  }
  await check("installation", async () => {
    await verifyInstallation();
    return "Installation receipt matches this runtime and dependency inputs.";
  });
  const settings = await check(
    "settings",
    async () => {
      let value: unknown;
      try {
        value = await Bun.file(resolve(settingsPath)).json();
      } catch {
        // JSON parser errors can quote the input; never echo credential material.
        throw new Error(`Cannot read settings JSON: ${resolve(settingsPath)}`);
      }
      return readSettings(value);
    },
    () => "Settings are valid.",
  );
  if (settings) {
    const runtime = await check(
      "profiles",
      async () => piRuntime(settings),
      () =>
        "Frozen models and explicit credential environment variables are available.",
    );
    if (runtime) {
      const models = runtime.models;
      const providers = new Set(
        Object.values(runtime.profiles)
          .filter(
            (profile) =>
              profile.model.provider === "codex-chatgpt-web" ||
              !profile.options?.apiKey,
          )
          .map((profile) => profile.model.provider),
      );
      for (const provider of providers) {
        if (provider === "codex-chatgpt-web") {
          checks.push({
            name: `credentials:${provider}`,
            status: "unchecked",
            message: "The external browser session was not checked.",
          });
          continue;
        }
        await check(`credentials:${provider}`, async () => {
          let available: unknown;
          try {
            available = await models.checkAuth(provider);
          } catch {
            throw new Error(
              `Could not check ${provider} credential availability.`,
            );
          }
          if (!available)
            throw new Error(
              `No ${provider} credential is available. Set the profile's apiKeyEnv to a populated environment variable.`,
            );
          return "Credential configuration is available; authentication was not attempted.";
        });
      }
    }
    const commands = new Set([
      settings.research?.command ?? "codex",
      ...(settings.codex ? [settings.codex.command ?? "codex"] : []),
    ]);
    for (const command of commands)
      await check(`codex:${command}`, async () => {
        const path = command.includes("/")
          ? resolve(command)
          : Bun.which(command);
        if (!path || !(await stat(path)).isFile())
          throw new Error(`Codex executable was not found: ${command}`);
        await access(path, constants.X_OK);
        return `Executable available: ${path}; Codex login and requests were not checked.`;
      });
    if (settings.codex) {
      const workspace = settings.codex.workspace;
      await check("codex-workspace", () => writableDirectory(workspace));
    }
  }
  await check("campaign-directory", () => writableDirectory(campaignDirectory));
  return { ok: checks.every((check) => check.status !== "error"), checks };
}
