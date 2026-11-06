import { expect, spyOn, test } from "bun:test";
import * as roleRuntime from "../src/role-runtime.ts";
import type { Respond } from "./worker-fixture.ts";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import { acceptedArgument, project, submitNotes } from "../src/index.ts";
import { fixture, complete, note, abortable } from "./worker-fixture.ts";

function explorerNoteId(
  run: Awaited<ReturnType<typeof fixture>>,
  job: { id: string },
) {
  const work = run.history().find((row) => row.id === job.id)?.args.work;
  if (work?.kind !== "explorer")
    throw new Error("Missing frozen Explorer input");
  return `${work.input.namespace}.1`;
}

test("independent Explorer and Verifier publish knowledge without a campaign or Coordinator", async () => {
  const run = await fixture();
  const explored = await run.run({
    kind: "explorer",
    guidance: "Prove P directly.",
  });
  expect(explored.outcome.kind).toBe("done");
  const id = explorerNoteId(run, explored);
  expect(await run.notes()).toMatchObject([
    { id, summary: "Complete proof of P.", verified: false },
  ]);
  const checked = await run.run({ kind: "verifier" });
  expect(checked.outcome.kind).toBe("done");
  const book = await run.book();
  expect(project(book).accepted).toEqual([id]);
  expect(book.checks).toHaveLength(4);
  expect(new Set(book.checks.map((check) => check.candidate)).size).toBe(1);
  const attempt = book.checks[0]!.candidate;
  expect(attempt).toBe(checked.origin);
  expect(
    run.history().find((row) => row.id === checked.id)?.state.claim?.verify,
  ).toHaveLength(1);
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
    await run.owner.change((data) =>
      submitNotes(data, "seed", { notes: [note("Imported premise.")] }),
    );
    const ids = await Promise.all([
      run.start({ kind: "explorer" }),
      run.start({ kind: "explorer" }),
    ]);
    const pending = ids.map((id) => run.wait(id));
    await arrived.promise;
    expect(new Set(namespaces).size).toBe(2);
    expect([...namespaces].sort()).toEqual(["w2", "w3"]);
    const first = reverse ? 1 : 0;
    releases[first]!.resolve();
    await pending[first];
    releases[1 - first]!.resolve();
    expect((await pending[1 - first])!.kind).toBe("done");
    const notes = await run.notes();
    expect(notes).toHaveLength(5);
    expect(notes[0]!.id).toBe("i1.1");
    expect(new Set(notes.map(({ id }) => id)).size).toBe(notes.length);
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

test("inspection and passive reopen observe suspended native work without executing it", async () => {
  const started = Promise.withResolvers<void>();
  let suspend = true;
  const run = await fixture(async (request) => {
    if (suspend) {
      started.resolve();
      await abortable(request.signal);
    }
    return complete(request);
  });
  const job = await run.start({
    kind: "explorer",
    guidance: "Frozen direction.",
  });
  await started.promise;
  const live = run.running().find((row) => row.id === job.id)!;
  const tasks = await run.tasks();
  expect(live.phase).toBe("running");
  if (live.phase === "blocked") throw new Error("Unexpected blocked job");
  expect((await run.data()).history).toEqual([]);
  const count = run.provider.state.callCount;
  await run.owner.close();
  const suspended = await run.tasks();
  expect(suspended.map((task: { id: number }) => task.id)).toEqual(
    tasks.map((task: { id: number }) => task.id),
  );
  await run.reopen(false);
  expect((await run.data()).history).toEqual([]);
  expect(run.provider.state.callCount).toBe(count);
  expect(await run.tasks()).toEqual(suspended);
  suspend = false;
  await run.reopen();
  await run.finished(job.id);
  expect(run.history().find((row) => row.id === job.id)?.args).toEqual(
    live.args,
  );
  expect(run.provider.state.callCount).toBe(count + 1);
  expect((await run.notes())[0]!.id).toBe(explorerNoteId(run, job));
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
  expect(first.outcome.kind).toBe("failed");
  await run.run({ kind: "explorer" });
  await run.owner.change((data) =>
    submitNotes(data, "caller", { notes: [note("Queued literature.")] }),
  );
  const retry = await run.run({ kind: "retry", job: first.id });
  expect(retry.outcome.kind).toBe("done");
  expect(run.requests.at(-1)!.descriptor).toEqual(run.requests[0]!.descriptor);
  expect(
    (await run.notes()).some((n) => n.id === explorerNoteId(run, first)),
  ).toBe(true);
  expect((await run.book()).inputs[0]!.consumed).toBe(false);
  expect(explorerNoteId(run, first)).toBe("w1.1");
  await run.reopen();
  await run.owner.change((data) =>
    submitNotes(data, "caller", { notes: [note("Queued literature.")] }),
  );
  const fresh = await run.run({ kind: "explorer" });
  expect(explorerNoteId(run, fresh)).toBe("w4.1");
  expect((await run.notes()).map(({ id }) => id).sort()).toEqual([
    "i3.1",
    "w1.1",
    "w2.1",
    "w4.1",
  ]);
});

test("completed statement and proof receipts survive a failed comparison and explicit retry", async () => {
  let fail = true;
  const run = await fixture((request) => {
    if (request.descriptor.kind === "reconstruction" && fail) {
      fail = false;
      return new Error("401 comparison interrupted");
    }
    return complete(request);
  });
  await run.run({ kind: "explorer" });
  const first = await run.run({ kind: "verifier" });
  expect(first.outcome.kind).toBe("failed");
  const before = await run.book();
  expect(before.checks).toHaveLength(3);
  const count = run.provider.state.callCount;
  const retry = await run.run({ kind: "retry", job: first.id });
  expect(retry.outcome.kind).toBe("done");
  expect(retry.origin).toBe(first.id);
  expect(run.provider.state.callCount - count).toBe(1);
  const after = await run.book();
  expect(after.checks.slice(0, 3)).toEqual(before.checks);
  expect(after.checks.every((check) => check.candidate === first.id)).toBe(
    true,
  );
  expect(project(after).accepted).toHaveLength(1);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "statement"),
  ).toHaveLength(1);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "proof"),
  ).toHaveLength(1);
  await expect(run.start({ kind: "retry", job: first.id })).rejects.toThrow(
    "superseded",
  );
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
      note: explorerNoteId(run, explored),
      verifiers: [
        "source",
        "correctness",
        "requirements",
        "reconstruction",
      ] as const,
    },
  ];
  const ids = await run.startGroup([
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
  ]);
  const pending = ids.map((id) => run.wait(id));
  await checking.promise;
  expect(await Promise.race(pending)).toMatchObject({
    kind: "done",
    result: { status: "busy" },
  });
  release.resolve();
  const results = await Promise.all(pending);
  expect(
    results
      .map(
        (result) =>
          result.kind === "done" &&
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
  const ids = await run.startGroup([
    { kind: "verifier" },
    { kind: "verifier" },
  ]);
  const results = await Promise.all(ids.map((id) => run.wait(id)));
  expect(
    results
      .map(
        (result) =>
          result.kind === "done" &&
          (result.result as { status: string }).status,
      )
      .sort(),
  ).toEqual(["completed", "no-work"]);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(1);
  const workers = run.history();
  expect(
    ids
      .map((job) => {
        const work = workers.find((row) => row.id === job.id)!.args.work;
        if (work.kind !== "selector")
          throw new Error("Expected selector input");
        return work.input.notes.length;
      })
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
  const first = await run.start({ kind: "verifier" });
  const pending = run.wait(first);
  let second: ReturnType<typeof run.wait> | undefined;
  try {
    await selecting.promise;
    await expect(
      run.startGroup([{ kind: "explorer" }, { kind: "explorer" }]),
    ).rejects.toThrow("maxWorkers");
    const empty = await run.run({ kind: "verifier" });
    expect(empty.outcome).toMatchObject({
      kind: "done",
      result: { status: "no-work" },
    });
    expect(views).toEqual([notes]);
    releaseSelection.resolve();
    await firstSource.promise;
    second = run.wait(await run.start({ kind: "verifier" }));
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
  expect(first.outcome.kind).toBe("failed");
  const before = run.requests.find(
    ({ descriptor }) => descriptor.kind === "selection",
  )!.descriptor;
  if (before.kind !== "selection") throw new Error("Missing selection");
  expect(before.input.notes.map((note) => note.id)).toEqual([
    explorerNoteId(run, firstNote),
  ]);
  const added = await run.run({ kind: "explorer" });
  expect((await run.run({ kind: "retry", job: first.id })).outcome.kind).toBe(
    "done",
  );
  const selections = run.requests.filter(
    ({ descriptor }) => descriptor.kind === "selection",
  );
  expect(selections).toHaveLength(2);
  expect(selections[1]!.descriptor).toEqual(before);
  expect(
    before.input.notes.some((note) => note.id === explorerNoteId(run, added)),
  ).toBe(false);
});

test("queued caller literature gets stable admission IDs before fresh exploration", async () => {
  const run = await fixture();
  const supplied = { notes: [note("Supplied literature.")] };
  await run.owner.change((data) => submitNotes(data, "literature", supplied));
  expect(await run.notes()).toEqual([]);
  await run.run({ kind: "explorer" });
  const descriptor = run.requests[0]!.descriptor;
  if (descriptor.kind !== "explorer") throw new Error("Expected Explorer");
  expect(descriptor.input.notes).toHaveLength(1);
  expect(descriptor.input.notes[0]!.id).toMatch(/^i[^.]+\.1$/);
  expect((await run.book()).inputs[0]!.consumed).toBe(true);
  expect(await run.notes()).toHaveLength(2);
});

test("current adverse evidence invalidates a root even when another check finishes later", async () => {
  const run = await fixture();
  const explored = await run.run({ kind: "explorer" });
  const target = explorerNoteId(run, explored);
  await run.run({ kind: "verifier" });
  const previous = await run.book();
  expect(project(previous).accepted).toEqual([target]);
  await run.owner.change((data) => {
    const book = data.notebook;
    book.checks.push({
      candidate: "external",
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
  });
  expect(project(await run.book()).accepted).toEqual([]);
  expect((await run.notes())[0]!.dead).toBe(true);
});

test("another publisher can finish between an append and its Chord rollback recovery", async () => {
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
        throw new Error("Interrupted after append before Chord commit");
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
  expect(first!.outcome.kind).toBe("failed");
  expect(await run.notes()).toEqual([]);
  const second = await run.run({ kind: "explorer", guidance: "B" });
  expect(second.outcome.kind).toBe("done");
  expect((await run.notes()).map((note) => note.id)).toEqual([
    explorerNoteId(run, second),
  ]);
  using store = new NoteStore(`${run.path}.notes.sqlite`);
  expect(store.snapshot()).toBe(2);
  store.commit(
    2,
    { [explorerNoteId(run, first!)]: { text: "External edit." } },
    "external",
  );
  const count = run.provider.state.callCount;
  await run.reopen();
  expect((await run.run({ kind: "retry", job: first!.id })).outcome.kind).toBe(
    "done",
  );
  expect(run.provider.state.callCount).toBe(count);
  expect(store.snapshot()).toBe(3);
  expect((await run.notes()).map(({ id, text }) => ({ id, text }))).toEqual([
    { id: explorerNoteId(run, first!), text: "Proof A." },
    { id: explorerNoteId(run, second), text: "Proof B." },
  ]);
  expect(store.read().notes[explorerNoteId(run, first!)]!.text).toBe(
    "External edit.",
  );
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
    const ids = await run.startGroup(
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
        kind: "done",
        result: { status: "completed" },
      });
      expect(
        (await run.notes()).find((note) => note.id === ancestor)!.dead,
      ).toBe(true);
    }
    release.resolve();
    for (const result of await Promise.all(pending))
      expect(result).toMatchObject({
        kind: "done",
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
  const ids = await run.startGroup([
    { kind: "verifier" },
    { kind: "verifier" },
  ]);
  const entries = [...run.running(), ...run.history()];
  const views = ids.map((job) => {
    const entry = entries.find((row) => row.id === job.id)!;
    if ("phase" in entry && entry.phase === "blocked")
      throw new Error("Blocked selector");
    const work = entry.args.work;
    if (work.kind !== "selector") throw new Error("Expected selector");
    return work.input.notes;
  });
  const original = (await run.notes()).map((note) => note.id);
  const listed = views.flatMap((notes) => notes.map((note) => note.id));
  expect(new Set(listed).size).toBe(listed.length);
  expect(new Set(listed)).toEqual(new Set(original));
  for (const view of views)
    expect(view.map((note) => note.id)).toEqual(
      original.filter((id) => view.some((note) => note.id === id)),
    );
  for (const result of await Promise.all(ids.map((id) => run.wait(id))))
    expect(result).toMatchObject({
      kind: "done",
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
    kind: "done",
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
            note: explorerNoteId(run, explored),
            verifiers: [
              "source",
              "correctness",
              "requirements",
              "reconstruction",
            ],
          },
        ],
      })
    ).outcome.kind,
  ).toBe("done");
  expect(project(await run.book()).accepted).toEqual([
    explorerNoteId(run, explored),
  ]);
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
  const both = await run.start({
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
    kind: "done",
    result: { status: "busy" },
  });
  expect(
    (
      await run.run({
        kind: "verifier",
        verify: [{ note: d, verifiers: ["source"] }],
      })
    ).outcome,
  ).toMatchObject({ kind: "done", result: { status: "completed" } });
  release.resolve();
  expect((await pending).kind).toBe("done");
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
  const ids = await run.startGroup([
    { kind: "explorer" },
    { kind: "verifier" },
  ]);
  const pending = ids.map((id) => run.wait(id));
  try {
    await both.promise;
    expect(liveCalls).toBe(2);
    expect((await run.notes()).map((note) => note.id)).toEqual([
      explorerNoteId(run, seed),
    ]);
    const selection = run.requests.find(
      ({ descriptor }) => descriptor.kind === "selection",
    )!.descriptor;
    expect(selection.input.notes.map((note) => note.id)).toEqual([
      explorerNoteId(run, seed),
    ]);
  } finally {
    release.resolve();
    for (const task of await Promise.all(pending))
      expect(task.kind).toBe("done");
  }
  expect((await run.notes()).map((note) => note.id)).toEqual([
    explorerNoteId(run, seed),
    explorerNoteId(run, ids[0]!),
  ]);
  expect(project(await run.book()).accepted).toEqual([
    explorerNoteId(run, seed),
  ]);
});

