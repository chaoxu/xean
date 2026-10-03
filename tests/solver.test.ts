import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  getDeclaredTools,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai/utils/transcript";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import { createSolver, project } from "../packages/core/src/solve/index.ts";
import type {
  Check,
  Note,
  Plan,
  Source,
  VerifierInput,
} from "../packages/core/src/solve/contracts.ts";
import {
  noteInfo,
  refresh,
  sourceEvidence,
} from "../packages/core/src/solve/notes.ts";
import {
  bindCodex,
  codexResearch,
} from "../packages/core/src/solve/research.ts";
import { invoke, fixtureRuntime } from "./fixtures/pi.ts";

const content = (text: string) => ({
  summary: `Index: ${text}`,
  detailedSummary: `Detail: ${text}`,
  text,
});

test("solver stops at requested stages, applies only PASS corrections, reuses checks, and reopens without calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-solver-"));
  const path = join(directory, "campaign.sqlite");
  const calls: string[] = [];
  const sourceTexts: string[] = [];
  let runtimeLoads = 0;
  let redundant = false;
  const pass = {
    verdict: "PASS" as const,
    report: "Checked the exact statement.",
  };
  const runtime = fixtureRuntime((context, _options, selected) => {
    calls.push(selected.id);
    const input = JSON.parse(
      String(
        context.messages.find((message) => message.role === "user")!.content,
      ),
    );
    const batch = (judge: (note: Note) => unknown) => ({
      results: input.notes.map((note: Note) => ({
        noteId: note.id,
        result: judge(note),
      })),
    });
    let result: unknown;
    switch (selected.id) {
      case "coordinator": {
        if (context.messages.length > 5)
          throw new Error(JSON.stringify(context.messages.at(-1)));
        const candidate = input.notes.at(-1);
        const verify = (through: string, notes = [candidate.id]) => ({
          kind: "verifier",
          notes,
          through,
        });
        const next = candidate?.passed.includes("correctness")
          ? candidate.passed.includes("source")
            ? candidate.passed.includes("requirements")
              ? "reconstruction"
              : "requirements"
            : "source"
          : "correctness";
        const repeat = next === "source" && !redundant;
        if (repeat) redundant = true;
        result = {
          work:
            input.notes.length === 0
              ? [
                  {
                    kind: "explorer",
                    guidance: "Solve the exact task",
                  },
                ]
              : next === "correctness"
                ? [
                    verify("correctness", [input.notes[0].id]),
                    verify("correctness"),
                    verify("correctness"),
                  ]
                : repeat
                  ? [verify("correctness")]
                  : next === "reconstruction"
                    ? [verify("source"), verify(next), verify("source")]
                    : [verify(next)],
        };
        break;
      }
      case "explorer":
        result = {
          candidate: calls.filter((name) => name === "explorer").length === 2,
          notes:
            calls.filter((name) => name === "explorer").length === 1
              ? [
                  {
                    id: "n1",
                    summary: "support",
                    detailedSummary: "ESTABLISHED-SUPPORT mechanism",
                    text: "ESTABLISHED-SUPPORT",
                    support: [],
                  },
                ]
              : [
                  {
                    id: "n2",
                    summary: "CANDIDATE-SUMMARY",
                    detailedSummary: "CANDIDATE-SECRET mechanism",
                    text: "CANDIDATE-SECRET",
                    support: ["n1"],
                  },
                ],
        };
        break;
      case "correctness":
        expect(input).not.toHaveProperty("sources");
        expect(input.instructions).toContain("otherwise warrants PASS");
        expect(input.instructions).toContain("Copy text exactly");
        expect(input.instructions).toContain("unmet task criterion");
        expect(input.notes.map((note: Note) => note.text)).toEqual([
          "ESTABLISHED-SUPPORT",
          "CANDIDATE-SECRET",
        ]);
        result = batch((note) => ({
          ...pass,
          premises: note.text.includes("CANDIDATE")
            ? ["Fixture premise"]
            : ["Established premise"],
          correction: {
            ...content(`${note.text} corrected`),
            // Restore the support's summaries without rewriting its argument.
            ...(note.text.startsWith("ESTABLISHED") ? { text: note.text } : {}),
          },
        }));
        break;
      case "requirements":
        expect(input.notes[0].text).toBe("CANDIDATE-SECRET corrected");
        expect(input.sources).toEqual([
          {
            noteId: input.support[0].id,
            source: expect.objectContaining({
              verdict: "PASS",
              operationId: "support-source",
              premises: ["Established premise"],
              passages: [
                expect.objectContaining({ quote: "Established premise" }),
              ],
            }),
          },
          {
            noteId: input.notes[0].id,
            source: expect.objectContaining({
              verdict: "PASS",
              operationId: "new-application",
              premises: ["Fixture premise"],
            }),
          },
        ]);
        result = batch(() =>
          calls.filter((name) => name === "requirements").length === 2
            ? {
                verdict: "INCONCLUSIVE",
                report: "Try this check again.",
                correction: content("SHOULD-NOT-APPLY inconclusive"),
              }
            : { ...pass, correction: content("CANDIDATE-SECRET requirements") },
        );
        break;
      case "statement":
        result = batch((note) => ({
          statement: `Claim ${note.id}`,
        }));
        break;
      case "proof":
        expect(JSON.stringify(context.messages)).not.toContain("CANDIDATE");
        expect(JSON.stringify(context.messages)).not.toContain(
          "ESTABLISHED-SUPPORT",
        );
        expect(input.notes).toHaveLength(
          calls.filter((name) => name === "proof").length === 1 ? 2 : 1,
        );
        result = batch((note) => ({
          proof: "INDEPENDENT-PROOF",
          complete:
            note.id.endsWith("n1") ||
            calls.filter((name) => name === "proof").length > 1,
        }));
        break;
      case "reconstruction":
        expect(input.notes.at(-1).text).toBe("CANDIDATE-SECRET requirements");
        result = batch((note) => ({
          ...pass,
          ...(note.id.endsWith("n2")
            ? {
                correction: content(
                  input.independent.find(
                    (item: { noteId: string }) => item.noteId === note.id,
                  ).result.complete
                    ? "CANDIDATE-SECRET final"
                    : "SHOULD-NOT-APPLY incomplete proof",
                ),
              }
            : {}),
        }));
        break;
      default:
        throw new Error(`Unexpected role: ${selected.id}`);
    }
    const message = fauxAssistantMessage(
      [fauxToolCall("submit_result", result as never)],
      { stopReason: "toolUse" },
    );
    if (
      selected.id === "requirements" &&
      calls.filter((name) => name === "requirements").length === 1
    )
      message.content.push(
        fauxToolCall("submit_result", {
          verdict: "FAIL",
          report: "Contradicts the first verdict.",
        }),
      );
    return message;
  });
  const solver = createSolver(
    { problem: "Exact task", completionCriteria: "Complete proof" },
    () => {
      runtimeLoads++;
      return runtime;
    },
    {},
    {
      ...codexResearch(),
      async source({ task, notes, evidence }) {
        expect(task).toEqual({
          problem: "Exact task",
          completionCriteria: "Complete proof",
        });
        return notes.map(({ id, text, summary, detailedSummary, premises }) => {
          sourceTexts.push(text);
          if (text.startsWith("ESTABLISHED")) {
            expect({ text, summary, detailedSummary }).toEqual({
              ...content("ESTABLISHED-SUPPORT corrected"),
              text: "ESTABLISHED-SUPPORT",
            });
            return {
              noteId: id,
              result: bindCodex(
                {
                  operationId: "support-source",
                  searches: 1,
                  value: {
                    ...pass,
                    correction: content(`${text} twice`),
                    passages: [
                      {
                        premise: 0,
                        url: "https://example.com/theorem",
                        quote: "Established premise",
                      },
                    ],
                  },
                },
                premises,
              ),
            };
          }
          expect(evidence?.[0]).toMatchObject({
            id: "support-source/0",
            statement: "Established premise",
          });
          expect(evidence).toHaveLength(1);
          expect(JSON.stringify(evidence)).not.toContain("correction");
          if (sourceTexts.length === 2)
            throw new Error("Temporary source execution failure");
          return {
            noteId: id,
            result: bindCodex(
              {
                operationId: "new-application",
                searches: 0,
                value: {
                  ...pass,
                  correction: null,
                  passages: [{ premise: 0, passageId: "support-source/0" }],
                },
              },
              premises,
              evidence,
            ),
          };
        });
      },
    },
  );
  let engine: Xean | undefined;
  try {
    engine = await Xean.open(await openXeanStorage(path), solver);
    expect(runtimeLoads).toBe(0);
    const result = await engine.run();
    expect(runtimeLoads).toBe(1);
    expect(result.error).toBeNull();
    expect(result.status).toBe("completed");
    expect(calls.filter((name) => name === "explorer")).toHaveLength(2);
    expect(calls.filter((name) => name === "correctness")).toHaveLength(1);
    expect(calls.filter((name) => name === "requirements")).toHaveLength(3);
    expect(calls.filter((name) => name === "statement")).toHaveLength(2);
    expect(calls.filter((name) => name === "proof")).toHaveLength(2);
    expect(calls.filter((name) => name === "reconstruction")).toHaveLength(2);
    const rawResults = JSON.stringify(result.work);
    const notes = project(result);
    expect(notes.flatMap((note) => noteInfo(note).feedback)).toEqual([]);
    expect(sourceEvidence([{ ...notes[0]!, dead: true }])).toEqual([]);
    expect(sourceEvidence([{ ...notes[0]!, verified: false }])).toEqual([]);
    expect(JSON.stringify(notes)).not.toContain('"correction"');
    expect(rawResults).toContain('"correction"');
    expect(JSON.stringify(result.work)).toBe(rawResults);
    const verifications = result.work.filter(
      (work) => work.role === "xean.verifier",
    );
    const firstCandidateCheck = (
      verifications[0]!.result as { checks: Check[] }
    ).checks.find((check) => check.noteId === notes[1]!.id);
    expect(firstCandidateCheck).toHaveProperty("correctness.verdict", "PASS");
    for (const stage of ["source", "requirements", "reconstruction"])
      expect(firstCandidateCheck).not.toHaveProperty(stage);
    expect(notes.map((note) => [note.verified, note.accepted])).toEqual([
      [true, false],
      [true, true],
    ]);
    expect(sourceTexts).toEqual([
      "ESTABLISHED-SUPPORT",
      "CANDIDATE-SECRET corrected",
      "CANDIDATE-SECRET corrected",
    ]);
    expect(
      result.work.filter((work) => work.status === "failed"),
    ).toMatchObject([
      { result: null, error: "Temporary source execution failure" },
    ]);
    expect(
      notes.map(({ text, summary, detailedSummary, revision }) => ({
        text,
        summary,
        detailedSummary,
        revision,
      })),
    ).toEqual([
      { ...content("ESTABLISHED-SUPPORT twice"), revision: 1 },
      { ...content("CANDIDATE-SECRET final"), revision: 3 },
    ]);
    expect(verifications[0]!.input).toMatchObject({
      notes: [
        { text: "ESTABLISHED-SUPPORT", revision: 0 },
        { text: "CANDIDATE-SECRET", revision: 0 },
      ],
    });
    const noCalls = {
      attemptId: "reuse",
      attempt: 1,
      recorder: {
        begin() {
          throw new Error("Reused checks must make no call");
        },
      },
    };
    const reused = await invoke(
      solver.functions.verifier,
      {
        task: solver.task.task,
        notes,
        targets: [{ id: notes[1]!.id, through: "reconstruction" }],
      },
      noCalls,
    );
    expect(reused).toEqual({ kind: "verification", checks: [] });
    const invalid = structuredClone(result);
    const verification = invalid.work.find(
      (work) => work.role === "xean.verifier",
    )!;
    (
      verification.result as unknown as { checks: { source?: Source }[] }
    ).checks[0]!.source = {
      verdict: "INCONCLUSIVE",
      report: "Missing evidence",
    };
    expect(solver.accept(result.result, invalid)).toBe(false);
    const offline = createSolver(solver.task.task, () => {
      throw new Error("Committed evidence needs no models");
    });
    const decision = await offline.coordinator.run(
      { id: verification.publicationId!, kind: "completed", value: null },
      { ...result, status: "running" },
      noCalls,
      BACKGROUND_CONTEXT,
    );
    expect(decision.completion).toEqual(result.result);
    expect(offline.accept(result.result, result)).toBe(true);
    const records = await engine.records();
    await engine.close();
    engine = await Xean.open(await openXeanStorage(path), offline);
    expect(await engine.run()).toEqual(result);
    expect(await engine.records()).toEqual(records);
  } finally {
    await engine?.close();
    await rm(directory, { recursive: true });
  }
}, 15_000);

