import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ConversationId, EntryId, Tx } from "@earendil-works/pi-durable";
import { open, readSettings, type Roles } from "../src/index.ts";
import { scanTasks, type WorkerInput } from "../src/workflow.ts";
import {
  controlCommand,
  observeOwner,
  runOwner,
} from "../apps/cli/lifecycle.ts";

export async function readRounds(tx: Tx, root: ConversationId) {
  const rounds: EntryId[] = [];
  for (const task of await scanTasks(tx, root, "research.worker")) {
    const input = task.input as WorkerInput;
    if ("at" in input) rounds.push(input.at);
  }
  return rounds;
}

/** Each admitted worker counts once, outside role inputs. */
export function limitRounds(plan: Roles["coordinator"], limit = 20) {
  assert.ok(Number.isSafeInteger(limit) && limit >= 0, "Invalid round limit");
  return async (...args: Parameters<Roles["coordinator"]>) => {
    const [, runtime, context] = args;
    let available = false;
    await runtime.commit(async (tx) => {
      const rounds = await readRounds(tx, runtime.conversationId);
      assert.ok(rounds.length <= limit, "Experiment exceeded its round limit");
      available = rounds.length < limit;
    }, context);
    return available ? plan(...args) : { work: null };
  };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      offline: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      "round-limit": { type: "string", default: "20" },
    },
  });
  assert.equal(
    positionals.length,
    1,
    "Usage: scripts/bounded-solve.ts RUN_DIRECTORY [--offline] [--resume] [--round-limit TOTAL]",
  );
  const directory = resolve(positionals[0]!);
  const roundLimit = Number(values["round-limit"]);
  const task = await Bun.file(resolve(directory, "task.json")).json();
  let settings = readSettings(
    await Bun.file(resolve(directory, "settings.json")).json(),
  );
  if (values.offline) {
    assert.notEqual(
      settings.literature,
      true,
      "Closed-book runs cannot enable literature",
    );
    assert.equal(
      settings.codex,
      undefined,
      "Codex implementation cannot enforce closed-book execution",
    );
    assert.equal(
      settings.chatgpt,
      undefined,
      "ChatGPT Web cannot enforce closed-book execution",
    );
    settings = readSettings({ ...settings, research: false });
  }
  const database = resolve(directory, "campaign.sqlite");
  const owner = await open(database, {
    create: { task, settings },
    roles: ({ coordinator }) => ({
      coordinator: limitRounds(coordinator, roundLimit),
    }),
  });
  try {
    await runOwner(
      owner,
      await realpath(database),
      async () => {
        let status = await observeOwner(owner);
        const rounds = Object.values(status.work).reduce(
          (sum, count) => sum + count,
          0,
        );
        const hitRoundLimit = rounds === roundLimit && status.status === "idle";
        if (hitRoundLimit) {
          await controlCommand(owner, { kind: "pause" });
          status = await observeOwner(owner);
        }
        const result = {
          ...status,
          outcome:
            status.status === "completed"
              ? "accepted"
              : hitRoundLimit
                ? "round_limit"
                : status.status,
          roundLimit,
          rounds,
        };
        await Bun.write(
          resolve(directory, "result.json"),
          JSON.stringify(result, null, 2) + "\n",
        );
        console.log(JSON.stringify(result));
      },
      { resume: values.resume },
    );
  } finally {
    await owner.close();
  }
}
