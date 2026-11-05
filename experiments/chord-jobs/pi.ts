import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context, JsonValue } from "@earendil-works/chord";
import type { Store } from "@earendil-works/chord/next";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineEntry,
  Harness,
  type EntryId,
} from "@earendil-works/pi-durable";
import { StoreStorage } from "@earendil-works/pi-durable/storage/store";
import {
  createRoleRuntime,
  roleGenerationPolicy,
} from "../../src/role-runtime.ts";
import {
  DefinitionDoc,
  Notebook,
  appendNotes,
  initializeNotebook,
  project,
  readNotebook,
  type Definition,
  type StoredNote,
} from "../../src/state.ts";
import type { CallDescriptor } from "../../src/policy/prompts.ts";
import type { PiRoleProfile } from "../../src/policy/settings.ts";
import type {
  ExplorerInput,
  SelectionInput,
  Verdict,
} from "../../src/policy/contracts.ts";

export type Work =
  | { kind: "explorer"; input: ExplorerInput }
  | { kind: "verifier"; input: SelectionInput };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const WorkEntry = defineEntry<{ work: JsonValue }>("xean.chord-work");

/** Pi owns only immutable work inputs and individual model calls, not Chord jobs. */
export async function openPi(
  store: Store,
  directory: string,
  definition: Definition,
  models: Models,
  report: (error: unknown) => void,
) {
  const storage = await StoreStorage.open(store, "pi", context);
  let close = () => storage.close(context);
  try {
    const roles = createRoleRuntime();
    const registry = createRegistry();
    registry.install(roles.extension);
    const harness = await Harness.open(
      storage,
      {
        registry,
        models,
        settings: {
          compaction: { enabled: false },
          retry: { enabled: true, maxRetries: 8 },
          restartLimit: Infinity,
          generation: roleGenerationPolicy,
          progress: { persistWithinMs: 0 },
          toolExecution: "sequential",
          contextRetentionMs: 0,
          documentRetentionMs: 0,
        },
        onReport: report,
      },
      context,
    );
    close = () => harness.close(context);
    const root = await harness.root(context, {
      init: async (tx, id) => {
        Object.assign(await tx.doc(DefinitionDoc, id), copy(definition));
        await initializeNotebook(tx, id, join(directory, "notes.sqlite"));
      },
    });
    assert.deepEqual(
      await root.commit(
        async (tx) => copy(await tx.doc(DefinitionDoc, root.id)),
        context,
      ),
      definition,
      "Frozen definition changed",
    );
    const book = () =>
      root.commit(async (tx) => {
        const saved = readNotebook(await tx.doc(Notebook, root.id));
        return copy({ ...saved, ...project(saved) });
      }, context);
    return {
      harness,
      root,
      book,
      close,
      async prepare(kind: Work["kind"], claimed: string[] = []) {
        return root.commit(async (tx) => {
          const { notes } = project(
            readNotebook(await tx.doc(Notebook, root.id)),
          );
          const work: Work =
            kind === "explorer"
              ? {
                  kind,
                  input: {
                    task: definition.task,
                    explorerGuidance: "",
                    namespace: "",
                    notes: notes.map(
                      ({ text: _text, detailedSummary: _detail, ...note }) =>
                        note,
                    ),
                  },
                }
              : { kind, input: { task: definition.task, notes, claimed } };
          return (
            await tx.appendEntry(WorkEntry, root.id, {
              data: { work: copy(work) as JsonValue },
            })
          ).id;
        }, context);
      },
      async work(ref: number): Promise<Work> {
        return root.commit(async (tx) => {
          const entry = await tx.entry(WorkEntry, ref as EntryId);
          assert(entry, "Frozen work input is missing");
          const value = copy(entry.data.work) as Work;
          if (value.kind === "explorer") value.input.namespace = `w${ref}`;
          return value;
        }, context);
      },
      call(
        ref: number,
        key: string,
        descriptor: CallDescriptor,
        profile: PiRoleProfile,
        ctx: Context,
      ) {
        return roles.call(harness, ref, key, descriptor, profile, ctx, report);
      },
      publish: (ref: number, notes: StoredNote[]) =>
        root.commit(async (tx) => {
          appendNotes(
            tx,
            await tx.doc(Notebook, root.id),
            copy(notes),
            `chord/${ref}`,
          );
        }, context),
      recorded: (ref: number): Promise<Verdict[]> =>
        root.commit(
          async (tx) =>
            copy(
              (await tx.doc(Notebook, root.id)).checks
                .filter((check) => check.candidate === ref)
                .flatMap((check) => check.values),
            ),
          context,
        ),
      record: (ref: number, call: number, values: Verdict[]) =>
        root.commit(async (tx) => {
          const saved = await tx.doc(Notebook, root.id);
          if (!saved.checks.some((check) => check.call === call))
            saved.checks.push({ candidate: ref, call, values: copy(values) });
        }, context),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type Pi = Awaited<ReturnType<typeof openPi>>;
