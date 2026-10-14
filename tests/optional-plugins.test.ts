import { expect, test } from "bun:test";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { open, readReport, type OpenOptions } from "../src/index.ts";
import { ExternalLog, ExternalRequest } from "../src/roles/backend.ts";
import { RoleFailure } from "../src/core/roles.ts";
import {
  claude,
  claudeCall,
  claudeTranscript,
} from "../src/plugins/role-backends/claude.ts";
import { codex, codexCall } from "../src/plugins/role-backends/codex.ts";
import { chatgpt } from "../src/plugins/role-backends/chatgpt.ts";
import { explorationSchema } from "../src/core/math/contracts.ts";
import { noteIdPrefix } from "../src/core/math/state.ts";
import { temporaryDirectory } from "./directory.ts";
import { context, noteResult, settings, task } from "./fixture.ts";

const success = {
  type: "result",
  subtype: "success",
  is_error: false,
  structured_output: noteResult,
  usage: { input_tokens: 41, output_tokens: 9, cache_read_input_tokens: 23 },
  total_cost_usd: 0.001,
};

async function command(source: string) {
  const workspace = await temporaryDirectory("optional-cli-");
  const executable = join(workspace, "fixture");
  await writeFile(executable, `#!${process.execPath}\n${source}\n`);
  await chmod(executable, 0o700);
  return { model: "fixture", command: executable, workspace };
}

async function runImplementation(
  options: Awaited<ReturnType<typeof command>>,
  roles: OpenOptions["roles"] = claude({ implementation: options }),
) {
  const owner = await open(join(options.workspace, "campaign.sqlite"), {
    create: {
      task,
      settings,
      mode: {
        role: "implementation",
        input: { notes: [], assignment: "Prove reflexivity" },
      },
    },
    roles,
  });
  try {
    await owner.root.waitForIdle(context);
    return await owner.root.commit(
      (tx) => readReport(tx, owner.root.id, { records: true }),
      context,
    );
  } finally {
    await owner.close();
  }
}

test("Claude uses native schema/stdin and journals structured output, usage, and provider identity", async () => {
  const options = await command(`
    const args = process.argv.slice(2);
    const parameter = flag => args[args.indexOf(flag) + 1];
    if (parameter('--output-format') !== 'json' || !args.includes('--no-session-persistence')) throw new Error('Wrong CLI mode');
    if (!args.includes('--restricted') || !args.includes('--safe-mode') || !args.includes('--strict-mcp-config')) throw new Error('Missing native isolation flags');
    const sandbox = JSON.parse(parameter('--settings')).sandbox;
    if (!sandbox.enabled || sandbox.allowUnsandboxedCommands !== false || sandbox.failIfUnavailable !== true) throw new Error('Wrong native sandbox config');
    if (parameter('--allowedTools') !== 'Read,Write,Edit,Bash,Glob,Grep') throw new Error('Required execution tools not allowed');
    const schema = JSON.parse(parameter('--json-schema'));
    if (!schema.properties.notes) throw new Error('Missing output schema');
    const input = await Bun.stdin.json();
    if (!input.task || !input.assignment || require('node:fs').realpathSync(input.workspace) !== process.cwd()) throw new Error('Missing frozen task');
    if (!input.noteIdPrefix) throw new Error('Missing permanent note namespace');
    const permanentId = input.noteIdPrefix + 'reflexivity';
    const idPattern = new RegExp(schema.properties.notes.items.properties.id.pattern);
    if (!idPattern.test(permanentId) || idPattern.test('n1')) throw new Error('Missing namespace constraint');
    const output = ${JSON.stringify(success)};
    output.structured_output.notes[0].id = permanentId;
    process.stdout.write(JSON.stringify(output));
  `);
  const report = await runImplementation(options);
  expect(report.status).toMatchObject({ status: "completed" });
  const request = report.records!.find(ExternalRequest.is)!.data;
  expect(request).toMatchObject({
    provider: "claude-cli",
    api: "claude-print",
    model: "fixture",
  });
  const log = report.records!.find(ExternalLog.is)!.data;
  expect(log).toMatchObject({
    operationId: request.operationId,
    exitCode: 0,
    usage: { ...success.usage, cost_usd: 0.001 },
  });
});

