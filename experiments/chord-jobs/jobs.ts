import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Models } from "@earendil-works/pi-ai";
import {
  arr,
  createHost,
  defineFacet,
  defineJob,
  defineState,
  int,
  local,
  obj,
  oneOf,
  openStore,
  opt,
  sqliteBackend,
  str,
  type JobHandle,
  type SingletonHandle,
  type Static,
  type Store,
  type StoreSelf,
} from "@earendil-works/chord/next";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import {
  explorerResultFor,
  noteIdAfter,
  pick,
  selectionResultFor,
  verifierNames,
} from "../../src/policy/contracts.ts";
import { codexSource } from "../../src/policy/settings.ts";
import { directSupport } from "../../src/policy/support.ts";
import { verificationPrefix } from "../../src/policy/verification.ts";
import { verify } from "../../src/verification.ts";
import type { Definition } from "../../src/state.ts";
import { openPi, type Pi } from "./pi.ts";

const kind = oneOf("explorer", "verifier");
const result = obj({
  status: oneOf("done", "busy", "no-work"),
  ids: arr(str()),
});
const planSchema = obj({
  verify: opt(
    arr(obj({ note: str(), verifiers: arr(oneOf(...verifierNames)) })),
  ),
});
const Plan = defineState("xean.chord.plan", {
  version: 1,
  schema: planSchema,
  initial: () => ({}),
  persist: true,
  checkpointWhen: () => false,
});
const history = obj({
  ref: int(),
  kind,
  status: oneOf("done", "failed", "busy", "no-work"),
  ids: arr(str()),
  error: opt(str()),
});
const ledgerSchema = obj({ history: arr(history) });
const Ledger = defineState("xean.chord.research", {
  version: 1,
  schema: ledgerSchema,
  initial: () => ({ history: [] }),
  persist: true,
  checkpointWhen: () => false,
});
const Owner = local("xean.chord.owner", {
  version: 1,
  params: {},
  members: {},
});
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Chord owns jobs and claims. Pi owns frozen mathematical inputs and receipts. */
export async function openJobs(
  directory: string,
  definition: Definition,
  models: Models,
) {
  definition = copy(definition);
  const { settings } = definition;
  if (settings.verifyOnSolution)
    throw new Error("The Chord spike does not support verifyOnSolution");
  if (codexSource(settings.source))
    throw new Error("The Chord spike does not support Codex source execution");
  const Research = defineJob("xean.chord.worker", {
    version: 1,
    args: obj({ ref: int(), kind }),
    result,
    state: Plan,
    concurrency: settings.maxWorkers,
    persist: { resume: "rerun" },
  });
  directory = resolve(directory);
  await mkdir(directory, { recursive: true });
  const ownership = new DatabaseSync(join(directory, "owner.sqlite"));
  try {
    ownership.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
  } catch (error) {
    ownership.close();
    throw new Error("Chord spike directory already has an owner", {
      cause: error,
    });
  }
  let store: Store | undefined;
  let pi!: Pi;
  let host: ReturnType<typeof createHost> | undefined;
  const errors: unknown[] = [];
  let ledger!: SingletonHandle<Static<typeof ledgerSchema>>;
  let self!: StoreSelf;
  let job!: JobHandle<
    { ref: number; kind: Static<typeof kind> },
    Static<typeof result>,
    Static<typeof planSchema>
  >;
  const claims = () =>
    job.running.value.flatMap((entry) => {
      if (entry.phase === "blocked" || !entry.state.verify) return [];
      return [
        { jobid: entry.id, ids: entry.state.verify.map(({ note }) => note) },
      ];
    });
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Host.close seals every object before its first await. Pi may then stop calls.
      const stopped = host?.close(context);
      try {
        const outcomes = await Promise.allSettled([stopped, pi?.close()]);
        for (const outcome of outcomes)
          if (outcome.status === "rejected") throw outcome.reason;
      } finally {
        try {
          await store?.close(context);
        } finally {
          ownership.close();
        }
      }
    })());
  try {
    store = await openStore(
      sqliteBackend(
        await openNodeSqliteDatabase(join(directory, "execution.sqlite")),
      ),
      context,
    );
    pi = await openPi(store, directory, definition, models);
    if ((await pi.book()).inputs.length)
      throw new Error("The Chord spike does not support imported inputs");
    host = createHost({ store, onError: (error) => errors.push(error) });
    await host.load(
      [
        {
          name: "xean.chord",
          facet: defineFacet((h) => {
            h.serve(Owner, (_, owner) => {
              self = owner;
              ledger = owner.state(Ledger);
              job = owner.job(Research, {
                run: async ({ ref }, ctx) => {
                  const work = await pi.work(ref);
                  if (work.kind === "explorer") {
                    const answer = await pi.call(
                      ref,
                      "explorer",
                      work,
                      settings.explorer,
                      ctx,
                    );
                    const { notes } = explorerResultFor(
                      work.input.notes,
                      work.input.namespace,
                    ).parse(answer.value);
                    const stored = notes.map((note, index) => ({
                      ...note,
                      id: noteIdAfter(work.input.namespace, index),
                    }));
                    await pi.publish(ref, stored);
                    return { status: "done", ids: stored.map(({ id }) => id) };
                  }
                  let plan = ctx.state.value.verify;
                  if (plan === undefined) {
                    if (!work.input.notes.length)
                      return { status: "no-work", ids: [] };
                    const answer = await pi.call(
                      ref,
                      "selection",
                      { kind: "selection", input: work.input },
                      settings.correctness,
                      ctx,
                    );
                    const selection = selectionResultFor(
                      work.input.notes,
                    ).parse(answer.value).verify;
                    const current = await pi.book();
                    if (
                      !selectionResultFor(current.notes).safeParse({
                        verify: selection,
                      }).success
                    )
                      return { status: "no-work", ids: [] };
                    const selected = verificationPrefix(
                      selection,
                      work.input.notes,
                      settings.window,
                    );
                    if (!selected.length) return { status: "no-work", ids: [] };
                    const claimed = await ctx.state.change((draft) => {
                      if (draft.verify) return copy(draft.verify);
                      if (
                        job.running.value.some(
                          (entry) => entry.phase === "blocked",
                        )
                      )
                        throw new Error("A blocked job prevents fresh claims");
                      const occupied = new Set(
                        claims().flatMap(({ ids }) => ids),
                      );
                      if (selected.some(({ note }) => occupied.has(note)))
                        return null;
                      draft.verify = copy(selected);
                      return copy(selected);
                    }, ctx);
                    if (claimed === null) return { status: "busy", ids: [] };
                    plan = claimed;
                  }
                  const notes = plan.map(({ note }) =>
                    pick(work.input.notes, note),
                  );
                  for (const note of notes)
                    for (const parent of note.support)
                      pick(work.input.notes, parent);
                  const selected = new Set(notes.map(({ id }) => id));
                  await verify(
                    {
                      task: work.input.task,
                      verify: plan,
                      notes,
                      support: directSupport(notes, work.input.notes).filter(
                        ({ id }) => !selected.has(id),
                      ),
                    },
                    settings,
                    {
                      call: (key, descriptor, profile) =>
                        pi.call(ref, key, descriptor, profile, ctx),
                      recorded: () => pi.recorded(ref),
                      record: (call, values) => pi.record(ref, call, values),
                    },
                  );
                  return { status: "done", ids: plan.map(({ note }) => note) };
                },
                finish: async (outcome, tx) => {
                  const draft = await tx.draft(ledger);
                  draft.history.push({
                    ref: outcome.args.ref,
                    kind: outcome.args.kind,
                    ...(outcome.kind === "done"
                      ? outcome.result
                      : {
                          status: "failed" as const,
                          ids: (outcome.state.verify ?? []).map(
                            ({ note }) => note,
                          ),
                          error:
                            outcome.error.kind === "threw"
                              ? outcome.error.error.message
                              : outcome.error.kind,
                        }),
                  });
                },
              });
              return {};
            });
          }),
        },
      ],
      context,
    );
  } catch (error) {
    await close();
    throw error;
  }
  return {
    pi,
    errors,
    running: job.running,
    history: () => copy(ledger.value.history),
    claims,
    async start(ref: number) {
      const work = await pi.work(ref);
      return self.tx(async (tx) => {
        const draft = await tx.draft(ledger);
        if (draft.history.some((entry) => entry.ref === ref))
          throw new Error("Work reference is already settled");
        return tx.start(job, { ref, kind: work.kind }, { key: String(ref) });
      }, context);
    },
    close,
  };
}
