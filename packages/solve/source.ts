import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { Campaign, Entry, EntryId, Json } from "xean";
import { z } from "zod";

import { jsonSnapshot, nonblank, returnedOutput, type RoleName } from "./roles";

// The source verifier runs Codex with live web search, isolated in a fresh
// CODEX_HOME. Only the selected provider's connection settings and credentials
// are inherited; other Codex features stay disabled.
// Its request and stdout are journaled like any call.

/** The reasoning levels the Codex CLI accepts for model_reasoning_effort. */
export const codexReasoning = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const codexRequest = z.strictObject({
  protocol: z.literal("xean/codex-exec/v1"),
  model: nonblank,
  reasoning: codexReasoning,
  search: z.literal(true),
  developerInstructions: nonblank,
  prompt: nonblank,
  outputSchema: z.json(),
});
export type CodexRequest = z.output<typeof codexRequest>;

export const codexResult = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("succeeded"),
    codexVersion: z.string().min(1),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.strictObject({
    state: z.enum(["failed", "cancelled"]),
    codexVersion: z.string().min(1).optional(),
    stdout: z.string(),
    stderr: z.string(),
    exitCode: z.number().int().nullable().optional(),
    error: nonblank,
  }),
]);
export type CodexResult = z.output<typeof codexResult>;
export type CodexExec = (
  request: CodexRequest,
  signal?: AbortSignal,
) => Promise<CodexResult>;

export const codexUsage = z.strictObject({
  input: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
});
export type CodexUsage = z.output<typeof codexUsage>;

const compactionWarning =
  "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";
const reconnectNotice = /^Reconnecting(?:\.\.\.|…)\s+\d+\/\d+\s+\(/u;

function eventObject(value: Json): Record<string, Json> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Codex emitted a non-object JSONL event");
  }
  return value as Record<string, Json>;
}

/** Validate one complete transcript; live cancellation belongs to the caller. */
export function codexTranscript(stdout: string) {
  const transitions = ["thread.started", "turn.started", "turn.completed"];
  let stage = 0;
  let searches = 0;
  let usage: CodexUsage | undefined;
  let message: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const event = eventObject(z.json().parse(JSON.parse(line)));
    const type = z.string().parse(event["type"]);
    if (
      type === "error" &&
      typeof event["message"] === "string" &&
      reconnectNotice.test(event["message"])
    )
      continue;
    if (transitions.includes(type)) {
      if (type !== transitions[stage]) throw new Error(`${type} out of order`);
      stage++;
      if (type === "turn.completed") {
        const raw = eventObject(event["usage"] ?? {});
        usage = codexUsage.parse({
          input: raw["input_tokens"],
          cacheRead: raw["cached_input_tokens"],
          cacheWrite: raw["cache_write_input_tokens"],
          output: raw["output_tokens"],
          reasoning: raw["reasoning_output_tokens"],
        });
      }
      continue;
    }
    if (!["item.started", "item.updated", "item.completed"].includes(type)) {
      throw new Error(`Codex emitted forbidden event type: ${type}`);
    }
    if (stage !== 2) throw new Error(`${type} outside an active turn`);
    const item = eventObject(event["item"] ?? null);
    const itemType = z.string().parse(item["type"]);
    if (
      type === "item.completed" &&
      itemType === "error" &&
      item["message"] === compactionWarning
    ) {
      continue;
    }
    if (!["reasoning", "agent_message", "web_search"].includes(itemType)) {
      throw new Error(`Codex used forbidden item type: ${itemType}`);
    }
    if (type !== "item.completed") continue;
    if (itemType === "web_search") searches++;
    message =
      itemType === "agent_message" ? nonblank.parse(item["text"]) : undefined;
  }
  if (stage !== 3 || usage === undefined)
    throw new Error("Codex emitted no complete turn");
  if (message === undefined)
    throw new Error("Codex emitted no final completed agent message");
  return { message, searches, usage };
}

