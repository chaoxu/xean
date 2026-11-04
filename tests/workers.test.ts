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
  const child = (await run.tasks()).find(
    (task: { owner?: number; input: { kind: string } }) =>
      task.owner === first && task.input.kind === "verify",
  );
  expect(child.state.outcome.status).toBe("aborted");
  await expect(run.create({ kind: "retry", task: child.id })).rejects.toThrow(
    "belong",
  );
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

test("explicit duplicate verification claims still produce one busy result", async () => {
  const checking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (
        request.descriptor.kind === "verifier" &&
        request.descriptor.name === "source"
      ) {
        checking.resolve();
        await release.promise;
      }
      return complete(request);
    },
  );
  const explored = await run.run({ kind: "explorer" });
  const verify = [
    {
      note: `w${explored.id}.1`,
      verifiers: [
        "source",
        "correctness",
        "requirements",
        "reconstruction",
      ] as const,
    },
  ];
  const ids = await run.owner.root.commit(
    (tx) =>
      run.owner.workers.createGroup(tx, run.owner.root.id, [
        {
          kind: "verifier",
          verify: verify.map((entry) => ({
            ...entry,
            verifiers: [...entry.verifiers],
          })),
        },
        {
          kind: "verifier",
          verify: verify.map((entry) => ({
            ...entry,
            verifiers: [...entry.verifiers],
          })),
        },
      ]),
    context,
  );
  const pending = ids.map((id) => run.wait(id));
  await checking.promise;
  expect((await Promise.race(pending)).state.outcome).toMatchObject({
    status: "completed",
    result: { status: "busy" },
  });
  release.resolve();
  const results = (await Promise.all(pending)).map(
    (task) => task.state.outcome,
  );
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
    run.requests.some(({ descriptor }) => descriptor.kind === "selection"),
  ).toBe(false);
  expect(
    run.requests.filter(
      ({ descriptor }) =>
        descriptor.kind === "verifier" && descriptor.name === "source",
    ),
  ).toHaveLength(1);
  expect((await run.book()).checks).toHaveLength(4);
});

test("an empty assigned view completes without calling the selector model", async () => {
  const run = await fixture();
  await run.run({ kind: "explorer" });
  const ids = await run.owner.root.commit(
    (tx) =>
      run.owner.workers.createGroup(tx, run.owner.root.id, [
        { kind: "verifier" },
        { kind: "verifier" },
      ]),
    context,
  );
  const results = (await Promise.all(ids.map((id) => run.wait(id)))).map(
    (task) => task.state.outcome,
  );
  expect(
    results
      .map(
        (result) =>
          result.status === "completed" &&
          (result.result as { status: string }).status,
      )
      .sort(),
  ).toEqual(["completed", "no-work"]);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(1);
  const workers = await run.tasks();
  expect(
    ids
      .map(
        (id) =>
          workers.find((task: { id: number }) => task.id === id).input.input
            .notes.length,
      )
      .sort(),
  ).toEqual([0, 1]);
});

