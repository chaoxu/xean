import { expect, test } from "bun:test";
import { access, chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect, open, readReport, type OpenOptions } from "../src/index.ts";
import { RoleFailure } from "../src/core/roles.ts";
import {
  explorationSchema,
  noteResultSchema,
} from "../src/core/math/contracts.ts";
import { noteIdPrefix } from "../src/core/math/state.ts";
import { ExternalLog, ExternalRequest } from "../src/roles/backend.ts";
import { bindExternal } from "../src/roles/evidence.ts";
import { acpx, acpxCall, acpxTranscript } from "../src/plugins/acpx.ts";
import { temporaryDirectory } from "./directory.ts";
import { context, noteResult, settings, task } from "./fixture.ts";

const usage = {
  input_tokens: 41,
  output_tokens: 9,
  cached_input_tokens: 23,
  total_tokens: 50,
};
const completed = {
  jsonrpc: "2.0",
  id: 3,
  result: {
    stopReason: "end_turn",
    usage: {
      inputTokens: 41,
      outputTokens: 9,
      cachedReadTokens: 23,
      totalTokens: 50,
    },
  },
};
const update = (value: object) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "fixture", update: value },
});
const chunk = (text: string) =>
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
  });
const framed = (value: unknown) =>
  `<xean-result>${JSON.stringify(value)}</xean-result>`;
const jsonl = (events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";
const review = {
  verdict: "PASS" as const,
  report: "Checked",
  premises: [],
  passages: [],
};
const output = (value: unknown) => jsonl([chunk(framed(value)), completed]);
const finalChunk = (text: string, messageId = "replacement") =>
  update({
    ...chunk(text).params.update,
    messageId,
    _meta: { codex: { phase: "final_answer" } },
  });
// P05 worker 689: Codex replaced a disconnected final response and ended normally.
const reconnect = (willRetry = true) =>
  update({
    sessionUpdate: "session_info_update",
    _meta: {
      codex: {
        error: {
          codexErrorInfo: {
            responseStreamDisconnected: { httpStatusCode: null },
          },
          willRetry,
        },
      },
    },
  });

test.each([
  ["replacement", [reconnect()], true],
  ["no reconnect", [], false],
  ["no retry", [reconnect(false)], false],
  ["same message", [reconnect(), finalChunk("more", "interrupted")], false],
  ["no message identity", [reconnect(), chunk("more")], false],
  ["earlier result", [reconnect()], false],
])("acpx final-response recovery: %s", (label, events, accepted) => {
  const parsed = acpxTranscript(
    jsonl([
      label === "earlier result"
        ? finalChunk(framed(review), "earlier")
        : chunk("Computing.\n"),
      update({ sessionUpdate: "tool_call", toolCallId: "web", kind: "fetch" }),
      finalChunk('<xean-result>{"notes":[', "interrupted"),
      ...events,
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "web",
        status: "completed",
      }),
      finalChunk(framed(review)),
      completed,
    ]),
  );
  expect(parsed.error?.message).toBe(
    accepted ? undefined : "acpx emitted no unique final result block",
  );
  expect(parsed.value).toEqual(accepted ? review : undefined);
  expect(parsed.usage).toEqual(usage);
  expect(parsed.searches).toBe(1);
});

// Exact r03 result whose duplicate key silently discarded the Gamma-function note.
const duplicateNotes = String.raw`{"notes":[{"id":"12/gamma-euler-integral","summary":"NIST DLMF defines Gamma(z) by Euler’s integral for complex z with Re z > 0.","detailedSummary":"The Euler integral definition is Gamma(z) = integral from 0 to infinity of e^{-t} t^{z-1} dt, valid when Re z > 0. DLMF states that for Re z <= 0, Gamma is instead defined by analytic continuation.","text":"12/gamma-euler-integral: NIST Digital Library of Mathematical Functions, §5.2(i), equation 5.2.1, gives the definition Gamma(z) = ∫_0^∞ e^{-t} t^{z-1} dt with domain Re z > 0. Exact supporting quotation: “Γ(z)={∫}_{0}^{∞}e^{-t}t^{z-1}dt,” followed by “Re z>0.” Source: https://dlmf.nist.gov/5.2#E1. The same source states that when Re z <= 0, Gamma(z) is defined by analytic continuation.","support":[]}],"notes":[]}`;

