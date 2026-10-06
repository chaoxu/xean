import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, Tx } from "@earendil-works/pi-durable";
import { open, readReport, readSettings, type Roles } from "../src/index.ts";
import { scanTasks, type WorkerInput } from "../src/workflow.ts";
import { verifyInstall } from "./dependencies.ts";
import { serveControl } from "../apps/cli/control.ts";
import { controlCommand, ownerReceipt } from "../apps/cli/lifecycle.ts";

export async function readRounds(tx: Tx, root: ConversationId) {
  const rounds: EntryId[] = [];
  for (const task of await scanTasks(tx, root, "research.worker")) {
    const input = task.input as WorkerInput;
    if ("at" in input) rounds.push(input.at);
  }
  return rounds;
}

/** Each admitted worker counts once, outside role inputs. */
export function limitRounds(roles: Pick<Roles, "coordinator">, limit = 20) {
  assert.ok(Number.isSafeInteger(limit) && limit >= 0, "Invalid round limit");
  const plan = roles.coordinator;
  roles.coordinator = async (...args) => {
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
  await verifyInstall();
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
    roles: (builtins) => {
      const roles = { coordinator: builtins.coordinator };
      limitRounds(roles, roundLimit);
      return roles;
    },
  });
  const observe = () =>
    owner.root.commit(
      async (tx) => ({
        report: await readReport(tx, owner.root.id),
        rounds: (await readRounds(tx, owner.root.id)).length,
      }),
      BACKGROUND_CONTEXT,
    );
  let control: Awaited<ReturnType<typeof serveControl>> | undefined;
  let shutdown: Promise<unknown> | undefined;
  const interrupt = () => {
    shutdown ??= Promise.all([control?.close(true), owner.close()]);
    void shutdown.catch(() => {});
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    control = await serveControl(await realpath(database), (command) =>
      controlCommand(owner, command),
    );
    if (values.resume) await controlCommand(owner, { kind: "resume" });
    else await owner.root.waitForIdle(BACKGROUND_CONTEXT);
    await control.close();
    if (!shutdown) {
      let { report, rounds } = await observe();
      const hitRoundLimit =
        rounds === roundLimit && report.status.status === "running";
      if (hitRoundLimit) {
        await controlCommand(owner, { kind: "pause" });
        ({ report, rounds } = await observe());
      }
      const result = {
        ...ownerReceipt(report),
        outcome:
          report.status.status === "completed"
            ? "accepted"
            : hitRoundLimit
              ? "round_limit"
              : report.status.status,
        roundLimit,
        rounds,
      };
      await Bun.write(
        resolve(directory, "result.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(JSON.stringify(result));
    } else process.exitCode = 130;
  } catch (error) {
    if (!shutdown) throw error;
    process.exitCode = 130;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await control?.close(true);
    await shutdown;
    await owner.close();
  }
}