test("pending selectors reserve their offered notes and release unselected notes when checking begins", async () => {
  const selecting = Promise.withResolvers<void>();
  const releaseSelection = Promise.withResolvers<void>();
  const firstSource = Promise.withResolvers<void>();
  const secondSource = Promise.withResolvers<void>();
  const releaseSources = Promise.withResolvers<void>();
  const views: string[][] = [];
  let sourceCalls = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer")
        return { notes: [note("First candidate."), note("Second candidate.")] };
      if (descriptor.kind === "selection") {
        views.push(descriptor.input.notes.map((note) => note.id));
        if (views.length === 1) {
          selecting.resolve();
          await Promise.race([
            releaseSelection.promise,
            abortable(request.signal),
          ]);
        }
        return {
          verify: [
            {
              note: descriptor.input.notes[0]!.id,
              verifiers: [
                "source",
                "correctness",
                "requirements",
                "reconstruction",
              ],
            },
          ],
        };
      }
      if (descriptor.kind === "verifier" && descriptor.name === "source") {
        if (++sourceCalls === 1) firstSource.resolve();
        if (sourceCalls === 2) secondSource.resolve();
        await Promise.race([releaseSources.promise, abortable(request.signal)]);
      }
      return complete(request);
    },
    { settings: { maxWorkers: 2 } },
  );
  await run.run({ kind: "explorer" });
  const notes = (await run.notes()).map((note) => note.id);
  const first = await run.create({ kind: "verifier" });
  const pending = run.wait(first);
  let second: ReturnType<typeof run.wait> | undefined;
  try {
    await selecting.promise;
    await expect(
      run.owner.root.commit(
        (tx) =>
          run.owner.workers.createGroup(tx, run.owner.root.id, [
            { kind: "explorer" },
            { kind: "explorer" },
          ]),
        context,
      ),
    ).rejects.toThrow("maxWorkers");
    const empty = await run.run({ kind: "verifier" });
    expect(empty.outcome).toMatchObject({
      status: "completed",
      result: { status: "no-work" },
    });
    expect(views).toEqual([notes]);
    releaseSelection.resolve();
    await firstSource.promise;
    second = run.wait(await run.create({ kind: "verifier" }));
    await secondSource.promise;
    expect(views).toEqual([notes, [notes[1]!]]);
  } finally {
    releaseSelection.resolve();
    releaseSources.resolve();
    await pending;
    if (second) await second;
  }
  expect(sourceCalls).toBe(2);
  expect(project(await run.book()).accepted).toEqual(notes);
});