test.each([
  ["notes", duplicateNotes],
  ["notes", '{"notes":[],"notes":[]}'],
  ["summary", '{"notes":[{"summary":"first","summary":"second"}]}'],
  ["notes", String.raw`{"notes":[],"\u006eotes":[{}]}`],
  ['a"b', String.raw`{"a\"b":1,"a\u0022b":2}`],
])("acpx rejects duplicate JSON key %j without losing usage", (key, json) => {
  const parsed = acpxTranscript(
    jsonl([chunk(`<xean-result>${json}</xean-result>`), completed]),
  );
  expect(parsed.error?.message).toContain(`Duplicate JSON key: ${key}`);
  expect(parsed.value).toBeUndefined();
  expect(parsed.usage).toEqual(usage);
});

test("acpx allows keys repeated across sibling objects and escaped key text", () => {
  const json = String.raw`{"notes":[{"id":"a","text":"An escaped \"notes\":[] is text","child":{"id":"inner"}},{"id":"b","\u0074ext":"Braces { } and \"id\":0 are text"}]}`;
  const parsed = acpxTranscript(
    jsonl([chunk(`<xean-result>${json}</xean-result>`), completed]),
  );
  expect(parsed.error).toBeUndefined();
  expect(parsed.value).toEqual(JSON.parse(json));
});

test.each(["failed", "pending", "in_progress"])(
  "local search and %s retrieval cannot unlock fresh source evidence",
  (status) => {
    const value = {
      ...review,
      passages: [
        { premise: 0, url: "https://example.org/paper", quote: "Claim" },
      ],
    };
    const parsed = acpxTranscript(
      jsonl([
        update({
          sessionUpdate: "tool_call",
          toolCallId: "local",
          kind: "search",
          status: "completed",
        }),
        update({
          sessionUpdate: "tool_call",
          toolCallId: "web",
          kind: "fetch",
          status: "in_progress",
        }),
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "web",
          status,
        }),
        chunk(framed(value)),
        completed,
      ]),
    );
    expect(parsed.searches).toBe(0);
    const evidence = bindExternal(
      { ...parsed, value, operationId: "probe", reportedAt: "now" },
      ["Claim"],
    );
    expect(evidence.verdict).toBe("INCONCLUSIVE");
    expect(evidence.passages).toEqual([]);
  },
);

// Actual child processes exercise capture, receipts, and cancellation together.
async function fixture(
  source: string,
  mode: "research" | "worker" = "research",
  override?: (options: {
    agent: string;
    model: string;
    command: string;
    workspace: string;
  }) => OpenOptions["roles"],
) {
  const directory = await temporaryDirectory("acpx-process-");
  const command = join(directory, "acpx-fixture");
  await writeFile(command, `#!${process.execPath}\n${source}\n`);
  await chmod(command, 0o700);
  const options = {
    agent: "fixture",
    model: "fixture-model",
    command,
    workspace: directory,
  };
  const path = join(directory, "campaign.sqlite");
  const owner = await open(path, {
    roles:
      override?.(options) ??
      acpx(
        mode === "worker" ? { implementation: options } : { research: options },
      ),
    create: {
      task,
      settings,
      mode:
        mode === "worker"
          ? {
              role: "implementation",
              input: { assignment: "Fixture only", notes: [] },
            }
          : { role: "review", input: { argument: "Fixture only" } },
    },
  });
  return { owner, directory, path, options };
}
const reportOf = (owner: Awaited<ReturnType<typeof open>>) =>
  owner.root.commit(
    (tx) => readReport(tx, owner.root.id, { records: true }),
    context,
  );

test.each(["\n", "\r\n"])(
  "acpx reads split result frames, counts completed fetches, and retains usage with %j separators",
  (separator) => {
    const result = framed(review);
    const events = [
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } },
      update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: framed({ wrong: true }) },
      }),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "s1",
        kind: "fetch",
        title: "Search",
      }),
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "s1",
        status: "completed",
      }),
      update({
        sessionUpdate: "tool_call",
        toolCallId: "s2",
        kind: "fetch",
        title: "Search",
      }),
      chunk("Working on it.\n" + result.slice(0, 7)),
      chunk(result.slice(7, 25)),
      chunk(result.slice(25)),
      completed,
    ];
    expect(
      acpxTranscript(
        events
          .map((event) => JSON.stringify(event))
          .join(separator + " \t" + separator),
      ),
    ).toEqual({ value: review, usage, searches: 1 });
  },
);

