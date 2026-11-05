import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ProviderDoc } from "@earendil-works/pi-durable";
import { findDocument, loadDocument } from "@earendil-works/chord/next";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import {
  ResearchState,
  ResearchType,
  type ResearchData,
} from "../src/records.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { Assignment } from "../src/role-runtime.ts";
import {
  open,
  inspect,
  readReport,
  solveSettings,
  type SourceExecutor,
} from "../src/index.ts";
import { verifierNames } from "../src/policy/contracts.ts";
import type { CodexRequest, CodexResult } from "../src/policy/source.ts";
import { fauxModels } from "./faux-models.ts";

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const profile = { provider: "test", model: "math", reasoning: "high" };
const verdict = { note: "n1", verdict: "PASS", report: "Checked." };
const initial: JsonValue[] = [
  { notes: [{ summary: "P holds.", text: "Proof of P.", support: [] }] },
  {
    verify: [{ note: "n1", verifiers: [...verifierNames] }],
  },
];
const remaining: JsonValue[] = [
  { verdicts: [verdict] },
  { verdicts: [verdict] },
  { statements: [{ note: "n1", statement: "P holds." }] },
  { proof: "Independent proof of P." },
  { statements: [], verdicts: [verdict] },
];

function sourceResult(cited = false): CodexResult {
  const sources = cited
    ? [{ result: "P holds.", source: "Paper P", url: "https://example.org/p" }]
    : [];
  return {
    state: "succeeded",
    codexVersion: "fixture-v1",
    output: { verdicts: [{ ...verdict, sources }] },
    stdout: "Opaque Codex log, including warnings and recovered errors.\n",
    stderr: "",
  };
}

const owners: Awaited<ReturnType<typeof open>>[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(
  outputs: CodexResult[],
  replies: (JsonValue | Error)[],
  search = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "xean-source-parity-"));
  directories.push(directory);
  const path = join(directory, "research.sqlite"),
    requests: CodexRequest[] = [];
  let owner: Awaited<ReturnType<typeof open>>;
  let ready = Promise.withResolvers<void>();
  let noteId: string | undefined;
  const relabel = (value: JsonValue): JsonValue =>
    JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
      item === "n1" ? noteId : item,
    ) as JsonValue;
  const source: SourceExecutor = async (request) => {
    requests.push(structuredClone(request));
    const output = outputs.shift();
    if (!output) throw new Error("Unexpected Codex execution");
    if (output.state === "succeeded") output.output = relabel(output.output);
    return output;
  };
  const native = fauxModels();
  const queued = {
    push: (...values: (JsonValue | Error)[]) =>
      native.provider.appendResponses(
        values.map((value) => async (transcript, options) => {
          await ready.promise;
          if (!noteId) {
            noteId = await owner.root.commit(async (tx) => {
              const { items } = await tx.scanConversations({}, 128);
              for (const conversation of items) {
                if (
                  (await tx.doc(ProviderDoc, conversation.id)).sessionId !==
                  options?.sessionId
                )
                  continue;
                const { descriptor } = await tx.doc(
                  Assignment,
                  conversation.id,
                );
                if (descriptor?.kind === "explorer")
                  return `${descriptor.input.namespace}.1`;
              }
              throw new Error("Explorer namespace is missing");
            }, BACKGROUND_CONTEXT);
          }
          if (value instanceof Error)
            return fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: value.message,
            });
          const tool = getCurrentTools(transcript.messages)[0];
          if (!tool) throw new Error("Expected role submission tool");
          return fauxAssistantMessage(
            [
              fauxToolCall(
                tool.name,
                relabel(value) as Record<string, JsonValue>,
              ),
            ],
            { stopReason: "toolUse" },
          );
        }),
      ),
  };
  queued.push(...replies);
  const settings = solveSettings.parse({
    ...Object.fromEntries(
      ["explorer", ...verifierNames].map((role) => [role, profile]),
    ),
    source: {
      provider: "codex",
      model: "source-fixture",
      reasoning: "low",
      search,
    },
    maxExplorerTurns: 1,
  });
  owner = await open(path, {
    create: { task, settings },
    execute: true,
    report: () => {},
    source,
    models: native.models,
  });
  owners.push(owner);
  ready.resolve();
  return {
    path,
    requests,
    replies: queued,
    get id() {
      return noteId!;
    },
    outputs,
    get owner() {
      return owner;
    },
    async settle() {
      await owner.wait();
      return inspect(path, readReport);
    },
    async resume(storageFailure = false) {
      owners.splice(owners.indexOf(owner), 1);
      if (storageFailure) await owner.close().catch(() => {});
      else await owner.close();
      ready = Promise.withResolvers<void>();
      owner = await open(path, {
        source,
        models: native.models,
        execute: true,
        report: () => {},
      });
      owners.push(owner);
      ready.resolve();
      await owner.resume();
    },
    async receipts() {
      return inspect(path, (data) =>
        structuredClone(
          data.sources.filter((receipt) => receipt.key === `source/${noteId}`),
        ),
      );
    },
  };
}

