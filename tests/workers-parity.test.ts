import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import {
  open,
  inspect,
  readReport,
  exportAccepted,
  solveSettings,
} from "../src/index.ts";
import { Assignment } from "../src/role-runtime.ts";
import { verifierNames, type Verification } from "../src/policy/contracts.ts";
import type { CallDescriptor } from "../src/policy/prompts.ts";
import { fauxModels } from "./faux-models.ts";
import baseline from "./fixtures/v450-workers.json";

const all = [...verifierNames];
const lemma: Verification["verifiers"] = ["source", "correctness"];
const note = (text: string, support: string[] = []) => ({ text, support });
const check = (id: string, verdict = "PASS") => ({
  verdicts: [{ note: id, verdict, report: `Check ${verdict.toLowerCase()}.` }],
});
const coordinate = (ids: string[], verify: Verification[]) => ({
  filings: ids.map((note) => ({ note, summary: `Summary ${note}.` })),
  verify,
});
const reconstruct = (ids: string[]): JsonValue[] => [
  { statements: ids.map((note) => ({ note, statement: `Claim ${note}.` })) },
  { proof: "Independent proof." },
  { statements: [], verdicts: ids.flatMap((id) => check(id).verdicts) },
];
const pass = (id: string, ancestors: string[] = []): JsonValue[] => [
  check(id),
  check(id),
  check(id),
  ...reconstruct([...ancestors, id]),
];
const scenarios: { name: string; turns: number; replies: JsonValue[] }[] = [
  {
    name: "generated-dependency-acceptance",
    turns: 1,
    replies: [
      {
        notes: [
          note("Lemma L."),
          note("Lemma M from L.", ["n1"]),
          note("Complete P from M.", ["n2"]),
          note("Unrelated alternative."),
        ],
      },
      coordinate(
        ["n1", "n2", "n3", "n4"],
        [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: lemma },
          { note: "n3", verifiers: all },
          { note: "n4", verifiers: all },
        ],
      ),
      check("n1"),
      check("n1"),
      check("n2"),
      check("n2"),
      ...pass("n3", ["n1", "n2"]),
    ],
  },
  {
    name: "failed-source-then-fresh-explorer",
    turns: 2,
    replies: [
      { notes: [note("Original proof.")] },
      coordinate(["n1"], [{ note: "n1", verifiers: all }]),
      check("n1", "FAIL"),
      { notes: [note("New proof.")] },
      coordinate(["n2"], [{ note: "n2", verifiers: all }]),
      ...pass("n2"),
    ],
  },
  {
    name: "corrected-ancestor-reconstruction-reuse",
    turns: 2,
    replies: [
      {
        notes: [
          {
            ...note("PRIVATE_ORIGINAL_PROOF"),
            summary: "PRIVATE_SUMMARY",
            detailedSummary: "PRIVATE_DETAIL",
          },
          note("First candidate.", ["n1"]),
        ],
      },
      coordinate(
        ["n2"],
        [
          { note: "n1", verifiers: lemma },
          { note: "n2", verifiers: all },
        ],
      ),
      check("n1"),
      check("n1"),
      check("n2"),
      check("n2"),
      check("n2"),
      {
        statements: [
          { note: "n1", statement: "INITIAL_WRONG_SCOPE" },
          { note: "n2", statement: "P." },
        ],
      },
      { proof: "PRIVATE_INITIAL_ARGUMENT" },
      {
        statements: [
          { note: "n1", statement: "Exact lemma with corrected hypotheses." },
          { note: "n2", statement: "P." },
        ],
        verdicts: [],
      },
      { proof: "PRIVATE_CORRECTED_ARGUMENT" },
      {
        statements: [],
        verdicts: [
          { note: "n1", verdict: "PASS", report: "PRIVATE_LEMMA_REPORT" },
          ...check("n2", "INCONCLUSIVE").verdicts,
        ],
      },
      { notes: [note("Repaired candidate.", ["n1"])] },
      coordinate(["n3"], [{ note: "n3", verifiers: all }]),
      ...pass("n3"),
    ],
  },
];