test("caller-configured web signatures distinguish web search from local search", () => {
  const webTools = [{ kind: "search", rawInput: { type: "webSearch" } }];
  const events = [
    update({
      sessionUpdate: "tool_call",
      toolCallId: "local",
      kind: "search",
      status: "completed",
      rawInput: { query: "Claim" },
    }),
    update({
      sessionUpdate: "tool_call",
      toolCallId: "web",
      kind: "search",
      status: "in_progress",
      rawInput: { type: "webSearch" },
    }),
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "web",
      status: "completed",
    }),
  ];
  const parse = (tools = webTools) =>
    acpxTranscript(
      jsonl([...events, chunk(framed(review)), completed]),
      false,
      tools,
    );
  expect(parse().searches).toBe(1);
  expect(parse([]).searches).toBe(0);
  expect(
    acpxTranscript(jsonl([...events, chunk(framed(review)), completed]))
      .searches,
  ).toBe(0);
  events.push(
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "web",
      status: "completed",
      rawInput: null,
    }),
  );
  expect(parse().searches).toBe(0);
});

test.each([
  ["no terminal event", jsonl([chunk(framed(review))])],
  ["missing frame", jsonl([chunk("Still working"), completed])],
  [
    "malformed result",
    jsonl([chunk("<xean-result>invalid</xean-result>"), completed]),
  ],
  ["ambiguous result", output(review) + jsonl([chunk(framed(review))])],
  ["nested tags", jsonl([chunk("<xean-result>" + framed(review)), completed])],
  ["unclosed tag", jsonl([chunk("<xean-result>{}"), completed])],
  [
    "text after result",
    jsonl([chunk(framed(review) + "Still working"), completed]),
  ],
  ["multiple terminal events", output(review) + jsonl([completed])],
  ["malformed JSONL", "not-json\n" + output(review)],
  [
    "JSON comment",
    jsonl([chunk("<xean-result>{/*comment*/}</xean-result>"), completed]),
  ],
  [
    "JSON trailing comma",
    jsonl([chunk('<xean-result>{"notes":[],}</xean-result>'), completed]),
  ],
])("acpx rejects %s without losing available accounting", (_kind, stdout) => {
  const parsed = acpxTranscript(stdout);
  expect(parsed.error).toBeInstanceOf(Error);
  expect(parsed.value).toBeUndefined();
  expect(parsed.usage).toEqual(stdout.includes('"inputTokens"') ? usage : null);
});

test.each(["cancelled", "max_tokens", "refusal"])(
  "acpx terminal %s rejects an already emitted result",
  (stopReason) => {
    const parsed = acpxTranscript(
      jsonl([
        chunk(framed(review)),
        { ...completed, result: { ...completed.result, stopReason } },
      ]),
    );
    expect(parsed.error).toBeInstanceOf(RoleFailure);
    expect(parsed.value).toBeUndefined();
    expect(parsed.usage).toEqual(usage);
  },
);

test("acpx records reported USD cost without treating context-window counters as billed tokens", () => {
  const parsed = acpxTranscript(
    jsonl([
      update({
        sessionUpdate: "usage_update",
        used: 40000,
        size: 128000,
        cost: { amount: 0.12, currency: "USD" },
      }),
      chunk(framed(review)),
      { ...completed, result: { stopReason: "end_turn" } },
    ]),
  );
  expect(parsed.usage).toEqual({ cost_usd: 0.12 });
});

const workerSource = `
const { instructions, schema, input } = await Bun.stdin.json();
const args = process.argv.slice(2);
const parameter = flag => args[args.indexOf(flag) + 1];
if (parameter('--format') !== 'json' || !args.includes('--json-strict') || !args.includes('--suppress-reads') || !args.includes('exec') || parameter('--file') !== '-' || parameter('--prompt-retries') !== '0') throw new Error('Wrong acpx protocol');
if (parameter('--model') !== 'fixture-model' || !args.includes('fixture') || !args.includes('--approve-all')) throw new Error('Requested agent/model missing');
const config = args.flatMap((arg, index) => arg === '--config-option' ? [args[index + 1]] : []);
if (!config.includes('reasoning_effort=low') || !config.includes('fixture=yes')) throw new Error('Requested agent configuration missing');
if (!instructions.includes('<xean-result>') || !schema.properties.notes || !input.task || !input.assignment) throw new Error('Missing role contract');
if (require('node:fs').realpathSync(input.workspace) !== process.cwd()) throw new Error('Wrong workspace');
const value = ${JSON.stringify(noteResult)};
value.notes[0].id = input.noteIdPrefix + 'reflexivity';
value.notes[0].text += '\\n' + input.assignment;
const pattern = new RegExp(schema.properties.notes.items.properties.id.pattern);
if (!pattern.test(value.notes[0].id) || pattern.test('n1')) throw new Error('Missing namespace constraint');
const event = ${JSON.stringify(chunk(""))};
event.params.update.content.text = '<xean-result>' + JSON.stringify(value) + '</xean-result>';
console.log(JSON.stringify(event));
console.log(${JSON.stringify(JSON.stringify(completed))});
`;

