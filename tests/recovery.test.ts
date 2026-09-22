import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { openReader } from "../src";
import type { Entry } from "../src";
import {
  countingModel,
  deriveNextAction,
  resumeCampaign,
  runSession,
  startCampaign,
} from "./fixtures/recovery-app";

const directories: string[] = [];

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xean-recovery-"));
  directories.push(directory);
  return join(directory, "campaign.db");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

function projection(records: readonly Entry[]): readonly string[] {
  return records.map((entry) =>
    entry.kind === "call" ? `call:${entry.label}` : entry.kind,
  );
}

function verifiedProjection(path: string): readonly string[] {
  const reader = openReader(path);
  try {
    const records = reader.records();
    expect(deriveNextAction(records)).toEqual({ kind: "done" });
    return projection(records);
  } finally {
    reader.close();
  }
}

// The reference happy path performs seven coordinator actions, four of which
// are model calls: two explorations and two verifications.
const HAPPY_PATH_ACTIONS = 7;
const HAPPY_PATH_MODEL_CALLS = 4;

describe("campaign recovery", () => {
  describe("phase-boundary recovery", () => {
    let expected: readonly string[];
    beforeAll(async () => {
      const reference = temporaryPath();
      const referenceModel = countingModel();
      const complete = await runSession(
        startCampaign(reference),
        referenceModel,
      );
      expect(complete.interrupted).toBe(false);
      expect(complete.actions).toHaveLength(HAPPY_PATH_ACTIONS);
      expect(referenceModel.calls).toBe(HAPPY_PATH_MODEL_CALLS);
      expected = verifiedProjection(reference);
    });

    // Each independent durable-write scenario gets its own timeout and
    // cleanup instead of sharing five seconds across the entire matrix.
    test.each(
      Array.from({ length: HAPPY_PATH_ACTIONS + 1 }, (_, budget) => budget),
    )(
      "resumes after %i actions without losing or repeating work",
      async (budget) => {
        const path = temporaryPath();
        const first = countingModel();
        const interrupted = await runSession(
          startCampaign(path),
          first,
          budget,
        );
        expect(interrupted.interrupted).toBe(budget < HAPPY_PATH_ACTIONS);
        expect(interrupted.actions).toHaveLength(budget);

        const second = countingModel();
        const resumed = await runSession(resumeCampaign(path), second);
        expect(resumed.interrupted).toBe(false);

        // Committed work must not disappear or repeat: the two sessions
        // together perform exactly the reference work, and the journal is
        // record-for-record the reference journal.
        expect(first.calls + second.calls).toBe(HAPPY_PATH_MODEL_CALLS);
        expect(resumed.actions).toHaveLength(HAPPY_PATH_ACTIONS - budget);
        expect(verifiedProjection(path)).toEqual(expected);

        // Resume after the last required PASS must make no model call and
        // append nothing.
        const third = countingModel();
        const settled = await runSession(resumeCampaign(path), third);
        expect(settled).toMatchObject({ interrupted: false, actions: [] });
        expect(third.calls).toBe(0);
        expect(verifiedProjection(path)).toEqual(expected);
      },
    );
  });

  test("a repeated evidence for the same call is rejected durably", async () => {
    const path = temporaryPath();
    await runSession(startCampaign(path), countingModel());
    const campaign = resumeCampaign(path);
    try {
      const records = campaign.records();
      const verdict = records.find((entry) => entry.kind === "evidence");
      expect(verdict).toBeDefined();
      const before = records.length;
      // A buggy or racing coordinator that replays a settled verdict must be
      // stopped by the journal itself, not by coordinator discipline.
      expect(() =>
        campaign.recordEvidence(verdict!.call, {
          verdict: "FAIL",
          evidence: "replayed verdict",
        }),
      ).toThrow(/UNIQUE|constraint/i);
      expect(campaign.records()).toHaveLength(before);
    } finally {
      campaign.close();
    }
  });

  test("a torn explorer call resumes as a fresh call without repeating committed rounds", async () => {
    const path = temporaryPath();
    const fixture = resolve("tests/fixtures/crash-explore.ts");
    const child = Bun.spawnSync([process.execPath, fixture, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);

    const torn = openReader(path);
    const tornRecords = torn.records();
    torn.close();
    expect(projection(tornRecords)).toEqual([
      "campaign",
      "call:explore/v1",
      "call-result",
      "call:explore/v1",
    ]);
    expect(deriveNextAction(tornRecords)).toEqual({
      kind: "explore",
      round: 2,
    });

    const model = countingModel();
    const resumed = await runSession(resumeCampaign(path), model);
    expect(resumed.interrupted).toBe(false);
    // Round one is committed and not repeated; round two, the verification opening, and
    // both verifications remain.
    expect(model.calls).toBe(3);

    const records = openReader(path);
    try {
      const all = records.records();
      const explores = all.filter(
        (entry) => entry.kind === "call" && entry.label === "explore/v1",
      );
      expect(explores).toHaveLength(3);
      const unsettled = explores.filter(
        (call) =>
          !all.some(
            (entry) =>
              entry.kind === "call-result" && entry.parent === call.seq,
          ),
      );
      // The interrupted call stays in the journal with an unknown outcome.
      expect(unsettled).toHaveLength(1);
      expect(deriveNextAction(all)).toEqual({ kind: "done" });
    } finally {
      records.close();
    }
  });

  test("a torn verifier call is unresolved even though its tool submission committed", async () => {
    const path = temporaryPath();
    const fixture = resolve("tests/fixtures/crash-verifier.ts");
    const child = Bun.spawnSync([process.execPath, fixture, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);

    const torn = openReader(path);
    const tornRecords = torn.records();
    torn.close();
    expect(projection(tornRecords).slice(-3)).toEqual([
      "call:audit/v1",
      "tool-call",
      "tool-result",
    ]);
    // A durable tool submission inside an unsettled call is an unknown
    // outcome: resume verifies afresh instead of reconciling a verdict.
    expect(deriveNextAction(tornRecords)).toEqual({
      kind: "verify",
      verifier: "audit/v1",
    });

    const model = countingModel();
    const resumed = await runSession(resumeCampaign(path), model);
    expect(resumed.interrupted).toBe(false);
    expect(model.calls).toBe(2);

    const records = openReader(path);
    try {
      const all = records.records();
      const audits = all.filter(
        (entry) => entry.kind === "call" && entry.label === "audit/v1",
      );
      expect(audits).toHaveLength(2);
      const verdicts = all.filter((entry) => entry.kind === "evidence");
      // Exactly one verdict per verifier; the torn call never gains one.
      expect(verdicts).toHaveLength(2);
      const verdictCalls = new Set(verdicts.map((entry) => entry.call));
      const settledAudit = audits.find((call) =>
        all.some(
          (entry) =>
            entry.kind === "call-result" &&
            entry.parent === call.seq &&
            entry.state === "returned",
        ),
      );
      expect(verdictCalls.has(settledAudit!.seq)).toBe(true);
      expect(deriveNextAction(all)).toEqual({ kind: "done" });
    } finally {
      records.close();
    }
  });
});
