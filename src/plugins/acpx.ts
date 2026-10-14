import { execa } from "execa";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { validateToolArguments, type Static } from "@earendil-works/pi-ai";
import type { EntryId } from "@earendil-works/pi-durable";
import {
  ExternalLog,
  ExternalRequest,
  type ExternalAnswer,
  type ExternalCall,
} from "../roles/backend.ts";
import { RoleFailure } from "../core/roles.ts";
import { externalResearch } from "../roles/research.ts";
import type { Roles } from "../core/workflow.ts";

export type AcpxOptions = {
  agent: string;
  model?: string;
  agentCommand?: string;
  config?: Record<string, string>;
  command?: string;
  environment?: NodeJS.ProcessEnv;
  workspace?: string;
  webTools?: { kind: string; rawInput?: Record<string, string> }[];
};
export type AcpxRoleOptions = {
  implementation?: AcpxOptions & { workspace: string };
  verifier?: AcpxOptions & { workspace: string };
  explorer?: AcpxOptions & { workspace: string };
  research?: AcpxOptions;
  usagePrefix?: string;
};
export type AcpxTranscript = {
  value?: JsonValue;
  error?: Error;
  usage: Record<string, number> | null;
  searches: number;
};
/** Register explicit CLI options through the existing role hook. */
export function acpx(options: AcpxRoleOptions) {
  return (builtins: Roles): Partial<Roles> => {
    const external = { ...builtins.external };
    for (const role of ["implementation", "verifier", "explorer"] as const) {
      const settings = options[role];
      if (settings) external[role] = acpxCall(settings, options.usagePrefix);
    }
    if (options.research)
      external.research = externalResearch(
        acpxCall(options.research, options.usagePrefix),
      );
    return { external };
  };
}

const defaultWebTools = [{ kind: "fetch" }];