/** The provider outcome of a settled Codex call; shared by execution and inspection. */
export function codexOutcome(records: readonly Entry[], call: EntryId) {
  const returned = returnedOutput(records, call);
  if (returned === undefined) return undefined;
  const parsed = codexResult.safeParse(returned.output);
  return parsed.success
    ? { settled: returned.settled, ...parsed.data }
    : undefined;
}

/** The parsed final message of a succeeded Codex call, with its searches and usage. Throws on a malformed transcript. */
export function codexSubmission(
  records: readonly Entry[],
  call: EntryId,
):
  | {
      readonly settled: EntryId;
      readonly input: Json;
      readonly searches: number;
      readonly usage: CodexUsage;
    }
  | undefined {
  const output = codexOutcome(records, call);
  if (output?.state !== "succeeded") return undefined;
  const transcript = codexTranscript(output.stdout);
  return {
    settled: output.settled,
    input: z.json().parse(JSON.parse(transcript.message)),
    searches: transcript.searches,
    usage: transcript.usage,
  };
}

/** One journaled Codex invocation; callers retain their own failure policy. */
export async function codexCall(
  campaign: Campaign,
  call: {
    readonly label: string;
    readonly role: RoleName;
    readonly parent?: EntryId;
  },
  request: Json | CodexRequest,
  exec: CodexExec,
  signal?: AbortSignal,
): Promise<{ readonly call: EntryId; readonly output: CodexResult }> {
  const receipt = await campaign.call(
    {
      ...call,
      request: jsonSnapshot(request),
      ...(signal === undefined ? {} : { signal }),
    },
    (context) => exec(codexRequest.parse(context.request), context.signal),
  );
  return { call: receipt.call, output: codexResult.parse(receipt.output) };
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cancelled: boolean;
  readonly error?: string;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly input?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CommandResult> {
  if (options.signal?.aborted) {
    return {
      exitCode: null,
      stdout: "",
      stderr: "",
      cancelled: true,
    };
  }
  return await new Promise<CommandResult>((complete) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      // Codex may be a launcher with a native child. Keep both in the group
      // that we terminate, while remaining attached to their output and exit.
      detached: processGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let cancelled = false;
    let error: string | undefined;
    let termination: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (processGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // A process that exited before its close event needs no signal.
      }
    };
    const stop = () => {
      if (termination !== undefined) return;
      kill("SIGTERM");
      // The CLI, its launcher, or both may ignore SIGTERM. Keep the timer
      // until close, since descendants can retain the output pipes.
      termination = setTimeout(() => kill("SIGKILL"), 250);
    };
    const abort = () => {
      cancelled = true;
      stop();
    };
    const failure = (reason: unknown) => {
      error ??= reason instanceof Error ? reason.message : String(reason);
      stop();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stdout.on("error", failure);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stderr.on("error", failure);
    child.stdin.on("error", failure);
    child.on("error", failure);
    child.on("close", (exitCode) => {
      if (termination !== undefined) clearTimeout(termination);
      options.signal?.removeEventListener("abort", abort);
      complete({
        exitCode,
        stdout,
        stderr,
        cancelled,
        ...(error === undefined ? {} : { error }),
      });
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdin.end(options.input);
  });
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

const fileCredentials = { cli_auth_credentials_store: "file" };
const configArguments = (
  values: Readonly<Record<string, string | number | boolean>>,
): string[] =>
  Object.entries(values).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);

const providerConnection = z.strictObject({
  name: nonblank,
  base_url: z.url(),
  wire_api: z.literal("responses").default("responses"),
  env_key: nonblank.optional(),
  requires_openai_auth: z.boolean().default(false),
  supports_websockets: z.boolean().optional(),
  supports_standalone_web_search: z.boolean().optional(),
  http_headers: z.record(z.string(), z.string()).default({}),
  env_http_headers: z.record(z.string(), nonblank).default({}),
});

/** Read connection settings only; user instructions, tools, and hooks stay out. */
async function providerEnvironment(
  home: string,
  inherited: NodeJS.ProcessEnv,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly args: string[]; readonly requiresLogin: boolean }> {
  const configPath = join(home, "config.toml");
  if (!existsSync(configPath)) return { args: [], requiresLogin: true };
  const config = Bun.TOML.parse(await readFile(configPath, "utf8")) as {
    model_provider?: unknown;
    model_providers?: Record<string, unknown>;
  };
  if (
    config.model_provider === undefined ||
    config.model_provider === "openai"
  ) {
    return { args: [], requiresLogin: true };
  }
  const selected = nonblank.parse(config.model_provider);
  const provider = providerConnection.parse(config.model_providers?.[selected]);
  const args = ["-c", 'model_provider="xean-source"'];
  for (const key of [
    "name",
    "base_url",
    "wire_api",
    "env_key",
    "requires_openai_auth",
    "supports_websockets",
    "supports_standalone_web_search",
  ] as const) {
    const value = provider[key];
    if (value !== undefined)
      args.push(
        "-c",
        `model_providers.xean-source.${key}=${JSON.stringify(value)}`,
      );
  }
  if (provider.env_key !== undefined) {
    const key = inherited[provider.env_key];
    if (key === undefined || key.trim() === "")
      throw new Error(
        `source provider requires environment variable ${provider.env_key}`,
      );
    env[provider.env_key] = key;
  }
  const headers: Record<string, string> = {};
  // Header values may be credentials. Put them in the child environment, never argv.
  let index = 0;
  for (const [name, value] of Object.entries(provider.http_headers)) {
    let variable: string;
    do {
      variable = `XEAN_SOURCE_HEADER_${index++}`;
    } while (variable in inherited || variable in env);
    env[variable] = value;
    headers[name.toLowerCase()] = variable;
  }
  for (const [name, variable] of Object.entries(provider.env_http_headers)) {
    const value = inherited[variable];
    if (value !== undefined && value.trim() !== "") {
      headers[name.toLowerCase()] = variable;
      env[variable] = value;
    }
  }
  if (Object.keys(headers).length)
    args.push(
      "-c",
      `model_providers.xean-source.env_http_headers={${Object.entries(headers)
        .map(
          ([name, variable]) =>
            `${JSON.stringify(name)}=${JSON.stringify(variable)}`,
        )
        .join(",")}}`,
    );
  return {
    args,
    requiresLogin:
      provider.requires_openai_auth && provider.env_key === undefined,
  };
}

async function sourceEnvironment(
  directory: string,
  inherited: NodeJS.ProcessEnv,
): Promise<{
  readonly env: NodeJS.ProcessEnv;
  readonly hasAuth: boolean;
  readonly providerArgs: string[];
  readonly requiresLogin: boolean;
}> {
  const codexHome = join(directory, "codex-home");
  await mkdir(codexHome);
  const inheritedHome = resolve(
    inherited["CODEX_HOME"] ?? join(inherited["HOME"] ?? homedir(), ".codex"),
  );
  const inheritedAuth = join(inheritedHome, "auth.json");
  const hasAuth = existsSync(inheritedAuth);
  // Only process/network settings and the selected provider's named credentials.
  const env: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const name of Object.keys(inherited)) {
    if (
      [
        "PATH",
        "HOME",
        "TMPDIR",
        "TERM",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
      ].includes(name) ||
      /^(?:HTTPS?|NO|ALL)_PROXY$/iu.test(name)
    ) {
      env[name] = inherited[name];
    }
  }
  const provider = await providerEnvironment(inheritedHome, inherited, env);
  if (provider.requiresLogin && hasAuth) {
    await symlink(await realpath(inheritedAuth), join(codexHome, "auth.json"));
  } else {
    await writeFile(join(codexHome, "auth.json"), "{}\n", { mode: 0o600 });
  }
  return {
    env,
    hasAuth,
    providerArgs: provider.args,
    requiresLogin: provider.requiresLogin,
  };
}

/** Check the CLI and credentials once, then execute each request in a fresh environment. */
export async function prepareCodex(
  options: {
    readonly command?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
  } = {},
): Promise<CodexExec> {
  const command = options.command ?? "codex";
  const inherited = options.environment ?? process.env;
  const directory = await mkdtemp(join(tmpdir(), "xean-source-"));
  let codexVersion: string;
  try {
    const { env, hasAuth, providerArgs, requiresLogin } =
      await sourceEnvironment(directory, inherited);
    const check = async (args: readonly string[], failure: string) => {
      if (options.signal?.aborted) {
        throw new Error("source verifier preflight cancelled");
      }
      let result: CommandResult;
      try {
        result = await runCommand(command, args, {
          cwd: directory,
          env,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch {
        throw new Error(
          options.signal?.aborted
            ? "source verifier preflight cancelled"
            : failure,
        );
      }
      if (result.cancelled) {
        throw new Error("source verifier preflight cancelled");
      }
      // In particular, login status output can contain credential details.
      // Only its exit status is authoritative; never expose its output.
      if (result.exitCode !== 0) throw new Error(failure);
      return result.stdout;
    };
    const versionFailure = "source verifier requires an executable Codex CLI";
    codexVersion = (await check(["--version"], versionFailure)).trim();
    if (codexVersion === "") {
      throw new Error(versionFailure);
    }
    for (const [args, flags] of [
      [["--help"], ["--search", "--disable", "--model", "--config"]],
      [
        ["exec", "--help"],
        [
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--strict-config",
          "--skip-git-repo-check",
          "--sandbox",
          "--json",
          "--color",
          "--output-schema",
          "--cd",
        ],
      ],
    ] as const) {
      const help = await check(
        args,
        "source verifier could not check Codex CLI capabilities",
      );
      const missing = flags.filter(
        (flag) => !new RegExp(`${flag}(?=[\\s=,]|$)`, "u").test(help),
      );
      if (missing.length > 0) {
        throw new Error(
          `source verifier requires Codex CLI options: ${missing.join(", ")}`,
        );
      }
    }
    const authFailure =
      "source verifier requires native Codex credentials in CODEX_HOME/auth.json; run codex login";
    if (requiresLogin) {
      if (!hasAuth) throw new Error(authFailure);
      await check(
        [
          ...providerArgs,
          ...configArguments(fileCredentials),
          "login",
          "status",
        ],
        authFailure,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return async (request, signal) => {
    let directory: string | undefined;
    try {
      directory = await mkdtemp(join(tmpdir(), "xean-source-"));
      const { env, providerArgs } = await sourceEnvironment(
        directory,
        inherited,
      );
      const schemaPath = join(directory, "verdict.schema.json");
      await writeFile(schemaPath, JSON.stringify(request.outputSchema));
      const run = await runCommand(
        command,
        [
          "exec",
          "-m",
          request.model,
          ...providerArgs,
          ...configArguments({
            web_search: "live",
            ...Object.fromEntries(
              disabledFeatures.map((feature) => [`features.${feature}`, false]),
            ),
            ...fileCredentials,
            model_reasoning_effort: request.reasoning,
            developer_instructions: request.developerInstructions,
            "skills.include_instructions": false,
            include_environment_context: false,
            include_permissions_instructions: false,
            include_apps_instructions: false,
            include_collaboration_mode_instructions: false,
            project_doc_max_bytes: 0,
            "tools.update_plan.enabled": false,
          }),
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
      const { stdout, stderr, exitCode } = run;
      if (run.cancelled || run.error !== undefined || run.exitCode !== 0) {
        return {
          state: run.cancelled ? "cancelled" : "failed",
          codexVersion,
          stdout,
          stderr,
          exitCode,
          error: run.cancelled
            ? "source verification cancelled"
            : (run.error ?? `Codex exited with status ${run.exitCode}`),
        };
      }
      return { state: "succeeded", codexVersion, stdout, stderr };
    } catch (error) {
      return {
        state: signal?.aborted ? "cancelled" : "failed",
        codexVersion,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (directory !== undefined) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          // The journaled result remains authoritative if cleanup fails.
        }
      }
    }
  };
}