test("retry keeps the selector's original note view after unrelated notes are published", async () => {
  let fail = true;
  const run = await fixture((request) => {
    if (request.descriptor.kind === "selection" && fail) {
      fail = false;
      return new Error("Selection interrupted");
    }
    return complete(request);
  });
  const firstNote = await run.run({ kind: "explorer" });
  const first = await run.run({ kind: "verifier" });
  expect(first.outcome.status).toBe("faulted");
  const before = run.requests.find(
    ({ descriptor }) => descriptor.kind === "selection",
  )!.descriptor;
  if (before.kind !== "selection") throw new Error("Missing selection");
  expect(before.input.notes.map((note) => note.id)).toEqual([
    `w${firstNote.id}.1`,
  ]);
  const added = await run.run({ kind: "explorer" });
  expect(
    (await run.run({ kind: "retry", task: first.id })).outcome.status,
  ).toBe("completed");
  const selections = run.requests.filter(
    ({ descriptor }) => descriptor.kind === "selection",
  );
  expect(selections).toHaveLength(2);
  expect(selections[1]!.descriptor).toEqual(before);
  expect(before.input.notes.some((note) => note.id === `w${added.id}.1`)).toBe(
    false,
  );
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

test.each(["pending", "failed"] as const)(
  "B and C verify concurrently assuming A while A is %s",
  async (dependencyState) => {
    let ancestor = "",
      b = "",
      c = "";
    const checking = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let started = 0;
    const run = await fixture(
      async (request): Promise<Awaited<ReturnType<Respond>>> => {
        const { descriptor } = request;
        if (descriptor.kind === "explorer") {
          ancestor = `${descriptor.input.namespace}.1`;
          b = `${descriptor.input.namespace}.2`;
          c = `${descriptor.input.namespace}.3`;
          return {
            notes: [
              note("PRIVATE_BODY_A"),
              note("Proof of B conditional on A.", [ancestor]),
              note("Proof of C conditional on A.", [ancestor]),
            ],
          };
        }
        if (
          descriptor.kind === "verifier" &&
          descriptor.name === "source" &&
          descriptor.judged.some((id) => id === b || id === c)
        ) {
          if (++started === 2) checking.resolve();
          await Promise.race([release.promise, abortable(request.signal)]);
        }
        if (
          dependencyState === "failed" &&
          descriptor.kind === "verifier" &&
          descriptor.name === "correctness" &&
          descriptor.judged.includes(ancestor)
        )
          return {
            verdicts: [
              {
                note: ancestor,
                verdict: "FAIL",
                report: "LATE_A_COUNTEREXAMPLE",
              },
            ],
          };
        return complete(request);
      },
      { settings: { maxWorkers: dependencyState === "failed" ? 3 : 2 } },
    );
    await run.run({ kind: "explorer" });
    const ids = await run.owner.root.commit(
      (tx) =>
        run.owner.workers.createGroup(
          tx,
          run.owner.root.id,
          [b, c].map((note) => ({
            kind: "verifier",
            verify: [
              {
                note,
                verifiers: [
                  "source",
                  "correctness",
                  "requirements",
                  "reconstruction",
                ],
              },
            ],
          })),
        ),
      context,
    );
    const pending = ids.map((id) => run.wait(id));
    await checking.promise;
    expect(started).toBe(2);
    if (dependencyState === "failed") {
      const result = await run.run({
        kind: "verifier",
        verify: [
          {
            note: ancestor,
            verifiers: ["source", "correctness", "reconstruction"],
          },
        ],
      });
      expect(result.outcome).toMatchObject({
        status: "completed",
        result: { status: "completed" },
      });
      expect(
        (await run.notes()).find((note) => note.id === ancestor)!.dead,
      ).toBe(true);
    }
    release.resolve();
    for (const result of await Promise.all(pending))
      expect(result.state.outcome).toMatchObject({
        status: "completed",
        result: { status: "completed" },
      });
    const book = await run.book();
    expect(project(book).accepted).toEqual([]);
    for (const root of [b, c]) {
      const checks = book.checks.filter((check) =>
        check.values.some((value) => value.note === root),
      );
      expect(new Set(checks.map((check) => check.candidate)).size).toBe(1);
      expect(
        checks.flatMap((check) =>
          check.values
            .filter((value) => value.note === root)
            .map((value) => value.verifier),
        ),
      ).toEqual(["source", "correctness", "requirements", "reconstruction"]);
      const proof = run.requests.find(
        ({ descriptor }) =>
          descriptor.kind === "proof" &&
          descriptor.input.notes.some((note) => note.id === root),
      )!;
      if (proof.descriptor.kind !== "proof")
        throw new Error("Missing local proof");
      expect(proof.descriptor.input.notes.map((note) => note.id)).toEqual([
        root,
      ]);
      expect(proof.descriptor.input.support.map((note) => note.id)).toEqual([
        ancestor,
      ]);
      expect(JSON.stringify(proof.transcript)).toContain(
        `Exact claim ${ancestor}.`,
      );
      expect(JSON.stringify(proof.transcript)).not.toContain("PRIVATE_BODY_A");
      expect(JSON.stringify(proof.transcript)).not.toContain(
        "LATE_A_COUNTEREXAMPLE",
      );
    }
    if (dependencyState === "pending") {
      expect(
        book.checks.some((check) =>
          check.values.some((value) => value.note === ancestor),
        ),
      ).toBe(false);
      await run.run({
        kind: "verifier",
        verify: [
          {
            note: ancestor,
            verifiers: ["source", "correctness", "reconstruction"],
          },
        ],
      });
      expect(project(await run.book()).accepted).toEqual([b, c]);
    } else {
      expect(
        (await run.notes())
          .filter((note) => note.id === b || note.id === c)
          .every((note) => note.dead),
      ).toBe(true);
    }
  },
);

test("selector views partition targets and the checker receives direct dependencies separately", async () => {
  const run = await fixture((request) => {
    if (request.descriptor.kind === "explorer") {
      const first = `${request.descriptor.input.namespace}.1`;
      return {
        notes: [
          note("Shared prerequisite."),
          note("First root.", [first]),
          note("Second root.", [first]),
        ],
      };
    }
    return complete(request);
  });
  await run.run({ kind: "explorer" });
  const ids = await run.owner.root.commit(
    (tx) =>
      run.owner.workers.createGroup(tx, run.owner.root.id, [
        { kind: "verifier" },
        { kind: "verifier" },
      ]),
    context,
  );
  const tasks = await run.tasks();
  const views = ids.map(
    (id) =>
      tasks.find((task: { id: number }) => task.id === id).input.input
        .notes as { id: string }[],
  );
  const original = (await run.notes()).map((note) => note.id);
  const listed = views.flatMap((notes) => notes.map((note) => note.id));
  expect(new Set(listed).size).toBe(listed.length);
  expect(new Set(listed)).toEqual(new Set(original));
  for (const view of views)
    expect(view.map((note) => note.id)).toEqual(
      original.filter((id) => view.some((note) => note.id === id)),
    );
  for (const result of await Promise.all(ids.map((id) => run.wait(id))))
    expect(result.state.outcome).toMatchObject({
      status: "completed",
      result: { status: "completed" },
    });
  const proof = run.requests.find(
    ({ descriptor }) =>
      descriptor.kind === "proof" && descriptor.input.support.length,
  )!;
  expect(proof).toBeDefined();
  if (proof.descriptor.kind !== "proof")
    throw new Error("Missing conditional proof");
  expect(proof.descriptor.input.support.map((note) => note.id)).toEqual([
    original[0]!,
  ]);
});

test("retry returns a completed child's receipt when its aborted parent has a busy sibling", async () => {
  let holdSource = false;
  const checking = Promise.withResolvers<void>();
  const releaseSource = Promise.withResolvers<void>();
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (
        holdSource &&
        request.descriptor.kind === "verifier" &&
        request.descriptor.name === "source"
      ) {
        checking.resolve();
        await releaseSource.promise;
      }
      return complete(request);
    },
  );
  const explored = await run.run({ kind: "explorer" });
  const verify = [
    { note: `w${explored.id}.1`, verifiers: ["source"] as ["source"] },
  ];
  const collected = Promise.withResolvers<void>();
  const phases = run.owner.workers.Worker.definition.phases;
  const original = phases.collect;
  let holdCollect = true;
  const collect = spyOn(phases, "collect").mockImplementation(
    async (task, runtime, ctx) => {
      if (holdCollect) {
        holdCollect = false;
        collected.resolve();
        await abortable(runtime.signal);
        runtime.signal.throwIfAborted();
      }
      return original(task, runtime, ctx);
    },
  );
  const parent = await run.create({ kind: "verifier", verify });
  const pending = run.wait(parent);
  await collected.promise;
  const child = (await run.tasks()).find(
    (task: { owner?: number; input: { kind: string } }) =>
      task.owner === parent && task.input.kind === "verify",
  );
  expect(child.state.outcome.status).toBe("completed");
  try {
    await run.owner.harness.abortTask(parent, context);
    expect((await pending).state.outcome.status).toBe("aborted");
  } finally {
    collect.mockRestore();
  }
  holdSource = true;
  const sibling = await run.create({ kind: "verifier", verify });
  const siblingPending = run.wait(sibling);
  await checking.promise;
  const calls = run.provider.state.callCount;
  const retry = await run.create({ kind: "retry", task: parent });
  expect(retry).toBe(child.id);
  expect((await run.wait(retry)).state.outcome).toEqual(child.state.outcome);
  expect(run.provider.state.callCount).toBe(calls);
  await expect(run.create({ kind: "retry", task: child.id })).rejects.toThrow();
  releaseSource.resolve();
  expect((await siblingPending).state.outcome.status).toBe("completed");
});