/** ACP has no final-answer phase. The role prompt supplies one explicit result block. */
export function acpxTranscript(
  stdout: string,
  failed = false,
  webTools: NonNullable<AcpxOptions["webTools"]> = defaultWebTools,
): AcpxTranscript {
  const result: AcpxTranscript = { usage: null, searches: 0 };
  const calls = new Map<
    string,
    {
      kind?: string;
      status?: string;
      rawInput?: Record<string, unknown> | null;
    }
  >();
  let text = "";
  let completed = 0;
  let protocolError: RoleFailure | undefined;
  const usage: Record<string, number> = {};
  const fields = {
    inputTokens: "input_tokens",
    outputTokens: "output_tokens",
    totalTokens: "total_tokens",
    thoughtTokens: "reasoning_tokens",
    cachedReadTokens: "cached_input_tokens",
    cachedWriteTokens: "cache_write_input_tokens",
  };
  for (const [line] of stdout.matchAll(/[^\n]+/g)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (!event || typeof event !== "object" || Array.isArray(event))
        throw new Error("acpx emitted an invalid event");
      const update =
        event.method === "session/update" ? event.params?.update : undefined;
      if (
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      )
        text += update.content.text;
      if (
        ["tool_call", "tool_call_update"].includes(update?.sessionUpdate) &&
        typeof update.toolCallId === "string"
      ) {
        const previous = calls.get(update.toolCallId);
        calls.set(update.toolCallId, {
          kind: update.kind ?? previous?.kind,
          status: update.status ?? previous?.status,
          rawInput:
            update.rawInput === undefined
              ? previous?.rawInput
              : update.rawInput,
        });
      }
      if (
        update?.sessionUpdate === "usage_update" &&
        update.cost?.currency === "USD" &&
        Number.isFinite(update.cost.amount) &&
        update.cost.amount >= 0
      )
        usage.cost_usd = update.cost.amount;
      if (typeof event.result?.stopReason === "string") {
        completed++;
        if (event.result.stopReason !== "end_turn")
          result.error ??= new RoleFailure(
            `acpx turn ended: ${event.result.stopReason}`,
          );
        for (const [from, to] of Object.entries(fields)) {
          const value = event.result.usage?.[from];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0)
            usage[to] = value;
        }
      }
      // Callback failures can be recovered by the agent before a successful end_turn.
      if (event.error)
        protocolError = new RoleFailure(
          typeof event.error.data?.details === "string" &&
            event.error.data.details.trim()
            ? event.error.data.details
            : event.error.message || "acpx agent failed",
        );
    } catch (error) {
      result.error ??= new Error("acpx emitted malformed JSONL", {
        cause: error,
      });
    }
  }
  result.usage = Object.keys(usage).length ? usage : null;
  result.searches = [...calls.values()].filter(
    (call) =>
      call.status === "completed" &&
      webTools.some(
        (tool) =>
          call.kind === tool.kind &&
          Object.entries(tool.rawInput ?? {}).every(
            ([key, value]) => call.rawInput?.[key] === value,
          ),
      ),
  ).length;
  if (completed !== 1 || failed)
    result.error ??=
      protocolError ?? new Error("acpx emitted no unique completed turn");
  const blocks = [...text.matchAll(/<xean-result>([\s\S]*?)<\/xean-result>/g)];
  const block = blocks[0];
  if (
    blocks.length !== 1 ||
    text.split("<xean-result>").length !== 2 ||
    text.split("</xean-result>").length !== 2 ||
    !block ||
    text.slice(block.index + block[0].length).trim()
  )
    result.error ??= new Error("acpx emitted no unique final result block");
  if (!result.error)
    try {
      result.value = JSON.parse(block![1]!) as JsonValue;
    } catch (error) {
      result.error = new Error("acpx final answer was not JSON", {
        cause: error,
      });
    }
  return result;
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Pi journals results; incomplete invocations restart in a fresh workspace. Execa owns processes. */
export function acpxCall(
  settings: AcpxOptions,
  usagePrefix?: string,
): ExternalCall {
  return async (mode, schema, instructions, input, runtime, context) => {
    const key = `external.${hash([mode, schema, instructions, input])}`;
    // Persist only a digest: executable configuration may contain credentials.
    const identity = hash([
      settings.agent,
      settings.agentCommand,
      settings.model,
      settings.command ?? "acpx",
      Object.entries(settings.config ?? {}).sort(([a], [b]) =>
        a.localeCompare(b),
      ),
      settings.workspace,
      settings.webTools ?? defaultWebTools,
      settings.environment &&
        Object.entries(settings.environment).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      usagePrefix,
    ]);
    if (
      (await runtime.memo(`external.${mode}.backend`, identity, context)) !==
      identity
    )
      throw new Error(
        "External backend configuration changed during task recovery",
      );
    const cached = await runtime.memo<ExternalAnswer<typeof schema>>(
      key,
      context,
    );
    if (cached !== undefined) return structuredClone(cached);
    const worker = mode === "worker";
    const tool = {
      name: "external_output",
      description: "External result",
      parameters: schema,
    };
    const parent = worker ? settings.workspace : tmpdir();
    if (!parent || !isAbsolute(parent))
      throw new Error("acpx.workspace must be an absolute directory");
    if (worker) await mkdir(parent, { recursive: true });
    const workspace = await mkdtemp(join(parent, "acpx-"));
    const operationId = crypto.randomUUID();
    let requestEntry: EntryId | undefined;
    let completion = "Completion unrecorded; execution may have occurred.";
    try {
      if (worker)
        await writeFile(
          join(workspace, "input.json"),
          JSON.stringify(input) + "\n",
        );
      const args = [
        "--cwd",
        workspace,
        "--format",
        "json",
        "--json-strict",
        "--suppress-reads",
        "--approve-all",
        "--prompt-retries",
        "0",
        ...(settings.model ? ["--model", settings.model] : []),
        ...(settings.agentCommand
          ? ["--agent", settings.agentCommand]
          : [settings.agent]),
        "exec",
        ...Object.entries(settings.config ?? {}).flatMap(([key, value]) => [
          "--config-option",
          `${key}=${value}`,
        ]),
        "--file",
        "-",
      ];
      const environment = { ...process.env, ...settings.environment };
      const usageTag = usagePrefix
        ? `${usagePrefix}/${runtime.taskId}`
        : environment.XEAN_CODEX_USAGE_TAG;
      let entry: EntryId | undefined;
      await runtime.commit(async (tx) => {
        entry = (
          await tx.appendEntry(ExternalRequest, runtime.conversationId, {
            data: {
              provider: `acpx/${settings.agent}`,
              api: "acpx-exec",
              operationId,
              model: settings.model ?? "default",
              workspace,
              reasoning: settings.config?.reasoning_effort ?? "default",
              profile: null,
              usageTag: usageTag ?? null,
            },
          })
        ).id;
      }, context);
      requestEntry = entry;
      const executable = settings.command ?? "acpx";
      context.abortSignal?.throwIfAborted();
      const child = execa(
        executable.includes("/") ? resolve(executable) : executable,
        args,
        {
          cwd: workspace,
          env: {
            ...environment,
            ...(usageTag ? { XEAN_CODEX_USAGE_TAG: usageTag } : {}),
          },
          extendEnv: false,
          input: JSON.stringify({
            instructions: `${instructions}\nEnd your answer with exactly one <xean-result>JSON</xean-result> block matching the supplied schema. Put only the final result in that block.`,
            schema,
            input:
              input !== null &&
              typeof input === "object" &&
              !Array.isArray(input)
                ? { ...input, workspace }
                : input,
          }),
          cancelSignal: context.abortSignal,
          killDescendants: true,
          reject: false,
          // Execa measures decoded output in characters, separately per stream.
          maxBuffer: { stdout: 16 * 1024 * 1024, stderr: 1024 * 1024 },
          stripFinalNewline: false,
        },
      );
      // Execa destroys an overflowing pipe but waits for process exit.
      for (const stream of [child.stdout, child.stderr])
        stream?.once("close", () => {
          if (!stream.readableEnded) child.kill();
        });
      // A cooperative parent can exit before Execa's force-kill timer fires.
      const run = await child.finally(() => {
        child.kill("SIGKILL");
      });
      context.abortSignal?.throwIfAborted();
      const transcript = acpxTranscript(
        run.stdout,
        run.failed,
        settings.webTools,
      );
      let log: EntryId | undefined;
      await runtime.commit(async (tx) => {
        log = (
          await tx.appendEntry(ExternalLog, runtime.conversationId, {
            data: {
              operationId,
              stdout: run.stdout,
              stderr: run.stderr,
              exitCode: run.exitCode ?? null,
              usage: transcript.usage,
              ...(run.isMaxBuffer ? { outputTruncated: true } : {}),
            },
          })
        ).id;
      }, context);
      completion = `acpx log entry: ${log}; exit code: ${run.exitCode ?? "unknown"}; output truncated: ${Boolean(run.isMaxBuffer)}.`;
      if (run.isMaxBuffer)
        throw new RoleFailure(
          `acpx exceeded its output capture limit (16 Mi characters stdout, 1 Mi stderr); recorded output is truncated`,
        );
      const failure =
        transcript.error instanceof RoleFailure ? transcript.error : undefined;
      if (run.failed || failure)
        throw new RoleFailure(
          failure?.message ||
            run.stderr.trim() ||
            (failure ? `acpx reported a failed turn` : run.shortMessage) ||
            `acpx process failed`,
        );
      if (transcript.error) throw transcript.error;
      const value: Static<typeof schema> = validateToolArguments(tool, {
        type: "toolCall",
        id: operationId,
        name: tool.name,
        arguments: transcript.value as Record<string, JsonValue>,
      });
      const answer = {
        value,
        workspace,
        operationId,
        searches: transcript.searches,
        reportedAt: new Date().toISOString(),
      };
      return structuredClone(await runtime.memo(key, answer, context));
    } catch (error) {
      context.abortSignal?.throwIfAborted();
      if (error instanceof Error) {
        const primary =
          error.message.length > 4096
            ? `${error.message.slice(0, 4096)}… [see acpx log]`
            : error.message;
        error.message = `${primary}\n\n${requestEntry ? "Execution receipt" : `acpx operation`}: ${operationId}\nRequest entry: ${requestEntry ?? "unrecorded"}\n${completion}\n${worker ? "Retained" : "Temporary research"} workspace: ${workspace}\nFailure does not imply that no commands ran.`;
      }
      throw error;
    } finally {
      if (!worker)
        await rm(workspace, { recursive: true, force: true }).catch((error) =>
          runtime.report(error),
        );
    }
  };
}