test("pending proof resumes the same Chord job and native generation without repeating earlier roles", async () => {
  const entered = Promise.withResolvers<void>(),
    recovered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let resuming = false;
  const run = await fixture(async (request) => {
    if (request.descriptor.kind === "proof") {
      if (!resuming) {
        entered.resolve();
        await abortable(request.signal);
      } else {
        recovered.resolve();
        await Promise.race([release.promise, abortable(request.signal)]);
      }
    }
    return complete(request);
  });
  await run.run({ kind: "explorer" });
  const job = await run.start({ kind: "verifier" });
  await entered.promise;
  const original = (await run.tasks()).findLast(
    (task: { kind: string; state: { status: string } }) =>
      task.kind === "pi.generation" && task.state.status !== "terminal",
  );
  const before = run.running().find((row) => row.id === job.id)!;
  await run.owner.close();
  resuming = true;
  await run.reopen();
  await recovered.promise;
  expect(run.running().map((row) => row.id)).toEqual([job.id]);
  const after = run.running().find((row) => row.id === job.id)!;
  if (before.phase === "blocked" || after.phase === "blocked")
    throw new Error("Unexpected blocked job");
  expect(after.state.claim).toEqual(before.state.claim);
  expect(
    (await run.tasks())
      .filter(
        (task: { conversationId: number; kind: string }) =>
          task.conversationId === original.conversationId &&
          task.kind === "pi.generation",
      )
      .map((task: { id: number }) => task.id),
  ).toEqual([original.id]);
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
    "proof",
  ]);
  release.resolve();
  expect((await run.finished(job.id)).status).toBe("completed");
  expect(project(await run.book()).accepted).toHaveLength(1);
});

