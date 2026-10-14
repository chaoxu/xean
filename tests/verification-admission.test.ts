import { expect, test } from "bun:test";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { inspect, open, readReport, type Note } from "../src/index.ts";
import type { VerifierInput } from "../src/core/math/contracts.ts";
import { context, noteResult, settings, task } from "./fixture.ts";
import { temporaryDirectory } from "./directory.ts";
import { codex } from "../src/plugins/role-backends/codex.ts";

async function run(scenario: "retry" | "repair" | "idle") {
  const directory = await temporaryDirectory(`xean-verification-${scenario}-`);
  const database = join(directory, "campaign.sqlite");
  let rounds = 0;
  const owner = await open(database, {
    create: {
      task,
      settings,
    },
    models: createModels(),
    roles: (builtins) => ({
      ...codex({ verifier: { model: "fixture", workspace: directory } })(
        builtins,
      ),
      coordinator: async ({ notes }: { notes: Note[] }) => {
        if ((scenario === "idle" && rounds === 2) || rounds === 4)
          return { work: null };
        const candidate = notes.find((note) => note.candidate);
        if (
          !candidate ||
          (scenario === "repair" &&
            !candidate.support.length &&
            Object.keys(candidate.checks).length)
        )
          return {
            work: { kind: "explorer", assignment: "Repair the proof." },
          };
        return {
          work: {
            kind: "verifier",
            notes: [candidate.id],
            through: "reconstruction",
          },
        };
      },
      explorer: async ({ notes }: { notes: Note[] }, runtime) => {
        rounds++;
        const candidate = notes.find((note) => note.candidate);
        return candidate
          ? {
              kind: "notes",
              notes: [
                {
                  ...noteResult.notes[0]!,
                  id: `${runtime.taskId}/n1`,
                  candidate: false,
                },
              ],
              edits: [
                {
                  id: candidate.id,
                  revision: candidate.revision,
                  support: [`${runtime.taskId}/n1`],
                  text: "By the declared reflexivity lemma, 1 = 1.",
                },
              ],
            }
          : {
              kind: "notes",
              notes: [
                {
                  ...noteResult.notes[0]!,
                  id: `${runtime.taskId}/n1`,
                  text: "Claim: 1 = 1. Proof missing.",
                  candidate: true,
                },
              ],
            };
      },
      verifier: async ({ notes }: { notes: Note[] }) => {
        rounds++;
        const candidate = notes.find((note) => note.candidate)!;
        const pass = { verdict: "PASS", report: "Scripted workflow judgment." };
        return {
          kind: "verification",
          checks: candidate.support.length
            ? notes.map((note) => ({
                noteId: note.id,
                correctness: { ...pass, statement: "1 = 1.", premises: [] },
                source: pass,
                reconstruction: { ...pass, proof: "By reflexivity, 1 = 1." },
                ...(note.candidate ? { requirements: pass } : {}),
              }))
            : [
                {
                  noteId: candidate.id,
                  correctness: {
                    verdict: "INCONCLUSIVE",
                    report: "The reflexivity lemma is missing.",
                    statement: "1 = 1.",
                    premises: [],
                  },
                },
              ],
        };
      },
    }),
  });
  try {
    await owner.root.waitForIdle(context);
    const report = await owner.root.commit(
      (tx) => readReport(tx, owner.root.id),
      context,
    );
    return { ...report, database };
  } finally {
    await owner.close();
  }
}

test("unchanged completed checks block another worker admission", async () => {
  const result = await run("retry");
  expect(result.status.status).toBe("blocked");
  expect(result.status.error).toContain("no pending checks");
  expect(result.status.calls.recordedResponses).toBe(0);
  expect(result.status.calls.externalInvocations).toBe(0);
  expect(result.status.acceptedNoteId).toBeNull();
  expect(result.notes).toHaveLength(1);
  expect(result.work.map(({ role }) => role)).toEqual(["explorer", "verifier"]);
});

test("a missing-lemma repair accepts the same stable candidate and survives reopen", async () => {
  const result = await run("repair");
  expect(result.status.status).toBe("completed");
  expect(result.notes).toHaveLength(2);
  expect(result.status.calls.recordedResponses).toBe(0);
  const candidate = result.notes.find((note) => note.candidate)!;
  const lemma = result.notes.find((note) => !note.candidate)!;
  expect(candidate.id).toBe(`${result.work[0]!.id}/n1`);
  expect(candidate.support).toEqual([lemma.id]);
  expect(candidate.accepted).toBe(true);
  expect(result.status.acceptedNoteId).toBe(candidate.id);
  expect(result.work.map(({ role }) => role)).toEqual([
    "explorer",
    "verifier",
    "explorer",
    "verifier",
  ]);
  const reopened = await inspect(result.database, readReport);
  expect(reopened.status.acceptedNoteId).toBe(candidate.id);
  expect(
    reopened.notes.find((note) => note.id === candidate.id)?.revision,
  ).toBe(candidate.revision);
});

