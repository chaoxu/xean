import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import {
  acceptedArgument,
  inspect,
  Notebook,
  open,
  project,
  readNotes,
  solveSettings,
  submitNotes,
} from "../src/index.ts";
import { readNotebook } from "../src/state.ts";
import { Assignment } from "../src/role-runtime.ts";
import { verifierNames, type Verification } from "../src/policy/contracts.ts";
import type { CallDescriptor } from "../src/policy/prompts.ts";
import type { WorkerRequest } from "../src/workers.ts";
import { fauxModels } from "./faux-models.ts";

const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const profile = { provider: "test", model: "math", reasoning: "high" };
const settings = solveSettings.parse(
  Object.fromEntries(
    ["explorer", "coordinator", ...verifierNames].map((name) => [
      name,
      profile,
    ]),
  ),
);
const proposal = { notes: [{ text: "Complete proof of P.", support: [] }] };
const verification: Verification[] = [
  { note: "n1", verifiers: [...verifierNames] },
];
const decision = {
  filings: [{ note: "n1", summary: "P holds." }],
  verify: verification,
};
const checked = {
  verdicts: [{ note: "n1", verdict: "PASS", report: "Checked." }],
};
const verificationReplies: JsonValue[] = [
  checked,
  checked,
  checked,
  { statements: [{ note: "n1", statement: "P holds." }] },
  { proof: "Independent proof of P." },
  { statements: [], ...checked },
];
const directories: string[] = [];
const owners: Awaited<ReturnType<typeof open>>[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0).reverse()) await owner.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(
  values: (JsonValue | Error)[] = [],
  startCampaign = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "xean-workers-"));
  directories.push(directory);
  const path = join(directory, "research.sqlite");
  const calls: {
    descriptor: CallDescriptor;
    system: string;
    tools: string[];
  }[] = [];
  let owner: Awaited<ReturnType<typeof open>>;
  const native = fauxModels(values, async (transcript) => {
    const descriptor = await owner.root.commit(async (tx) => {
      const child = (await tx.scanConversations({ order: "descending" }, 1))
        .items[0]!;
      return JSON.parse(
        JSON.stringify((await tx.doc(Assignment, child.id)).descriptor),
      ) as CallDescriptor;
    }, context);
    calls.push({
      descriptor,
      system: getCurrentSystemPrompt(transcript.messages),
      tools: getCurrentTools(transcript.messages).map((tool) => tool.name),
    });
  });
  owner = await open(path, {
    create: { task, settings },
    startCampaign,
    models: native.models,
  });
  owners.push(owner);
  return {
    path,
    native,
    calls,
    get owner() {
      return owner;
    },
    create(request: WorkerRequest) {
      return owner.root.commit(
        (tx) => owner.workers.create(tx, owner.root.id, request),
        context,
      );
    },
    async run(request: WorkerRequest) {
      const id = await this.create(request);
      const settled = await owner.harness.waitForTask(id, context);
      return { id, outcome: settled.state.outcome };
    },
    async reopen() {
      await owner.close();
      owner = await open(path, { models: native.models });
      owners.push(owner);
      return owner;
    },
    notes() {
      return inspect(path, readNotes);
    },
    book() {
      return inspect(
        path,
        async (tx, root) =>
          JSON.parse(
            JSON.stringify(readNotebook(await tx.doc(Notebook, root))),
          ) as ReturnType<typeof readNotebook>,
      );
    },
    tasks() {
      return inspect(
        path,
        async (tx, root) =>
          (await tx.scanTasks({ conversationId: root }, 128)).items,
      );
    },
  };
}