test("final source and requirements verdicts reject no-op plans across revisions and dependencies", async () => {
  const pass = { verdict: "PASS" as const, report: "Checked." };
  const task = { problem: "Exact task", completionCriteria: "Complete proof" };
  const notes: Note[] = ["base", "lemma", "dependent", "rejected"].map(
    (id) => ({
      id,
      text: id,
      summary: id,
      detailedSummary: id,
      support:
        id === "dependent"
          ? ["base", "lemma"]
          : id === "rejected"
            ? ["lemma"]
            : [],
      revision: 0,
      imported: false,
      checks: [
        {
          noteId: id,
          correctness: { ...pass, premises: ["External theorem"] },
          ...(id !== "base" ? { source: pass } : {}),
          ...(id === "rejected"
            ? {
                requirements: {
                  verdict: "FAIL" as const,
                  report: "Missing completion criterion",
                },
              }
            : {}),
        },
      ],
      candidate: false,
      dead: false,
      verified: false,
      accepted: false,
    }),
  );
  const sources: string[][] = [];
  const requests: Plan["work"] = [
    { kind: "verifier", notes: ["base"], through: "source" },
    { kind: "verifier", notes: ["dependent"], through: "reconstruction" },
    { kind: "verifier", notes: ["rejected"], through: "requirements" },
    { kind: "verifier", notes: ["rejected"], through: "reconstruction" },
    { kind: "explorer", guidance: "Find a supported argument" },
  ];
  const requestCount = requests.length;
  const runtime = fixtureRuntime((context, _options, selected) => {
    expect(selected.id).toBe("coordinator");
    if (requests.length < requestCount) {
      expect(context.messages.at(-1)).toMatchObject({
        role: "toolResult",
        isError: true,
      });
      expect(JSON.stringify(context.messages.at(-1))).toContain(
        "no pending checks",
      );
    }
    const request = requests.shift();
    if (!request) throw new Error("Coordinator failed to accept useful work");
    return fauxAssistantMessage(
      [fauxToolCall("submit_result", { work: [request] })],
      { stopReason: "toolUse" },
    );
  });
  const solver = createSolver(
    task,
    runtime,
    {},
    {
      ...codexResearch(),
      async source({ notes }) {
        sources.push(notes.map(({ id }) => id));
        return notes.map(({ id }) => ({
          noteId: id,
          result:
            id === "base"
              ? {
                  verdict: "INCONCLUSIVE" as const,
                  report: "Missing source",
                  correction: content("SHOULD-NOT-APPLY"),
                }
              : pass,
        }));
      },
    },
  );
  const input: VerifierInput = {
    task,
    notes,
    targets: ["dependent", "rejected"].map((id) => ({
      id,
      through: "reconstruction",
    })),
    evidence: [],
  };
  const verify = () => invoke(solver.functions.verifier, input);
  const first = await verify();
  if (first.kind !== "verification") throw new Error("Expected verification");
  expect(first.checks).toMatchObject([
    { noteId: "base", source: { verdict: "INCONCLUSIVE" } },
  ]);
  expect(first.checks[0]).not.toHaveProperty("correction");
  notes[0]!.checks.push(...first.checks);
  refresh(notes);
  expect(
    notes.map(({ dead, verified, accepted }) => [dead, verified, accepted]),
  ).toEqual([
    [false, false, false],
    [false, true, false],
    [false, false, false],
    [false, true, false],
  ]);
  notes[0]!.text += ".";
  notes[0]!.revision++;
  input.evidence!.push({
    id: "new-source",
    statement: "External theorem",
    url: "https://example.com/theorem",
    quote: "New evidence",
  });
  expect(await verify()).toEqual({ kind: "verification", checks: [] });
  const plan = await invoke(solver.functions.coordinator, {
    task,
    notes,
    failures: [],
    guidance: [],
    literatureUsed: false,
    explorerUsed: false,
  });
  expect(plan.work[0]!.kind).toBe("explorer");
  notes.push({
    ...notes[0]!,
    id: "fresh",
    revision: 0,
    text: "External theorem with new source evidence",
    checks: [
      {
        noteId: "fresh",
        correctness: { ...pass, premises: ["External theorem"] },
      },
    ],
  });
  input.targets.push({ id: "fresh", through: "source" });
  expect(await verify()).toEqual({
    kind: "verification",
    checks: [{ noteId: "fresh", source: pass }],
  });
  expect(sources).toEqual([["base"], ["fresh"]]);
});