test("acpx preserves provider details behind a generic ACP error", () => {
  const parsed = acpxTranscript(
    jsonl([
      {
        jsonrpc: "2.0",
        id: 3,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: "Selected model is at capacity" },
        },
      },
    ]),
  );
  expect(parsed.error?.message).toBe("Selected model is at capacity");
  expect(parsed.value).toBeUndefined();
});

test("acpx distinguishes recoverable client-tool errors from prompt failure", () => {
  const prelude = [
    { jsonrpc: "2.0", id: 4, method: "session/prompt", params: {} },
    { jsonrpc: "2.0", id: "read-1", method: "fs/read_text_file", params: {} },
    {
      jsonrpc: "2.0",
      id: "read-1",
      error: { code: -32000, message: "File not found" },
    },
  ];
  const result = { jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } };
  expect(
    acpxTranscript(jsonl([...prelude, chunk(framed(review)), result])).value,
  ).toEqual(review);
  const failure = acpxTranscript(
    jsonl([
      ...prelude,
      {
        jsonrpc: "2.0",
        id: 4,
        error: { code: -32000, message: "Provider unavailable" },
      },
    ]),
  );
  expect(failure.error?.message).toBe("Provider unavailable");
  expect(failure.value).toBeUndefined();
});

test("acpx uses the role envelope and Pi memo; changed assignment dispatches, changed configuration does not", async () => {
  const { owner } = await fixture(workerSource, "worker", (options) => () => ({
    async implementation(input, runtime, context) {
      const configured = {
        ...options,
        config: { reasoning_effort: "low", fixture: "yes" },
      };
      const call = acpxCall(configured);
      const schema = noteResultSchema(
        explorationSchema,
        noteIdPrefix(runtime.taskId),
      );
      const args = [
        "worker",
        schema,
        "Solve exactly",
        { ...input, noteIdPrefix: noteIdPrefix(runtime.taskId) },
        runtime,
        context,
      ] as const;
      const first = await call(...args);
      const original = structuredClone(first);
      first.value.notes[0]!.text = "Caller changed its copy";
      expect(await call(...args)).toEqual(original);
      expect(
        await acpxCall({
          ...options,
          config: { fixture: "yes", reasoning_effort: "low" },
        })(...args),
      ).toEqual(original);
      for (const changed of [
        { agent: "different" },
        { model: "different" },
        { config: { reasoning_effort: "max" } },
        { webTools: [] },
      ])
        await expect(
          acpxCall({ ...configured, ...changed })(...args),
        ).rejects.toThrow("configuration changed");
      const changed = await call(
        "worker",
        schema,
        "Solve exactly",
        { ...args[3], assignment: "Different assignment" },
        runtime,
        context,
      );
      expect(changed.operationId).not.toBe(original.operationId);
      expect(changed.value.notes[0]!.text).toContain("Different assignment");
      return { kind: "notes", ...changed.value };
    },
  }));
  try {
    await owner.root.waitForIdle(context);
    const report = await reportOf(owner);
    expect(report.status.status, report.status.error ?? undefined).toBe(
      "completed",
    );
    const requests = report.records!.filter(ExternalRequest.is);
    const logs = report.records!.filter(ExternalLog.is);
    expect(requests).toHaveLength(2);
    expect(logs).toHaveLength(2);
    expect(requests[0]!.data).toMatchObject({
      provider: "acpx/fixture",
      api: "acpx-exec",
      model: "fixture-model",
      reasoning: "low",
    });
    expect(logs[0]!.data).toMatchObject({
      operationId: requests[0]!.data.operationId,
      exitCode: 0,
      usage,
    });
  } finally {
    await owner.close();
  }
});

