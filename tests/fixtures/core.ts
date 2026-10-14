import assert from "node:assert/strict";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  Control,
  DefinitionDoc,
  createResearch,
  noteIdPrefix,
  publicationResult,
  publishExploration,
  readView,
  type Exploration,
  type Roles,
} from "../../src/core/index.ts";

let reopened = false;
let decisions = 0;
const published = Promise.withResolvers<void>();
const pass = { verdict: "PASS" as const, report: "Scripted check." };
const roles: Roles = {
  capabilities: () => ({ literature: false, implementation: false }),
  coordinator: async ({ notes }) => {
    decisions++;
    return {
      work: notes.length
        ? {
            kind: "verifier",
            notes: notes.map(({ id }: { id: string }) => id),
            through: "reconstruction",
          }
        : { kind: "explorer", assignment: "Prove the target." },
    };
  },
  explorer: async (_input, runtime, ctx, source) => {
    assert.ok(source);
    const lemma = `${noteIdPrefix(runtime.taskId)}reflexivity`;
    const target = `${noteIdPrefix(runtime.taskId)}target`;
    const submissions: Exploration[] = [
      { id: lemma, text: "For every x, x = x." },
      { id: target, text: "1 = 1 by reflexivity." },
    ].map(({ id, text }, index) => ({
      notes: [
        {
          id,
          summary: text,
          detailedSummary: text,
          text,
          support: index ? [lemma] : [],
          candidate: !!index,
        },
      ],
    }));
    for (const delta of submissions) {
      await runtime.commit(async (tx) => {
        const view = await readView(tx, source.root);
        if (view.notes.some(({ id }) => id === delta.notes[0]!.id)) return;
        await publishExploration(
          tx,
          source.root,
          runtime.taskId,
          delta,
          Object.fromEntries(
            view.notes.map(({ id, revision }) => [id, revision]),
          ),
        );
      }, ctx);
      if (!reopened) {
        published.resolve();
        await awaitWithContext(new Promise<void>(() => {}), ctx);
      }
    }
    return publicationResult(submissions);
  },
  verifier: async ({ targets, notes }) => ({
    kind: "verification",
    checks: targets.map((noteId: string) => ({
      noteId,
      correctness: {
        ...pass,
        statement: notes.find(({ id }: { id: string }) => id === noteId)!
          .candidate
          ? "1 = 1."
          : "For every x, x = x.",
        premises: [],
      },
      source: pass,
      ...(notes.find(({ id }: { id: string }) => id === noteId)!.candidate
        ? { requirements: pass }
        : {}),
      reconstruction: { ...pass, proof: "Reflexivity of equality." },
    })),
  }),
};
const research = createResearch(roles);
const registry = createRegistry();
registry.install(research.extension);
const start = async () => {
  const harness = await Harness.open(
    await openNodeJsonlStorage("campaign", context, { fsync: true }),
    { registry, models: createModels() },
    context,
  );
  const root = await harness.root(context, {
    init: async (tx, root) => {
      Object.assign(await tx.doc(DefinitionDoc, root), {
        task: {
          problem: "Prove 1 = 1.",
          completionCriteria: "A self-contained proof.",
        },
        settings: {},
      });
      await research.initialize(tx, root);
    },
  });
  return {
    harness,
    root,
    view: () => root.commit((tx) => readView(tx, root.id), context),
  };
};
let owner = await start();
try {
  owner.harness.resume();
  await published.promise;
  const first = await owner.view();
  assert.equal(first.notes.length, 1);
  assert.equal(decisions, 1);
  await owner.harness.close(context);
  reopened = true;
  owner = await start();
  assert.deepEqual(await owner.view(), first);
  owner.harness.resume();
  await owner.root.waitForIdle(context);
  const final = await owner.view();
  assert.equal(final.notes.length, 2);
  assert.equal(final.notes[0]!.id, first.notes[0]!.id);
  assert.ok(
    final.notes.every(({ verified }) => verified),
    JSON.stringify(final),
  );
  const accepted = await owner.root.commit(
    async (tx) => (await tx.doc(Control, owner.root.id)).accepted?.candidateId,
    context,
  );
  assert.equal(accepted, final.notes[1]!.id);
  assert.equal(decisions, 2);
  console.log("Core publication, recovery, and acceptance passed.");
} finally {
  await owner.harness.close(context);
}
