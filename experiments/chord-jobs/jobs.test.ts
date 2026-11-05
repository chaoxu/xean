import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
import { ProviderDoc } from "@earendil-works/pi-durable";
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
import { openPi, type Pi } from "./pi.ts";

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
const stage = ({ descriptor }: Request) =>
  descriptor.kind === "verifier" ? descriptor.name : descriptor.kind;

async function fixture(respond: Respond = complete) {
  const directory = await mkdtemp(join(tmpdir(), "xean-chord-contract-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const definition = { task: problem, settings: defaultSettings() };
  const provider = fauxProvider({
    provider: "test",
    models: [{ id: "math", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  let pi: Pi;
  const requests: Request[] = [];
  provider.setResponses(
    Array.from({ length: 128 }, () => async (transcript, options) => {
      const descriptor = await pi.root.commit(async (tx) => {
        const conversations = await tx.scanConversations({}, 256);
        for (const conversation of conversations.items) {
          const provider = await tx.doc(ProviderDoc, conversation.id);
          if (provider.sessionId !== options?.sessionId) continue;
          const assignment = await tx.doc(Assignment, conversation.id);
          if (assignment.descriptor)
            return copy(assignment.descriptor) as CallDescriptor;
        }
        throw new Error("Missing native role assignment");
      }, context);
      const request = {
        descriptor,
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
  pi = await openPi(directory, definition, models);
  let jobs = await openJobs(join(directory, "jobs.sqlite"), pi);
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
    requests,
    sizes,
    finished(ref: number) {
      return until(() => jobs.history().find((row) => row.ref === ref));
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
      pi = await openPi(directory, definition, models);
      beforeJobs?.(pi);
      jobs = await openJobs(join(directory, "jobs.sqlite"), pi);
      watch = await jobs.running.watch(context);
      observe();
    },
  };
}

test("Chord refills a shared slot with verification while another Explorer is held", async () => {
  const releaseExplorer = gate(),
    releaseChecks = gate();
  let heldExplorer = -1;
  const checking = new Set<string>();
  const run = await fixture(async (request) => {
    const d = request.descriptor;
    if (d.kind === "explorer" && d.input.namespace === `w${heldExplorer}`)
      await Promise.race([releaseExplorer.promise, abortable(request.signal)]);
    if (d.kind === "verifier" && d.name === "source") {
      d.judged.forEach((id) => checking.add(id));
      await Promise.race([releaseChecks.promise, abortable(request.signal)]);
    }
    return complete(request);
  });
  const first = await run.pi.prepare("explorer");
  heldExplorer = await run.pi.prepare("explorer");
  await run.jobs.start(first);
  await run.jobs.start(heldExplorer);
  expect((await run.finished(first)).status).toBe("done");
  const firstId = `w${first}.1`,
    secondId = `w${heldExplorer}.1`;
  const v1 = await run.pi.prepare("verifier", [firstId]);
  await run.jobs.start(v1);
  await until(() => (checking.has(firstId) ? true : undefined));
  expect(run.jobs.history().some((row) => row.ref === heldExplorer)).toBe(
    false,
  );
  expect(run.jobs.running.value.length).toBe(2);
  const excess = await run.pi.prepare("explorer");
  await expect(run.jobs.start(excess)).rejects.toThrow(
    /busy|concurrency|limit/i,
  );
  releaseExplorer.resolve();
  expect((await run.finished(heldExplorer)).status).toBe("done");
  const v2 = await run.pi.prepare("verifier", [secondId]);
  await run.jobs.start(v2);
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
  for (const id of [firstId, secondId]) {
    const calls = run.requests.filter(
      ({ descriptor: d }) =>
        d.kind !== "explorer" && d.input.notes.some((note) => note.id === id),
    );
    expect(calls.map(stage)).toEqual([
      "selection",
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
      (task) => task.kind !== "xean.worker" && task.kind !== "xean.campaign",
    ),
  ).toBe(true);
});

test("overlapping selector batches claim atomically without reserving the losing remainder", async () => {
  const firstSelection = gate(),
    secondSelection = gate(),
    releaseChecks = gate();
  const selected = new Set<string>(),
    checking = new Set<string>();
  let b = "",
    c = "",
    d = "";
  const run = await fixture(async (request) => {
    const descriptor = request.descriptor;
    if (descriptor.kind === "explorer")
      return { notes: [note("B"), note("C"), note("D")] };
    if (descriptor.kind === "selection") {
      const ids = descriptor.input.notes.map((note) => note.id);
      selected.add(ids.join(","));
      if (ids.length === 2)
        await Promise.race([
          ids.includes(b) ? firstSelection.promise : secondSelection.promise,
          abortable(request.signal),
        ]);
    }
    if (descriptor.kind === "verifier" && descriptor.name === "source") {
      descriptor.judged.forEach((id) => checking.add(id));
      await Promise.race([releaseChecks.promise, abortable(request.signal)]);
    }
    return complete(request);
  });
  const explorer = await run.pi.prepare("explorer");
  await run.jobs.start(explorer);
  await run.finished(explorer);
  [b, c, d] = [1, 2, 3].map((index) => `w${explorer}.${index}`) as [
    string,
    string,
    string,
  ];
  const bc = await run.pi.prepare("verifier", [b, c]);
  const cd = await run.pi.prepare("verifier", [c, d]);
  await run.jobs.start(bc);
  await run.jobs.start(cd);
  await until(() => (selected.size === 2 ? true : undefined));
  firstSelection.resolve();
  await until(() => (checking.has(b) ? true : undefined));
  secondSelection.resolve();
  expect(await run.finished(cd)).toMatchObject({ status: "busy", ids: [] });
  expect(run.jobs.claims().map((row) => row.ids)).toEqual([[b, c]]);
  const onlyD = await run.pi.prepare("verifier", [d]);
  await run.jobs.start(onlyD);
  await until(() => (checking.has(d) ? true : undefined));
  expect(run.jobs.claims().map((row) => row.ids)).toEqual([[b, c], [d]]);
  releaseChecks.resolve();
  expect((await run.finished(bc)).status).toBe("done");
  expect((await run.finished(onlyD)).status).toBe("done");
  const loserCalls = (await run.tasks()).filter(
    (task) => (task.input as { ref?: number }).ref === cd,
  );
  expect(
    loserCalls.map(
      (task) => (task.input as { descriptor: CallDescriptor }).descriptor.kind,
    ),
  ).toEqual(["selection"]);
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
  const explorer = await run.pi.prepare("explorer");
  await run.jobs.start(explorer);
  await run.finished(explorer);
  const verifier = await run.pi.prepare("verifier");
  const job = await run.jobs.start(verifier);
  await proofPending.promise;
  const before = await run.tasks();
  const original = before.find(
    (task) =>
      (task.input as { descriptor?: CallDescriptor }).descriptor?.kind ===
      "proof",
  )!;
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
  const proofTasks = (await run.tasks()).filter(
    (task) =>
      (task.input as { descriptor?: CallDescriptor }).descriptor?.kind ===
      "proof",
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
  const explorer = await firstPi.prepare("explorer");
  const job = await run.jobs.start(explorer);
  await published.promise;
  const before = (await run.tasks()).filter(
    (task) => task.kind === "xean.chord-call",
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
      .filter((task) => task.kind === "xean.chord-call")
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
  const explorer = await run.pi.prepare("explorer");
  await run.jobs.start(explorer);
  await run.finished(explorer);
  const stale = await run.pi.prepare("verifier");
  await run.jobs.start(stale);
  await selecting.promise;
  const invalidating = await run.pi.prepare("verifier");
  await run.jobs.start(invalidating);
  expect((await run.finished(invalidating)).status).toBe("done");
  expect((await run.pi.book()).notes[0]!.dead).toBe(true);
  expect((await run.pi.work(stale)).input.notes[0]!.dead).toBe(false);
  releaseSelection.resolve();
  expect(await run.finished(stale)).toMatchObject({
    status: "no-work",
    ids: [],
  });
  const staleCalls = (await run.tasks()).filter(
    (task) => (task.input as { ref?: number }).ref === stale,
  );
  expect(
    staleCalls.map(
      (task) => (task.input as { descriptor: CallDescriptor }).descriptor.kind,
    ),
  ).toEqual(["selection"]);
  expect(
    run.requests.filter((request) => stage(request) === "source"),
  ).toHaveLength(1);
  expect(run.jobs.claims()).toEqual([]);
});

test("exclusive ownership survives a competing open and is released after failed initialization", async () => {
  const run = await fixture();
  await expect(
    openPi(run.directory, run.definition, run.models),
  ).rejects.toThrow("already has an owner");
  expect(await run.pi.book()).toMatchObject({ notes: [], checks: [] });
  await run.jobs.close();
  await expect(
    openPi(
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
  const ref = await run.pi.prepare("explorer");
  expect((await run.pi.work(ref)).kind).toBe("explorer");
  expect(run.requests).toEqual([]);
});
