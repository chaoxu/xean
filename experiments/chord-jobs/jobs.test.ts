import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  GenerationTask,
  ProviderDoc,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { Assignment } from "../../src/role-runtime.ts";
import { Notebook } from "../../src/state.ts";
import type { CallDescriptor } from "../../src/policy/prompts.ts";
import {
  abortable,
  checks,
  complete,
  context,
  defaultSettings,
  note,
  problem,
  type Request,
  type Respond,
} from "../../tests/worker-fixture.ts";
import { openJobs } from "./jobs.ts";
import * as piModule from "./pi.ts";
import type { Pi } from "./pi.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const gate = () => Promise.withResolvers<void>();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for persisted result");
    await Bun.sleep(5);
  }
}
const selection = (ids: string[]) => ({
  verify: ids.map((note) => ({
    note,
    verifiers: ["source", "correctness", "requirements", "reconstruction"],
  })),
});
const stage = ({ descriptor }: Request) =>
  descriptor.kind === "verifier" ? descriptor.name : descriptor.kind;

async function fixture(respond: Respond = complete, maxWorkers = 2) {
  const directory = await mkdtemp(join(tmpdir(), "xean-chord-contract-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const definition = {
    task: problem,
    settings: { ...defaultSettings(), maxWorkers },
  };
  const provider = fauxProvider({
    provider: "test",
    models: [{ id: "math", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  let pi: Pi;
  let ready = gate();
  const requests: (Request & { conversationId: ConversationId })[] = [];
  provider.setResponses(
    Array.from({ length: 128 }, () => async (transcript, options) => {
      await ready.promise;
      const assignment = await pi.root.commit(async (tx) => {
        const conversations = await tx.scanConversations({}, 256);
        for (const conversation of conversations.items) {
          const provider = await tx.doc(ProviderDoc, conversation.id);
          if (provider.sessionId !== options?.sessionId) continue;
          const assignment = await tx.doc(Assignment, conversation.id);
          if (assignment.descriptor)
            return {
              descriptor: copy(assignment.descriptor) as CallDescriptor,
              conversationId: conversation.id,
            };
        }
        throw new Error("Missing native role assignment");
      }, context);
      const request = {
        ...assignment,
        transcript: structuredClone(transcript),
        signal: options?.signal,
      };
      requests.push(request);
      const value = await respond(request);
      if (options?.signal?.aborted)
        return fauxAssistantMessage("", { stopReason: "aborted" });
      if (value instanceof Error)
        return fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: value.message,
        });
      const tool = getCurrentTools(transcript.messages)[0];
      if (!tool) throw new Error("Missing structured role tool");
      return fauxAssistantMessage(
        [fauxToolCall(tool.name, value as Record<string, JsonValue>)],
        { stopReason: "toolUse" },
      );
    }),
  );
  const reports: unknown[] = [];
  const report = (event: unknown) => reports.push(event);
  let jobs = await openJobs(directory, definition, models, report);
  pi = jobs.pi;
  ready.resolve();
  let watch = await jobs.running.watch(context);
  const sizes: number[] = [];
  const observe = () => {
    sizes.push(watch.value.length);
    watch.start(async (call) => {
      if (call.kind === "value") sizes.push(call.value.length);
    });
  };
  observe();
  cleanups.push(async () => {
    watch.stop();
    await jobs.close();
  });
  return {
    get pi() {
      return pi;
    },
    get jobs() {
      return jobs;
    },
    directory,
    definition,
    models,
    provider,
    reports,
    requests,
    sizes,
    async start(kind: "explorer" | "verifier") {
      const job = await jobs.start(kind);
      const entry = jobs.running.value.find((entry) => entry.id === job.id);
      if (entry?.phase === "blocked")
        throw new Error("New native job is blocked");
      const ref = entry?.args.ref ?? (await job.outcome(context)).args.ref;
      return { id: job.id, ref };
    },
    finished(ref: number) {
      return until(() => jobs.history().find((row) => row.ref === ref));
    },
    assignments() {
      return pi.root.commit(async (tx) => {
        const records = [];
        for (const conversation of (await tx.scanConversations({}, 256))
          .items) {
          const assignment = await tx.doc(Assignment, conversation.id);
          if (assignment.descriptor)
            records.push({
              conversationId: conversation.id,
              descriptor: copy(assignment.descriptor),
            });
        }
        return records;
      }, context);
    },
    tasks() {
      return pi.root.commit(
        async (tx) => copy((await tx.scanTasks({}, 256)).items),
        context,
      );
    },
    publications() {
      return pi.root.commit(
        async (tx) => copy((await tx.doc(Notebook, pi.root.id)).publications),
        context,
      );
    },
    async reopen(beforeJobs?: (next: Pi) => void) {
      watch.stop();
      await jobs.close();
      ready = gate();
      const initialize = piModule.openPi;
      const hook = beforeJobs
        ? spyOn(piModule, "openPi").mockImplementation(async (...args) => {
            const next = await initialize(...args);
            beforeJobs(next);
            return next;
          })
        : undefined;
      try {
        jobs = await openJobs(directory, definition, models, report);
        pi = jobs.pi;
      } finally {
        hook?.mockRestore();
        ready.resolve();
      }
      watch = await jobs.running.watch(context);
      observe();
    },
  };
}

test("Chord refills a shared slot with verification while another Explorer is held", async () => {
  const releaseExplorer = gate(),
    releaseChecks = gate();
  let explorers = 0;
  const checking = new Set<string>();
  const run = await fixture(async (request) => {
    const d = request.descriptor;
    if (d.kind === "explorer" && explorers++ === 1)
      await Promise.race([releaseExplorer.promise, abortable(request.signal)]);
    if (d.kind === "verifier" && d.name === "source") {
      d.judged.forEach((id) => checking.add(id));
      await Promise.race([releaseChecks.promise, abortable(request.signal)]);
    }
    if (d.kind === "selection")
      return selection(
        d.input.notes
          .filter((note) => !d.input.claimed.includes(note.id))
          .map((note) => note.id),
      );
    return complete(request);
  });
  const { ref: first } = await run.start("explorer");
  const { ref: heldExplorer } = await run.start("explorer");
  expect((await run.finished(first)).status).toBe("done");
  const firstId = `w${first}.1`,
    secondId = `w${heldExplorer}.1`;
  const { ref: v1 } = await run.start("verifier");
  await until(() => (checking.has(firstId) ? true : undefined));
  expect(run.jobs.history().some((row) => row.ref === heldExplorer)).toBe(
    false,
  );
  expect(run.jobs.running.value.length).toBe(2);
  await expect(run.jobs.start("explorer")).rejects.toThrow(
    /busy|concurrency|limit/i,
  );
  releaseExplorer.resolve();
  expect((await run.finished(heldExplorer)).status).toBe("done");
  const { ref: v2 } = await run.start("verifier");
  await until(() => (checking.has(secondId) ? true : undefined));
  expect(
    run.jobs
      .claims()
      .map((row) => row.ids)
      .sort(),
  ).toEqual([[firstId], [secondId]].sort());
  releaseChecks.resolve();
  expect((await run.finished(v1)).status).toBe("done");
  expect((await run.finished(v2)).status).toBe("done");
  const book = await run.pi.book();
  expect(book.accepted.sort()).toEqual([firstId, secondId].sort());
  const selectors = run.requests
    .map((request) => request.descriptor)
    .filter((descriptor) => descriptor.kind === "selection");
  expect(selectors).toHaveLength(2);
  expect(selectors[1]!.input.claimed).toEqual([firstId]);
  expect(selectors[1]!.input.notes.map((note) => note.id)).toEqual([
    firstId,
    secondId,
  ]);
  for (const id of [firstId, secondId]) {
    const calls = run.requests.filter(
      ({ descriptor: d }) =>
        d.kind !== "explorer" &&
        d.kind !== "selection" &&
        d.input.notes.some((note) => note.id === id),
    );
    expect(calls.map(stage)).toEqual([
      "source",
      "correctness",
      "requirements",
      "statement",
      "proof",
      "reconstruction",
    ]);
    expect(
      book.checks
        .flatMap((check) => check.values)
        .filter((value) => value.note === id)
        .map((value) => value.verifier),
    ).toEqual(["source", "correctness", "requirements", "reconstruction"]);
  }
  expect(Math.max(...run.sizes)).toBe(2);
  expect(
    (await run.tasks()).every(
      (task) =>
        !["xean.worker", "xean.campaign", "xean.chord-call"].includes(
          task.kind,
        ),
    ),
  ).toBe(true);
});

test("overlapping selector batches claim atomically without reserving the losing remainder", async () => {
  const firstSelection = gate(),
    secondSelection = gate(),
    releaseChecks = gate();
  let selections = 0;
  const checking = new Set<string>();
  let b = "",
    c = "",
    d = "";
  const run = await fixture(async (request) => {
    const descriptor = request.descriptor;
    if (descriptor.kind === "explorer")
      return { notes: [note("B"), note("C"), note("D")] };
    if (descriptor.kind === "selection") {
      const index = selections++;
      if (index < 2)
        await Promise.race([
          index === 0 ? firstSelection.promise : secondSelection.promise,
          abortable(request.signal),
        ]);
      return selection(index === 0 ? [b, c] : index === 1 ? [c, d] : [d]);
    }
    if (descriptor.kind === "verifier" && descriptor.name === "source") {
      descriptor.judged.forEach((id) => checking.add(id));
      await Promise.race([releaseChecks.promise, abortable(request.signal)]);
    }
    return complete(request);
  });
  const { ref: explorer } = await run.start("explorer");
  await run.finished(explorer);
  [b, c, d] = [1, 2, 3].map((index) => `w${explorer}.${index}`) as [
    string,
    string,
    string,
  ];
  const { ref: bc } = await run.start("verifier");
  const { ref: cd } = await run.start("verifier");
  await until(() => (selections === 2 ? true : undefined));
  firstSelection.resolve();
  await until(() => (checking.has(b) ? true : undefined));
  secondSelection.resolve();
  expect(await run.finished(cd)).toMatchObject({ status: "busy", ids: [] });
  expect(run.jobs.claims().map((row) => row.ids)).toEqual([[b, c]]);
  const { ref: onlyD } = await run.start("verifier");
  await until(() => (checking.has(d) ? true : undefined));
  expect(run.jobs.claims().map((row) => row.ids)).toEqual([[b, c], [d]]);
  const selectors = run.requests
    .map((request) => request.descriptor)
    .filter((descriptor) => descriptor.kind === "selection");
  expect(
    selectors.map((descriptor) =>
      descriptor.input.notes.map((note) => note.id),
    ),
  ).toEqual([
    [b, c, d],
    [b, c, d],
    [b, c, d],
  ]);
  expect(selectors[2]!.input.claimed).toEqual([b, c]);
  releaseChecks.resolve();
  expect((await run.finished(bc)).status).toBe("done");
  expect((await run.finished(onlyD)).status).toBe("done");
  expect(
    run.requests
      .filter(
        (request) =>
          request.descriptor.kind === "verifier" &&
          request.descriptor.name === "source",
      )
      .map((request) =>
        request.descriptor.kind === "verifier" ? request.descriptor.judged : [],
      ),
  ).toEqual([[b, c], [d]]);
  expect((await run.pi.book()).accepted.sort()).toEqual([b, c, d].sort());
});

test("close and reopen keep the Chord job and pending Pi proof, reusing all completed stages", async () => {
  const proofPending = gate(),
    recoveredProof = gate(),
    releaseProof = gate();
  let resumed = false;
  const run = await fixture(async (request) => {
    if (request.descriptor.kind === "proof") {
      if (!resumed) {
        proofPending.resolve();
        await abortable(request.signal);
      } else {
        recoveredProof.resolve();
        await Promise.race([releaseProof.promise, abortable(request.signal)]);
      }
    }
    return complete(request);
  });
  const { ref: explorer } = await run.start("explorer");
  await run.finished(explorer);
  const job = await run.start("verifier");
  const verifier = job.ref;
  await proofPending.promise;
  const before = await run.tasks();
  const proofConversation = run.requests.find(
    (request) => request.descriptor.kind === "proof",
  )!.conversationId;
  const original = before.find(
    (task) =>
      task.conversationId === proofConversation &&
      task.kind === GenerationTask.definition.name,
  )!;
  const originalClaims = run.jobs.claims();
  expect(original.state.status).not.toBe("terminal");
  expect(run.requests.map(stage)).toEqual([
    "explorer",
    "selection",
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
  ]);
  expect(run.jobs.history().some((row) => row.ref === verifier)).toBe(false);
  await run.jobs.close();
  resumed = true;
  await run.reopen();
  await recoveredProof.promise;
  expect(run.jobs.running.value.map((entry) => entry.id)).toEqual([job.id]);
  expect(run.jobs.claims()).toEqual(originalClaims);
  expect(
    run.requests
      .filter((request) => request.descriptor.kind === "proof")
      .map((request) => request.conversationId),
  ).toEqual([proofConversation, proofConversation]);
  const proofTasks = (await run.tasks()).filter(
    (task) =>
      task.conversationId === proofConversation &&
      task.kind === GenerationTask.definition.name,
  );
  expect(proofTasks.map((task) => task.id)).toEqual([original.id]);
  expect(run.requests.map(stage)).toEqual([
    "explorer",
    "selection",
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "proof",
  ]);
  releaseProof.resolve();
  expect((await run.finished(verifier)).status).toBe("done");
  expect(
    run.requests.filter((request) => stage(request) === "reconstruction"),
  ).toHaveLength(1);
  expect((await run.pi.book()).accepted).toEqual([`w${explorer}.1`]);
});

test("publication before Chord settlement replays its completed Pi call without duplicate notes", async () => {
  const published = gate(),
    replayed = gate(),
    releaseFinish = gate();
  const run = await fixture();
  const firstPi = run.pi;
  const publish = firstPi.publish.bind(firstPi);
  const interrupted = spyOn(firstPi, "publish").mockImplementation(
    async (ref, notes) => {
      await publish(ref, notes);
      published.resolve();
      await firstPi.harness.closed;
      throw new Error("Owner closed after publication before job settlement");
    },
  );
  const job = await run.start("explorer");
  const explorer = job.ref;
  await published.promise;
  const before = (await run.tasks()).filter(
    (task) => task.kind === GenerationTask.definition.name,
  );
  expect(before).toHaveLength(1);
  expect(before[0]!.state).toMatchObject({
    status: "terminal",
    outcome: { status: "completed" },
  });
  const publications = await run.publications();
  expect(publications).toHaveLength(1);
  expect(run.jobs.history()).toEqual([]);
  await run.jobs.close();
  interrupted.mockRestore();
  await run.reopen((next) => {
    const publishAgain = next.publish.bind(next);
    next.publish = async (ref, notes) => {
      await publishAgain(ref, notes);
      replayed.resolve();
      await releaseFinish.promise;
    };
  });
  await replayed.promise;
  expect(run.jobs.running.value.map((entry) => entry.id)).toEqual([job.id]);
  expect(
    (await run.tasks())
      .filter((task) => task.kind === GenerationTask.definition.name)
      .map((task) => task.id),
  ).toEqual(before.map((task) => task.id));
  expect(run.requests.map(stage)).toEqual(["explorer"]);
  expect(await run.publications()).toEqual(publications);
  expect((await run.pi.book()).notes.map((note) => note.id)).toEqual([
    `w${explorer}.1`,
  ]);
  releaseFinish.resolve();
  expect(await run.finished(explorer)).toMatchObject({
    status: "done",
    ids: [`w${explorer}.1`],
  });
  expect(run.jobs.history()).toHaveLength(1);
});

test("a frozen selection invalidated before claiming does not start any check", async () => {
  const selecting = gate(),
    releaseSelection = gate();
  let selections = 0;
  const run = await fixture(async (request) => {
    const descriptor = request.descriptor;
    if (descriptor.kind === "selection" && selections++ === 0) {
      selecting.resolve();
      await Promise.race([releaseSelection.promise, abortable(request.signal)]);
    }
    if (descriptor.kind === "verifier" && descriptor.name === "source")
      return checks(descriptor.judged, "FAIL");
    return complete(request);
  });
  const { ref: explorer } = await run.start("explorer");
  await run.finished(explorer);
  const { ref: stale } = await run.start("verifier");
  await selecting.promise;
  const { ref: invalidating } = await run.start("verifier");
  expect((await run.finished(invalidating)).status).toBe("done");
  expect((await run.pi.book()).notes[0]!.dead).toBe(true);
  expect((await run.pi.work(stale)).input.notes[0]!.dead).toBe(false);
  releaseSelection.resolve();
  expect(await run.finished(stale)).toMatchObject({
    status: "no-work",
    ids: [],
  });
  expect(
    (await run.assignments()).map(({ descriptor }) => descriptor.kind),
  ).toEqual(["explorer", "selection", "selection", "verifier"]);
  expect(
    run.requests.filter((request) => stage(request) === "source"),
  ).toHaveLength(1);
  expect(run.jobs.claims()).toEqual([]);
});

test("exclusive ownership survives a competing open and is released after failed initialization", async () => {
  const run = await fixture();
  await expect(
    openJobs(run.directory, run.definition, run.models),
  ).rejects.toThrow("already has an owner");
  expect(await run.pi.book()).toMatchObject({ notes: [], checks: [] });
  await run.jobs.close();
  await expect(
    openJobs(
      run.directory,
      {
        ...run.definition,
        task: {
          ...run.definition.task,
          problem: "A different frozen problem.",
        },
      },
      run.models,
    ),
  ).rejects.toThrow("Frozen definition changed");
  await run.reopen();
  expect(await run.pi.book()).toMatchObject({ notes: [], checks: [] });
  expect(run.jobs.running.value).toEqual([]);
  expect(run.requests).toEqual([]);
  const files = await readdir(run.directory);
  expect(files).toContain("execution.sqlite");
  expect(files).toContain("notes.sqlite");
  expect(files).not.toContain("pi.sqlite");
  expect(files).not.toContain("jobs.sqlite");
});

test("maxWorkers 1 completes Explorer then Verifier with native sequential capacity", async () => {
  const exploring = gate(),
    releaseExplorer = gate();
  const run = await fixture(async (request) => {
    if (request.descriptor.kind === "explorer") {
      exploring.resolve();
      await Promise.race([releaseExplorer.promise, abortable(request.signal)]);
    }
    return complete(request);
  }, 1);
  const { ref: explorer } = await run.start("explorer");
  await exploring.promise;
  await expect(run.jobs.start("explorer")).rejects.toThrow(
    /busy|concurrency|limit/i,
  );
  expect(run.jobs.running.value).toHaveLength(1);
  releaseExplorer.resolve();
  expect((await run.finished(explorer)).status).toBe("done");
  const { ref: verifier } = await run.start("verifier");
  expect((await run.finished(verifier)).status).toBe("done");
  expect((await run.pi.book()).accepted).toEqual([`w${explorer}.1`]);
  expect(Math.max(...run.sizes)).toBe(1);
  expect(
    run.requests.filter((request) => request.descriptor.kind === "explorer"),
  ).toHaveLength(1);
});

test("terminal Pi failure survives interrupted Chord settlement without another model attempt", async () => {
  const failed = gate();
  const run = await fixture(() => new Error("401 upstream_unavailable"));
  const firstPi = run.pi;
  const call = firstPi.call.bind(firstPi);
  const interrupted = spyOn(firstPi, "call").mockImplementation(
    async (...args) => {
      try {
        return await call(...args);
      } catch (error) {
        failed.resolve();
        await firstPi.harness.closed;
        throw error;
      }
    },
  );
  const { ref } = await run.start("explorer");
  await failed.promise;
  expect(run.provider.state.callCount).toBe(1);
  expect(run.jobs.history()).toEqual([]);
  const conversationId = run.requests[0]!.conversationId;
  const original = await firstPi.root.commit(
    async (tx) =>
      copy(await tx.submissionByRequest(conversationId, "explorer")),
    context,
  );
  expect(original?.status).toBe("unanswered");
  await run.jobs.close();
  interrupted.mockRestore();
  await run.reopen();
  expect(await run.finished(ref)).toMatchObject({ status: "failed", ids: [] });
  expect(run.reports).toContainEqual(
    expect.objectContaining({
      kind: "job_failed",
      error: expect.objectContaining({
        message: "explorer failed: 401 upstream_unavailable",
      }),
    }),
  );
  expect(run.provider.state.callCount).toBe(1);
  expect(
    await run.pi.root.commit(
      async (tx) =>
        copy(await tx.submissionByRequest(conversationId, "explorer")),
      context,
    ),
  ).toEqual(original);
  expect((await run.pi.book()).notes).toEqual([]);
});

test("selection sees the full dependency chain while only selected notes are checked", async () => {
  let a = "",
    b = "",
    c = "";
  const run = await fixture((request) => {
    const descriptor = request.descriptor;
    if (descriptor.kind === "explorer") {
      [a, b, c] = [1, 2, 3].map(
        (index) => `${descriptor.input.namespace}.${index}`,
      ) as [string, string, string];
      return {
        notes: [
          note("A"),
          note("B assuming A", [a]),
          note("C assuming B", [b]),
        ],
      };
    }
    if (descriptor.kind === "selection") return selection([b, c]);
    return complete(request);
  });
  const { ref: explorer } = await run.start("explorer");
  await run.finished(explorer);
  const { ref: verifier } = await run.start("verifier");
  expect((await run.finished(verifier)).status).toBe("done");
  const descriptors = run.requests.map((request) => request.descriptor);
  const selected = descriptors.find(
    (descriptor) => descriptor.kind === "selection",
  )!;
  expect(selected.input.notes.map((note) => note.id)).toEqual([a, b, c]);
  const reconstructed = descriptors.find(
    (descriptor) => descriptor.kind === "proof",
  )!;
  expect(reconstructed.input.notes.map((note) => note.id)).toEqual([b, c]);
  expect(reconstructed.input.support.map((note) => note.id)).toEqual([a]);
  const book = await run.pi.book();
  expect(
    book.notes.map((note) => ({
      id: note.id,
      checked: note.checked,
      verified: note.verified,
    })),
  ).toEqual([
    { id: a, checked: false, verified: false },
    { id: b, checked: true, verified: false },
    { id: c, checked: true, verified: false },
  ]);
  expect(book.accepted).toEqual([]);
});
