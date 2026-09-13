import { Database, SQLiteError } from "bun:sqlite";
import { constants, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinPi } from "elenx/pi";

export type SolveModels = Pick<
  ReturnType<typeof builtinPi>,
  "getModel" | "streamSimple"
> & { readonly checkAuth?: (provider: string) => Promise<unknown> };

export async function createModelRuntime(
  options: Parameters<typeof ModelRuntime.create>[0],
): Promise<ModelRuntime> {
  const modelsPath = options?.modelsPath;
  if (typeof modelsPath === "string") await access(modelsPath, constants.R_OK);
  // Pi 0.85.1 has no public runtime subpath. Keep its pinned layout here so
  // model setup does not load the coding-agent CLI and terminal UI.
  const url = new URL(
    "./core/model-runtime.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  );
  const { ModelRuntime: Runtime } = (await import(url.href)) as {
    ModelRuntime: typeof ModelRuntime;
  };
  const runtime = await Runtime.create(options);
  if (typeof modelsPath === "string") {
    const error = runtime.getError();
    if (error !== undefined) throw new Error(error);
  }
  // The installed coding-agent can have its own pi-ai dependency. Bind the
  // Responses adapters to Elenx's reviewed Pi distribution so request handling
  // and session cleanup use the same native provider module.
  const native = builtinPi();
  const responses = new Map([
    ["openai-responses", native.getProvider("openai")!],
    ["openai-codex-responses", native.getProvider("openai-codex")!],
  ]);
  for (const provider of runtime.getProviders()) {
    if (!provider.getModels().some((model) => responses.has(model.api)))
      continue;
    runtime.registerNativeProvider({
      ...provider,
      stream(model, context, streamOptions) {
        return (responses.get(model.api) ?? provider).stream(
          model,
          context,
          streamOptions,
        );
      },
      streamSimple(model, context, streamOptions) {
        return (responses.get(model.api) ?? provider).streamSimple(
          model,
          context,
          streamOptions,
        );
      },
    });
  }
  return runtime;
}

export function codexCommand(environment: NodeJS.ProcessEnv): string {
  return environment["ELENX_CODEX_COMMAND"] ?? "codex";
}

export function modelRegistryPath(
  environment: NodeJS.ProcessEnv,
): string | null {
  const value = environment["ELENX_MODELS_PATH"];
  if (value === undefined) return null;
  if (!isAbsolute(value)) throw new Error("ELENX_MODELS_PATH must be absolute");
  return value;
}

export async function requireCredentials(
  runtime: { readonly checkAuth: (provider: string) => Promise<unknown> },
  providers: readonly string[],
): Promise<void> {
  const missing = (
    await Promise.all(
      [...new Set(providers)].map(async (provider) =>
        (await runtime.checkAuth(provider)) === undefined ? [provider] : [],
      ),
    )
  ).flat();
  if (missing.length > 0) {
    throw new Error(`No credential for provider(s): ${missing.join(", ")}`);
  }
}

function runnerLockPath(campaignPath: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(campaignPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    canonicalPath = join(
      realpathSync(dirname(campaignPath)),
      basename(campaignPath),
    );
  }
  return `${canonicalPath}.runner.lock`;
}

export async function withCampaignLock<T>(
  campaignPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  using lock = new Database(runnerLockPath(campaignPath), {
    create: true,
  });
  lock.run("PRAGMA busy_timeout = 0");
  try {
    lock.run("BEGIN EXCLUSIVE");
  } catch (error) {
    if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY")) {
      throw new Error(
        `campaign already has a running process: ${campaignPath}`,
        { cause: error },
      );
    }
    throw error;
  }
  return await operation();
}

export function selectModel(
  models: SolveModels,
  selection: { readonly provider: string; readonly modelId: string },
) {
  const model = models.getModel(selection.provider, selection.modelId);
  if (model === undefined) {
    throw new Error(
      `unknown Pi model: ${selection.provider}/${selection.modelId}`,
    );
  }
  return model;
}
