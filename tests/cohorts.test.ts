import { expect, spyOn, test } from "bun:test";
import { Notebook as NoteStore } from "@chaoxu/notebook-store";
import type { Respond } from "./worker-fixture.ts";
import * as verification from "../src/verification.ts";
import { project } from "../src/state.ts";
import { initialCampaign } from "../src/workflow.ts";
import { inspect, readStatus } from "../src/index.ts";
import {
  fixture,
  complete,
  abortable,
  note,
  context,
} from "./worker-fixture.ts";
import { verifierNames } from "../src/policy/contracts.ts";
const all = [...verifierNames];
async function observed<T>(
  promise: Promise<T>,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${description}`)),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const pause = () => Promise.withResolvers<void>();

test("an accepted proof waits for an unrelated failed peer to settle", async () => {
  const release = pause(),
    checked = pause();
  let unrelated = "";
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const d = request.descriptor;
      if (d.kind === "explorer") {
        unrelated = `${d.input.namespace}.2`;
        return {
          notes: [note("Complete proof."), note("Unrelated argument.")],
        };
      }
      if (
        d.kind === "verifier" &&
        d.name === "source" &&
        d.judged.includes(unrelated)
      ) {
        await Promise.race([release.promise, abortable(request.signal)]);
        return new Error("401 unrelated Verifier failed");
      }
      if (d.kind === "reconstruction") checked.resolve();
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 1 } },
  );
  const done = run.owner.wait();
  try {
    await observed(checked.promise, "candidate reconstruction");
    await observed(
      (async () => {
        while (!project(await run.book()).accepted.length) await Bun.sleep(5);
      })(),
      "accepted projection",
    );
    expect(run.running()).toHaveLength(1);
    expect(await inspect(run.path, readStatus)).toMatchObject({
      outcome: "running",
      accepted: null,
    });
    release.resolve();
    expect(await done).toMatchObject({ outcome: "accepted", turns: 1 });
    expect(run.running()).toHaveLength(0);
    expect(
      run.history().filter((row) => row.status === "failed"),
    ).toMatchObject([{ state: { claim: { verify: [{ note: unrelated }] } } }]);
  } finally {
    release.resolve();
    await done;
  }
});

test("verification refills capacity while another Explorer remains running", async () => {
  const exploring = pause(),
    firstSource = pause(),
    bothSources = pause();
  const releases = [pause(), pause()],
    releaseChecks = pause();
  let explorers = 0,
    sources = 0;
  const selected: string[] = [];
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const descriptor = request.descriptor;
      if (descriptor.kind === "explorer") {
        const slot = explorers++;
        if (explorers === 2) exploring.resolve();
        await Promise.race([
          releases[slot]!.promise,
          abortable(request.signal),
        ]);
      }
      if (descriptor.kind === "selection") {
        const target = descriptor.input.notes.find(
          (note) => !note.dead && !note.checked,
        )!.id;
        selected.push(target);
        return { verify: [{ note: target, verifiers: all }] };
      }
      if (descriptor.kind === "verifier" && descriptor.name === "source") {
        if (++sources === 1) firstSource.resolve();
        if (sources === 2) bothSources.resolve();
        await Promise.race([releaseChecks.promise, abortable(request.signal)]);
      }
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 2 } },
  );
  const done = run.owner.wait();
  try {
    await observed(exploring.promise, "two Explorers");
    releases[0]!.resolve();
    await observed(firstSource.promise, "mixed work");
    expect(
      run
        .running()
        .map((row) =>
          row.phase === "blocked" ? "blocked" : row.args.work.kind,
        )
        .sort(),
    ).toEqual(["explorer", "selector"]);
    expect(await run.notes()).toHaveLength(1);
    await expect(run.start({ kind: "explorer" })).rejects.toThrow(
      "settle or resume",
    );
    releases[1]!.resolve();
    await observed(bothSources.promise, "two Verifiers");
    expect(run.running()).toHaveLength(2);
    expect(explorers).toBe(2);
    expect(new Set(selected).size).toBe(2);
    expect((await inspect(run.path, readStatus)).status).not.toBe("terminal");
  } finally {
    releases.forEach((release) => release.resolve());
    releaseChecks.resolve();
    await done;
  }
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "accepted",
    turns: 2,
    status: "terminal",
  });
  expect((await run.book()).checks).toHaveLength(8);
});

test("a hung Explorer prevents final acceptance and recovers on active reopen", async () => {
  const started = pause(),
    checked = pause();
  let explorers = 0,
    hold = true,
    hung = "";
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const d = request.descriptor;
      if (
        d.kind === "explorer" &&
        (++explorers === 2 || d.input.namespace === hung)
      ) {
        hung = d.input.namespace;
        started.resolve();
        if (hold) await abortable(request.signal);
      }
      if (d.kind === "reconstruction") checked.resolve();
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 2 } },
  );
  const pending = run.owner.wait().catch(() => undefined);
  await observed(started.promise, "hung Explorer");
  await observed(checked.promise, "first proof checked");
  while (!run.history().some((row) => row.args.work.kind !== "explorer"))
    await Bun.sleep(5);
  expect(project(await run.book()).accepted).toHaveLength(1);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "running",
    accepted: null,
  });
  const calls = run.provider.state.callCount;
  await run.owner.close();
  await pending;
  expect((await inspect(run.path, readStatus)).status).not.toBe("terminal");
  hold = false;
  await run.reopen();
  await run.owner.wait();
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "accepted",
  });
  expect(run.provider.state.callCount).toBe(calls + 1);
  expect(
    run.requests.filter(
      ({ descriptor }) =>
        descriptor.kind === "explorer" && descriptor.input.namespace === hung,
    ),
  ).toHaveLength(2);
});

test("provisional acceptance waits for an unpublished adverse receipt and explicit resume", async () => {
  const accepted = pause();
  let ancestor = "",
    root = "",
    explorers = 0,
    interrupted = false;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const d = request.descriptor;
      if (d.kind === "explorer") {
        if (++explorers === 1) {
          ancestor = `${d.input.namespace}.1`;
          return { notes: [note("Generated lemma.")] };
        }
        root = `${d.input.namespace}.1`;
        return { notes: [note("Final candidate.", [ancestor])] };
      }
      if (d.kind === "selection")
        return {
          verify: root
            ? d.input.notes.map((note) => ({ note: note.id, verifiers: all }))
            : [],
        };
      if (
        root &&
        d.kind === "verifier" &&
        d.name === "source" &&
        d.judged.includes(ancestor)
      ) {
        await Promise.race([accepted.promise, abortable(request.signal)]);
        return {
          verdicts: [
            { note: ancestor, verdict: "FAIL", report: "False prerequisite." },
          ],
        };
      }
      return complete(request);
    },
    { settings: { maxWorkers: 3, maxExplorerTurns: 1 } },
  );
  await run.run({ kind: "explorer" });
  await run.run({
    kind: "verifier",
    verify: [
      {
        note: ancestor,
        verifiers: ["source", "correctness", "reconstruction"],
      },
    ],
  });
  const original = verification.verify;
  const interception = spyOn(verification, "verify").mockImplementation(
    (input, settings, deps) =>
      original(input, settings, {
        ...deps,
        async record(id, values) {
          if (
            !interrupted &&
            values.some((v) => v.note === ancestor && v.verdict === "FAIL")
          ) {
            interrupted = true;
            throw new Error("Adverse receipt before publication");
          }
          await deps.record(id, values);
          if (
            values.some(
              (v) => v.note === root && v.verifier === "reconstruction",
            )
          )
            accepted.resolve();
        },
      }),
  );
  try {
    await run.owner.change((data) => {
      data.campaign = initialCampaign();
    });
    await run.owner.wait();
  } finally {
    accepted.resolve();
    interception.mockRestore();
  }
  expect(interrupted).toBe(true);
  expect(project(await run.book()).accepted).toEqual([root]);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "call-failure",
    accepted: null,
  });
  await expect(run.start({ kind: "explorer" })).rejects.toThrow(
    "settle or resume",
  );
  const failed = run.history().find((row) => row.status === "failed")!;
  const calls = run.provider.state.callCount;
  await run.reopen();
  await run.owner.wait();
  expect(run.provider.state.callCount).toBe(calls);
  expect((await inspect(run.path, readStatus)).outcome).toBe("call-failure");
  await run.owner.resume();
  await run.owner.wait();
  expect(run.provider.state.callCount).toBe(calls);
  expect(
    (await run.book()).checks.find((check) =>
      check.values.some(
        (value) => value.note === ancestor && value.verdict === "FAIL",
      ),
    )?.candidate,
  ).toBe(failed.origin);
  expect(project(await run.book()).accepted).toEqual([]);
  expect((await run.notes()).find((note) => note.id === root)!.dead).toBe(true);
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
    accepted: null,
  });
});

test("close retains completed, unpublished, and unfinished Explorer work", async () => {
  const held = pause();
  let count = 0,
    release = false,
    interrupted = false;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "explorer") {
        const slot = ++count;
        if (slot === 3 && !release) {
          held.resolve();
          await abortable(request.signal);
        }
        return {
          notes: [
            note(slot === 2 ? "Publication boundary." : "Completed progress."),
          ],
        };
      }
      if (request.descriptor.kind === "selection") return { verify: [] };
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 3, maxExplorerTurns: 3 } },
  );
  const append = NoteStore.prototype.append;
  const interruption = spyOn(NoteStore.prototype, "append").mockImplementation(
    function (this: NoteStore, request, notes) {
      const version = append.call(this, request, notes);
      if (
        !interrupted &&
        Object.values(notes).some(
          (note) => note.text === "Publication boundary.",
        )
      ) {
        interrupted = true;
        throw new Error("Publication committed before admission");
      }
      return version;
    },
  );
  const pending = run.owner.wait().catch(() => undefined);
  try {
    await observed(held.promise, "unfinished Explorer");
    while (!run.history().some((row) => row.status === "failed"))
      await Bun.sleep(5);
    await run.owner.close();
    await pending;
  } finally {
    interruption.mockRestore();
  }
  expect(interrupted).toBe(true);
  expect((await run.notes()).length).toBe(1);
  release = true;
  await run.reopen();
  expect((await run.owner.wait()).outcome).toBe("call-failure");
  const calls = run.provider.state.callCount;
  await run.owner.resume();
  expect((await run.owner.wait()).outcome).toBe("turn-limit");
  expect(run.provider.state.callCount).toBe(calls + 3); // Three finite no-work selector offers, with no repeated Explorer.
  expect((await run.notes()).length).toBe(3);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "explorer"),
  ).toHaveLength(4);
  expect((await inspect(run.path, readStatus)).turns).toBe(3);
});

test("solution-only selection allows supporting-lemma checks with a complete root nomination", async () => {
  let a = "",
    b = "";
  const run = await fixture(
    (request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        a = `${descriptor.input.namespace}.1`;
        b = `${descriptor.input.namespace}.2`;
        return {
          notes: [
            {
              text: "Supporting lemma.",
              summary: "Partial prerequisite.",
              support: [],
            },
            {
              text: "Complete conditional solution.",
              summary: "Meets the task if the lemma holds.",
              support: [a],
            },
          ],
        };
      }
      if (descriptor.kind === "selection")
        return {
          verify: [
            { note: a, verifiers: ["source", "correctness", "reconstruction"] },
            ...(descriptor.input.notes.some((note) => note.id === b)
              ? [{ note: b, verifiers: all }]
              : []),
          ],
        };
      return complete(request);
    },
    {
      automatic: true,
      settings: {
        maxWorkers: 2,
        maxExplorerTurns: 1,
        verifyOnSolution: true,
      },
    },
  );
  await run.owner.wait();
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "accepted",
    accepted: b,
  });
  const selections = run.requests.filter(
    ({ descriptor }) => descriptor.kind === "selection",
  );
  expect(selections).toHaveLength(2);
  expect(
    selections.map(({ descriptor }) => descriptor.input.notes.length).sort(),
  ).toEqual([1, 2]);
  const book = await run.book();
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === a)
      .map((value) => value.verifier),
  ).toEqual(["source", "correctness", "reconstruction"]);
  expect(new Set(book.checks.map((check) => check.candidate)).size).toBe(1);
  expect(project(book).accepted).toEqual([b]);
});

test("a no-work selection does not repeat on an unchanged notebook", async () => {
  const run = await fixture(
    (request) =>
      request.descriptor.kind === "selection"
        ? { verify: [] }
        : complete(request),
    {
      automatic: true,
      settings: { maxWorkers: 1, maxExplorerTurns: 1 },
    },
  );
  await run.owner.wait();
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "turn-limit",
    turns: 1,
  });
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(1);
  expect((await run.book()).checks).toEqual([]);
});

test("verification drains multiple windows after the exploration limit", async () => {
  const run = await fixture(
    (request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer")
        return {
          notes: ["First", "Second", "Third"].map((name) => ({
            text: `${name} useful intermediate lemma, with its complete proof.`,
            summary: `${name} intermediate lemma.`,
            support: [],
          })),
        };
      if (descriptor.kind === "selection")
        return {
          verify: descriptor.input.notes
            .filter((note) => !note.checked)
            .map((note) => ({
              note: note.id,
              verifiers: ["source", "correctness", "reconstruction"],
            })),
        };
      return complete(request);
    },
    {
      automatic: true,
      settings: { maxWorkers: 1, maxExplorerTurns: 1, window: 1 },
    },
  );
  await run.owner.wait();
  expect(await inspect(run.path, readStatus)).toMatchObject({
    status: "terminal",
    outcome: "turn-limit",
    turns: 1,
  });
  const book = await run.book();
  const projected = project(book);
  expect(projected.notes).toHaveLength(3);
  expect(projected.notes.every((note) => note.checked && note.verified)).toBe(
    true,
  );
  expect(projected.accepted).toEqual([]);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "explorer"),
  ).toHaveLength(1);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(3);
  expect(book.checks).toHaveLength(9);
  expect(new Set(book.checks.map((check) => check.candidate)).size).toBe(3);
  for (const note of projected.notes)
    expect(
      book.checks
        .flatMap((check) => check.values)
        .filter((value) => value.note === note.id)
        .map((value) => value.verifier),
    ).toEqual(["source", "correctness", "reconstruction"]);
});

test("INCONCLUSIVE checks do not create a new selection frontier", async () => {
  const run = await fixture(
    (request): ReturnType<Respond> => {
      const { descriptor } = request;
      if (descriptor.kind === "verifier" && descriptor.name === "source")
        return {
          verdicts: descriptor.judged.map((note) => ({
            note,
            verdict: "INCONCLUSIVE",
            report: "The same unresolved source obligation remains.",
          })),
        };
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 1, maxExplorerTurns: 1 } },
  );
  await run.owner.wait();
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "turn-limit",
    turns: 1,
  });
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "selection"),
  ).toHaveLength(1);
  expect((await run.book()).checks).toHaveLength(1);
});

test.each(["inconclusive", "local-only"])(
  "a new publication permits an earlier %s note to receive a fresh full attempt",
  async (earlier) => {
    let firstNote = "",
      explorerCalls = 0,
      selectionCalls = 0,
      sourceCalls = 0;
    const run = await fixture(
      (request): ReturnType<Respond> => {
        const { descriptor } = request;
        if (descriptor.kind === "explorer") {
          if (++explorerCalls === 1)
            firstNote = `${descriptor.input.namespace}.1`;
          return complete(request);
        }
        if (descriptor.kind === "selection") {
          expect(
            descriptor.input.notes.some((note) => note.id === firstNote),
          ).toBe(true);
          selectionCalls++;
          return {
            verify: [
              {
                note: firstNote,
                verifiers:
                  earlier === "local-only" && selectionCalls === 1
                    ? ["source", "correctness", "reconstruction"]
                    : all,
              },
            ],
          };
        }
        if (descriptor.kind === "verifier" && descriptor.name === "source") {
          sourceCalls++;
          if (earlier === "inconclusive" && sourceCalls === 1)
            return {
              verdicts: [
                {
                  note: firstNote,
                  verdict: "INCONCLUSIVE",
                  report: "Unresolved before the next exploration.",
                },
              ],
            };
        }
        return complete(request);
      },
      { automatic: true, settings: { maxWorkers: 1, maxExplorerTurns: 2 } },
    );
    await run.owner.wait();
    expect(await inspect(run.path, readStatus)).toMatchObject({
      outcome: "accepted",
      accepted: firstNote,
      turns: 2,
    });
    expect(explorerCalls).toBe(2);
    expect(selectionCalls).toBe(2);
    expect(sourceCalls).toBe(2);
    const checks = (await run.book()).checks;
    const attempts = [...new Set(checks.map((check) => check.candidate))];
    expect(attempts).toHaveLength(2);
    expect(
      checks
        .filter((check) => check.candidate === attempts[1])
        .flatMap((check) => check.values)
        .map((value) => value.verifier),
    ).toEqual(all);
  },
);

test("deferred verification drains windowed support through its full ancestry without rechecking the root", async () => {
  let x = "",
    a = "",
    b = "",
    selections = 0;
  const local = ["source", "correctness", "reconstruction"] as const;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        x = `${descriptor.input.namespace}.1`;
        a = `${descriptor.input.namespace}.2`;
        b = `${descriptor.input.namespace}.3`;
        return {
          notes: [
            {
              text: "Long foundational argument. ".repeat(20),
              summary: "Foundational lemma X.",
              support: [],
            },
            {
              text: "Proof of A assuming X.",
              summary: "Supporting lemma A.",
              support: [x],
            },
            {
              text: "Complete proof B assuming A.",
              summary: "Completes the task.",
              support: [a],
            },
          ],
        };
      }
      if (descriptor.kind === "selection") {
        if (++selections === 1)
          return {
            verify: [
              { note: b, verifiers: all },
              { note: a, verifiers: [...local] },
              { note: x, verifiers: [...local] },
            ],
          };
        expect(selections).toBeLessThanOrEqual(3);
        expect(descriptor.input.notes.map((note) => note.id)).toEqual(
          selections === 2 ? [x, a] : [x],
        );
        expect(new Set(descriptor.input.nominatedSupport)).toEqual(
          new Set([x, a]),
        );
        const interim = project(await run.book());
        expect(interim.accepted).toEqual([]);
        expect(interim.notes.find((note) => note.id === b)).toMatchObject({
          checked: true,
          verified: false,
        });
        return {
          verify:
            selections === 2
              ? [
                  { note: a, verifiers: [...local] },
                  { note: x, verifiers: [...local] },
                ]
              : [{ note: x, verifiers: [...local] }],
        };
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: {
        maxWorkers: 1,
        maxExplorerTurns: 1,
        verifyOnSolution: true,
        window: 80,
      },
    },
  );
  await run.owner.wait();
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "accepted",
    accepted: b,
    turns: 1,
  });
  const claims = run.history().filter((row) => row.state.claim);
  expect(
    claims.map((row) => row.state.claim!.verify.map((entry) => entry.note)),
  ).toEqual([[b], [a], [x]]);
  expect(selections).toBe(3);
  const book = await run.book();
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === b)
      .map((value) => value.verifier),
  ).toEqual(all);
  expect(project(book).notes.every((note) => note.verified)).toBe(true);
});

test("a later solution nomination reoffers support declined earlier in the same publication", async () => {
  const declined = Promise.withResolvers<void>();
  let a = "",
    b = "",
    declines = 0,
    supportSelections = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const { descriptor } = request;
      if (descriptor.kind === "explorer") {
        a = `${descriptor.input.namespace}.1`;
        b = `${descriptor.input.namespace}.2`;
        return {
          notes: [
            {
              text: "Long prerequisite argument. ".repeat(20),
              summary: "Supporting lemma A.",
              support: [],
            },
            {
              text: "Complete proof of B assuming A.",
              summary: "Completes the task.",
              support: [a],
            },
          ],
        };
      }
      if (descriptor.kind === "selection") {
        if (descriptor.input.notes.some((note) => note.id === b)) {
          await observed(
            declined.promise,
            "A-only no-work before solution nomination",
          );
          return {
            verify: [
              { note: b, verifiers: all },
              {
                note: a,
                verifiers: ["source", "correctness", "reconstruction"],
              },
            ],
          };
        }
        expect(descriptor.input.notes.map((note) => note.id)).toEqual([a]);
        if (!descriptor.input.nominatedSupport?.includes(a)) {
          expect(++declines).toBe(1);
          return { verify: [] };
        }
        expect(++supportSelections).toBe(1);
        return {
          verify: [
            { note: a, verifiers: ["source", "correctness", "reconstruction"] },
          ],
        };
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: {
        maxWorkers: 2,
        maxExplorerTurns: 1,
        verifyOnSolution: true,
        window: 80,
      },
    },
  );
  const observation = await run.owner.running.watch(context);
  observation.start(async (event) => {
    if (
      event.kind === "value" &&
      run.history().some((row) => row.result?.status === "no-work")
    )
      declined.resolve();
  });
  try {
    await run.owner.wait();
  } finally {
    observation.stop();
  }
  expect(await inspect(run.path, readStatus)).toMatchObject({
    outcome: "accepted",
    accepted: b,
    turns: 1,
  });
  expect(declines).toBe(1);
  expect(supportSelections).toBe(1);
  const book = await run.book();
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === b)
      .map((value) => value.verifier),
  ).toEqual(all);
  expect(
    book.checks
      .flatMap((check) => check.values)
      .filter((value) => value.note === a)
      .map((value) => value.verifier),
  ).toEqual(["source", "correctness", "reconstruction"]);
  expect(
    run.requests.filter(({ descriptor }) => descriptor.kind === "explorer"),
  ).toHaveLength(1);
});

test("an in-flight Explorer consumes the last exploration allowance after no-work", async () => {
  const held = pause(),
    release = pause(),
    declined = pause();
  let explorers = 0;
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      if (request.descriptor.kind === "explorer" && ++explorers === 2) {
        held.resolve();
        await Promise.race([release.promise, abortable(request.signal)]);
      }
      if (request.descriptor.kind === "selection") return { verify: [] };
      return complete(request);
    },
    { automatic: true, settings: { maxWorkers: 2, maxExplorerTurns: 2 } },
  );
  const watch = await run.owner.running.watch(context);
  const check = () => {
    if (run.history().some((row) => row.result?.status === "no-work"))
      declined.resolve();
  };
  watch.start(async (event) => {
    if (event.kind === "value") check();
  });
  check();
  try {
    await observed(held.promise, "last Explorer");
    await observed(declined.promise, "no-work selection");
    await Bun.sleep(20);
    expect(explorers).toBe(2);
    expect(run.running()).toHaveLength(1);
    expect((await inspect(run.path, readStatus)).status).toBe("running");
    release.resolve();
    expect(await run.owner.wait()).toMatchObject({
      outcome: "turn-limit",
      turns: 2,
    });
    expect(explorers).toBe(2);
  } finally {
    release.resolve();
    watch.stop();
  }
});

test("a busy deferred selection drains only the unclaimed remainder without spinning", async () => {
  const checking = pause(),
    release = pause();
  let sources = 0;
  const views: string[][] = [];
  const run = await fixture(
    async (request): Promise<Awaited<ReturnType<Respond>>> => {
      const d = request.descriptor;
      if (d.kind === "explorer")
        return {
          notes: [
            note("Candidate A."),
            note("Candidate B assuming A.", [`${d.input.namespace}.1`]),
          ],
        };
      if (d.kind === "selection") {
        views.push(d.input.notes.map((note) => note.id));
        return { verify: [{ note: d.input.notes[0]!.id, verifiers: all }] };
      }
      if (d.kind === "verifier" && d.name === "source") {
        if (++sources === 2) checking.resolve();
        await Promise.race([release.promise, abortable(request.signal)]);
      }
      return complete(request);
    },
    {
      automatic: true,
      settings: { maxWorkers: 2, maxExplorerTurns: 1, verifyOnSolution: true },
    },
  );
  try {
    await observed(checking.promise, "both disjoint check batches");
    expect(
      run.history().filter((row) => row.result?.status === "busy"),
    ).toHaveLength(1);
    expect(views).toHaveLength(3);
    expect(views[2]).toHaveLength(1);
    expect(views[2]![0]).not.toBe(views[0]![0]);
    await Bun.sleep(20);
    expect(views).toHaveLength(3);
    expect(sources).toBe(2);
  } finally {
    release.resolve();
  }
  expect((await run.owner.wait()).outcome).toBe("accepted");
});
