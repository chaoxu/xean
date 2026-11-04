import { expect, spyOn, test } from "bun:test";
import type { Respond } from "./worker-fixture.ts";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import {
  inspect,
  acceptedArgument,
  project,
  submitNotes,
} from "../src/index.ts";
import {
  fixture,
  complete,
  context,
  note,
  abortable,
} from "./worker-fixture.ts";

test("independent Explorer and Verifier publish knowledge without a campaign or Coordinator", async () => {
  const run = await fixture();
  const explored = await run.run({
    kind: "explorer",
    guidance: "Prove P directly.",
  });
  expect(explored.outcome.status).toBe("completed");
  const id = `w${explored.id}.1`;
  expect(await run.notes()).toMatchObject([
    { id, summary: "Complete proof of P.", verified: false },
  ]);
  const checked = await run.run({ kind: "verifier" });
  expect(checked.outcome.status).toBe("completed");
  const book = await run.book();
  expect(project(book).accepted).toEqual([id]);
  expect(book.checks).toHaveLength(4);
  expect(new Set(book.checks.map((check) => check.candidate)).size).toBe(1);
  const attempt = book.checks[0]!.candidate;
  expect(attempt).not.toBe(checked.id);
  expect(
    (await run.tasks()).find((task: { id: number }) => task.id === attempt)
      .input.kind,
  ).toBe("verify");
  expect(acceptedArgument(await run.notes(), id)).toBe(
    `## ${id}\n\nComplete proof of P.\n`,
  );
  expect(
    run.requests.map(({ descriptor }) =>
      descriptor.kind === "verifier" ? descriptor.name : descriptor.kind,
    ),
  ).toEqual([
    "explorer",
    "selection",
    "source",
    "correctness",
    "requirements",
    "statement",
    "proof",
    "reconstruction",
  ]);
  const calls = run.provider.state.callCount;
  await run.reopen();
  await run.owner.root.waitForIdle(context);
  expect(run.provider.state.callCount).toBe(calls);
  expect(
    (await run.tasks()).some(
      (task: { kind: string }) => task.kind === "xean.campaign",
    ),
  ).toBe(false);
});

test.each([false, true])(
  "two Explorers retain independent IDs and prose when publication order reverses=%s",
  async (reverse) => {
    const arrived = Promise.withResolvers<void>();
    const releases = [
      Promise.withResolvers<void>(),
      Promise.withResolvers<void>(),
    ];
    const namespaces: string[] = [];
    const run = await fixture(
      async (request): Promise<Awaited<ReturnType<Respond>>> => {
        const { descriptor } = request;
        if (descriptor.kind !== "explorer") return complete(request);
        const slot = namespaces.push(descriptor.input.namespace) - 1;
        if (namespaces.length === 2) arrived.resolve();
        await releases[slot]!.promise;
        const lemma = `${descriptor.input.namespace}.1`;
        return {
          notes: [
            note(`Lemma ${lemma}.`),
            note(`Consequence cites ${lemma} verbatim.`, [lemma]),
          ],
        };
      },
    );
    const ids = await Promise.all([
      run.create({ kind: "explorer" }),
      run.create({ kind: "explorer" }),
    ]);
    const pending = ids.map((id) => run.wait(id));
    await arrived.promise;
    expect(new Set(namespaces).size).toBe(2);
    const first = reverse ? 1 : 0;
    releases[first]!.resolve();
    await pending[first];
    releases[1 - first]!.resolve();
    expect((await pending[1 - first])!.state.outcome.status).toBe("completed");
    const notes = await run.notes();
    expect(notes).toHaveLength(4);
    for (const namespace of namespaces) {
      expect(notes.find((n) => n.id === `${namespace}.2`)).toMatchObject({
        text: `Consequence cites ${namespace}.1 verbatim.`,
        support: [`${namespace}.1`],
      });
      expect(notes.findIndex((n) => n.id === `${namespace}.1`)).toBeLessThan(
        notes.findIndex((n) => n.id === `${namespace}.2`),
      );
    }
  },
);

