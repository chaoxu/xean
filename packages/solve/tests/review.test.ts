import { afterEach, expect, test } from "bun:test";
import { openCampaign, openReader } from "xean";

import { review, reviewVerdict } from "../review";
import { codexStdout } from "./fixtures/codex-stdout";
import { storeCodexResult, type CodexRequest } from "../source";
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
    model: "gpt-6-astra",
    reasoning: "xhigh" as const,
  },
  campaignPath: campaignPath(),
});
const claim = "Global-BiCut is UGC-hard.";
const passage = {
  source: "Global and fixed-terminal cuts in digraphs, Section 1.1",
  url: "https://arxiv.org/html/1612.00156v2",
  quote: "we do not have a hardness result",
};
const evidence = { result: claim, ...passage };
const externalResult = { result: claim, sources: [passage] };

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
      return {
        state: "succeeded" as const,
        codexVersion: "fixture",
        stdout: codexStdout({
          verdict: "FAIL",
          report: "The paper leaves global edge-bicut hardness open.",
          externalResults: [externalResult],
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
  ).rejects.toThrow("configuration disagrees");
  expect(calls).toBe(1);
  const reader = openReader(request.campaignPath);
  try {
    expect(reader.record(1)).toMatchObject({ config: { schemaVersion: 3 } });
    expect(reader.records({ kinds: ["call"] })).toHaveLength(1);
    expect(reader.records({ kinds: ["call-result"] })).toHaveLength(1);
  } finally {
    reader.close();
  }
});

test.each(["request", "role"])(
  "review rejects a completed call with a different %s before reusing its verdict",
  async (mismatch) => {
    const request = input();
    let frozen: CodexRequest | undefined;
    let calls = 0;
    await expect(
      review(request, {
        codex: async (value) => {
          calls++;
          frozen = value;
          return {
            state: "succeeded",
            codexVersion: "fixture",
            stdout: "invalid JSON",
            stderr: "",
          };
        },
      }),
    ).rejects.toThrow();
    if (frozen === undefined)
      throw new Error("review request was not recorded");
    const campaign = openCampaign(request.campaignPath);
    try {
      await campaign.call(
        {
          label: "xean-solve/review",
          role: mismatch === "role" ? "explorer" : "verifier",
          request:
            mismatch === "request"
              ? { ...frozen, prompt: "A different task and argument." }
              : frozen,
        },
        async () =>
          storeCodexResult(campaign, {
            state: "succeeded",
            codexVersion: "fixture",
            stdout: codexStdout(
              {
                verdict: "PASS",
                report: "A different audit.",
                externalResults: [],
              },
              false,
            ),
            stderr: "",
          }),
      );
    } finally {
      campaign.close();
    }
    await expect(
      review(request, {
        codex: async () => {
          calls++;
          throw new Error("must reject without another model call");
        },
      }),
    ).rejects.toThrow(
      mismatch === "request" ? "review request differs" : "does not belong",
    );
    expect(calls).toBe(1);
  },
);

test.each(["uninspected passage", "malformed JSON"])(
  "review retries a rejected %s without reusing it",
  async (failure) => {
    const request = input();
    let calls = 0;
    const dependencies = {
      codex: async () => ({
        state: "succeeded" as const,
        codexVersion: "fixture",
        stdout:
          ++calls === 1
            ? failure === "malformed JSON"
              ? "invalid JSON"
              : codexStdout(
                  {
                    verdict: "FAIL",
                    report: "Contradictory source.",
                    externalResults: [externalResult],
                  },
                  false,
                )
            : codexStdout({
                verdict: "FAIL",
                report: "Checked contradictory source.",
                externalResults: [externalResult],
              }),
        stderr: "",
      }),
    };
    await expect(review(request, dependencies)).rejects.toThrow(
      failure === "malformed JSON" ? "JSON" : "without using web search",
    );
    const result = await review(request, dependencies);
    expect(result.report).toContain("Checked contradictory source.");
    expect(await review(request, dependencies)).toEqual(result);
    expect(calls).toBe(2);
  },
);

test.each(["PASS", "FAIL", "INCONCLUSIVE"])(
  "the final review requires passages for PASS while retaining %s uncertainty",
  (verdict) => {
    expect(
      reviewVerdict.safeParse({
        verdict,
        report: "Seems known.",
        externalResults: [{ result: claim, sources: [] }],
      }).success,
    ).toBe(verdict !== "PASS");
  },
);
