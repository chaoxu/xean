import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getDeclaredTools } from "@earendil-works/pi-ai/utils/transcript";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import { chatGptWebProviderId } from "../packages/core/src/providers/chatgpt-web.ts";
import {
  createSolver,
  decode,
  submitCommand,
} from "../packages/core/src/solve/index.ts";
import { fixtureRuntime, invoke } from "./fixtures/pi.ts";

const task = { problem: "Exact task", completionCriteria: "Complete proof" };
const exploration = { kind: "explorer" as const, guidance: "Continue" };
const reply = (value: unknown) =>
  fauxAssistantMessage([fauxToolCall("submit_result", value as never)], {
    stopReason: "toolUse",
  });

test.each([false, true])(
  "browser availability survives wrapped planners and reopen (declared=%s)",
  async (declared) => {
    const directory = await mkdtemp(join(tmpdir(), "xean-planning-"));
    const path = join(directory, "campaign.sqlite");
    const available: boolean[] = [];
    let explorers = 0;
    let loads = 0;
    const setup = () => {
      const runtime = fixtureRuntime((context, _options, selected) => {
        if (selected.id === "explorer") {
          explorers++;
          if (!declared) throw new Error("Fixture browser failure");
          return reply({ notes: [], candidate: false });
        }
        expect(selected.id).toBe("coordinator");
        const input = JSON.parse(
          String(
            context.messages.find((message) => message.role === "user")!
              .content,
          ),
        );
        const enabled = input.capabilities.explorer;
        available.push(enabled);
        const schema = getDeclaredTools(context.messages).find(
          (tool) => tool.name === "submit_result",
        )!.parameters;
        expect(() =>
          decode(schema, { work: enabled ? [exploration] : [] }),
        ).not.toThrow();
        expect(() =>
          decode(schema, { work: enabled ? [] : [exploration] }),
        ).toThrow();
        return reply({ work: enabled ? [exploration] : [] });
      });
      runtime.profiles.explorer.model.provider = chatGptWebProviderId;
      const solver = createSolver(
        task,
        () => {
          loads++;
          return runtime;
        },
        declared ? { chatGptSingleShot: true } : {},
      );
      const planner = solver.functions.coordinator;
      solver.functions.coordinator = (...args) => planner(...args);
      return solver;
    };
    let engine: Xean | undefined;
    try {
      engine = await Xean.open(await openXeanStorage(path), setup());
      expect(loads).toBe(0);
      const waiting = await engine.run();
      expect(waiting.status).toBe("running");
      expect(waiting.result).toBeNull();
      expect(waiting.work).toHaveLength(1);
      expect(waiting.work[0]!.status).toBe(declared ? "completed" : "failed");
      expect(available).toEqual([true, false]);
      expect(explorers).toBe(1);
      await engine.close();

      engine = await Xean.open(await openXeanStorage(path), setup());
      expect(loads).toBe(1);
      await submitCommand(engine, {
        kind: "guide",
        id: "continue",
        text: "Inspect the remaining work",
      });
      expect(loads).toBe(1);
      expect((await engine.run()).status).toBe("running");
      expect(available).toEqual([true, false, false]);
      expect(explorers).toBe(1);
      await engine.close();

      const replaced = setup();
      replaced.functions.coordinator = async () => ({ work: [exploration] });
      engine = await Xean.open(await openXeanStorage(path), replaced);
      expect(loads).toBe(2);
      await submitCommand(engine, {
        kind: "guide",
        id: "invalid-plan",
        text: "Continue",
      });
      const rejected = await engine.run();
      expect(loads).toBe(3);
      expect(rejected.status).toBe("blocked");
      expect(rejected.error).toContain("Explorer is unavailable");
      expect(rejected.work).toHaveLength(1);
      expect(explorers).toBe(1);
    } finally {
      await engine?.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("API planning requires work while replaced roles preserve lazy runtime and empty handoff", async () => {
  let calls = 0;
  const runtime = fixtureRuntime((context) => {
    calls++;
    const input = JSON.parse(
      String(
        context.messages.find((message) => message.role === "user")!.content,
      ),
    );
    expect(input.capabilities.explorer).toBe(true);
    expect(getDeclaredTools(context.messages).map(({ name }) => name)).toEqual([
      "submit_result",
    ]);
    if (calls === 1) return reply({ work: [] });
    expect(context.messages.at(-1)).toMatchObject({
      role: "toolResult",
      isError: true,
    });
    return reply({ work: [exploration] });
  });
  expect(
    await invoke(createSolver(task, runtime).functions.coordinator, {
      task,
      notes: [],
      guidance: [],
      failures: [],
      literatureUsed: false,
      explorerUsed: true,
    }),
  ).toEqual({ work: [exploration] });
  expect(calls).toBe(2);

  const solver = createSolver(
    task,
    () => {
      throw new Error("Replaced roles need no Pi runtime");
    },
    { chatGptSingleShot: true },
  );
  let plans = 0;
  solver.functions.coordinator = async (input) => {
    expect(input.explorerUsed).toBe(false);
    return { work: ++plans <= 2 ? [exploration] : [] };
  };
  solver.functions.explorer = async () => ({
    kind: "notes",
    notes: [],
    candidate: false,
  });
  const engine = await Xean.open(new MemoryStorage(), solver);
  try {
    const waiting = await engine.run();
    expect(waiting.status).toBe("running");
    expect(waiting.work).toHaveLength(2);
    expect(waiting.providerCalls).toBe(0);
  } finally {
    await engine.close();
  }
});