test("solution-only selection defers a local lemma checklist until a full root is nominated", async () => {
  const run = await fixture(
    (request): ReturnType<Respond> => {
      if (request.descriptor.kind === "selection")
        return {
          verify: request.descriptor.input.notes.map((note) => ({
            note: note.id,
            verifiers: ["source", "correctness", "reconstruction"],
          })),
        };
      return complete(request);
    },
    { settings: { verifyOnSolution: true } },
  );
  const explored = await run.run({ kind: "explorer" });
  expect((await run.run({ kind: "verifier" })).outcome).toMatchObject({
    status: "completed",
    result: { status: "no-work", verify: [] },
  });
  expect((await run.book()).checks).toEqual([]);
  expect(run.requests.map(({ descriptor }) => descriptor.kind)).toEqual([
    "explorer",
    "selection",
  ]);
  expect(
    (
      await run.run({
        kind: "verifier",
        verify: [
          {
            note: `w${explored.id}.1`,
            verifiers: [
              "source",
              "correctness",
              "requirements",
              "reconstruction",
            ],
          },
        ],
      })
    ).outcome.status,
  ).toBe("completed");
  expect(project(await run.book()).accepted).toEqual([`w${explored.id}.1`]);
});

test("overlapping selected sets conflict atomically without reserving their nonoverlapping notes", async () => {
  let b = "",
    c = "",
    d = "";
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "explorer") {
        const namespace = request.descriptor.input.namespace;
        [b, c, d] = [1, 2, 3].map((n) => `${namespace}.${n}`) as [
          string,
          string,
          string,
        ];
        return { notes: [note("B."), note("C."), note("D.")] };
      }
      if (
        request.descriptor.kind === "verifier" &&
        request.descriptor.name === "source" &&
        request.descriptor.judged.includes(b)
      ) {
        started.resolve();
        await release.promise;
      }
      return complete(request);
    },
  );
  await run.run({ kind: "explorer" });
  const both = await run.create({
    kind: "verifier",
    verify: [b, c].map((note) => ({
      note,
      verifiers: ["source", "correctness", "requirements", "reconstruction"],
    })),
  });
  const pending = run.wait(both);
  await started.promise;
  const conflict = await run.run({
    kind: "verifier",
    verify: [c, d].map((note) => ({
      note,
      verifiers: ["source", "correctness", "requirements", "reconstruction"],
    })),
  });
  expect(conflict.outcome).toMatchObject({
    status: "completed",
    result: { status: "busy" },
  });
  expect(
    (
      await run.run({
        kind: "verifier",
        verify: [{ note: d, verifiers: ["source"] }],
      })
    ).outcome,
  ).toMatchObject({ status: "completed", result: { status: "completed" } });
  release.resolve();
  expect((await pending).state.outcome.status).toBe("completed");
  expect(
    run.requests
      .filter(
        ({ descriptor }) =>
          descriptor.kind === "verifier" && descriptor.name === "source",
      )
      .map(({ descriptor }) =>
        descriptor.kind === "verifier" ? descriptor.judged : [],
      ),
  ).toEqual([[b, c], [d]]);
});

