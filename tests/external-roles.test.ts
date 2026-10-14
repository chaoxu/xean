import { expect, test } from "bun:test";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { awaitWithContext } from "@earendil-works/chord/context";
import { createRuntime } from "../src/roles/config.ts";
import { open } from "../src/host.ts";
import { type Note } from "../src/core/math/contracts.ts";
import { createRoles } from "../src/roles/index.ts";
import type { ExternalCall } from "../src/roles/backend.ts";
import type { RoleRuntime } from "../src/core/roles.ts";
import { closedBookResearch } from "../src/roles/research.ts";
import { context, noteResult, settings, task } from "./fixture.ts";
import { temporaryDirectory } from "./directory.ts";

const roles = () =>
  createRoles({
    ...settings,
    ...createRuntime(settings, { models: createModels() }),
  });
const runtime = { taskId: 23 } as RoleRuntime;
const resultNote = {
  ...noteResult.notes[0]!,
  id: `${runtime.taskId}/reflexivity`,
};
const answer = (value: unknown): ExternalCall =>
  (async () => ({
    value,
    workspace: "/fixture",
    operationId: "op",
    searches: 0,
    reportedAt: "2026-10-13T00:00:00Z",
  })) as ExternalCall;
const note: Note = {
  ...noteResult.notes[0]!,
  id: "seed",
  revision: 0,
  checks: {},
  verified: false,
  dead: false,
  accepted: false,
  retired: false,
};
const input = { task, notes: [note], assignment: "Check reflexivity." };

async function workerOutcome(owner: Awaited<ReturnType<typeof open>>) {
  await owner.root.waitForIdle(context);
  const page = await owner.root.commit(
    (tx) => tx.scanTasks({ kind: "research.worker" }, 10),
    context,
  );
  return page.items[0]!.state.outcome;
}

test("default core has no external backend and registration changes capabilities", async () => {
  const builtins = roles();
  const input = {
    task,
    notes: [],
    failures: [],
    guidance: [],
    literatureUsed: false,
  };
  expect(builtins.capabilities(input)).toMatchObject({
    implementation: false,
    externalVerifier: false,
    sourceRetrieval: false,
  });
  await expect(
    builtins.implementation(
      { ...input, assignment: "Compute." },
      runtime,
      context,
    ),
  ).rejects.toThrow("Implementation backend is disabled");
  builtins.external = {
    implementation: answer({ notes: [] }),
    verifier: answer({ results: [] }),
    explorer: answer({ notes: [] }),
  };
  expect(builtins.capabilities(input)).toMatchObject({
    implementation: true,
    externalVerifier: true,
  });
});

test("core rejects malformed external implementation and unsupported dependency results", async () => {
  const builtins = roles();
  builtins.external.implementation = answer({ notes: "not an array" });
  await expect(
    builtins.implementation(input, runtime, context),
  ).rejects.toThrow();
  builtins.external.implementation = answer({
    notes: [{ ...resultNote, support: ["missing"] }],
  });
  await expect(
    builtins.implementation(input, runtime, context),
  ).rejects.toThrow("missing");
});

test.each(["new notes", "blind edit"])(
  "external Explorer receives only the index and validates %s",
  async (mode) => {
    const builtins = roles();
    const result =
      mode === "new notes"
        ? {
            notes: [
              {
                ...resultNote,
                support: [note.id],
              },
            ],
          }
        : {
            notes: [],
            edits: [{ id: note.id, revision: 0, text: "Replacement." }],
          };
    let calls = 0;
    builtins.external.explorer = async (...args) => {
      calls++;
      const input = JSON.stringify(args[3]);
      expect(input).toContain(note.summary);
      expect(input).not.toContain(JSON.stringify(note.text));
      expect(input).not.toContain(note.detailedSummary);
      return answer(result)(...args);
    };
    const invocation = builtins.explorer(input, runtime, context);
    if (mode === "blind edit")
      await expect(invocation).rejects.toThrow("without their full text");
    else
      await expect(invocation).resolves.toEqual({ kind: "notes", ...result });
    expect(calls).toBe(1);
  },
);

test("external verification must return exactly the requested IDs", async () => {
  const builtins = roles();
  builtins.external.verifier = answer({
    results: [
      {
        noteId: "wrong",
        verdict: "PASS",
        report: "Reflexive.",
        statement: "1 = 1.",
        premises: [],
      },
    ],
  });
  await expect(
    builtins.verifier(
      {
        ...input,
        targets: [note.id],
        through: "correctness",
        backend: "external",
      },
      runtime,
      context,
    ),
  ).rejects.toThrow("exactly one result per requested note");
});

test("standalone replacement results receive the same notebook validation", async () => {
  const directory = await temporaryDirectory("external-standalone-");
  const owner = await open(join(directory, "campaign.sqlite"), {
    create: {
      task,
      settings,
      mode: {
        role: "implementation",
        input: { notes: [], assignment: "Compute." },
      },
    },
    models: createModels(),
    roles: () => ({
      implementation: async (_input, runtime) => ({
        kind: "notes",
        notes: [
          {
            ...noteResult.notes[0],
            id: `${runtime.taskId}/reflexivity`,
            support: ["missing"],
          },
        ],
      }),
    }),
  });
  try {
    const outcome = await workerOutcome(owner);
    expect(outcome?.status).toBe("faulted");
    expect(outcome?.error?.message).toContain("missing");
  } finally {
    await owner.close();
  }
});

test.each(["explorer", "verifier"] as const)(
  "removing an interrupted %s backend cannot silently resume with the native default",
  async (role) => {
    const directory = await temporaryDirectory("external-mode-recovery-");
    const database = join(directory, "campaign.sqlite");
    const started = Promise.withResolvers<void>();
    const wait = async (callContext: typeof context): Promise<never> => {
      started.resolve();
      return awaitWithContext(new Promise<never>(() => {}), callContext);
    };
    const input =
      role === "explorer"
        ? { notes: [], assignment: "Explore." }
        : {
            notes: [
              {
                ...note,
                checks: {
                  correctness: {
                    verdict: "PASS",
                    report: "Conditional on the premise.",
                    statement: "1 = 1.",
                    premises: ["External theorem."],
                  },
                },
              },
            ],
            targets: [note.id],
            through: "source",
          };
    const owner = await open(database, {
      create: {
        task,
        settings,
        mode: { role, input: JSON.parse(JSON.stringify(input)) },
      },
      models: createModels(),
      roles: () => ({
        external:
          role === "explorer"
            ? {
                explorer: async (...args) => wait(args[5]),
              }
            : {
                research: {
                  ...closedBookResearch,
                  retrieval: true,
                  source: async (_input, _runtime, context) => wait(context),
                },
              },
      }),
    });
    owner.harness.resume();
    await started.promise;
    await owner.close();
    const reopened = await open(database, { models: createModels() });
    try {
      const outcome = await workerOutcome(reopened);
      expect(outcome?.status).toBe("faulted");
      expect(outcome?.error?.message).toContain("backend registration changed");
    } finally {
      await reopened.close();
    }
  },
);
