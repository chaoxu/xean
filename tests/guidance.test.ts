import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Xean, openXeanStorage, type CampaignView, type EntryId } from "xean";
import {
  createSolver,
  project,
  submitCommand,
  type ExplorerInput,
} from "xean/solve";

test("guidance changes the next assignment while interrupted Explorer inputs stay frozen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-guidance-"));
  const path = join(directory, "campaign.sqlite");
  const task = {
    problem: "Prove the sum of squares formula",
    completionCriteria: "For every nonnegative integer",
  };
  const initial = "Try induction.\n";
  const later = "Try telescoping instead.\n";
  const started = Promise.withResolvers<void>();
  const received: ExplorerInput[] = [];
  const plans: string[][] = [];
  const solver = createSolver(task, () => {
    throw new Error("No model calls in this regression");
  });
  solver.functions.coordinator = async ({ guidance }) => {
    plans.push(guidance);
    return {
      work:
        received.length < 3
          ? [{ kind: "explorer", guidance: guidance.at(-1)! }]
          : [],
    };
  };
  solver.functions.explorer = async (input, _execution, context) => {
    received.push(structuredClone(input));
    if (received.length === 1) {
      started.resolve();
      await new Promise<void>((done) =>
        context.abortSignal!.addEventListener("abort", () => done(), {
          once: true,
        }),
      );
      expect(input).toEqual(received[0]!);
      context.abortSignal!.throwIfAborted();
    }
    return { kind: "notes", candidate: false, notes: [] };
  };
  const options = { ...solver, limits: { concurrency: 1, attempts: 2 } };
  let engine = await Xean.open(await openXeanStorage(path), options);
  try {
    await submitCommand(engine, {
      kind: "guide",
      id: "initial",
      text: initial,
    });
    const running = engine.run();
    await started.promise;
    await submitCommand(engine, { kind: "guide", id: "later", text: later });
    expect(received[0]!.guidance).toBe(initial);
    await engine.close();
    await running;
    engine = await Xean.open(await openXeanStorage(path), options);
    const result = await engine.run();
    expect(received.map(({ guidance }) => guidance)).toEqual([
      initial,
      initial,
      later,
    ]);
    for (const input of received) expect(input.task).toEqual(task);
    expect(plans[0]).toEqual([initial]);
    expect(plans.at(-1)).toEqual([initial, later]);
    expect(result.work.map(({ attempts }) => attempts)).toEqual([2, 1]);
    expect(result.inputs.map(({ value }) => value)).toEqual([
      { kind: "guide", id: "initial", text: initial },
      { kind: "guide", id: "later", text: later },
    ]);
    const workers = (await engine.records()).filter(
      (entry) =>
        entry.kind === "xean.attempt.started" &&
        result.work.some((work) => work.taskId === entry.byTaskId),
    );
    expect(
      await Promise.all(
        workers.map(async (entry) => {
          const request = (await engine.attemptInput(entry.id)) as {
            view: EntryId;
            guidance: string;
          };
          const frozen = (await engine.attemptInput(request.view)) as {
            view: CampaignView;
          };
          return {
            task,
            notes: project(frozen.view),
            guidance: request.guidance,
          };
        }),
      ),
    ).toEqual(received);
  } finally {
    await engine.close();
    await rm(directory, { recursive: true });
  }
});