test("Coordinator can leave an inconclusive check idle even with Codex configured", async () => {
  const result = await run("idle");
  expect(result.status.status).toBe("idle");
  expect(result.work.map(({ role }) => role)).toEqual(["explorer", "verifier"]);
  expect(result.notes[0]!.checks.correctness?.verdict).toBe("INCONCLUSIVE");
  expect(result.status.acceptedNoteId).toBeNull();
  expect(result.status.pendingDecisions).toBe(0);
  expect(result.status.calls.recordedResponses).toBe(0);
  expect(result.status.calls.externalInvocations).toBe(0);
});

async function runComputationalVerification(verdict: "PASS" | "INCONCLUSIVE") {
  const directory = await temporaryDirectory("xean-computational-verifier-");
  const database = join(directory, "campaign.sqlite");
  const observed: Note[] = [];
  let codexChecks = 0;
  const owner = await open(database, {
    create: {
      task,
      settings,
    },
    models: createModels(),
    roles: (builtins) => ({
      ...codex({ verifier: { model: "fixture", workspace: directory } })(
        builtins,
      ),
      coordinator: async ({ notes }: { notes: Note[] }) => {
        const candidate = notes[0];
        if (!candidate)
          return {
            work: {
              kind: "explorer",
              assignment: "Give a finite certificate.",
            },
          };
        observed.push(structuredClone(candidate));
        if (codexChecks === 2) return { work: null };
        const correctness = candidate.checks.correctness;
        return {
          work: {
            kind: "verifier",
            notes: [candidate.id],
            through:
              correctness?.verdict === "PASS"
                ? "reconstruction"
                : "correctness",
            ...(correctness?.verdict === "INCONCLUSIVE"
              ? { backend: "external" }
              : {}),
          },
        };
      },
      explorer: async (_input, runtime) => ({
        kind: "notes",
        notes: [{ ...noteResult.notes[0]!, id: `${runtime.taskId}/n1` }],
      }),
      verifier: async ({ notes, backend, through }: VerifierInput) => {
        if (backend === "external") codexChecks++;
        const candidate = notes[0]!;
        const pass = { verdict: "PASS", report: "Scripted workflow judgment." };
        const check =
          through === "reconstruction"
            ? {
                source: pass,
                requirements: pass,
                reconstruction: { ...pass, proof: "By reflexivity, 1 = 1." },
              }
            : {
                correctness: {
                  verdict: backend === "external" ? verdict : "INCONCLUSIVE",
                  report: "Scripted finite-certificate assessment.",
                  statement: "1 = 1.",
                  premises: [],
                },
              };
        return {
          kind: "verification",
          checks: [{ noteId: candidate.id, ...check }],
        };
      },
    }),
  });
  try {
    await owner.root.waitForIdle(context);
    const report = await owner.root.commit(
      (tx) => readReport(tx, owner.root.id, { records: true }),
      context,
    );
    return { ...report, database, observed };
  } finally {
    await owner.close();
  }
}

test("Coordinator selects Codex for an unchanged inconclusive claim without bypassing later stages", async () => {
  const result = await runComputationalVerification("PASS");
  expect(result.status.status).toBe("completed");
  expect(result.work.map(({ role }) => role)).toEqual([
    "explorer",
    "verifier",
    "verifier",
    "verifier",
  ]);
  const [original, uncertain, checked] = result.observed;
  expect(uncertain!.checks.correctness?.verdict).toBe("INCONCLUSIVE");
  expect(checked!.checks.correctness?.verdict).toBe("PASS");
  expect(Object.keys(checked!.checks)).toEqual(["correctness"]);
  expect(checked!.accepted).toBe(false);
  const candidate = result.notes[0]!;
  for (const note of [uncertain!, checked!, candidate])
    expect(note).toMatchObject({
      id: original!.id,
      support: original!.support,
      revision: original!.revision,
    });
  expect(candidate.text).toBe(noteResult.notes[0]!.text);
  expect(candidate.accepted).toBe(true);
  expect(result.status.acceptedNoteId).toBe(candidate.id);
  const workers = result.tasks!.filter(
    (task) => task.kind === "research.worker",
  );
  expect(workers[1]!.state.outcome).toMatchObject({
    status: "completed",
    result: {
      checks: [{ correctness: { verdict: "INCONCLUSIVE" } }],
    },
  });
  expect(workers[2]!.input).toMatchObject({
    request: { kind: "verifier", backend: "external" },
  });
  const reopened = await inspect(result.database, (tx, root) =>
    readReport(tx, root, { records: true }),
  );
  expect(reopened.notes).toEqual(result.notes);
  expect(
    reopened.tasks!.filter((task) => task.kind === "research.worker"),
  ).toEqual(workers);
});

