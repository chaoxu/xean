import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  decode,
  sourceSchema,
  type SourceEvidence,
} from "../src/math/contracts.ts";
import { codexResearch } from "../src/roles/research.ts";
import type { RoleRuntime } from "../src/roles/types.ts";

const task = {
  problem: "Prove the claim.",
  completionCriteria: "Exact proof.",
};
const runtime = {} as RoleRuntime;
const note = (id: string, premises: string[]) => ({
  id,
  premises,
});
const judgment = (
  noteId: string,
  verdict = "PASS",
  passages: unknown[] = [],
) => ({
  noteId,
  verdict,
  passages,
  report: `Judgment ${noteId}`,
});

test("one exact fact judgment maps to every local premise without rebinding evidence", async () => {
  const shared = "Shared theorem.";
  const distinct = `${shared} `;
  const evidence: SourceEvidence = {
    id: "earlier/0",
    statement: "Original broader theorem.",
    url: "https://example.org/original",
    quote: "Inspected original quotation.",
  };
  const notes = [
    note("a", [shared, distinct, shared]),
    note("b", [shared, "Unsettled theorem."]),
    note("c", [shared, "False theorem.", "Unsettled theorem."]),
    note("d", []),
    note("e", ["Unsupported PASS."]),
  ];
  let calls = 0;
  const research = codexResearch(
    async (_mode, schema, _instructions, input) => {
      calls++;
      expect(input).toEqual({
        task,
        evidence: [evidence],
        facts: [
          { id: "f1", statement: shared },
          { id: "f2", statement: distinct },
          { id: "f3", statement: "Unsettled theorem." },
          { id: "f4", statement: "False theorem." },
          { id: "f5", statement: "Unsupported PASS." },
        ],
      });
      return {
        operationId: "op",
        searches: 1,
        reportedAt: "2026-10-05T00:00:00Z",
        value: decode(schema, {
          results: [
            judgment("f4", "FAIL"),
            judgment("f2", "PASS", [
              {
                premise: 0,
                url: "https://example.org/new",
                quote: "Fresh quotation.",
              },
            ]),
            judgment("f1", "PASS", [{ premise: 0, passageId: evidence.id }]),
            judgment("f5", "PASS", [{ premise: 0, passageId: "missing" }]),
            judgment("f3", "INCONCLUSIVE"),
          ],
        }),
      };
    },
  );
  const results = await research.source(
    { task, notes, evidence: [evidence] },
    runtime,
    context,
  );
  expect(() =>
    decode(sourceSchema, {
      verdict: "PASS",
      report: "Checked",
      passages: [],
      correction: { statement: "Repaired frozen claim" },
    }),
  ).toThrow();
  expect(calls).toBe(1);
  expect(results.map(({ noteId, verdict }) => [noteId, verdict])).toEqual([
    ["a", "PASS"],
    ["b", "INCONCLUSIVE"],
    ["c", "FAIL"],
    ["d", "PASS"],
    ["e", "INCONCLUSIVE"],
  ]);
  expect(results[0]).toMatchObject({
    kind: "codex-report",
    operationId: "op",
    reportedAt: "2026-10-05T00:00:00Z",
    premises: [shared, distinct, shared],
    passages: [
      { ...evidence, premise: 0 },
      {
        id: "op/f2/0",
        statement: distinct,
        premise: 1,
        url: "https://example.org/new",
        quote: "Fresh quotation.",
      },
      { ...evidence, premise: 2 },
    ],
  });
  expect(results[1]).toMatchObject({
    premises: [shared, "Unsettled theorem."],
    passages: [{ ...evidence, premise: 0 }],
  });
  expect(results.every((result) => !("correction" in result))).toBe(true);
  expect(results[4]!.report).toContain("lacked valid task or source evidence");
});

test("source batches reject missing, duplicate, or unexpected fact judgments", async () => {
  for (const ids of [["f1"], ["f1", "f1"], ["f1", "other"]]) {
    const research = codexResearch(async (_mode, schema) => ({
      operationId: "op",
      searches: 0,
      reportedAt: "2026-10-05T00:00:00Z",
      value: decode(schema, { results: ids.map((id) => judgment(id)) }),
    }));
    await expect(
      research.source(
        { task, notes: [note("a", ["A", "B"])] },
        runtime,
        context,
      ),
    ).rejects.toThrow("exactly one result");
  }
});

test("self-contained notes need no source invocation", async () => {
  const research = codexResearch(async () => {
    throw new Error("Unexpected Codex call");
  });
  expect(
    await research.source({ task, notes: [note("a", [])] }, runtime, context),
  ).toMatchObject([{ noteId: "a", verdict: "PASS" }]);
});