test("verifier stages share unchanged prefixes while the blind proof sees only statements", async () => {
  const task = { problem: "Exact task", completionCriteria: "Complete proof" };
  const notes: Note[] = [
    {
      id: "n1",
      text: "ORIGINAL-PROOF",
      summary: "Claim",
      detailedSummary: "ORIGINAL-METHOD in the detailed summary",
      support: [],
      revision: 0,
      imported: false,
      checks: [],
      candidate: true,
      dead: false,
      verified: false,
      accepted: false,
    },
  ];
  const calls = new Map<
    string,
    { system: unknown; tools: unknown; prompt: string }
  >();
  let extractions = 0;
  const runtime = fixtureRuntime((context, _options, selected) => {
    const prompt = String(
      context.messages.find((message) => message.role === "user")!.content,
    );
    calls.set(selected.id, {
      system: getCurrentSystemPrompt(context.messages),
      tools: getDeclaredTools(context.messages),
      prompt,
    });
    const input = JSON.parse(prompt);
    if (selected.id === "statement" && ++extractions === 2)
      expect(context.messages.at(-1)).toMatchObject({
        role: "toolResult",
        isError: true,
      });
    if (selected.id === "proof")
      expect(input.notes[0].statement).toBe(
        "Claim n ≥ 2\n\twith n - 2 and literal \\u001e",
      );
    const result =
      selected.id === "statement"
        ? {
            statement:
              extractions === 1
                ? "Claim n \u001e 2"
                : "Claim n ≥ 2\n\twith n - 2 and literal \\u001e",
          }
        : selected.id === "proof"
          ? { proof: "INDEPENDENT-PROOF", complete: true }
          : {
              verdict: "PASS",
              report: "Checked.",
              ...(selected.id === "correctness" ? { premises: [] } : {}),
            };
    return fauxAssistantMessage(
      [
        fauxToolCall("submit_result", {
          results: input.notes.map(({ id }: Note) => ({ noteId: id, result })),
        }),
      ],
      { stopReason: "toolUse" },
    );
  });
  await invoke(createSolver(task, runtime).functions.verifier, {
    task,
    notes,
    targets: [{ id: "n1", through: "reconstruction" }],
  });
  const requirements = calls.get("requirements")!;
  const reconstruction = calls.get("reconstruction")!;
  expect(requirements.tools).toEqual(reconstruction.tools);
  expect(calls.get("correctness")!.tools).not.toEqual(requirements.tools);
  expect(new Set([...calls.values()].map(({ system }) => system)).size).toBe(1);
  const prefix = requirements.prompt.slice(
    0,
    requirements.prompt.indexOf(',"verifiedSupport":'),
  );
  expect(prefix).toContain("ORIGINAL-PROOF");
  expect(reconstruction.prompt.startsWith(prefix)).toBe(true);
  expect(calls.get("proof")!.prompt).not.toContain("ORIGINAL-PROOF");
  expect(calls.get("proof")!.prompt).not.toContain("ORIGINAL-METHOD");
  for (const stage of ["correctness", "requirements", "reconstruction"]) {
    const input = JSON.parse(calls.get(stage)!.prompt);
    expect(input.notes[0]).toMatchObject({
      summary: notes[0]!.summary,
      detailedSummary: notes[0]!.detailedSummary,
    });
    expect(input.instructions).toContain("Check both summaries");
  }
  expect(reconstruction.prompt).toContain("INDEPENDENT-PROOF");
  expect(extractions).toBe(2);
});