test("inspection observes live and suspended native work without invoking a model", async () => {
  const started = Promise.withResolvers<void>();
  let suspend = true;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (suspend) {
        started.resolve();
        await abortable(request.signal);
        return new Error("Suspended");
      }
      return complete(request);
    },
  );
  const id = await run.create({
    kind: "explorer",
    guidance: "Frozen direction.",
  });
  const pending = run.wait(id).catch(() => {});
  await started.promise;
  const inspectWorker = () =>
    inspect(run.path, async (tx) =>
      JSON.parse(JSON.stringify(await tx.task(id))),
    );
  const live = await inspectWorker();
  expect(live).toMatchObject({ id, kind: "xean.worker" });
  expect(live.state.status).not.toBe("terminal");
  const calls = run.provider.state.callCount;
  await run.owner.close();
  await pending;
  const suspended = await inspectWorker();
  expect(suspended.input).toEqual(live.input);
  expect(suspended.state.status).not.toBe("terminal");
  expect(await inspectWorker()).toEqual(suspended);
  expect(run.provider.state.callCount).toBe(calls);
  suspend = false;
  await run.reopen();
  expect((await run.wait(id)).state.outcome.status).toBe("completed");
  expect((await inspectWorker()).input).toEqual(live.input);
  expect(run.provider.state.callCount).toBe(calls + 1);
});

test("retry retains Explorer namespace and input despite unrelated publication and queued caller notes", async () => {
  let fail = true;
  const run = await fixture((request) => {
    if (request.descriptor.kind === "explorer" && fail) {
      fail = false;
      return new Error("Explorer disconnected");
    }
    return complete(request);
  });
  const first = await run.run({
    kind: "explorer",
    guidance: "Frozen direction.",
  });
  expect(first.outcome.status).toBe("faulted");
  await run.run({ kind: "explorer" });
  await run.owner.root.commit(
    (tx) =>
      submitNotes(tx, run.owner.root.id, "caller", {
        notes: [note("Queued literature.")],
      }),
    context,
  );
  const retry = await run.run({ kind: "retry", task: first.id });
  expect(retry.outcome.status).toBe("completed");
  expect(run.requests.at(-1)!.descriptor).toEqual(run.requests[0]!.descriptor);
  expect((await run.notes()).some((n) => n.id === `w${first.id}.1`)).toBe(true);
  expect((await run.book()).inputs[0]!.consumed).toBe(false);
});

test("completed statement and proof receipts survive abort and verifier retry", async () => {
  const started = Promise.withResolvers<void>();
  let hold = true;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "reconstruction" && hold) {
        started.resolve();
        await abortable(request.signal);
        return new Error("Aborted");
      }
      return complete(request);
    },
  );
  await run.run({ kind: "explorer" });
  const first = await run.create({ kind: "verifier" });
  const pending = run.wait(first);
  await started.promise;
  const before = await run.book();
  expect(before.checks).toHaveLength(3);
  await run.owner.harness.abortTask(first, context);
  expect((await pending).state.outcome.status).toBe("aborted");
  hold = false;
  const count = run.provider.state.callCount;
  const retry = await run.run({ kind: "retry", task: first });
  expect(retry.outcome.status).toBe("completed");
  expect(run.provider.state.callCount - count).toBe(1);
  const after = await run.book();
  expect(after.checks.slice(0, 3)).toEqual(before.checks);
  expect(
    after.checks.every(
      (check) => check.candidate === before.checks[0]!.candidate,
    ),
  ).toBe(true);
  expect(project(after).accepted).toHaveLength(1);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "statement"),
  ).toHaveLength(1);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "proof"),
  ).toHaveLength(1);
});