// Sort JSON object keys, preserving array order and all mathematical content.
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        )
      : item,
  );
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

function modelInput(transcript: TranscriptContext) {
  const ids = new Map<string, string>();
  const callId = (id: string) => {
    if (!ids.has(id)) ids.set(id, `call-${ids.size + 1}`);
    return ids.get(id)!;
  };
  const messages = transcript.messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      const copy = structuredClone(message);
      delete (copy as { timestamp?: number }).timestamp;
      if (copy.role === "toolResult") {
        delete copy.durationMs;
        copy.toolCallId = callId(copy.toolCallId);
      }
      if (copy.role === "assistant")
        for (const block of copy.content)
          if (block.type === "toolCall") block.id = callId(block.id);
      return copy;
    });
  return {
    system: getCurrentSystemPrompt(transcript.messages),
    tools: getCurrentTools(transcript.messages),
    messages,
  };
}

test.each(scenarios)("4.5 worker parity: $name", async (scenario) => {
  const directory = await mkdtemp(join(tmpdir(), "xean-workers-parity-"));
  const path = join(directory, "campaign.sqlite");
  const requests: {
    descriptor: CallDescriptor;
    input: ReturnType<typeof modelInput>;
  }[] = [];
  let owner: Awaited<ReturnType<typeof open>> | undefined;
  const native = fauxModels(scenario.replies, async (transcript) => {
    const descriptor = await owner!.root.commit(async (tx) => {
      const conversation = (
        await tx.scanConversations({ order: "descending" }, 1)
      ).items[0]!;
      return JSON.parse(
        JSON.stringify((await tx.doc(Assignment, conversation.id)).descriptor),
      ) as CallDescriptor;
    }, context);
    requests.push({ descriptor, input: modelInput(transcript) });
  });
  const profile = { provider: "test", model: "math", reasoning: "high" };
  const settings = solveSettings.parse({
    ...Object.fromEntries(
      ["explorer", "coordinator", ...verifierNames].map((name) => [
        name,
        profile,
      ]),
    ),
    maxExplorerTurns: scenario.turns,
    window: 1,
  });
  try {
    owner = await open(path, {
      create: {
        task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
        settings,
      },
      models: native.models,
    });
    await owner.root.waitForIdle(context);
    const report = await inspect(path, readReport);
    expect(report.status.outcome).toBe("accepted");
    expect(report.status.turns).toBe(scenario.turns);
    expect(requests).toHaveLength(scenario.replies.length);
    const candidates = new Map<number, number>();
    const result = {
      outcome: report.status.outcome,
      turns: report.status.turns,
      accepted: report.accepted,
      notes: report.notes,
      checks: report.checks.map(({ candidate, values }) => {
        if (!candidates.has(candidate))
          candidates.set(candidate, candidates.size + 1);
        return { candidate: candidates.get(candidate), values };
      }),
      argument: await exportAccepted(path),
    };
    const snapshot = {
      requests: requests.map(({ descriptor, input }) => ({
        role:
          descriptor.kind === "verifier" ? descriptor.name : descriptor.kind,
        descriptor: hash(descriptor),
        system: hash(input.system),
        tools: hash(input.tools),
        messages: hash(input.messages),
      })),
      result,
    };
    // Capture only writes external review artifacts; it never rewrites this fixture.
    const capture = process.env.XEAN_WORKERS_PARITY_CAPTURE;
    if (capture)
      await Bun.write(
        join(capture, `${scenario.name}.json`),
        JSON.stringify({ snapshot, requests }, null, 2) + "\n",
      );
    else
      expect<unknown>(snapshot).toEqual(
        (baseline.cases as Record<string, unknown>)[scenario.name],
      );
  } finally {
    await owner?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