test("batched reconstruction proves the dependency chain, trusts imported support, and reuses conditional checks", async () => {
  const pass = { verdict: "PASS" as const, report: "Checked." };
  const task = { problem: "Exact task", completionCriteria: "Complete proof" };
  const notes: Note[] = (
    [
      ["s", ["theorem"]],
      ["fail", []],
      ["uncertain", []],
      ["blocked-fail", ["fail"]],
      ["blocked-uncertain", ["uncertain"]],
      ["a", ["s"]],
      ["b", ["s", "a"]],
      ["imported", ["s"]],
      ["theorem", ["base"]],
      ["base", []],
    ] satisfies [string, string[]][]
  ).map(([id, support]) => ({
    id,
    support,
    text: `SECRET-${id}`,
    summary: id,
    detailedSummary: `SECRET-METHOD-${id}`,
    revision: 0,
    imported: id === "imported" || id === "theorem",
    checks: [],
    candidate: true,
    dead: false,
    verified: false,
    accepted: false,
  }));
  notes[0]!.checks.push({
    noteId: "s",
    correctness: { ...pass, premises: [] },
    source: pass,
    requirements: {
      verdict: "FAIL",
      report: "A support lemma does not solve the task.",
    },
  });
  const calls: string[] = [];
  let retry = false;
  let target = "b";
  const runtime = fixtureRuntime((context, _options, selected) => {
    calls.push(selected.id);
    const input = JSON.parse(
      String(
        context.messages.find((message) => message.role === "user")!.content,
      ),
    );
    let result: unknown;
    if (selected.id === "coordinator") {
      result = {
        work: [
          { kind: "verifier", notes: [target], through: "reconstruction" },
        ],
      };
    } else {
      if (selected.id === "proof") {
        expect(JSON.stringify(context.messages)).not.toContain("SECRET-");
        expect(input.support.map((note: Note) => note.id)).toEqual(
          retry ? ["base", "theorem"] : ["theorem"],
        );
        expect(input.notes.map((note: Note) => note.id)).toEqual(
          retry ? ["s"] : ["base", "s", "a", "b", "imported"],
        );
      }
      const results = input.notes
        .map((note: Note) => ({
          noteId: note.id,
          result:
            selected.id === "statement"
              ? { statement: `Claim ${note.id}` }
              : selected.id === "proof"
                ? {
                    proof: `Independent ${note.id}`,
                    complete: retry || note.id !== "s",
                  }
                : {
                    ...pass,
                    ...(selected.id === "correctness"
                      ? {
                          premises: [],
                          verdict:
                            note.id === "fail"
                              ? "FAIL"
                              : note.id === "uncertain"
                                ? "INCONCLUSIVE"
                                : "PASS",
                        }
                      : {}),
                  },
        }))
        .reverse();
      if (selected.id === "correctness") {
        expect(input.notes.map((note: Note) => note.id)).not.toContain(
          "imported",
        );
        expect(input.notes.map((note: Note) => note.id)).not.toContain(
          "theorem",
        );
        const turn = calls.length;
        if (turn > 1) {
          expect(context.messages.at(-1)).toMatchObject({
            role: "toolResult",
            isError: true,
          });
          expect(JSON.stringify(context.messages.at(-1))).toContain(
            "exactly one result per requested note",
          );
        }
        if (turn === 1) results.pop();
        if (turn === 2) results[0] = results[1];
        if (turn === 3) results[0].noteId = "unknown";
        if (turn > 4)
          throw new Error("Batch validation did not accept the valid retry");
      } else if (selected.id === "requirements") {
        expect(input.sources).toContainEqual({
          noteId: "imported",
          source: { kind: "caller-import" },
        });
        expect(input.notes.map((note: Note) => note.id)).toEqual([
          "a",
          "b",
          "imported",
        ]);
      }
      result = { results };
    }
    return fauxAssistantMessage(
      [fauxToolCall("submit_result", result as never)],
      { stopReason: "toolUse" },
    );
  });
  const solver = createSolver(task, runtime);
  const result = await invoke(solver.functions.verifier, {
    task,
    notes,
    targets: notes
      .slice(3, 8)
      .map(({ id }) => ({ id, through: "reconstruction" as const })),
  });
  if (result.kind !== "verification") throw new Error("Expected verification");
  for (const check of result.checks)
    notes.find((note) => note.id === check.noteId)!.checks.push(check);
  refresh(notes);
  expect(
    notes.map(({ id, dead, verified, accepted }) => [
      id,
      dead,
      verified,
      accepted,
    ]),
  ).toEqual([
    ["s", false, true, false],
    ["fail", true, false, false],
    ["uncertain", false, false, false],
    ["blocked-fail", true, false, false],
    ["blocked-uncertain", false, false, false],
    ["a", false, true, false],
    ["b", false, true, false],
    ["imported", false, true, false],
    ["theorem", false, true, false],
    ["base", false, true, false],
  ]);
  expect(result.checks.find((check) => check.noteId === "imported")).toEqual({
    noteId: "imported",
    requirements: pass,
    reconstruction: {
      ...pass,
      statement: "Claim imported",
      proof: "Independent imported",
    },
  });
  expect(notes.find((note) => note.id === "theorem")!.checks).toEqual([]);
  expect(calls.filter((name) => name !== "correctness")).toEqual([
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  // A candidate's own PASS must not prevent scheduling its missing dependency.
  const plan = () =>
    invoke(solver.functions.coordinator, {
      task,
      notes,
      failures: [],
      guidance: [],
      literatureUsed: false,
      explorerUsed: false,
    });
  expect((await plan()).work).toEqual([
    { kind: "verifier", notes: ["b"], through: "reconstruction" },
  ]);
  retry = true;
  const resumed = await invoke(solver.functions.verifier, {
    task,
    notes,
    targets: [{ id: "b", through: "reconstruction" }],
  });
  if (resumed.kind !== "verification") throw new Error("Expected verification");
  expect(resumed.checks.map((check) => check.noteId)).toEqual(["s"]);
  notes[0]!.checks.push(...resumed.checks);
  refresh(notes);
  expect(notes.filter((note) => note.accepted).map((note) => note.id)).toEqual([
    "a",
    "b",
    "imported",
  ]);
  expect(
    await invoke(
      solver.functions.reconstruct,
      { task, notes, targets: ["a", "b"] },
      {
        attemptId: "reuse",
        attempt: 1,
        recorder: {
          begin() {
            throw new Error("Checks must be reused");
          },
        },
      },
    ),
  ).toEqual({ kind: "verification", checks: [] });
  expect(calls.slice(-3)).toEqual(["statement", "proof", "reconstruction"]);
  // Imported targets still need their own reconstruction when support is done.
  target = "theorem";
  notes
    .find((note) => note.id === target)!
    .checks.push({ noteId: target, requirements: pass });
  expect((await plan()).work).toEqual([
    { kind: "verifier", notes: [target], through: "reconstruction" },
  ]);
  const invalid = structuredClone(notes);
  invalid[0]!.checks.push({
    noteId: "s",
    reconstruction: {
      ...resumed.checks[0]!.reconstruction!,
      verdict: "FAIL",
      report: "Concrete defect in the support proof.",
    },
  });
  refresh(invalid);
  expect(
    invalid
      .filter((note) => ["s", "a", "b", "imported"].includes(note.id))
      .every((note) => note.dead && !note.accepted),
  ).toBe(true);
});
