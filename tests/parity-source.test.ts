import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  open,
  inspect,
  readReport,
  Notebook,
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
  { notes: [{ text: "Proof of P.", support: [] }] },
  {
    filings: [{ note: "n1", summary: "P holds." }],
    explorerGuidance: "Prove P fully.",
    support: [],
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
  const source: SourceExecutor = async (request) => {
    requests.push(structuredClone(request));
    const output = outputs.shift();
    if (!output) throw new Error("Unexpected Codex execution");
    return output;
  };
  const native = fauxModels(replies);
  const settings = solveSettings.parse({
    ...Object.fromEntries(
      ["explorer", "coordinator", ...verifierNames].map((role) => [
        role,
        profile,
      ]),
    ),
    source: {
      provider: "codex",
      model: "source-fixture",
      reasoning: "low",
      search,
    },
    maxExplorerTurns: 1,
  });
  let owner = await open(path, {
    create: { task, settings },
    source,
    models: native.models,
  });
  owners.push(owner);
  return {
    path,
    requests,
    replies: native.replies,
    outputs,
    get owner() {
      return owner;
    },
    async settle() {
      await owner.root.waitForIdle(BACKGROUND_CONTEXT);
      return inspect(path, readReport);
    },
    async resume() {
      await owner.close();
      owner = await open(path, { source, models: native.models });
      owners.push(owner);
      await owner.resume();
    },
    async receipts() {
      return inspect(path, async (tx, root) => {
        const entries = await tx.scanEntries(
          { conversationId: root, order: "ascending" },
          128,
        );
        return JSON.parse(
          JSON.stringify(
            entries.items.filter(
              (entry) =>
                entry.kind === "xean.role-result" &&
                (entry.data as { key?: string }).key === "source/n1",
            ),
          ),
        ) as {
          id: number;
          data: { value: CodexResult; descriptor: CodexRequest };
        }[];
      });
    },
  };
}

test("a simulated receipt-before-verdict interruption reuses the exact durable Codex answer on resume", async () => {
  const output = sourceResult();
  const drive = await fixture(
    [output],
    [...initial, new Error("Correctness disconnected")],
  );
  const failed = await drive.settle();
  expect(failed.status).toMatchObject({
    outcome: "call-failure",
    error: "verifier failed: Correctness disconnected",
  });
  expect(failed.checks).toHaveLength(1);
  const sourceCheck = failed.checks[0]!;
  const originalReceipt = (await drive.receipts())[0]!;
  expect(originalReceipt.id).toBe(sourceCheck.call);
  expect(originalReceipt.data.value).toEqual(output);
  // Synthetic crash boundary: remove only the derived verdict after a later
  // role fails; retain the native durable source result and original request.
  await drive.owner.root.commit(async (tx) => {
    const book = await tx.doc(Notebook, drive.owner.root.id);
    book.checks = book.checks.filter(
      (check) => check.call !== sourceCheck.call,
    );
  }, BACKGROUND_CONTEXT);
  drive.replies.push(...remaining);
  await drive.resume();
  const report = await drive.settle();
  expect(report.status).toMatchObject({
    outcome: "accepted",
    accepted: "n1",
    turns: 1,
  });
  expect(drive.requests).toHaveLength(1);
  expect(report.checks[0]).toEqual(sourceCheck);
  expect(await drive.receipts()).toEqual([originalReceipt]);
});

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
  expect((await drive.receipts()).map(({ data }) => data.value)).toEqual([
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
  expect((await drive.receipts())[0]?.data.value).toEqual(output);
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
  expect(saved.data.value).toEqual(failure);
  drive.outputs.push(sourceResult());
  drive.replies.push(...remaining);
  await drive.resume();
  const report = await drive.settle();
  expect(report.status).toMatchObject({ outcome: "accepted", accepted: "n1" });
  expect(drive.requests).toHaveLength(2);
  expect(drive.requests[1]).toEqual(drive.requests[0]);
  const receipts = await drive.receipts();
  expect(receipts).toHaveLength(2);
  expect(receipts[0]).toEqual(saved);
  expect(receipts[1]?.data.value.state).toBe("succeeded");
  expect(report.checks[0]?.call).toBe(receipts[1]?.id);
});
