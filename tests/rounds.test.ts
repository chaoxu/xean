import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import { createSolver } from "../packages/core/src/solve/index.ts";
import { limitRounds, resumeExperiment } from "../scripts/bounded-solve.ts";

const model = {
  provider: "fixture",
  id: "fixture",
  api: "openai-responses" as const,
};

test("an increased total resumes only additional rounds and preserves prior work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-rounds-"));
  const database = join(directory, "campaign.sqlite");
  const task = { problem: "Fixture", completionCriteria: "Complete proof" };
  const setup = (roundLimit: number) => {
    const solver = createSolver(task, () => {
      throw new Error("Round accounting needs no models");
    });
    solver.functions.coordinator = async (input, execution) => {
      expect(input).not.toHaveProperty("rounds");
      expect(input).not.toHaveProperty("allowance");
      expect(JSON.stringify(input)).not.toContain("bounded-continue-");
      const call = await execution.recorder.begin(model);
      await call.recordRequest({ role: "coordinator" });
      await call.settle(fauxAssistantMessage("Continue"), {
        input: 1,
        output: 1,
        totalTokens: 2,
      });
      return {
        work: [{ kind: "explorer", guidance: "Continue" }],
      };
    };
    solver.functions.explorer = async (_input, execution) => {
      const call = await execution.recorder.begin(model);
      await call.recordRequest({ role: "explorer" });
      await call.settle(fauxAssistantMessage("Partial work"), {
        input: 1,
        output: 1,
        totalTokens: 2,
      });
      return {
        kind: "notes",
        candidate: false,
        notes: [
          {
            id: "n1",
            text: "Partial work",
            summary: "Partial",
            detailedSummary: "Partial work remains incomplete.",
            support: [],
          },
        ],
      };
    };
    return { solver, rounds: limitRounds(solver, directory, roundLimit) };
  };
  let engine: Xean | undefined;
  try {
    const first = setup(2);
    engine = await Xean.open(await openXeanStorage(database), first.solver);
    await engine.run();
    const paused = await engine.pause();
    expect(first.rounds()).toBe(2);
    expect(paused.providerCalls).toBeGreaterThan(first.rounds());
    expect(paused.work).toHaveLength(2);
    const lastMarker = await readFile(join(directory, "round-2.json"), "utf8");
    await engine.close();

    const continuation = setup(4);
    engine = await Xean.open(
      await openXeanStorage(database),
      continuation.solver,
    );
    expect(await engine.run()).toEqual(paused);
    const resumed = await resumeExperiment(engine, 4);
    expect(continuation.rounds()).toBe(4);
    expect(resumed.work).toHaveLength(4);
    expect(resumed.work.slice(0, 2)).toEqual(paused.work);
    expect(resumed.providerCalls).toBeGreaterThan(paused.providerCalls);
    expect(await readFile(join(directory, "round-2.json"), "utf8")).toBe(
      lastMarker,
    );
    const finished = await engine.pause();
    await engine.close();

    const repeated = setup(4);
    engine = await Xean.open(await openXeanStorage(database), repeated.solver);
    expect(repeated.rounds()).toBe(4);
    expect(await engine.run()).toEqual(finished);
    const retried = await resumeExperiment(engine, 4);
    expect(retried.work).toHaveLength(4);
    expect(retried.inputs).toEqual(finished.inputs);
    expect(repeated.rounds()).toBe(4);
    expect(retried.providerCalls).toBe(resumed.providerCalls);
    const cancelled = await engine.cancel();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.providerCalls).toBe(retried.providerCalls);
    await expect(engine.resume()).rejects.toThrow(
      "Cannot resume a cancelled campaign",
    );
    expect(() => setup(2)).toThrow("exceeded its round limit");
  } finally {
    await engine?.close();
    await rm(directory, { recursive: true });
  }
});