test("two Verifiers cannot claim the same target after selecting it concurrently", async () => {
  const selected = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let selections = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "selection") {
        if (++selections === 2) selected.resolve();
        await release.promise;
      }
      return complete(request);
    },
  );
  await run.run({ kind: "explorer" });
  const ids = await Promise.all([
    run.create({ kind: "verifier" }),
    run.create({ kind: "verifier" }),
  ]);
  const pending = ids.map((id) => run.wait(id));
  await selected.promise;
  release.resolve();
  const results = (await Promise.all(pending)).map(
    (task) => task.state.outcome,
  );
  expect(results.every((result) => result.status === "completed")).toBe(true);
  expect(
    results
      .map(
        (result) =>
          result.status === "completed" &&
          (result.result as { status: string }).status,
      )
      .sort(),
  ).toEqual(["busy", "completed"]);
  expect(
    run.requests.filter(
      ({ descriptor }) =>
        descriptor.kind === "verifier" && descriptor.name === "source",
    ),
  ).toHaveLength(1);
  expect((await run.book()).checks).toHaveLength(4);
});

test("queued caller literature gets stable admission IDs before fresh exploration", async () => {
  const run = await fixture();
  const supplied = { notes: [note("Supplied literature.")] };
  await run.owner.root.commit(
    (tx) => submitNotes(tx, run.owner.root.id, "literature", supplied),
    context,
  );
  expect(await run.notes()).toEqual([]);
  await run.run({ kind: "explorer" });
  const descriptor = run.requests[0]!.descriptor;
  if (descriptor.kind !== "explorer") throw new Error("Expected Explorer");
  expect(descriptor.input.notes).toHaveLength(1);
  expect(descriptor.input.notes[0]!.id).toMatch(/^i[0-9]+\.1$/);
  expect((await run.book()).inputs[0]!.consumed).toBe(true);
  expect(await run.notes()).toHaveLength(2);
});

test("current adverse evidence invalidates a root even when another check finishes later", async () => {
  const run = await fixture();
  const explored = await run.run({ kind: "explorer" });
  const target = `w${explored.id}.1`;
  await run.run({ kind: "verifier" });
  const previous = await run.book();
  expect(project(previous).accepted).toEqual([target]);
  await run.owner.root.commit(async (tx) => {
    const { Notebook } = await import("../src/state.ts");
    const book = await tx.doc(Notebook, run.owner.root.id);
    book.checks.push({
      candidate: 999,
      call: 999,
      values: [
        {
          verifier: "correctness",
          note: target,
          verdict: "FAIL",
          report: "Counterexample.",
        },
      ],
    });
  }, context);
  expect(project(await run.book()).accepted).toEqual([]);
  expect((await run.notes())[0]!.dead).toBe(true);
});

test("another publisher can finish between an append and its Pi rollback recovery", async () => {
  const run = await fixture((request) =>
    request.descriptor.kind === "explorer"
      ? { notes: [note(`Proof ${request.descriptor.input.explorerGuidance}.`)] }
      : complete(request),
  );
  const original = NoteStore.prototype.append;
  let interrupted = false;
  const append = spyOn(NoteStore.prototype, "append").mockImplementation(
    function (this: NoteStore, requestId, notes) {
      const version = original.call(this, requestId, notes);
      if (
        !interrupted &&
        Object.values(notes).some((note) => note.text === "Proof A.")
      ) {
        interrupted = true;
        throw new Error("Interrupted after append before Pi commit");
      }
      return version;
    },
  );
  let first: Awaited<ReturnType<typeof run.run>>;
  try {
    first = await run.run({ kind: "explorer", guidance: "A" });
  } finally {
    append.mockRestore();
  }
  expect(first!.outcome.status).toBe("faulted");
  expect(await run.notes()).toEqual([]);
  const second = await run.run({ kind: "explorer", guidance: "B" });
  expect(second.outcome.status).toBe("completed");
  expect((await run.notes()).map((note) => note.id)).toEqual([
    `w${second.id}.1`,
  ]);
  using store = new NoteStore(`${run.path}.notes.sqlite`);
  expect(store.snapshot()).toBe(2);
  store.commit(
    2,
    { [`w${first!.id}.1`]: { text: "External edit." } },
    "external",
  );
  const count = run.provider.state.callCount;
  await run.reopen();
  expect(
    (await run.run({ kind: "retry", task: first!.id })).outcome.status,
  ).toBe("completed");
  expect(run.provider.state.callCount).toBe(count);
  expect(store.snapshot()).toBe(3);
  expect((await run.notes()).map(({ id, text }) => ({ id, text }))).toEqual([
    { id: `w${first!.id}.1`, text: "Proof A." },
    { id: `w${second.id}.1`, text: "Proof B." },
  ]);
  expect(store.read().notes[`w${first!.id}.1`]!.text).toBe("External edit.");
});

