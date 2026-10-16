import { execa } from "execa";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodexExec } from "./policy/source.ts";

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    input?: string;
    signal?: AbortSignal;
  },
) {
  const child = execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: false,
    input: options.input,
    cancelSignal: options.signal,
    killDescendants: true,
    forceKillAfterDelay: 1000,
    reject: false,
    stripFinalNewline: false,
    maxBuffer: { stdout: 16 * 1024 * 1024, stderr: 1024 * 1024 },
  });
  // An overflowing pipe must also terminate a producer that keeps running.
  for (const stream of [child.stdout, child.stderr])
    stream?.once("close", () => {
      if (!stream.readableEnded) child.kill();
    });
  const result = await child.finally(() => {
    child.kill("SIGKILL");
  });
  return {
    ...result,
    cancelled: options.signal?.aborted === true || result.isCanceled,
    exitCode: result.exitCode ?? null,
  };
}

const disabledFeatures = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "remote_plugin",
  "plugin_sharing",
  "shell_tool",
  "skill_search",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
] as const;

const fileCredentials = 'cli_auth_credentials_store="file"';

async function sourceEnvironment(
  directory: string,
  inherited: NodeJS.ProcessEnv,
): Promise<{ readonly env: NodeJS.ProcessEnv; readonly hasAuth: boolean }> {
  const codexHome = join(directory, "codex-home");
  await mkdir(codexHome);
  const inheritedHome = resolve(
    inherited["CODEX_HOME"] ?? join(inherited["HOME"] ?? homedir(), ".codex"),
  );
  const inheritedAuth = join(inheritedHome, "auth.json");
  const hasAuth = existsSync(inheritedAuth);
  if (hasAuth) {
    await symlink(await realpath(inheritedAuth), join(codexHome, "auth.json"));
  } else {
    await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  }
  // Only what the CLI needs to run and reach the network; in particular
  // no OPENAI_* or CODEX_* variable that would move it off its native
  // credential, and no other process's secrets.
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const name of Object.keys(inherited)) {
    if (
      ["PATH", "HOME", "TMPDIR", "TERM", "LANG", "LC_ALL"].includes(name) ||
      /^(?:HTTPS?|NO|ALL)_PROXY$/iu.test(name)
    ) {
      env[name] = inherited[name];
    }
  }
  return { env, hasAuth };
}

export function codexExec(
  options: {
    readonly command?: string;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): CodexExec {
  const command =
    options.command ?? process.env["XEAN_CODEX_COMMAND"] ?? "codex";
  const inherited = options.environment ?? process.env;
  let knownVersion: string | undefined;
  return async (request, signal) => {
    let directory: string | undefined;
    let codexVersion = knownVersion;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null | undefined;
    try {
      signal?.throwIfAborted();
      directory = await mkdtemp(join(tmpdir(), "xean-source-"));
      const { env } = await sourceEnvironment(directory, inherited);
      const schemaPath = join(directory, "verdict.schema.json");
      await writeFile(schemaPath, JSON.stringify(request.outputSchema));
      if (codexVersion === undefined) {
        const version = await runCommand(command, ["--version"], {
          env,
          ...(signal === undefined ? {} : { signal }),
        });
        const reported = version.stdout.trim();
        if (version.cancelled) {
          return {
            state: "cancelled",
            ...(reported === "" ? {} : { codexVersion: reported }),
            stdout,
            stderr: version.stderr,
            error: "source verification cancelled",
          };
        }
        if (version.failed || reported === "") {
          throw new Error(
            version.stderr || "could not determine Codex version",
          );
        }
        codexVersion = reported;
        knownVersion = reported;
      }
      const run = await runCommand(
        command,
        [
          ...(request.search ? ["--search"] : []),
          "-m",
          request.model,
          ...disabledFeatures.flatMap((feature) => ["--disable", feature]),
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--strict-config",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--json",
          "--color",
          "never",
          "--output-schema",
          schemaPath,
          "-c",
          fileCredentials,
          "-c",
          `model_reasoning_effort="${request.reasoning}"`,
          // Current Codex needs these explicit controls to retain v1's tool policy:
          // an omitted --search may allow cached search, and feature flags alone
          // do not disable model-configured subagents. Mathematical prompts stay exact.
          ...(request.search ? [] : ["-c", 'web_search="disabled"']),
          "-c",
          "agents.enabled=false",
          "-c",
          `developer_instructions=${JSON.stringify(request.developerInstructions)}`,
          "-c",
          "skills.include_instructions=false",
          "-c",
          "include_environment_context=false",
          "-c",
          "include_permissions_instructions=false",
          "-c",
          "include_apps_instructions=false",
          "-c",
          "include_collaboration_mode_instructions=false",
          "-c",
          "project_doc_max_bytes=0",
          "-c",
          "tools.update_plan.enabled=false",
          "-C",
          directory,
          "-",
        ],
        {
          cwd: directory,
          env,
          input: request.prompt,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      stdout = run.stdout;
      stderr = run.stderr;
      exitCode = run.exitCode;
      if (run.cancelled) {
        return {
          state: "cancelled",
          codexVersion,
          stdout,
          stderr,
          exitCode,
          error: "source verification cancelled",
        };
      }
      if (run.failed) {
        return {
          state: "failed",
          codexVersion,
          stdout,
          stderr,
          exitCode,
          error: run.isMaxBuffer
            ? "Codex output exceeded the capture limit"
            : `Codex exited with status ${run.exitCode}`,
        };
      }
      return { state: "succeeded", codexVersion, stdout, stderr };
    } catch (error) {
      return {
        state: signal?.aborted ? "cancelled" : "failed",
        ...(codexVersion === undefined ? {} : { codexVersion }),
        stdout,
        stderr,
        ...(exitCode === undefined ? {} : { exitCode }),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (directory !== undefined) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          // Cleanup must not discard the returned execution receipt.
        }
      }
    }
  };
}
