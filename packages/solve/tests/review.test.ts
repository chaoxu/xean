import { afterEach, expect, test } from "bun:test";
import { openReader } from "xean";

import { review, reviewVerdict } from "../review";
import { sourceVerdictsFor } from "../roles";
import { codexStdout } from "./fixtures/codex-stdout";
import type { CodexRequest } from "../source";
import { campaignPath, cleanupCampaigns } from "./harness";

afterEach(cleanupCampaigns);
const input = () => ({
  task: {
    problem: "Classify global edge-bicut.",
    completionCriteria: "Prove the classification.",
  },
  argument:
    "Supporting theorem: Global-BiCut is UGC-hard, citing Global and fixed-terminal cuts in digraphs. The final claim follows by identity reduction.",
  profile: {
    provider: "codex" as const,
    model: "gpt-6-astra",
    reasoning: "xhigh" as const,
  },
  campaignPath: campaignPath(),
});
const claim = "Global-BiCut is UGC-hard.";
const evidence = {
  result: claim,
  source: "Global and fixed-terminal cuts in digraphs, Section 1.1",
  url: "https://arxiv.org/html/1612.00156v2",
  quote: "we do not have a hardness result",
};

test("the source gate rejects an unsupported PASS and retains explicit uncertainty", () => {
  const schema = sourceVerdictsFor(["n24"]);
  const value = {
    note: "n24",
    verdict: "PASS",
    report: "From my knowledge of the cited result.",
    externalResults: [claim],
    sources: [],
  };
  expect(schema.safeParse({ verdicts: [value] }).success).toBe(false);
  expect(
    schema.safeParse({ verdicts: [{ ...value, verdict: "INCONCLUSIVE" }] })
      .success,
  ).toBe(true);
  expect(
    schema.safeParse({
      verdicts: [
        {
          ...value,
          sources: [{ ...evidence, result: "Fixed-terminal BiCut is hard." }],
        },
      ],
    }).success,
  ).toBe(false);
});

test.each(["PASS", "FAIL", "INCONCLUSIVE"])(
  "source evidence cannot name an undeclared result for %s",
  (verdict) => {
    const schema = sourceVerdictsFor(["n24"]);
    const value = {
      note: "n24",
      verdict,
      report: "Source assessment.",
      externalResults: [],
      sources: [evidence],
    };
    expect(schema.safeParse({ verdicts: [value] }).success).toBe(false);
    expect(
      reviewVerdict.safeParse({
        verdict,
        report: value.report,
        externalResults: [],
        sources: [evidence],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ verdicts: [{ ...value, externalResults: [claim] }] })
        .success,
    ).toBe(true);
  },
);

test("a full audit receives the entire argument and reuses only the exact completed review", async () => {
  const request = input();
  let calls = 0;
  const dependencies = {
    codex: async (value: CodexRequest) => {
      calls++;
      expect(value.search).toBe(true);
      expect(JSON.parse(value.prompt)).toEqual({
        task: request.task,
        argument: request.argument,
      });
      expect(value.developerInstructions).toContain(
        "Notes in this packet are all under review",
      );
      expect(value.developerInstructions).toContain(
        "Open and read the cited paper",
      );
      return {
        state: "succeeded" as const,
        codexVersion: "fixture",
        stdout: codexStdout({
          verdict: "FAIL",
          report: "The paper leaves global edge-bicut hardness open.",
          externalResults: [claim],
          sources: [evidence],
        }),
        stderr: "",
      };
    },
  };
  const result = await review(request, dependencies);
  expect(result.verdict).toBe("FAIL");
  expect(result.report).toContain(evidence.quote);
  expect(await review(request, dependencies)).toEqual(result);
  expect(calls).toBe(1);
  await expect(
    review(
      { ...request, argument: request.argument + " Changed." },
      dependencies,
    ),
  ).rejects.toThrow("disagree with the journal");
  expect(calls).toBe(1);
  const reader = openReader(request.campaignPath);
  try {
    expect(reader.records({ kinds: ["call"] })).toHaveLength(1);
    expect(reader.records({ kinds: ["call-result"] })).toHaveLength(1);
  } finally {
    reader.close();
  }
});

test("a full audit cannot claim source inspection without a web call", async () => {
  await expect(
    review(input(), {
      codex: async () => ({
        state: "succeeded",
        codexVersion: "fixture",
        stdout: codexStdout(
          {
            verdict: "FAIL",
            report: "Contradictory source.",
            externalResults: [claim],
            sources: [evidence],
          },
          false,
        ),
        stderr: "",
      }),
    }),
  ).rejects.toThrow("without using web search");
});

test("the final review also refuses PASS when a declared external theorem lacks a passage", () => {
  expect(
    reviewVerdict.safeParse({
      verdict: "PASS",
      report: "Seems known.",
      externalResults: [claim],
      sources: [],
    }).success,
  ).toBe(false);
});

test("an explicit retry preserves a malformed response and completes a fresh audit", async () => {
  const request = input();
  let calls = 0;
  await expect(
    review(request, {
      codex: async () => {
        calls++;
        return {
          state: "succeeded",
          codexVersion: "fixture",
          stdout: "invalid JSON",
          stderr: "",
        };
      },
    }),
  ).rejects.toThrow();
  const dependencies = {
    codex: async () => {
      calls++;
      return {
        state: "succeeded" as const,
        codexVersion: "fixture",
        stdout: codexStdout({
          verdict: "FAIL",
          report: "Citation mismatch.",
          externalResults: [claim],
          sources: [evidence],
        }),
        stderr: "",
      };
    },
  };
  const result = await review(request, dependencies);
  expect(result.verdict).toBe("FAIL");
  expect(await review(request, dependencies)).toEqual(result);
  expect(calls).toBe(2);
});
