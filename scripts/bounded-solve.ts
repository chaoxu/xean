import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Xean, openXeanStorage, type XeanOptions } from "xean";
import { chatGptWebProviderId } from "xean/pi";
import { ownerReceipt, serveControl } from "xean-cli/control";
import { verifyInstall } from "./dependencies.ts";
import {
  createSolver,
  codexResearch,
  declarationVersion,
  piRuntime,
  readSettings,
  decode,
  taskSchema,
  submitCommand,
  type Research,
} from "xean/solve";

/** Correctness checks task-permitted background; unresolved premises stay blocked. */
export const offlineResearch: Research = {
  retrieval: false,
  async source({ notes }) {
    return notes.map(({ id, premises }) => ({
      noteId: id,
      result: premises.length
        ? {
            verdict: "INCONCLUSIVE" as const,
            report:
              "Source retrieval is disabled. These premises remain unresolved under the task's proof rules. Prove them in notes before relying on them.",
          }
        : {
            verdict: "PASS" as const,
            report:
              "Correctness left no unresolved external premise under the task's proof rules.",
          },
    }));
  },
  async literature() {
    throw new Error(
      "Literature retrieval is disabled for this closed-book run",
    );
  },
  async review() {
    throw new Error("Online review is disabled for this closed-book run");
  },
};

/** This experiment counts planning invocations, including interrupted ones. */
export function limitRounds(
  solver: ReturnType<typeof createSolver>,
  directory: string,
  roundLimit = 20,
) {
  assert.ok(
    Number.isSafeInteger(roundLimit) && roundLimit >= 0,
    "Invalid round limit",
  );
  const plan = solver.functions.coordinator;
  let rounds = 0;
  while (existsSync(resolve(directory, `round-${rounds + 1}.json`))) rounds++;
  assert.ok(rounds <= roundLimit, "Experiment exceeded its round limit");
  solver.functions.coordinator = async (...args) => {
    if (rounds === roundLimit) return { work: [] };
    const marker = {
      round: rounds + 1,
      attemptId: args[1].attemptId,
      startedAt: new Date().toISOString(),
    };
    await writeFile(
      resolve(directory, `round-${rounds + 1}.json`),
      JSON.stringify(marker) + "\n",
      { flag: "wx", flush: true },
    );
    rounds++;
    console.log(JSON.stringify(marker));
    return plan(...args);
  };
  return () => rounds;
}

/** Resume a campaign while the outer runner retains its round limit. */
export async function resumeExperiment(engine: Xean, roundLimit: number) {
  if ((await engine.inspect()).status === "blocked") return engine.resume();
  await submitCommand(engine, {
    kind: "guide",
    id: `bounded-continue-${roundLimit}`,
    text: "Continue the exact task using the recorded mathematical notes and verification feedback.",
  });
  return engine.resume();
}

if (import.meta.main) {
  await verifyInstall(resolve(import.meta.dir, ".."));
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      offline: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      "round-limit": { type: "string", default: "20" },
    },
  });
  const offline = values.offline;
  const roundLimit = Number(values["round-limit"]);
  assert.ok(
    positionals.length === 1,
    "Usage: scripts/bounded-solve.ts RUN_DIRECTORY [--offline] [--round-limit TOTAL] [--resume]",
  );
  const directory = resolve(positionals[0]!);
  const task = decode(
    taskSchema,
    await Bun.file(resolve(directory, "task.json")).json(),
  );
  const settings = readSettings(
    await Bun.file(resolve(directory, "settings.json")).json(),
  );
  if (offline) {
    assert.notEqual(settings.literature, true);
    assert.equal(
      settings.codex,
      undefined,
      "Codex worker cannot enforce closed-book execution",
    );
    assert.notEqual(
      settings.profiles.explorer?.provider,
      chatGptWebProviderId,
      "ChatGPT Web cannot enforce closed-book execution",
    );
  }
  const solver = createSolver(
    task,
    () => piRuntime(settings),
    settings,
    offline
      ? offlineResearch
      : codexResearch(settings.research, settings.usagePrefix),
  );
  const rounds = limitRounds(solver, directory, roundLimit);
  const options: XeanOptions = {
    ...solver,
    // A separate kind prevents the online CLI from resuming this experiment.
    task: {
      kind: offline ? "xean.solve.offline" : "xean.solve",
      version: declarationVersion,
      task,
      settings,
    },
    limits: settings.limits,
  };
  const database = resolve(directory, "campaign.sqlite");
  const storage = await openXeanStorage(database);
  const engine = await Xean.open(storage, options);
  let control: Awaited<ReturnType<typeof serveControl>> | undefined;
  let shutdown: Promise<unknown> | undefined;
  const interrupt = () => {
    shutdown ??= Promise.all([control?.close(true), engine.close()]);
    void shutdown.catch(() => {});
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const heartbeat = setInterval(() => {
    void engine
      .inspect()
      .then((view) =>
        console.log(
          JSON.stringify({
            status: view.status,
            rounds: rounds(),
            calls: view.providerCalls,
            active: view.work
              .filter((work) => work.status === "active")
              .map((work) => ({ id: work.id, role: work.role })),
          }),
        ),
      )
      .catch(() => {});
  }, 30_000);
  const write = (name: string, value: unknown) =>
    Bun.write(resolve(directory, name), JSON.stringify(value, null, 2) + "\n");
  try {
    control = await serveControl(await realpath(database), engine);
    if (values.resume) await resumeExperiment(engine, roundLimit);
    else await engine.run();
    await control.close();
    if (shutdown) process.exitCode = 130;
    else {
      let campaign = await engine.inspect();
      const hitRoundLimit =
        rounds() === roundLimit && campaign.status === "running";
      if (hitRoundLimit) {
        await engine.pause();
        campaign = await engine.inspect();
      }
      clearInterval(heartbeat);
      const result = {
        ...ownerReceipt(campaign),
        outcome:
          campaign.status === "completed"
            ? "accepted"
            : hitRoundLimit
              ? "round_limit"
              : campaign.status,
        roundLimit,
        rounds: rounds(),
      };
      await write("result.json", result);
      console.log(JSON.stringify(result));
    }
  } finally {
    clearInterval(heartbeat);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await control?.close(true);
    await shutdown;
    await engine.close();
  }
}
