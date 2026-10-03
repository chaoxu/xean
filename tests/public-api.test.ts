import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Xean, openXeanStorage } from "xean";
import {
  createSolver,
  piRuntime,
  readSettings,
  type Plan,
  type Task,
} from "xean/solve";
import { fixtureRuntime, invoke } from "./fixtures/pi.ts";

const coordination = {
  task: { problem: "P", completionCriteria: "Prove P" },
  notes: [],
  failures: [],
  guidance: [],
  literatureUsed: false,
  explorerUsed: false,
};
const explore = { kind: "explorer" as const, guidance: "Explore" };
const planReply = () =>
  fauxAssistantMessage([fauxToolCall("submit_result", { work: [explore] })], {
    stopReason: "toolUse",
  });

test("built-in planner sees replacement Codex and keeps literature opt-in", async () => {
  const capabilities: { codex: boolean; literature: boolean }[] = [];
  const solver = createSolver(
    coordination.task,
    fixtureRuntime((context) => {
      const input = JSON.parse(
        String(
          context.messages.findLast((message) => message.role === "user")!
            .content,
        ),
      );
      capabilities.push({
        codex: input.capabilities.codex,
        literature: input.capabilities.literature,
      });
      return planReply();
    }),
  );
  await invoke(solver.functions.coordinator, coordination);
  const replacement = async () => ({
    kind: "notes" as const,
    notes: [],
    candidate: false,
  });
  solver.functions.codex = replacement;
  solver.functions.literature = replacement;
  await invoke(solver.functions.coordinator, coordination);
  expect(capabilities).toEqual([
    { codex: false, literature: false },
    { codex: true, literature: false },
  ]);
});

test("direct Pi runtime rejects browser Coordinator before call admission", async () => {
  let calls = 0;
  let admitted = 0;
  const runtime = fixtureRuntime(() => {
    calls++;
    return planReply();
  });
  runtime.profiles.coordinator.model.provider = "codex-chatgpt-web";
  const solver = createSolver(coordination.task, runtime);
  await expect(
    invoke(solver.functions.coordinator, coordination, {
      recorder: {
        begin() {
          admitted++;
          return { recordRequest() {}, settle() {} };
        },
      },
    }),
  ).rejects.toThrow("profiles.explorer");
  expect(admitted).toBe(0);
  expect(calls).toBe(0);
});

test("duplicate browser work rejects the entire plan before any provider call", async () => {
  let calls = 0;
  const runtime = fixtureRuntime(() => {
    calls++;
    throw new Error("Invalid plans must not call Explorer");
  });
  runtime.profiles.explorer.model.provider = "codex-chatgpt-web";
  const solver = createSolver(
    { problem: "P", completionCriteria: "Prove P" },
    () => runtime,
  );
  solver.functions.coordinator = async () => ({
    work: [
      { kind: "explorer", guidance: "Explore" },
      { kind: "explorer", guidance: "Try another approach" },
    ],
  });
  const engine = await Xean.open(await openXeanStorage(":memory:"), solver);
  try {
    const rejected = await engine.run();
    expect(rejected.status).toBe("blocked");
    expect(rejected.error).toContain("Explorer is unavailable");
    expect(rejected.work).toEqual([]);
    expect(calls).toBe(0);
  } finally {
    await engine.close();
  }
});

test("runtime construction validates profiles and never falls back from an explicit credential environment", () => {
  expect(() =>
    readSettings({
      profiles: { default: { provider: "openai", model: "unused" } },
      codex: { model: "unused", workspace: "relative" },
    }),
  ).toThrow("codex.workspace must be an absolute directory");
  const browser = {
    provider: "codex-chatgpt-web" as const,
    model: "chatgpt-web/gpt-6-pro",
  };
  expect(() => piRuntime({ profiles: { default: browser } })).toThrow(
    "profiles.explorer",
  );
  expect(() =>
    piRuntime({
      profiles: {
        default: {
          provider: "openai",
          model: "gpt-6-astra",
          baseUrl: "https://example.invalid/v1?credential=fixture",
        },
      },
    }),
  ).toThrow("baseUrl");
  const apiKeyEnv = "XEAN_TEST_MISSING_PROFILE_CREDENTIAL";
  const previous = process.env[apiKeyEnv];
  try {
    const settings = readSettings({
      profiles: {
        default: { provider: "openai", model: "gpt-6-astra", apiKeyEnv },
      },
    });
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env[apiKeyEnv];
      else process.env[apiKeyEnv] = value;
      expect(() => piRuntime(settings, "unrelated-key")).toThrow(apiKeyEnv);
    }
    process.env[apiKeyEnv] = "selected-key";
    expect(
      piRuntime(settings, "unrelated-key").profiles.explorer.options?.apiKey,
    ).toBe("selected-key");
  } finally {
    if (previous === undefined) delete process.env[apiKeyEnv];
    else process.env[apiKeyEnv] = previous;
  }
});

test.each(["explorer", "codex"] as const)(
  "public solver functions replace planning, %s, and Verifier without constructing Pi",
  async (worker) => {
    const task: Task = {
      problem: "Prove 2 + 2 = 4",
      completionCriteria: "Give a proof",
    };
    const pass = { verdict: "PASS" as const, report: "Checked" };
    const solver = createSolver(
      task,
      () => {
        throw new Error(
          "Replaced functions must not initialize the default runtime",
        );
      },
      { maxExplorerReads: undefined, maxExplorerResponses: undefined },
    );
    expect(solver.options).toMatchObject({
      maxExplorerReads: 4,
      maxExplorerResponses: 8,
    });
    const called: string[] = [];
    solver.functions.coordinator = async ({
      task: exact,
      notes,
    }): Promise<Plan> => {
      expect(exact).toEqual(task);
      called.push("plan");
      return {
        work: notes.length
          ? [
              {
                kind: "verifier",
                notes: [notes[0]!.id],
                through: "reconstruction",
              },
            ]
          : [
              worker === "explorer"
                ? {
                    kind: "explorer",
                    guidance: "Prove the exact claim",
                  }
                : {
                    kind: "codex",
                    assignment:
                      "Compute the requested sum and record the result",
                    notes: [],
                  },
            ],
      };
    };
    solver.functions[worker] = async () => {
      called.push(worker);
      return {
        kind: "notes",
        candidate: true,
        notes: [
          {
            id: "n1",
            summary: "Addition",
            detailedSummary: "Two plus two equals four by associativity.",
            text: "2 + 2 = (1 + 1) + (1 + 1) = 4.",
            support: [],
          },
        ],
      };
    };
    solver.functions.verifier = async ({ notes, targets }) => {
      called.push("verify");
      expect(targets).toEqual([
        { id: notes[0]!.id, through: "reconstruction" },
      ]);
      return {
        kind: "verification",
        checks: [
          {
            noteId: notes[0]!.id,
            correctness: { ...pass, premises: [] },
            source: pass,
            requirements: pass,
            reconstruction: {
              ...pass,
              statement: task.problem,
              proof: "Counting two pairs gives four units.",
            },
          },
        ],
      };
    };
    const engine = await Xean.open(await openXeanStorage(":memory:"), solver);
    try {
      const result = await engine.run();
      expect(result.status).toBe("completed");
      expect(result.providerCalls).toBe(0);
      expect(called).toEqual(["plan", worker, "plan", "verify"]);
      expect(await engine.run()).toEqual(result);
      expect(called).toHaveLength(4);
    } finally {
      await engine.close();
    }
  },
);
