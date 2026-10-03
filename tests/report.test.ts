import { expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  type EntryId,
} from "@earendil-works/pi-durable";
import { Xean, type JsonValue, type Work } from "xean";
import { declarationVersion, type Note } from "xean/solve";
import { campaignReport, statusReport, usageRecord } from "xean/report";
import {
  readSnapshot,
  snapshot as observeSnapshot,
  snapshotFromReport,
} from "xean-observe";

test("status preserves committed verification and native usage with bounded operational metadata", async () => {
  const storage = new MemoryStorage();
  const engine = await Xean.open(storage, {
    task: { kind: "xean.solve", version: declarationVersion },
    roles: [],
    coordinator: { name: "fixture", run: () => ({ state: null }) },
  });
  try {
    const draft = {
      id: "n1",
      text: "A proof",
      summary: "A claim",
      detailedSummary: "A claim with a proof",
      support: [] as string[],
    };
    await engine.input({
      kind: "submit",
      id: "example",
      notes: [draft],
      candidate: true,
    });
    const snapshot = await engine.inspectWithRecords();
    let id = 100;
    const entry = (kind: string, data: JsonValue) => {
      const record = {
        id: id++ as EntryId,
        conversationId: ROOT_CONVERSATION_ID,
        kind,
        data,
      };
      snapshot.records.push(record);
      return record.id;
    };
    const pi = { provider: "fixture", id: "model", api: "openai-responses" };
    const calls = (
      [
        [
          pi,
          {
            input: 100,
            output: 20,
            cacheRead: 30,
            reasoning: 10,
            totalTokens: 150,
            cost: { total: 99 },
          },
        ],
        [
          pi,
          { input: 0, output: 0, cacheRead: 0, reasoning: 0, totalTokens: 0 },
        ],
        [pi, null],
        [pi, undefined],
        [
          { provider: "codex-cli", id: "model", api: "codex-exec" },
          { input_tokens: 200, cached_input_tokens: 50, output_tokens: 40 },
        ],
      ] as const
    ).map(([model, usage]) => ({
      callId: entry("xean.call.started", { model }),
      usage,
    }));
    const body = "Large transcript body ".repeat(4096);
    entry("xean.call.request", { payload: body });
    for (const { callId, usage } of calls)
      if (usage !== undefined)
        entry("xean.call.settled", { callId, message: body, usage });
    snapshot.campaign.providerCalls = calls.length;
    const report = statusReport(snapshot);
    const prepared = campaignReport(snapshot);
    const observed = snapshotFromReport({ ...prepared, status: report });
    expect(observed.notes).toBe(prepared.notes!);
    expect(observed.status).toBe(report);
    const completed = {
      status: "completed" as const,
      attempts: 1,
      attemptId: "fixture",
      error: null,
      input: null,
      result: null,
    };
    const pass = { verdict: "PASS", report: "Checked." } as const;
    const work: Work[] = [
      {
        ...completed,
        id: "explore",
        role: "xean.explorer",
        taskId: 10 as Work["taskId"],
        publicationId: 20 as Work["publicationId"],
        input: {
          guidance: "Try a stronger claim.",
          notes: "frozen-input-not-for-export",
        },
        result: {
          kind: "notes",
          candidate: true,
          notes: [{ ...draft, support: ["input/example/n1"] }],
        },
      },
      {
        ...completed,
        id: "verify",
        role: "xean.verifier",
        taskId: 11 as Work["taskId"],
        publicationId: 30 as Work["publicationId"],
        result: {
          kind: "verification",
          checks: [
            {
              noteId: "explore/n1",
              correctness: {
                ...pass,
                premises: ["External premise."],
              },
              source: {
                ...pass,
                kind: "codex-report",
                operationId: "source-1",
                reportedAt: new Date(0).toISOString(),
                premises: ["External premise."],
                passages: [
                  {
                    id: "source-1/0",
                    statement: "External premise.",
                    premise: 0,
                    url: "https://example.org/theorem",
                    quote: "Exact quotation.",
                  },
                ],
              },
              reconstruction: {
                ...pass,
                statement: "Exact claim.",
                proof: "Independent proof.",
              },
            },
            { noteId: "explore/n1", requirements: pass },
          ],
        },
      },
      {
        ...completed,
        id: "search",
        role: "xean.literature",
        status: "active",
        taskId: 12 as Work["taskId"],
        publicationId: null,
        input: { query: "Find the exact source." },
      },
    ];
    const observedCampaign = (fields: Partial<typeof snapshot.campaign>) =>
      readSnapshot(
        observeSnapshot({
          ...snapshot,
          campaign: { ...snapshot.campaign, ...fields },
        }),
      );
    const history = observedCampaign({ work });
    expect(history.kind).toBe("xean.solve");
    expect(
      history.work.map(({ publicationId, guidance, noteIds, checkCount }) => [
        publicationId,
        guidance,
        noteIds,
        checkCount,
      ]),
    ).toEqual([
      [20, "Try a stronger claim.", ["explore/n1"], 0],
      [30, null, ["explore/n1"], 2],
      [null, "Find the exact source.", [], 0],
    ]);
    expect(JSON.stringify(history)).not.toContain(
      "frozen-input-not-for-export",
    );
    expect(history.notes[1]).toMatchObject({
      revision: 0,
      checks: [
        { reconstruction: { proof: "Independent proof." } },
        { requirements: pass },
      ],
    });
    const checked = history.notes[1]!;
    const check = checked.checks[0]!;
    const inconclusive = { verdict: "INCONCLUSIVE", report: body } as const;
    const verificationNotes: Note[] = [
      { ...history.notes[0]!, candidate: false },
      {
        ...checked,
        verified: false,
        dead: true,
        accepted: false,
        checks: [
          ...checked.checks,
          {
            noteId: checked.id,
            correctness: { ...inconclusive, premises: [] },
            source: { verdict: "FAIL", report: body },
          },
          { noteId: checked.id, source: pass },
        ],
      },
      {
        ...checked,
        id: "unresolved",
        verified: false,
        accepted: false,
        checks: [
          {
            noteId: "unresolved",
            correctness: check.correctness,
            source: inconclusive,
          },
        ],
      },
      {
        ...checked,
        id: "unchecked",
        verified: false,
        accepted: false,
        checks: [],
      },
    ];
    const verification = statusReport({
      ...snapshot,
      notes: verificationNotes,
    });
    expect(verification.notes).toMatchObject({
      total: 4,
      imported: 1,
      generated: 3,
      verified: 1,
      dead: 1,
      accepted: 0,
    });
    expect(verification.verification).toEqual({
      correctness: {
        PASS: 2,
        FAIL: 0,
        INCONCLUSIVE: 0,
        trusted: 1,
        unchecked: 1,
      },
      source: { PASS: 0, FAIL: 1, INCONCLUSIVE: 1, trusted: 1, unchecked: 1 },
      requirements: {
        PASS: 1,
        FAIL: 0,
        INCONCLUSIVE: 0,
        trusted: 0,
        unchecked: 3,
      },
      reconstruction: {
        PASS: 1,
        FAIL: 0,
        INCONCLUSIVE: 0,
        trusted: 0,
        unchecked: 3,
      },
    });
    expect(verification.verificationIssues?.items).toContainEqual({
      noteId: "unresolved",
      stage: "source",
      verdict: "INCONCLUSIVE",
      report: body.slice(0, 499) + "…",
    });
    expect(
      verification.verificationIssues?.items.some(
        (issue) =>
          issue.noteId === "input/example/n1" &&
          issue.stage === "reconstruction",
      ),
    ).toBe(false);
    const dependency = {
      ...checked,
      id: "dependency",
      candidate: false,
      accepted: false,
      support: [],
      checks: [
        {
          noteId: "dependency",
          correctness: check.correctness,
          source: check.source,
        },
      ],
    };
    expect(
      statusReport({
        ...snapshot,
        notes: [
          dependency,
          { ...checked, accepted: false, support: [dependency.id] },
        ],
      }).verificationIssues,
    ).toEqual({
      items: [
        {
          noteId: "dependency",
          stage: "reconstruction",
          verdict: "unchecked",
          report: null,
        },
      ],
      omitted: 0,
    });
    for (const status of [
      "running",
      "paused",
      "blocked",
      "limited",
      "cancelled",
      "completed",
    ] as const) {
      const accepted = observedCampaign({
        work,
        status,
        result: { noteId: checked.id },
      }).status;
      expect(accepted.notes?.accepted).toBe(1);
      expect(accepted.acceptedNoteId).toBe(
        status === "completed" ? checked.id : null,
      );
      if (status === "blocked")
        expect(accepted.nextAction).toContain("Coordinator failure");
    }
    expect(
      observedCampaign({ status: "blocked", callLimitReached: true }).status
        .nextAction,
    ).toContain("extend the call allowance before resuming");
    expect(
      observedCampaign({ status: "running", callLimitReached: true }).status
        .nextAction,
    ).toContain("drains");
    expect(observedCampaign({ status: "pausing" }).status.nextAction).toContain(
      "owner is still active",
    );
    for (const malformed of [
      { ...check, source: { ...check.source, passages: "not an array" } },
      { ...check, reconstruction: { ...check.reconstruction, proof: 7 } },
    ])
      expect(() =>
        readSnapshot({
          ...history,
          notes: [{ ...checked, checks: [malformed] }],
        }),
      ).toThrow("malformed snapshot");
    const generic = observedCampaign({
      task: { kind: "custom", task: "not a solver task" },
      status: "completed",
      result: { noteId: checked.id },
      work: [
        {
          ...work[0]!,
          result: { kind: "verification", checks: "opaque generic result" },
        },
      ],
    });
    expect(generic).toMatchObject({
      kind: "custom",
      task: null,
      notes: [],
      result: { noteId: checked.id },
      work: [{ guidance: null, noteIds: [], checkCount: 0 }],
    });
    expect(generic.status.acceptedNoteId).toBeNull();
    expect(generic.status.verification).toBeUndefined();
    for (const kind of ["xean.solve.offline", "xean.solve.library"])
      expect(
        statusReport({
          ...snapshot,
          campaign: {
            ...snapshot.campaign,
            task: { kind, version: declarationVersion },
          },
        }),
      ).toEqual(report);
    expect(report).toMatchObject({
      status: "running",
      pendingSignals: 2,
      work: { queued: 0, active: 0, completed: 0, failed: 0, cancelled: 0 },
      notes: {
        total: 1,
        imported: 1,
        generated: 0,
        verified: 1,
        dead: 0,
        accepted: 0,
        candidates: 1,
      },
      calls: { admitted: 5, settled: 4, unknownUsage: 1, unsettled: 1 },
    });
    expect(report.calls.byModel).toEqual([
      {
        provider: "fixture",
        model: "model",
        api: "openai-responses",
        admitted: 4,
        settled: 3,
        unknownUsage: 1,
        unsettled: 1,
        reportedUsage: {
          input: 100,
          output: 20,
          cacheRead: 30,
          reasoning: 10,
          totalTokens: 150,
        },
      },
      {
        provider: "codex-cli",
        model: "model",
        api: "codex-exec",
        admitted: 1,
        settled: 1,
        unknownUsage: 0,
        unsettled: 0,
        reportedUsage: {
          input_tokens: 200,
          cached_input_tokens: 50,
          output_tokens: 40,
        },
      },
    ]);
    await storage.commit(
      snapshot.records.map((value) => ({ type: "entry", value })),
      BACKGROUND_CONTEXT,
    );
    const scanEntries = storage.scanEntries.bind(storage);
    let projected = 0;
    const scanning = spyOn(storage, "scanEntries").mockImplementation(
      (query, _limit, cursor, context) => {
        // Project each page before requesting another.
        if (cursor) expect(projected).toBeGreaterThan(0);
        return scanEntries(query, 2, cursor, context);
      },
    );
    try {
      const selected = await engine.inspectWithRecords((entry) => {
        projected++;
        return usageRecord(entry);
      });
      selected.campaign.providerCalls = calls.length;
      expect(statusReport(selected)).toEqual(report);
      expect(selected.records).toHaveLength(calls.length + 4);
      expect(JSON.stringify(selected.records)).not.toContain(body);
    } finally {
      scanning.mockRestore();
    }
    expect(await engine.records()).toEqual(snapshot.records);
    // Omitted models still contribute to exact totals, including unknown and unsettled usage.
    for (let index = 0; index < 12; index++) {
      const callId = entry("xean.call.started", {
        model: { ...pi, id: `model-${index}` },
      });
      if (index < 11)
        entry("xean.call.settled", {
          callId,
          message: body,
          usage: index === 10 ? null : { input_tokens: 0 },
        });
    }
    const diagnostic = "Operational diagnostic. ".repeat(100);
    const metadata: Work[] = Array.from({ length: 25 }, (_, index) => ({
      ...work[0]!,
      id: `work-${index}`,
      role: index === 11 ? "xean.verifier" : "xean.explorer",
      status: index < 11 ? "queued" : index < 13 ? "active" : "failed",
      input: { targets: body, notes: body, guidance: body },
      result: body,
      error: diagnostic,
    }));
    const bounded = statusReport({
      ...snapshot,
      notes: verificationNotes,
      campaign: {
        ...snapshot.campaign,
        work: metadata,
        error: diagnostic,
        providerCalls: calls.length + 12,
      },
    });
    expect(bounded.work).toEqual({
      queued: 11,
      active: 2,
      completed: 0,
      failed: 12,
      cancelled: 0,
    });
    expect(bounded.activity.items.map(({ id }) => id)).toEqual([
      "work-11",
      "work-12",
      ...Array.from({ length: 8 }, (_, index) => `work-${index}`),
    ]);
    expect(bounded.activity.omitted).toBe(3);
    expect(bounded.activity.items[0]).toEqual({
      id: "work-11",
      role: "xean.verifier",
      status: "active",
      attempts: 1,
    });
    expect(bounded.failures.items.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `work-${24 - index}`),
    );
    expect(bounded.failures.omitted).toBe(2);
    expect(bounded.error).toBe(diagnostic.slice(0, 499) + "…");
    expect(
      bounded.failures.items.every(({ error }) => error === bounded.error),
    ).toBe(true);
    expect(bounded.calls.byModel).toHaveLength(10);
    expect(bounded.calls).toMatchObject({
      admitted: 17,
      settled: 15,
      unknownUsage: 2,
      unsettled: 2,
      byModelOmitted: 4,
    });
    expect(JSON.stringify(bounded)).not.toContain(body);
    expect(JSON.stringify(bounded)).not.toContain("Independent proof.");
    expect(JSON.stringify(bounded).length).toBeLessThan(15_000);
  } finally {
    await engine.close();
  }
});
