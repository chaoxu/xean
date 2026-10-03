import { expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Xean } from "../packages/core/src/index.ts";

const model = {
  provider: "fixture",
  id: "fixture",
  api: "openai-responses" as const,
};

test("model-call accounting does not stop later work", async () => {
  let next = false;
  const engine = await Xean.open(new MemoryStorage(), {
    task: "continue after many calls",
    limits: { attempts: 1 },
    roles: [
      {
        name: "worker",
        async run(input, execution) {
          const calls = input === "first" ? 3 : 2;
          for (let index = 0; index < calls; index++) {
            const call = await execution.recorder.begin(model);
            await call.recordRequest({ input, index });
            await call.settle(fauxAssistantMessage(String(index)), {
              input: 1,
              output: 1,
              totalTokens: 2,
            });
          }
          return input;
        },
      },
    ],
    coordinator: {
      name: "continue",
      run(signal, view) {
        if (signal.kind === "start")
          return {
            state: null,
            dispatch: [{ id: "first", role: "worker", input: "first" }],
          };
        if (signal.kind === "input" && !next) {
          next = true;
          return {
            state: null,
            dispatch: [{ id: "second", role: "worker", input: "second" }],
          };
        }
        return { state: view.state };
      },
    },
  });
  try {
    const first = await engine.run();
    expect(first.status).toBe("running");
    expect(first.providerCalls).toBe(3);
    expect(first.work[0]?.status).toBe("completed");

    await engine.input("continue");
    const second = await engine.run();
    expect(second.status).toBe("running");
    expect(second.providerCalls).toBe(5);
    expect(second.work.map((work) => work.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect("callAllowance" in second).toBe(false);
    expect("callLimitReached" in second).toBe(false);
  } finally {
    await engine.close();
  }
});