test("one native admission can start an Explorer and Verifier over the same frozen notebook", async () => {
  const both = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let explorers = 0,
    liveCalls = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      const exploring = descriptor.kind === "explorer" && ++explorers > 1;
      const checking =
        descriptor.kind === "verifier" && descriptor.name === "source";
      if (exploring || checking) {
        if (++liveCalls === 2) both.resolve();
        await Promise.race([release.promise, abortable(request.signal)]);
      }
      return complete(request);
    },
    { settings: { maxWorkers: 2 } },
  );
  const seed = await run.run({ kind: "explorer" });
  const ids = await run.owner.root.commit(
    (tx) =>
      run.owner.workers.createGroup(tx, run.owner.root.id, [
        { kind: "explorer" },
        { kind: "verifier" },
      ]),
    context,
  );
  const pending = ids.map((id) => run.wait(id));
  try {
    await both.promise;
    expect(liveCalls).toBe(2);
    expect((await run.notes()).map((note) => note.id)).toEqual([
      `w${seed.id}.1`,
    ]);
    const selection = run.requests.find(
      ({ descriptor }) => descriptor.kind === "selection",
    )!.descriptor;
    expect(selection.input.notes.map((note) => note.id)).toEqual([
      `w${seed.id}.1`,
    ]);
  } finally {
    release.resolve();
    for (const task of await Promise.all(pending))
      expect(task.state.outcome.status).toBe("completed");
  }
  expect((await run.notes()).map((note) => note.id)).toEqual([
    `w${seed.id}.1`,
    `w${ids[0]}.1`,
  ]);
  expect(project(await run.book()).accepted).toEqual([`w${seed.id}.1`]);
});
