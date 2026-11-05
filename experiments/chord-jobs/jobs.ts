import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
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
import type { Pi } from "./pi.ts";

const kind = oneOf("explorer", "verifier");
const result = obj({
  status: oneOf("done", "busy", "no-work"),
  ids: arr(str()),
});
const claim = obj({
  jobid: str(),
  verify: arr(obj({ note: str(), verifiers: arr(oneOf(...verifierNames)) })),
});
const history = obj({
  ref: int(),
  kind,
  status: oneOf("done", "failed", "busy", "no-work"),
  ids: arr(str()),
  error: opt(str()),
});
const ledgerSchema = obj({ claims: arr(claim), history: arr(history) });
const Ledger = defineState("xean.chord.research", {
  version: 1,
  schema: ledgerSchema,
  initial: () => ({ claims: [], history: [] }),
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
export async function openJobs(path: string, pi: Pi) {
  const { settings } = pi.definition;
  if (settings.verifyOnSolution)
    throw new Error("The Chord spike does not support verifyOnSolution");
  if (codexSource(settings.source))
    throw new Error("The Chord spike does not support Codex source execution");
  if ((await pi.book()).inputs.length)
    throw new Error("The Chord spike does not support imported inputs");
  const Research = defineJob("xean.chord.worker", {
    version: 1,
    args: obj({ ref: int(), kind }),
    result,
    concurrency: settings.maxWorkers,
    persist: { resume: "rerun" },
  });
  const store = await openStore(
    sqliteBackend(await openNodeSqliteDatabase(path)),
    context,
  );
  const errors: unknown[] = [];
  const host = createHost({ store, onError: (error) => errors.push(error) });
  let ledger!: SingletonHandle<Static<typeof ledgerSchema>>;
  let self!: StoreSelf;
  let job!: JobHandle<
    { ref: number; kind: Static<typeof kind> },
    Static<typeof result>,
    undefined
  >;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Host.close seals every object before its first await. Pi may then stop calls.
      const stopped = host.close(context);
      try {
        const outcomes = await Promise.allSettled([stopped, pi.stop()]);
        for (const outcome of outcomes)
          if (outcome.status === "rejected") throw outcome.reason;
      } finally {
        try {
          await store.close(context);
        } finally {
          await pi.close();
        }
      }
    })());
  try {
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
                  let plan = ledger.value.claims.find(
                    (entry) => entry.jobid === ctx.jobId,
                  )?.verify;
                  if (plan === undefined) {
                    if (!work.input.notes.length)
                      return { status: "no-work", ids: [] };
                    const answer = await pi.call(
                      ref,
                      "selection",
                      { kind: "selection", input: work.input },
                      settings.correctness,
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
                    const claimed = await owner.tx(async (tx) => {
                      const draft = await tx.draft(ledger);
                      const own = draft.claims.find(
                        (entry) => entry.jobid === ctx.jobId,
                      );
                      if (own) return copy(own.verify);
                      const occupied = new Set(
                        draft.claims.flatMap((entry) =>
                          entry.verify.map(({ note }) => note),
                        ),
                      );
                      if (selected.some(({ note }) => occupied.has(note)))
                        return null;
                      draft.claims.push({
                        jobid: ctx.jobId,
                        verify: copy(selected),
                      });
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
                        pi.call(ref, key, descriptor, profile),
                      recorded: () => pi.recorded(ref),
                      record: (call, values) => pi.record(ref, call, values),
                    },
                  );
                  return { status: "done", ids: plan.map(({ note }) => note) };
                },
                finish: async (outcome, tx) => {
                  const draft = await tx.draft(ledger);
                  const own = draft.claims.find(
                    (entry) => entry.jobid === outcome.id,
                  );
                  draft.history.push({
                    ref: outcome.args.ref,
                    kind: outcome.args.kind,
                    ...(outcome.kind === "done"
                      ? outcome.result
                      : {
                          status: "failed" as const,
                          ids: (own?.verify ?? []).map(({ note }) => note),
                          error:
                            outcome.error.kind === "threw"
                              ? outcome.error.error.message
                              : outcome.error.kind,
                        }),
                  });
                  draft.claims = draft.claims.filter(
                    (entry) => entry.jobid !== outcome.id,
                  );
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
    errors,
    running: job.running,
    history: () => copy(ledger.value.history),
    claims: () =>
      ledger.value.claims.map((entry) => ({
        jobid: entry.jobid,
        ids: entry.verify.map(({ note }) => note),
      })),
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