test.each(["PASS", "FAIL"] as const)(
  "an in-flight claim keeps its positive evidence frozen but respects a concurrent ancestor %s",
  async (outsideVerdict) => {
    let ancestor = "",
      root = "";
    const rootStarted = Promise.withResolvers<void>();
    const releaseRoot = Promise.withResolvers<void>();
    const run = await fixture(
      async (request): Promise<Awaited<ReturnType<Respond>>> => {
        const { descriptor } = request;
        if (descriptor.kind === "explorer") {
          ancestor = `${descriptor.input.namespace}.1`;
          root = `${descriptor.input.namespace}.2`;
          return {
            notes: [
              note("Generated lemma."),
              note("Candidate from lemma.", [ancestor]),
            ],
          };
        }
        if (
          descriptor.kind === "verifier" &&
          descriptor.name === "source" &&
          descriptor.judged.includes(root)
        ) {
          rootStarted.resolve();
          await releaseRoot.promise;
        }
        if (
          descriptor.kind === "verifier" &&
          descriptor.name === "correctness" &&
          descriptor.judged.includes(ancestor)
        )
          return {
            verdicts: [
              {
                note: ancestor,
                verdict: outsideVerdict,
                report: "Concurrent assessment.",
              },
            ],
          };
        return complete(request);
      },
    );
    await run.run({ kind: "explorer" });
    await run.owner.root.commit(async (tx) => {
      const { Notebook } = await import("../src/state.ts");
      (await tx.doc(Notebook, run.owner.root.id)).checks.push({
        candidate: 1000,
        call: 1000,
        values: [
          {
            note: ancestor,
            verifier: "source",
            verdict: "PASS",
            report: "Prior source.",
          },
          {
            note: ancestor,
            verifier: "correctness",
            verdict: "PASS",
            report: "Prior correctness.",
          },
        ],
      });
    }, context);
    const first = await run.create({
      kind: "verifier",
      verify: [
        {
          note: root,
          verifiers: ["source", "correctness"],
        },
      ],
    });
    const pending = run.wait(first);
    await rootStarted.promise;
    expect(
      (
        await run.run({
          kind: "verifier",
          verify: [
            {
              note: ancestor,
              verifiers: [
                "source",
                "correctness",
                "requirements",
                "reconstruction",
              ],
            },
          ],
        })
      ).outcome,
    ).toMatchObject({ status: "completed", result: { status: "completed" } });
    releaseRoot.resolve();
    expect((await pending).state.outcome.status).toBe("completed");
    if (outsideVerdict === "FAIL") {
      expect((await run.notes()).find((note) => note.id === root)!.dead).toBe(
        true,
      );
      expect(
        run.requests.some(
          ({ descriptor }) =>
            descriptor.kind === "verifier" &&
            descriptor.name === "correctness" &&
            descriptor.judged.includes(root),
        ),
      ).toBe(false);
      expect(project(await run.book()).accepted).toEqual([]);
    } else {
      const correctness = run.requests.find(
        ({ descriptor }) =>
          descriptor.kind === "verifier" &&
          descriptor.name === "correctness" &&
          descriptor.judged.includes(root),
      )!.descriptor;
      if (correctness.kind !== "verifier")
        throw new Error("Missing correctness call");
      expect(correctness.input.support.map((note) => note.id)).toEqual([
        ancestor,
      ]);
      expect(
        correctness.input.support[0]!.verdicts.some(
          (value) => value.verifier === "reconstruction",
        ),
      ).toBe(false);
      expect(
        (await run.notes()).find((note) => note.id === root)!.verified,
      ).toBe(true);
    }
  },
);
