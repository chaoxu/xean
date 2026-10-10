import { expect, test } from "bun:test";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { inspect, open, readReport, type Note } from "../src/index.ts";
import { context, noteResult, settings, task } from "./fixture.ts";
import { temporaryDirectory } from "./directory.ts";

async function run(scenario: "retry" | "repair" | "idle") {
  const directory = await temporaryDirectory(`xean-verification-${scenario}-`);
  const database = join(directory, "campaign.sqlite");
  let rounds = 0;
  const owner = await open(database, {
    create: { task, settings },
    models: createModels(),
    roles: () => ({
      coordinator: async ({ notes }: { notes: Note[] }) => {
        if (scenario === "idle" || rounds === 4) return { work: null };
        const candidate = notes.find((note) => note.candidate);
        if (
          !candidate ||
          (scenario === "repair" &&
            !candidate.support.length &&
            Object.keys(candidate.checks).length)
        )
          return { work: { kind: "explorer", guidance: "Repair the proof." } };
        return {
          work: {
            kind: "verifier",
            notes: [candidate.id],
            through: "reconstruction",
          },
        };
      },
      explorer: async ({ notes }: { notes: Note[] }) => {
        rounds++;
        const candidate = notes.find((note) => note.candidate);
        return candidate
          ? {
              kind: "notes",
              candidate: false,
              notes: noteResult.notes,
              edits: [
                {
                  id: candidate.id,
                  revision: candidate.revision,
                  support: ["n1"],
                  text: "By the declared reflexivity lemma, 1 = 1.",
                },
              ],
            }
          : {
              kind: "notes",
              candidate: true,
              notes: [
                {
                  ...noteResult.notes[0]!,
                  text: "Claim: 1 = 1. Proof missing.",
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
    return { ...report, rounds: report.work.length, database };
  } finally {
    await owner.close();
  }
}

test("unchanged completed checks block another worker admission", async () => {
  const result = await run("retry");
  expect(result.status.status).toBe("blocked");
  expect(result.status.error).toContain("no pending checks");
  expect(result.rounds).toBe(2);
  expect(result.status.calls.recordedResponses).toBe(0);
  expect(result.status.calls.codexInvocations).toBe(0);
  expect(result.status.acceptedNoteId).toBeNull();
  expect(result.notes).toHaveLength(1);
  expect(result.notes[0]!.revision).toBeGreaterThan(0);
  expect(result.notes[0]!.revision).toBeLessThan(Number(result.work[1]!.id));
  expect(result.work.filter(({ role }) => role === "verifier")).toHaveLength(1);
});

test("a missing-lemma repair accepts the same stable candidate and survives reopen", async () => {
  const result = await run("repair");
  expect(result.status.status).toBe("completed");
  expect(result.rounds).toBe(4);
  expect(result.notes).toHaveLength(2);
  expect(result.status.calls.recordedResponses).toBe(0);
  const candidate = result.notes.find((note) => note.candidate)!;
  const lemma = result.notes.find((note) => !note.candidate)!;
  expect(candidate.revision).toBeGreaterThan(Number(result.work[2]!.id));
  expect(candidate.id.startsWith(`${result.work[0]!.id}/`)).toBe(true);
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

test("Coordinator can intentionally leave the campaign idle", async () => {
  const result = await run("idle");
  expect(result.status.status).toBe("idle");
  expect(result.rounds).toBe(0);
  expect(result.notes).toHaveLength(0);
  expect(result.status.pendingDecisions).toBe(0);
  expect(result.status.calls.recordedResponses).toBe(0);
});
