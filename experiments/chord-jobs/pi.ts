import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineEntry,
  defineExtension,
  defineTask,
  Harness,
  type EntryId,
  type TaskId,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
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
import { directSupport } from "../../src/policy/support.ts";

export type Work =
  | { kind: "explorer"; input: ExplorerInput }
  | { kind: "verifier"; input: SelectionInput };
type Receipt = { call: number; value: JsonValue; fresh: boolean };
type CallInput = {
  ref: number;
  key: string;
  descriptor: CallDescriptor;
  profile: PiRoleProfile;
  previous: number[];
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const WorkEntry = defineEntry<{ work: JsonValue }>("xean.chord-work");
const callKind = "xean.chord-call";

/** Pi owns only immutable work inputs and individual model calls, not Chord jobs. */
export async function openPi(
  directory: string,
  definition: Definition,
  models: Models,
) {
  directory = resolve(directory);
  definition = copy(definition);
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
  let stopped: Promise<void> | undefined;
  let released = false;
  let stop = async () => {};
  const close = async () => {
    try {
      await stop();
    } finally {
      if (!released) {
        released = true;
        ownership.close();
      }
    }
  };
  try {
    const errors: unknown[] = [];
    const roles = createRoleRuntime();
    const Call = defineTask<CallInput, { phase: "run" }, Receipt>({
      name: callKind,
      version: 1,
      initial: () => ({ phase: "run" }),
      abort: async (_task, runtime, ctx) => {
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "aborted" } }),
          ctx,
        );
      },
      phases: {
        async run(task, runtime, ctx) {
          const input = task.input;
          const value = await roles.run(
            runtime,
            input.key,
            input.descriptor,
            input.profile,
            ctx,
            input.previous,
          );
          await runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: value },
            }),
            ctx,
          );
        },
      },
    });
    const registry = createRegistry();
    registry.install(defineExtension({ ...roles.extension, tasks: [Call] }));
    const storage = await openNodeSqliteStorage(join(directory, "pi.sqlite"));
    stop = () => (stopped ??= storage.close(context));
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
        onReport: (value) => errors.push(value),
      },
      context,
    );
    stop = () => (stopped ??= harness.close(context));
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
      definition,
      harness,
      root,
      errors,
      book,
      close,
      stop,
      async prepare(kind: Work["kind"], ids?: string[]) {
        return root.commit(async (tx) => {
          let { notes } = project(
            readNotebook(await tx.doc(Notebook, root.id)),
          );
          if (ids) {
            const targets = notes.filter((note) => ids.includes(note.id));
            const selected = new Set([
              ...ids,
              ...directSupport(targets, notes).map((note) => note.id),
            ]);
            notes = notes.filter((note) => selected.has(note.id));
          }
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
              : { kind, input: { task: definition.task, notes, claimed: [] } };
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
      async call(
        ref: number,
        key: string,
        descriptor: CallDescriptor,
        profile: PiRoleProfile,
      ): Promise<Receipt> {
        let id!: TaskId<Receipt>,
          replay = false;
        await root.commit(async (tx) => {
          let cursor,
            prior: TaskRecord<CallInput, { phase: "run" }, Receipt> | undefined;
          do {
            const page = await tx.scanTasks(
              { conversationId: root.id, kind: callKind },
              128,
              cursor,
            );
            for (const record of page.items) {
              const input = record.input as CallInput;
              if (input.ref === ref && input.key === key)
                prior = record as typeof prior;
            }
            cursor = page.next;
          } while (cursor);
          if (prior) {
            assert.deepEqual(
              prior.input.descriptor,
              descriptor,
              "Stage descriptor changed on replay",
            );
            assert.deepEqual(
              prior.input.profile,
              profile,
              "Stage profile changed on replay",
            );
            if (
              prior.state.status !== "terminal" ||
              prior.state.outcome.status === "completed"
            ) {
              id = prior.id;
              replay = prior.state.status === "terminal";
              return;
            }
          }
          id = await tx.createTask(
            Call,
            {
              ref,
              key,
              descriptor: copy(descriptor),
              profile: copy(profile),
              previous: prior ? [...prior.input.previous, prior.id] : [],
            },
            { conversationId: root.id, ownership: { kind: "conversation" } },
          );
        }, context);
        const task = await harness.waitForTask(id, context);
        if (task.state.outcome.status !== "completed")
          throw new Error(
            task.state.outcome.error?.message ?? "Pi role did not complete",
          );
        return {
          ...task.state.outcome.result,
          ...(replay ? { fresh: false } : {}),
        };
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
      recorded: async (ref: number): Promise<Verdict[]> =>
        (await book()).checks
          .filter((check) => check.candidate === ref)
          .flatMap((check) => check.values),
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