test.each(["provider", "schema", "exit", "duplicate"])(
  "acpx %s failure retains receipts and never publishes an early result",
  async (failure) => {
    const events =
      (failure === "duplicate"
        ? jsonl([
            chunk(`<xean-result>${duplicateNotes}</xean-result>`),
            completed,
          ])
        : failure === "provider"
          ? ""
          : output(failure === "schema" ? {} : review)) +
      (failure === "provider"
        ? jsonl([
            {
              jsonrpc: "2.0",
              id: 4,
              error: { code: -32000, message: "Selected model is at capacity" },
            },
          ])
        : "");
    const { owner, path } = await fixture(
      `process.stdout.write(${JSON.stringify(events)}); process.stderr.write('fixture stderr'); process.exitCode = ${failure === "exit" ? 1 : 0};`,
    );
    try {
      await owner.root.waitForIdle(context);
      const report = await reportOf(owner);
      expect(report.status.status).toBe("blocked");
      const request = report.records!.find(ExternalRequest.is)!;
      const log = report.records!.find(ExternalLog.is)!;
      expect(report.status.error).toContain(`Request entry: ${request.id}`);
      expect(report.status.error).toContain(`acpx log entry: ${log.id}`);
      if (failure === "provider" || failure === "exit")
        expect(report.status.error).toContain(
          failure === "provider"
            ? "Selected model is at capacity"
            : "fixture stderr",
        );
      expect(log.data).toMatchObject({
        stdout: events,
        stderr: "fixture stderr",
        usage: failure === "provider" ? null : usage,
      });
      expect(report.result).toBeUndefined();
      if (failure === "duplicate") {
        expect(report.status.error).toContain("Duplicate JSON key: notes");
        expect(report.notes).toEqual([]);
      }
      await expect(access(request.data.workspace)).rejects.toThrow();
      await owner.close();
      const retained = await inspect(path, (tx, root) =>
        readReport(tx, root, { records: true }),
      );
      expect(retained.status.error).toBe(report.status.error);
      expect(retained.records!.filter(ExternalLog.is)).toEqual([log]);
    } finally {
      await owner.close();
    }
  },
);

test.each(["stdout", "stderr"] as const)(
  "acpx %s overflow stops the process and rejects an early result",
  async (stream) => {
    const { owner } = await fixture(`
import { writeSync } from "node:fs";
process.on('SIGTERM', () => {});
writeSync(1, ${JSON.stringify(output(review))});
setInterval(() => {}, 1000);
try { for (let i = 0; i < 300; i++) writeSync(${stream === "stdout" ? 1 : 2}, 'x'.repeat(65536)); }
catch (error) { if (!['EPIPE', 'ECONNRESET'].includes(error.code)) throw error; }
`);
    try {
      await owner.root.waitForIdle(context);
      const report = await reportOf(owner);
      expect(report.status.status).toBe("blocked");
      expect(report.status.error).toContain("output capture limit");
      const log = report.records!.find(ExternalLog.is)!.data;
      expect(log.outputTruncated).toBe(true);
      expect(log.usage).toEqual(usage);
      expect(log.stdout.length).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(log.stderr.length).toBeLessThanOrEqual(1024 * 1024);
      expect(report.result).toBeUndefined();
    } finally {
      await owner.close();
    }
  },
  15_000,
);

test.each([1, 2])(
  "acpx failed receipt commit %j references only durable evidence",
  async (failedCommit) => {
    const { owner } = await fixture(
      `require('node:fs').writeFileSync('ran.txt', 'ran'); process.stdout.write(${JSON.stringify(output(noteResult))});`,
      "worker",
      (options) => () => ({
        async implementation(input, runtime, context) {
          let commits = 0;
          const result = await acpxCall(options)(
            "worker",
            explorationSchema,
            "Solve",
            input,
            {
              ...runtime,
              commit: (change, context) =>
                runtime.commit(async (tx, current) => {
                  await change(tx, current);
                  if (++commits === failedCommit)
                    throw new Error("Fixture receipt commit failed");
                }, context),
            },
            context,
          );
          return { kind: "notes", ...result.value };
        },
      }),
    );
    try {
      await owner.root.waitForIdle(context);
      const report = await reportOf(owner);
      const error = report.tasks!.find(
        (task) => task.state.outcome?.status === "faulted",
      )!.state.outcome!.error!.message;
      expect(error).toStartWith("Fixture receipt commit failed");
      expect(error).toContain(
        "Completion unrecorded; execution may have occurred",
      );
      expect(error).not.toContain("acpx log entry:");
      expect(report.records!.filter(ExternalLog.is)).toEqual([]);
      const requests = report.records!.filter(ExternalRequest.is);
      expect(requests).toHaveLength(failedCommit - 1);
      if (failedCommit === 1)
        expect(error).toContain("Request entry: unrecorded");
      else {
        expect(error).toContain(`Request entry: ${requests[0]!.id}`);
        expect(
          await Bun.file(join(requests[0]!.data.workspace, "ran.txt")).text(),
        ).toBe("ran");
      }
      expect(report.result).toBeUndefined();
    } finally {
      await owner.close();
    }
  },
);