test("a terminal Pi failure interrupted before Chord settlement stays failed on reopen", async () => {
  const failed = Promise.withResolvers<void>();
  const original = roleRuntime.createRoleRuntime;
  const factory = spyOn(roleRuntime, "createRoleRuntime").mockImplementation(
    (...args) => {
      const roles = original(...args),
        call = roles.call.bind(roles);
      return {
        ...roles,
        call: async (...input) => {
          try {
            return await call(...input);
          } catch (error) {
            failed.resolve();
            await input[0].closed;
            throw error;
          }
        },
      };
    },
  );
  let run: Awaited<ReturnType<typeof fixture>>;
  try {
    run = await fixture(() => new Error("401 upstream_unavailable"));
  } finally {
    factory.mockRestore();
  }
  const job = await run.start({ kind: "explorer" });
  await failed.promise;
  expect(run.history()).toEqual([]);
  expect(run.provider.state.callCount).toBe(1);
  const tasks = await run.tasks();
  await run.reopen();
  expect((await run.finished(job.id)).status).toBe("failed");
  expect(run.provider.state.callCount).toBe(1);
  expect(await run.tasks()).toEqual(tasks);
  expect(await run.notes()).toEqual([]);
});

test("a selection invalidated while its model is running finishes without checking dead notes", async () => {
  const selecting = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const run = await fixture(async (request) => {
    const d = request.descriptor;
    if (d.kind === "selection") {
      selecting.resolve();
      await Promise.race([release.promise, abortable(request.signal)]);
    }
    if (d.kind === "verifier" && d.name === "source")
      return {
        verdicts: d.judged.map((note) => ({
          note,
          verdict: "FAIL",
          report: "Counterexample before claim.",
        })),
      };
    return complete(request);
  });
  const explorer = await run.run({ kind: "explorer" }),
    id = explorerNoteId(run, explorer);
  const stale = await run.start({ kind: "verifier" });
  await selecting.promise;
  await run.run({
    kind: "verifier",
    verify: [{ note: id, verifiers: ["source"] }],
  });
  expect((await run.notes())[0]!.dead).toBe(true);
  const frozen = run.requests.find(
    (request) => request.descriptor.kind === "selection",
  )!.descriptor;
  expect(frozen.input.notes[0]!.dead).toBe(false);
  release.resolve();
  expect(await run.wait(stale)).toMatchObject({
    kind: "done",
    result: { status: "no-work" },
  });
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "verifier"),
  ).toHaveLength(1);
});