test("Coordinator can select repeated Codex checks of an unchanged inconclusive claim", async () => {
  const result = await runComputationalVerification("INCONCLUSIVE");
  expect(result.status.status).toBe("idle");
  expect(result.work.map(({ role }) => role)).toEqual([
    "explorer",
    "verifier",
    "verifier",
    "verifier",
  ]);
  const original = result.observed[0]!;
  expect(result.notes[0]).toMatchObject({
    id: original.id,
    text: noteResult.notes[0]!.text,
    revision: original.revision,
    checks: { correctness: { verdict: "INCONCLUSIVE" } },
  });
  for (const worker of result
    .tasks!.filter((task) => task.kind === "research.worker")
    .slice(2))
    expect(worker).toMatchObject({
      input: { request: { kind: "verifier", backend: "external" } },
      state: { outcome: { status: "completed" } },
    });
  expect(result.status.acceptedNoteId).toBeNull();
  const reopened = await inspect(result.database, readReport);
  expect(reopened.notes).toEqual(result.notes);
});

const routingNote = (
  id: string,
  imported = false,
  support: string[] = [],
): Note => ({
  ...noteResult.notes[0]!,
  id,
  text: `${id}: 1 = 1. No proof supplied.`,
  support,
  revision: 0,
  checks: imported ? { external: { entry: 1 } } : {},
  retired: false,
  verified: false,
  accepted: false,
  dead: false,
});

test.each([
  ["support", [["generated"]], [["generated", "INCONCLUSIVE"]]],
  [
    "mixed",
    [["ancestor", "generated"]],
    [
      ["ancestor", "INCONCLUSIVE"],
      ["generated", "INCONCLUSIVE"],
    ],
  ],
  ["import", [], []],
  ["failure", [["generated"]], []],
] satisfies [string, string[][], [string, string][]][])(
  "import trust stays confined to extraction targets: %s",
  async (scenario, expectedCalls, expectedChecks) => {
    const imported = routingNote("imported", true);
    const generated = routingNote("generated", false, [imported.id]);
    const ancestor = routingNote("ancestor");
    const notes = scenario === "import" ? [imported] : [imported, generated];
    if (scenario === "support")
      imported.checks.correctness = {
        verdict: "PASS",
        statement: "1 = 1.",
        premises: [],
        report: "Caller-granted statement extracted.",
      };
    if (scenario === "mixed") {
      imported.support = [ancestor.id];
      notes.unshift(ancestor);
    }
    const calls: {
      notes: (Note & { external?: { entry: number } })[];
      support: Note[];
      extraction: boolean;
    }[] = [];
    const provider = fauxProvider({
      provider: "openai",
      models: [{ id: "fixture", contextWindow: 131072, maxTokens: 8192 }],
    });
    const response: FauxResponseFactory = (transcript) => {
      provider.appendResponses([response]);
      const input = JSON.parse(
        transcript.messages.filter((message) => message.role === "user").at(-1)!
          .content as string,
      ) as {
        notes: (Note & { external?: { entry: number } })[];
        support: Note[];
      };
      // Model the observed mistake: extraction instructions grant every target.
      const system = getCurrentSystemPrompt(transcript.messages);
      const extraction = system.includes(
        "caller grants the mathematical result",
      );
      const proofRequired = system.includes(
        "PASS requires the original argument",
      );
      calls.push({ ...input, extraction });
      if (scenario === "failure" && !extraction)
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "Invalid API key",
        });
      return fauxAssistantMessage(
        [
          fauxToolCall("submit_correctness", {
            results: input.notes.map(({ id }) => ({
              noteId: id,
              verdict:
                extraction &&
                !(input.notes.every((note) => !!note.external) && proofRequired)
                  ? "PASS"
                  : "INCONCLUSIVE",
              statement: "1 = 1.",
              premises: [],
              report: extraction
                ? "Faithful extraction; proof not checked."
                : "Original proof missing.",
            })),
          }),
        ],
        { stopReason: "toolUse" },
      );
    };
    provider.setResponses([response]);
    const models = createModels();
    models.setProvider(provider.provider);
    const directory = await temporaryDirectory("xean-import-routing-");
    const owner = await open(join(directory, "campaign.sqlite"), {
      models,
      create: {
        task,
        settings,
        mode: {
          role: "verifier",
          input: { notes, targets: [notes.at(-1)!.id], through: "correctness" },
        },
      },
    });
    try {
      await owner.root.waitForIdle(context);
      const report = await owner.root.commit(
        (tx) => readReport(tx, owner.root.id),
        context,
      );
      expect(report.status.status).toBe(
        scenario === "failure" ? "blocked" : "completed",
      );
      expect(calls.map(({ notes }) => notes.map(({ id }) => id))).toEqual(
        expectedCalls,
      );
      for (const call of calls)
        expect(
          call.notes.every((note) => !!note.external === call.extraction),
        ).toBe(true);
      const generatedCall = calls.find((call) => !call.extraction);
      if (generatedCall)
        expect(
          generatedCall.support.find((note) => note.id === imported.id),
        ).toMatchObject({
          external: { entry: 1 },
          support: imported.support,
        });
      if (scenario === "failure") expect(report.result).toBeUndefined();
      else
        expect(report.result).toMatchObject({
          kind: "verification",
          checks: expectedChecks.map(([noteId, verdict]) => ({
            noteId,
            correctness: { verdict, premises: [] },
          })),
        });
    } finally {
      await owner.close();
    }
  },
);