test.each(["before", "after"] as const)(
  "Codex receipt and check recover atomically from failure %s their storage commit",
  async (boundary) => {
    const message = `Interrupted ${boundary} source commit`;
    const original = NodeSqliteDatabase.prototype.transaction;
    const fault = Promise.withResolvers<void>();
    let interrupted = false;
    const commit = spyOn(
      NodeSqliteDatabase.prototype,
      "transaction",
    ).mockImplementation(async function <T>(
      this: NodeSqliteDatabase,
      callback: (tx: SqliteExecutor) => Promise<T>,
    ): Promise<T> {
      let sourceCommit = false;
      const result = (await original.call(this, async (tx) => {
        const run = tx.run.bind(tx);
        tx.run = async (sql, ...params) => {
          if (
            !interrupted &&
            params.some(
              (value) =>
                typeof value === "string" && value.includes("Opaque Codex log"),
            )
          )
            sourceCommit = true;
          return run(sql, ...params);
        };
        const result = await callback(tx);
        if (sourceCommit) {
          const document = await findDocument(tx, {
            owner: ResearchType.name,
            namespace: "chord",
            kind: ResearchState.name,
          });
          const stored = (await loadDocument(tx, document!))
            .value as ResearchData;
          expect(stored.sources).toHaveLength(1);
          expect(stored.notebook.checks).toHaveLength(1);
          expect(stored.notebook.checks[0]!.call).toBe(stored.sources[0]!.id);
          interrupted = true;
          if (boundary === "before") {
            fault.resolve();
            throw new Error(message);
          }
        }
        return result;
      })) as T;
      if (sourceCommit) {
        fault.resolve();
        throw new Error(message);
      }
      return result;
    });
    try {
      const output = sourceResult();
      const drive = await fixture(
        boundary === "before" ? [output, sourceResult()] : [output],
        [...initial],
      );
      const settled = drive.owner.wait();
      void settled.catch(() => {});
      await fault.promise;
      await expect(settled).rejects.toThrow(
        "Campaign owner closed before settlement",
      );
      commit.mockRestore();
      const stored = await inspect(drive.path, readReport);
      const receipts = await drive.receipts();
      expect(interrupted).toBe(true);
      expect(stored.checks).toHaveLength(boundary === "before" ? 0 : 1);
      expect(receipts).toHaveLength(stored.checks.length);
      if (boundary === "after") {
        expect(stored.checks[0]?.call).toBe(receipts[0]?.id);
        expect(receipts[0]?.output).toEqual(output);
        expect(receipts[0]?.request).toEqual(drive.requests[0]);
      }
      drive.replies.push(...remaining);
      await drive.resume(true);
      const report = await drive.settle();
      expect(report.status).toMatchObject({
        outcome: "accepted",
        accepted: drive.id,
        turns: 1,
      });
      expect(drive.requests).toHaveLength(boundary === "before" ? 2 : 1);
      if (boundary === "before")
        expect(drive.requests[1]).toEqual(drive.requests[0]);
      expect(await drive.receipts()).toHaveLength(1);
      if (boundary === "after") {
        expect(report.checks[0]).toEqual(stored.checks[0]);
        expect(await drive.receipts()).toEqual(receipts);
      }
    } finally {
      commit.mockRestore();
    }
  },
);

test("Codex source rejects citations with search disabled and retains the result", async () => {
  const output = sourceResult(true);
  const drive = await fixture([output], [...initial], false);
  const report = await drive.settle();
  expect(report.status).toMatchObject({
    outcome: "call-failure",
    error: "Source citations require search to be enabled",
  });
  expect(report.checks).toEqual([]);
  expect(report.accepted).toEqual([]);
  expect(drive.requests).toHaveLength(1);
  expect(drive.requests[0]?.search).toBe(false);
  expect((await drive.receipts()).map(({ output }) => output)).toEqual([
    output,
  ]);
});

test("Codex output must contain exactly the requested verdict IDs", async () => {
  const output = sourceResult();
  if (output.state !== "succeeded") throw new Error("Expected fixture result");
  output.output = { verdicts: [{ ...verdict, note: "n99", sources: [] }] };
  const drive = await fixture([output], [...initial]);
  const report = await drive.settle();
  expect(report.status.outcome).toBe("call-failure");
  expect(report.checks).toEqual([]);
  expect((await drive.receipts())[0]?.output).toEqual(output);
});

test("a completed failed Codex execution remains evidence while resume makes a fresh source call", async () => {
  const failure: CodexResult = {
    state: "failed",
    stdout: "partial provider output",
    stderr: "fixture provider disconnected",
    exitCode: 1,
    error: "provider disconnected",
  };
  const drive = await fixture([failure], [...initial]);
  const failed = await drive.settle();
  expect(failed.status).toMatchObject({
    outcome: "call-failure",
    error: "verifier failed: provider disconnected",
  });
  expect(failed.checks).toEqual([]);
  const saved = (await drive.receipts())[0]!;
  expect(saved.output).toEqual(failure);
  drive.outputs.push(sourceResult());
  drive.replies.push(...remaining);
  await drive.resume();
  const report = await drive.settle();
  expect(report.status).toMatchObject({
    outcome: "accepted",
    accepted: drive.id,
  });
  expect(drive.requests).toHaveLength(2);
  expect(drive.requests[1]).toEqual(drive.requests[0]);
  const receipts = await drive.receipts();
  expect(receipts).toHaveLength(2);
  expect(receipts[0]).toEqual(saved);
  expect(receipts[1]?.output.state).toBe("succeeded");
  expect(report.checks[0]?.call).toBe(receipts[1]?.id);
});