test("completed plugin calls reuse Pi results; recovery rejects another adapter or changed configuration", async () => {
  const options = await command(
    `const input = await Bun.stdin.json();
     const output = ${JSON.stringify(success)};
     output.structured_output.notes[0].id = input.noteIdPrefix + 'reflexivity';
     process.stdout.write(JSON.stringify(output));`,
  );
  const report = await runImplementation(options, () => ({
    async implementation(input, runtime, context) {
      const call = claudeCall(options);
      const args = [
        "worker",
        explorationSchema,
        "Exact task",
        { ...input, noteIdPrefix: noteIdPrefix(runtime.taskId) },
        runtime,
        context,
      ] as const;
      const first = await call(...args);
      const original = structuredClone(first);
      first.value.notes[0]!.text = "Changed caller copy";
      expect(await call(...args)).toEqual(original);
      // Property order is not configuration identity.
      expect(
        await claudeCall({
          workspace: options.workspace,
          command: options.command,
          model: options.model,
        })(...args),
      ).toEqual(original);
      await expect(
        claudeCall({ ...options, model: "changed" })(...args),
      ).rejects.toThrow("configuration changed");
      await expect(codexCall(options)(...args)).rejects.toThrow(
        "configuration changed",
      );
      return { kind: "notes", ...original.value };
    },
  }));
  expect(report.status).toMatchObject({ status: "completed" });
  expect(report.records!.filter(ExternalLog.is)).toHaveLength(1);
  expect(report.records!.filter(ExternalRequest.is)).toHaveLength(1);
});

test.each([
  {
    ...success,
    subtype: "error_max_turns",
    is_error: true,
    result: "Turn limit reached",
  },
  {
    ...success,
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Provider unavailable"],
  },
])(
  "Claude failed results retain accounting and fail even with structured output present",
  (event) => {
    const parsed = claudeTranscript(JSON.stringify(event));
    expect(parsed.error).toBeInstanceOf(RoleFailure);
    expect(parsed.value).toBeUndefined();
    expect(parsed.usage).toEqual({ ...success.usage, cost_usd: 0.001 });
  },
);

test.each([
  "",
  "not json",
  JSON.stringify({ type: "assistant" }),
  JSON.stringify({ type: "result", subtype: "success" }),
])("Claude requires a complete native structured result: %j", (output) => {
  const parsed = claudeTranscript(output);
  expect(parsed.error).toBeInstanceOf(Error);
  expect(parsed.value).toBeUndefined();
});

test.each([
  ["codex", "claude"],
  ["claude", "codex"],
  ["browser", "codex"],
  ["codex", "browser"],
] as const)(
  "interrupted %s Explorer cannot recover under %s or dispatch again",
  async (first, second) => {
    const started = Promise.withResolvers<void>();
    const calls = { codex: 0, claude: 0, browser: 0 };
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        const kind =
          path === "/codex"
            ? "codex"
            : path === "/claude"
              ? "claude"
              : "browser";
        calls[kind]++;
        started.resolve();
        return kind === "browser"
          ? new Promise<Response>(() => {})
          : new Response("ready");
      },
    });
    let owner: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const options = await command(
        `await fetch(${JSON.stringify(server.url.href)} + (process.argv.includes("--print") ? "claude" : "codex")); setInterval(() => {}, 1000);`,
      );
      const path = join(options.workspace, "campaign.sqlite");
      const roles = {
        codex: codex({ explorer: options }),
        claude: claude({ explorer: options }),
        browser: chatgpt({
          baseUrl: server.url.href.replace(/\/$/, ""),
          model: "chatgpt-web/fixture",
        }),
      };
      owner = await open(path, {
        roles: roles[first],
        create: {
          task,
          settings,
          mode: {
            role: "explorer",
            input: { notes: [], assignment: "Continue" },
          },
        },
      });
      owner.harness.resume();
      await started.promise;
      await owner.close();
      owner = undefined;
      const admitted = { ...calls };
      expect(admitted).toEqual({ codex: 0, claude: 0, browser: 0, [first]: 1 });
      owner = await open(path, {
        roles: roles[second],
      });
      await owner.root.waitForIdle(context);
      const root = owner.root;
      const report = await root.commit(
        (tx) => readReport(tx, root.id),
        context,
      );
      expect(report.status.status).toBe("blocked");
      expect(report.status.error).toContain(
        "External backend configuration changed",
      );
      expect(calls).toEqual(admitted);
    } finally {
      await owner?.close();
      await server.stop(true);
    }
  },
);