test("manual workers publish each result and preserve the normal verified argument without creating a campaign", async () => {
  const run = await fixture([proposal, decision, ...verificationReplies]);
  expect(await run.tasks()).toEqual([]);
  const first = await run.run({
    kind: "explorer",
    guidance: "Prove P directly.",
  });
  expect(first.outcome).toEqual({ status: "completed", result: proposal });
  expect(await run.notes()).toMatchObject([
    { id: "n1", text: proposal.notes[0]!.text, verified: false },
  ]);
  expect((await run.notes())[0]!.summary).toBeUndefined();
  expect(run.native.provider.state.callCount).toBe(1);
  const coordination = await run.run({ kind: "coordinator" });
  expect(coordination.outcome).toEqual({
    status: "completed",
    result: decision,
  });
  expect((await run.notes())[0]!.summary).toBe("P holds.");
  expect((await run.notes())[0]!.verdicts).toEqual([]);
  const verified = await run.run({ kind: "verifier", verify: verification });
  expect(verified.outcome).toEqual({ status: "completed", result: null });
  const notes = await run.notes();
  const book = await run.book();
  expect(project(book).accepted).toEqual(["n1"]);
  expect(notes[0]!.verdicts.map((verdict) => verdict.verifier)).toEqual([
    ...verifierNames,
  ]);
  expect(book.checks).toHaveLength(4);
  expect(book.checks.every((check) => check.candidate === verified.id)).toBe(
    true,
  );
  expect(acceptedArgument(notes, "n1")).toBe("## n1\n\nComplete proof of P.\n");
  expect(
    run.calls.map(({ descriptor }) =>
      descriptor.kind === "verifier" ? descriptor.name : descriptor.kind,
    ),
  ).toEqual([
    "explorer",
    "coordinator",
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  expect(
    (await run.tasks()).some((task) => task.kind === "xean.campaign"),
  ).toBe(false);
  notes[0]!.text = "Local inspection mutation";
  expect((await run.notes())[0]!.text).toBe(proposal.notes[0]!.text);
  await run.reopen();
  await run.owner.root.waitForIdle(context);
  expect(
    (await run.tasks()).some((task) => task.kind === "xean.campaign"),
  ).toBe(false);
  expect(run.native.provider.state.callCount).toBe(8);
  expect(await run.notes()).toEqual(project(book).notes);
});

test.each([false, true])(
  "manual admission rejects an existing root task, automatic=%s",
  async (automatic) => {
    const run = await fixture([], automatic);
    if (!automatic) await run.create({ kind: "explorer" });
    const before = await run.tasks();
    await expect(run.create({ kind: "coordinator" })).rejects.toThrow();
    expect(await run.tasks()).toEqual(before);
    expect(run.native.provider.state.callCount).toBe(0);
  },
);

test("closing a live native worker recovers the same task and frozen role on ordinary reopen", async () => {
  const run = await fixture();
  const started = Promise.withResolvers<void>();
  run.native.provider.setResponses([
    async (_transcript, options) => {
      started.resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
  ]);
  const id = await run.create({
    kind: "explorer",
    guidance: "Frozen direction.",
  });
  const pending = run.owner.harness.waitForTask(id, context).catch(() => {});
  await started.promise;
  const frozen = (await run.tasks()).find((task) => task.id === id)!.input;
  await run.owner.close();
  await pending;
  run.native.replies.push(proposal);
  await run.reopen();
  expect(
    (await run.owner.harness.waitForTask(id, context)).state.outcome,
  ).toEqual({ status: "completed", result: proposal });
  expect((await run.tasks()).find((task) => task.id === id)!.input).toEqual(
    frozen,
  );
  expect((await run.notes()).map((note) => note.id)).toEqual(["n1"]);
  expect(
    (await run.tasks()).some((task) => task.kind === "xean.campaign"),
  ).toBe(false);
});

test("retry keeps the failed Explorer input and future note IDs while caller input remains queued", async () => {
  const run = await fixture([new Error("Disconnected Explorer")]);
  const first = await run.run({
    kind: "explorer",
    guidance: "Frozen direction.",
  });
  expect(first.outcome.status).toBe("faulted");
  await run.owner.root.commit(
    (tx) =>
      submitNotes(tx, run.owner.root.id, "caller", {
        notes: [{ text: "Caller result.", support: [] }],
      }),
    context,
  );
  const recovered = {
    notes: [
      { text: "Explorer lemma.", support: [] },
      { text: "Explorer consequence.", support: ["n1"] },
    ],
  };
  run.native.replies.push(recovered);
  const retried = await run.run({ kind: "retry", task: first.id });
  expect(retried.outcome).toEqual({ status: "completed", result: recovered });
  expect(run.calls[1]!.descriptor).toEqual(run.calls[0]!.descriptor);
  expect(
    (await run.notes()).map(({ id, text, support }) => ({ id, text, support })),
  ).toEqual(
    recovered.notes.map((note, index) => ({ id: `n${index + 1}`, ...note })),
  );
  expect((await run.book()).inputs).toEqual([
    {
      id: "caller",
      notes: [{ text: "Caller result.", support: [] }],
      consumed: false,
    },
  ]);
  const requests = await run.tasks();
  expect(requests.find((task) => task.id === retried.id)!.input).toMatchObject({
    previousTasks: [first.id],
  });
});

test("verification retry reuses checked calls and keeps one candidate lineage", async () => {
  const run = await fixture([
    proposal,
    decision,
    ...verificationReplies.slice(0, -1),
    new Error("Comparison disconnected"),
  ]);
  await run.run({ kind: "explorer" });
  await run.run({ kind: "coordinator" });
  const first = await run.run({ kind: "verifier", verify: verification });
  expect(first.outcome.status).toBe("faulted");
  const partial = await run.book();
  expect(partial.checks).toHaveLength(3);
  expect(project(partial).accepted).toEqual([]);
  run.native.replies.push({ statements: [], ...checked });
  const count = run.native.provider.state.callCount;
  const retried = await run.run({ kind: "retry", task: first.id });
  expect(retried.outcome).toEqual({ status: "completed", result: null });
  expect(run.native.provider.state.callCount - count).toBe(1);
  const final = await run.book();
  expect(final.checks).toHaveLength(4);
  expect(final.checks.slice(0, 3)).toEqual(partial.checks);
  expect(final.checks.every((check) => check.candidate === first.id)).toBe(
    true,
  );
  expect(new Set(final.checks.map((check) => check.call)).size).toBe(4);
  expect(project(final).accepted).toEqual(["n1"]);
});

test("publication recovery reuses the role receipt after the note store committed before Pi settlement", async () => {
  const run = await fixture([proposal]);
  const original = NoteStore.prototype.commit;
  let injected = false;
  const writes = spyOn(NoteStore.prototype, "commit").mockImplementation(
    function (this: NoteStore, expected, changes, receipt) {
      const result = original.call(this, expected, changes, receipt);
      if (!injected && changes.n1?.text === proposal.notes[0]!.text) {
        injected = true;
        throw new Error("Interrupted after notebook commit");
      }
      return result;
    },
  );
  let first: Awaited<ReturnType<typeof run.run>>;
  try {
    first = await run.run({ kind: "explorer" });
  } finally {
    writes.mockRestore();
  }
  expect(injected).toBe(true);
  expect(first!.outcome.status).toBe("faulted");
  expect(await run.notes()).toEqual([]);
  using store = new NoteStore(`${run.path}.notes.sqlite`);
  expect(store.snapshot()).toBe(1);
  expect(store.read().notes.n1?.text).toBe(proposal.notes[0]!.text);
  expect(run.native.provider.state.callCount).toBe(1);
  await expect(run.create({ kind: "explorer" })).rejects.toThrow();
  store.commit(
    1,
    { n1: { id: "n1", text: "Later external revision.", support: [] } },
    "external",
  );
  await run.reopen();
  const retried = await run.run({ kind: "retry", task: first!.id });
  expect(retried.outcome).toEqual({ status: "completed", result: proposal });
  expect(run.native.provider.state.callCount).toBe(1);
  expect(store.snapshot()).toBe(2);
  expect((await run.notes()).map((note) => note.id)).toEqual(["n1"]);
  expect((await run.notes())[0]!.text).toBe(proposal.notes[0]!.text);
  expect(store.read().notes.n1?.text).toBe("Later external revision.");
});

test("external notebook advancement rejects worker admission before a model call", async () => {
  const run = await fixture([proposal]);
  using store = new NoteStore(`${run.path}.notes.sqlite`);
  store.commit(0, { external: { text: "External knowledge." } }, "external");
  await expect(run.create({ kind: "explorer" })).rejects.toThrow();
  expect(await run.tasks()).toEqual([]);
  expect(run.native.provider.state.callCount).toBe(0);
  expect(await run.notes()).toEqual([]);
  expect(store.read().notes).toEqual({
    external: { text: "External knowledge." },
  });
});

test("external advancement during a producer cannot be overwritten by worker publication", async () => {
  const run = await fixture();
  using store = new NoteStore(`${run.path}.notes.sqlite`);
  run.native.provider.setResponses([
    () => {
      store.commit(
        0,
        { external: { text: "Concurrent knowledge." } },
        "external",
      );
      return fauxAssistantMessage([fauxToolCall("submit_notes", proposal)], {
        stopReason: "toolUse",
      });
    },
  ]);
  const result = await run.run({ kind: "explorer" });
  expect(result.outcome.status).toBe("faulted");
  expect(run.native.provider.state.callCount).toBe(1);
  expect(await run.notes()).toEqual([]);
  expect(store.snapshot()).toBe(1);
  expect(store.read().notes).toEqual({
    external: { text: "Concurrent knowledge." },
  });
});

test("retry rejects an obsolete notebook snapshot after another worker publishes", async () => {
  const run = await fixture([new Error("First Explorer failed"), proposal]);
  const first = await run.run({ kind: "explorer" });
  expect(first.outcome.status).toBe("faulted");
  expect((await run.run({ kind: "explorer" })).outcome.status).toBe(
    "completed",
  );
  const before = await run.notes();
  const calls = run.native.provider.state.callCount;
  await expect(run.create({ kind: "retry", task: first.id })).rejects.toThrow();
  expect(await run.notes()).toEqual(before);
  expect(run.native.provider.state.callCount).toBe(calls);
});

test.each(["explorer", "coordinator"] as const)(
  "fresh %s admits queued literature before freezing its input",
  async (kind) => {
    const response: JsonValue =
      kind === "explorer"
        ? {
            notes: [
              { text: "Consequence of the supplied result.", support: ["n1"] },
            ],
          }
        : {
            filings: [{ note: "n1", summary: "Supplied lemma holds." }],
            verify: [],
          };
    const run = await fixture([response]);
    const supplied = {
      notes: [
        {
          text: "Supplied literature lemma.",
          support: [],
          verification: {
            source: "Caller supplied reference",
            report: "Exact result checked.",
          },
        },
      ],
    };
    await run.owner.root.commit(
      (tx) => submitNotes(tx, run.owner.root.id, "literature", supplied),
      context,
    );
    expect(await run.notes()).toEqual([]);
    const worker = await run.run({ kind });
    expect(worker.outcome).toEqual({ status: "completed", result: response });
    const descriptor = run.calls[0]!.descriptor;
    expect(descriptor.kind).toBe(kind);
    if (descriptor.kind !== "explorer" && descriptor.kind !== "coordinator")
      throw new Error("Expected a producing role");
    expect(descriptor.input.notes).toMatchObject([
      { id: "n1", verification: supplied.notes[0]!.verification },
    ]);
    const book = await run.book();
    expect(book.inputs).toEqual([
      { id: "literature", ...supplied, consumed: true },
    ]);
    expect(book.notes[0]).toMatchObject({ id: "n1", ...supplied.notes[0]! });
    expect(book.notes.map((note) => note.id)).toEqual(
      kind === "explorer" ? ["n1", "n2"] : ["n1"],
    );
  },
);

test("retry of an aborted verifier reuses completed statement and proof receipts", async () => {
  const run = await fixture([
    proposal,
    decision,
    ...verificationReplies.slice(0, -1),
  ]);
  const comparisonStarted = Promise.withResolvers<void>();
  run.native.provider.appendResponses([
    async (_transcript, options) => {
      comparisonStarted.resolve();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
      });
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
  ]);
  await run.run({ kind: "explorer" });
  await run.run({ kind: "coordinator" });
  const first = await run.create({ kind: "verifier", verify: verification });
  const pending = run.owner.harness.waitForTask(first, context);
  await comparisonStarted.promise;
  const partial = await run.book();
  expect(partial.checks).toHaveLength(3);
  expect(run.calls.slice(-2).map(({ descriptor }) => descriptor.kind)).toEqual([
    "statement",
    "proof",
  ]);
  await run.owner.harness.abortTask(first, context);
  expect((await pending).state.outcome.status).toBe("aborted");
  expect(project(await run.book()).accepted).toEqual([]);
  run.native.replies.push({ statements: [], ...checked });
  const count = run.native.provider.state.callCount;
  const retried = await run.run({ kind: "retry", task: first });
  expect(retried.outcome).toEqual({ status: "completed", result: null });
  expect(run.native.provider.state.callCount - count).toBe(1);
  expect(run.calls.at(-1)!.descriptor.kind).toBe("reconstruction");
  expect(
    run.calls.filter(({ descriptor }) => descriptor.kind === "statement"),
  ).toHaveLength(1);
  expect(
    run.calls.filter(({ descriptor }) => descriptor.kind === "proof"),
  ).toHaveLength(1);
  const final = await run.book();
  expect(final.checks.slice(0, 3)).toEqual(partial.checks);
  expect(final.checks).toHaveLength(4);
  expect(final.checks.every((check) => check.candidate === first)).toBe(true);
  expect(project(final).accepted).toEqual(["n1"]);
});
