import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  openStore,
  sqliteBackend,
  str,
  type JobHandle,
  type SingletonHandle,
  type Static,
  type StoreSelf,
} from "@earendil-works/chord/next";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";

const Record = obj({ id: str(), notes: arr(str()) });
type LedgerValue = {
  claims: Static<typeof Record>[];
  finished: Static<typeof Record>[];
};
const Ledger = defineState("xean.probe.ledger", {
  version: 1,
  persist: true,
  checkpointWhen: () => false,
  schema: obj({ claims: arr(Record), finished: arr(Record) }),
  initial: () => ({ claims: [], finished: [] }),
});
const Progress = defineState("xean.probe.progress", {
  version: 1,
  persist: true,
  checkpointWhen: () => false,
  schema: obj({ starts: int() }),
  initial: () => ({ starts: 0 }),
});
const Work = defineJob("xean.probe.work", {
  version: 1,
  args: obj({ notes: arr(str()) }),
  result: str(),
  state: Progress,
  concurrency: 2,
  persist: { resume: "rerun" },
});
const Owner = local("xean.probe.owner", {
  version: 1,
  params: {},
  members: {},
});
const directory = await mkdtemp(join(tmpdir(), "xean-chord-probe-"));
const path = join(directory, "jobs.sqlite");

async function open() {
  const store = await openStore(
    sqliteBackend(await openNodeSqliteDatabase(path)),
    context,
  );
  const errors: unknown[] = [];
  const host = createHost({ store, onError: (error) => errors.push(error) });
  const gates = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const starts = new Map<string, number>();
  let self!: StoreSelf;
  let ledger!: SingletonHandle<LedgerValue>;
  let work!: JobHandle<{ notes: string[] }, string, { starts: number }>;
  await host.load(
    [
      {
        name: "xean.probe",
        facet: defineFacet((h) => {
          h.serve(Owner, (_, owner) => {
            self = owner;
            const state = owner.state(Ledger);
            ledger = state;
            work = owner.job(Work, {
              run: async (_args, ctx) => {
                await ctx.state.change((draft) => {
                  draft.starts++;
                }, ctx);
                starts.set(ctx.jobId, ctx.state.value.starts);
                const gate = Promise.withResolvers<void>();
                gates.set(ctx.jobId, gate);
                const abort = () => gate.reject(ctx.abortSignal!.reason);
                if (ctx.abortSignal?.aborted) abort();
                else
                  ctx.abortSignal?.addEventListener("abort", abort, {
                    once: true,
                  });
                try {
                  await gate.promise;
                } finally {
                  ctx.abortSignal?.removeEventListener("abort", abort);
                }
                return "checked";
              },
              finish: async (outcome, tx) => {
                const draft = await tx.draft(state);
                draft.claims = draft.claims.filter(
                  ({ id }) => id !== outcome.id,
                );
                if (outcome.kind === "done")
                  draft.finished.push({
                    id: outcome.id,
                    notes: outcome.args.notes,
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
  const watch = await work.running.watch(context);
  const sizes: number[] = [watch.value.length];
  watch.start(async (call) => {
    if (call.kind === "value") sizes.push(call.value.length);
  });
  return {
    work,
    starts,
    gates,
    errors,
    sizes,
    ledger: () => ledger.value,
    admit: (notes: string[], key: string) =>
      self.tx(async (tx) => {
        const draft = await tx.draft(ledger);
        const claims = draft.claims;
        assert(
          !claims.some((claim) => claim.notes.some((id) => notes.includes(id))),
          "claim busy",
        );
        const run = tx.start(work, { notes }, { key });
        assert.equal(tx.start(work, { notes }, { key }).id, run.id);
        claims.push({ id: run.id, notes });
        return run;
      }, context),
    close: async () => {
      watch.stop();
      await host.close(context);
      await store.close(context);
    },
  };
}

// Yield only to native startup and watch delivery. No model or network work exists.
const delivered = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
let owner = await open();
try {
  const first = await owner.admit(["n1"], "first");
  await assert.rejects(owner.admit(["n1"], "collision"), /claim busy/);
  const second = await owner.admit(["n2"], "second");
  await assert.rejects(
    owner.admit(["n3"], "over-cap"),
    /busy|concurrency|limit/i,
  );
  await delivered();
  assert.equal(owner.work.running.value.length, 2);
  assert.equal(owner.ledger().claims.length, 2);
  assert.equal(owner.starts.get(second.id), 1);
  owner.gates.get(first.id)!.resolve();
  assert.equal((await first.outcome(context)).kind, "done");
  assert.deepEqual(
    owner.ledger().claims.map(({ id }) => id),
    [second.id],
  );
  assert.equal(owner.ledger().finished.length, 1);
  assert(owner.sizes.includes(2));
  await owner.close();

  owner = await open();
  await delivered();
  assert.equal(owner.starts.get(second.id), 2);
  assert.deepEqual(
    owner.ledger().claims.map(({ id }) => id),
    [second.id],
  );
  const recovered = owner.work.outcome(second.id, context);
  owner.gates.get(second.id)!.resolve();
  assert.equal((await recovered).kind, "done");
  assert.equal(owner.ledger().claims.length, 0);
  assert.equal(owner.ledger().finished.length, 2);
  await owner.close();

  owner = await open();
  assert.equal(owner.work.running.value.length, 0);
  assert.equal(owner.ledger().finished.length, 2);
  await assert.rejects(owner.work.outcome(second.id, context));
  assert.equal(owner.errors.length, 0);
  console.log(
    JSON.stringify(
      {
        outcome: "PASS",
        bun: Bun.version,
        models: 0,
        checks: [
          "atomic selected-ID claim",
          "native cap 2",
          "same-transaction key dedupe",
          "running watch",
          "finish plus claim release",
          "clean-close rerun with same ID",
          "persisted finish history",
          "native completed record removal",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await owner.close();
  await rm(directory, { recursive: true, force: true });
}