test.each(["cancel", "close", "cleanup", "orphan"] as const)(
  "acpx %s kills resistant descendants and abandons private research output",
  async (action) => {
    const { owner, path, directory, options } = await fixture(`
import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);'], { detached: ${action === "cleanup"} });
process.on("SIGTERM", () => {
  if (${action === "cleanup"}) {
    child.kill("SIGKILL");
    writeFileSync(join(import.meta.dir, "cleaned"), "yes");
    process.exit(0);
  }
  if (${action === "orphan"}) process.exit(0);
});
await new Promise((resolve) => child.stdout.once("data", resolve));
writeSync(1, "unfinished acpx output\\n");
writeSync(2, "fixture waiting\\n");
writeFileSync(join(import.meta.dir, "processes.json"), JSON.stringify([process.pid, child.pid]));
setInterval(() => {}, 1000);
`);
    const ready = join(directory, "processes.json");
    let processes: number[] = [];
    let workspace: string | undefined;
    try {
      owner.harness.resume();
      for (
        const deadline = Date.now() + 5000;
        !(await Bun.file(ready).exists());
      ) {
        if (Date.now() > deadline)
          throw new Error(
            `acpx fixture did not become ready: ${JSON.stringify(await reportOf(owner))}`,
          );
        await Bun.sleep(10);
      }
      const recorded: unknown = await Bun.file(ready).json();
      if (
        !Array.isArray(recorded) ||
        recorded.length !== 2 ||
        !recorded.every((pid) => Number.isSafeInteger(pid) && pid > 1)
      )
        throw new Error("Invalid fixture process IDs");
      processes = recorded as number[];
      const before = await reportOf(owner);
      const request = before.records!.find(ExternalRequest.is)!;
      workspace = request.data.workspace;
      if (action !== "close") {
        await owner.harness.abortTask(request.byTaskId!, context);
        expect(
          (await owner.harness.waitForTask(request.byTaskId!, context)).state
            .outcome.status,
        ).toBe("aborted");
        await owner.root.waitForIdle(context);
      }
      await owner.close();
      if (action === "cleanup")
        expect(await Bun.file(join(directory, "cleaned")).text()).toBe("yes");
      for (const pid of processes)
        for (const deadline = Date.now() + 3000; alive(pid);) {
          if (Date.now() > deadline)
            throw new Error(`acpx fixture process ${pid} survived ${action}`);
          await Bun.sleep(10);
        }
      const report = await inspect(path, (tx, root) =>
        readReport(tx, root, { records: true }),
      );
      const logs = report.records!.filter(ExternalLog.is);
      expect(logs).toHaveLength(0);
      expect(report.status.calls).toMatchObject({
        externalInvocations: 1,
        unknownUsage: 1,
      });
      expect(report.notes).toEqual([]);
      expect(report.result).toBeUndefined();
      await expect(access(workspace)).rejects.toThrow();
      if (action === "close") {
        const recovered = await open(path, {
          roles: acpx({ research: { ...options, agent: "changed" } }),
        });
        try {
          await recovered.root.waitForIdle(context);
          const report = await reportOf(recovered);
          expect(report.status.error).toContain(
            "External backend configuration changed",
          );
          expect(report.records!.filter(ExternalRequest.is)).toHaveLength(1);
        } finally {
          await recovered.close();
        }
      }
    } finally {
      for (const pid of processes) if (alive(pid)) process.kill(pid, "SIGKILL");
      await owner.close();
      if (workspace) await rm(workspace, { recursive: true, force: true });
    }
  },
  15_000,
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
