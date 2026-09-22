import { afterEach, expect, test } from "bun:test";
import { openCampaign, openReader } from "xean";

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

test.each([{ provider: "codex" }, { search: true }, { search: false }])(
  "review rejects removed profile fields before setup: %j",
  async (removed) => {
    const request = input();
    await expect(
      review(
        { ...request, profile: { ...request.profile, ...removed } },
        {
          codex: async () => {
            throw new Error("must reject before Codex setup");
          },
        },
      ),
    ).rejects.toThrow("Unrecognized key");
    expect(await Bun.file(request.campaignPath).exists()).toBe(false);
  },
);

test("the source gate rejects an unsupported PASS and retains explicit uncertainty", () => {
  const schema = sourceVerdictsFor(
    ["n24"],
    [{ note: "n24", externalResults: [claim] }],
  );
  const value = {
    note: "n24",
    verdict: "PASS",
    report: "From my knowledge of the cited result.",
    correctedText: null,
    sources: [],
  };
  expect(schema.safeParse({ verdicts: [value] }).success).toBe(false);
  expect(
    schema.safeParse({ verdicts: [{ ...value, verdict: "INCONCLUSIVE" }] })
      .success,
  ).toBe(true);
  // A runtime passage binds by resultId; one without it is rejected.
  expect(
    schema.safeParse({ verdicts: [{ ...value, sources: [evidence] }] }).success,
  ).toBe(false);
  expect(
    schema.safeParse({
      verdicts: [
        {
          ...value,
          sources: [
            {
              ...evidence,
              result: "Global-BiCut is hard, with harmless restatement.",
              resultId: "n24#1",
            },
          ],
        },
      ],
    }).success,
  ).toBe(true);
});

test.each(["PASS", "FAIL", "INCONCLUSIVE"])(
  "source evidence cannot name an undeclared result for %s",
  (verdict) => {
    const schema = sourceVerdictsFor(
      ["n24"],
      [{ note: "n24", externalResults: [claim] }],
    );
    const value = {
      note: "n24",
      verdict,
      report: "Source assessment.",
      correctedText: null,
      sources: [{ ...evidence, resultId: "n24#2" }],
    };
    expect(schema.safeParse({ verdicts: [value] }).success).toBe(false);
    expect(
      schema.safeParse({
        verdicts: [
          {
            ...value,
            sources: [{ ...evidence, resultId: "n24#1" }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      reviewVerdict.safeParse({
        verdict,
        report: value.report,
        externalResults: [],
        sources: [evidence],
      }).success,
    ).toBe(false);
    expect(
      reviewVerdict.safeParse({
        verdict,
        report: value.report,
        externalResults: [
          {
            result: claim,
            sources: [{ ...passage, resultId: "external-arbitrary" }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      reviewVerdict.safeParse({
        verdict,
        report: value.report,
        externalResults: [externalResult],
      }).success,
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
      expect(value.developerInstructions).not.toContain(
        "must name a support note",
      );
      expect(value.developerInstructions).toContain(
        "a verified external theorem may be cited directly",
      );
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
  ).rejects.toThrow("disagree with the journal");
  expect(calls).toBe(1);
  const reader = openReader(request.campaignPath);
  try {
    expect(reader.record(1)).toMatchObject({ config: { schemaVersion: 2 } });
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
        async () => ({
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
    ).rejects.toThrow("does not match the declared review request and role");
    expect(calls).toBe(1);
  },
);

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
            externalResults: [externalResult],
          },
          false,
        ),
        stderr: "",
      }),
    }),
  ).rejects.toThrow("without using web search");
});

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
          externalResults: [externalResult],
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
