import type { Context, JsonValue } from "@earendil-works/chord";
import { Notebook as NoteStore, ConflictError } from "@chaoxu/notebook-store";
import {
  defineEntry,
  defineExtension,
  defineTask,
  type ConversationId,
  type EntryId,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { createRoleRuntime, Assignment } from "./role-runtime.ts";
import {
  Notebook,
  admitNotes,
  definition,
  project,
  readNotebook,
  saveNotebook,
} from "./state.ts";
import {
  coordinatorResultFor,
  explorerResultFor,
  noteIdAfter,
  pick,
  sourceVerdictsFor,
  type ExplorerInput,
  type Verification,
  type VerifierInput,
  type Verdict,
} from "./policy/contracts.ts";
import type { CallDescriptor } from "./policy/prompts.ts";
import type { PiRoleProfile, SolveSettings } from "./policy/settings.ts";
import { supportClosure } from "./policy/support.ts";
import { verificationPrefix } from "./policy/verification.ts";
import type { CodexRequest, CodexResult } from "./policy/source.ts";
import { verify } from "./verification.ts";
import type { ActivityOptions } from "./activity.ts";

type Runtime = TaskRuntime<any, any, any, any>;
export type SourceExecutor = (
  request: CodexRequest,
  signal: AbortSignal,
) => Promise<CodexResult>;
export type WorkerInput = (
  | { kind: "call"; descriptor: CallDescriptor; profile: PiRoleProfile }
  | {
      kind: "verify";
      input: VerifierInput;
      settings: SolveSettings;
      reconstruction?: { note: string; call: number }[];
    }
) & { version: number; previousTasks?: number[] };
export type WorkerRequest =
  | { kind: "explorer"; guidance?: string }
  | { kind: "coordinator" }
  | { kind: "verifier"; verify: Verification[] }
  | { kind: "retry"; task: number };

const ResultEntry = defineEntry<{
  key: string;
  value: JsonValue;
  descriptor?: JsonValue;
}>("xean.role-result");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const abort = async (_task: unknown, runtime: Runtime, context: Context) => {
  await runtime.commit(
    () => ({ status: "terminal", outcome: { status: "aborted" } }),
    context,
  );
};

function currentVersion(ref: { version: number }, input: WorkerInput) {
  if (ref.version !== input.version)
    throw new Error("Worker notebook version is stale");
}

/** Independently invoked roles retain Pi's native execution and recovery. */
export function createWorkers(
  options: { source?: SourceExecutor; activity?: ActivityOptions } = {},
) {
  const roles = createRoleRuntime(options.activity);
  const Worker = defineTask<WorkerInput, { phase: "run" }, JsonValue>({
    name: "xean.worker",
    version: 1,
    initial: () => ({ phase: "run" }),
    abort,
    phases: {
      async run(task, runtime, context) {
        const snapshot = async () => {
          const ref = await runtime.snapshot(
            Notebook,
            task.conversationId,
            context,
          );
          if (!ref) throw new Error("Campaign notebook is missing");
          currentVersion(ref, task.input);
          return ref;
        };
        await snapshot();
        let value: JsonValue;
        if (task.input.kind === "call") {
          const answer = await roles.run(
            runtime,
            "role",
            task.input.descriptor,
            task.input.profile,
            context,
            task.input.previousTasks,
          );
          value = answer.value;
        } else {
          const input = task.input;
          const candidate = input.previousTasks?.[0] ?? task.id;
          const recorded = async (): Promise<Verdict[]> => {
            const book = await snapshot();
            return book.checks
              .filter((c) => c.candidate === candidate)
              .flatMap((c) => c.values);
          };
          const premises: Record<string, string> = {};
          await runtime.commit(async (tx) => {
            for (const ref of input.reconstruction ?? []) {
              const entry = await tx.entry(ref.call as EntryId);
              const { descriptor } = await tx.doc(
                Assignment,
                entry!.conversationId,
              );
              if (descriptor?.kind !== "reconstruction")
                throw new Error("Missing reconstruction assignment");
              premises[ref.note] = descriptor.statement.statements.find(
                (value) => value.note === ref.note,
              )!.statement;
            }
          }, context);
          await verify(input.input, input.settings, {
            premises,
            call: async (key, descriptor, profile) => {
              await snapshot();
              return roles.run(
                runtime,
                key,
                descriptor,
                profile,
                context,
                input.previousTasks,
              );
            },
            recorded,
            refresh: async (value) => {
              const refreshed = copy(value);
              const book = await snapshot();
              const current = new Map(
                project(readNotebook(book)).notes.map((note) => [
                  note.id,
                  note,
                ]),
              );
              for (const note of [...refreshed.notes, ...refreshed.support]) {
                const latest = current.get(note.id);
                if (latest === undefined) continue;
                note.verdicts = latest.verdicts;
                note.verified = latest.verified;
                note.dead = latest.dead;
              }
              return refreshed;
            },
            record: async (id, values) => {
              await runtime.commit(async (tx) => {
                const book = await tx.doc(Notebook, task.conversationId);
                currentVersion(book, task.input);
                if (!book.checks.some((check) => check.call === id))
                  book.checks.push({
                    candidate,
                    call: id,
                    values: copy(values),
                  });
              }, context);
            },
            source: async (key, request, judged) => {
              await snapshot();
              if (!options.source)
                throw new Error("Codex source execution is not registered");
              const validate = (output: CodexResult) => {
                if (output.state !== "succeeded")
                  throw new Error(`verifier failed: ${output.error}`);
                const value = sourceVerdictsFor(judged).parse(output.output);
                if (
                  !request.search &&
                  value.verdicts.some((v) => v.sources.length)
                )
                  throw new Error(
                    "Source citations require search to be enabled",
                  );
                return value;
              };
              let prior:
                | { call: number; value: ReturnType<typeof validate> }
                | undefined;
              const owners = [task.id, ...(input.previousTasks ?? [])];
              await runtime.commit(async (tx) => {
                let cursor;
                do {
                  const page = await tx.scanEntries(
                    { conversationId: task.conversationId },
                    128,
                    cursor,
                  );
                  for (const entry of page.items) {
                    if (
                      !ResultEntry.is(entry) ||
                      entry.byTaskId === undefined ||
                      !owners.includes(entry.byTaskId) ||
                      entry.data.key !== key ||
                      JSON.stringify(entry.data.descriptor) !==
                        JSON.stringify(request)
                    )
                      continue;
                    try {
                      prior = {
                        call: entry.id,
                        value: validate(entry.data.value as CodexResult),
                      };
                      return;
                    } catch {
                      /* Failed calls remain evidence, not reusable answers. */
                    }
                  }
                  cursor = page.next;
                } while (cursor);
              }, context);
              if (prior) return prior;
              const output = await options.source(request, runtime.signal);
              let id!: number;
              await runtime.commit(async (tx) => {
                id = (
                  await tx.appendEntry(ResultEntry, task.conversationId, {
                    data: {
                      key,
                      value: copy(output) as JsonValue,
                      descriptor: copy(request) as JsonValue,
                    },
                  })
                ).id;
              }, context);
              return { call: id, value: validate(output) };
            },
          });
          value = null;
        }
        await runtime.commit(async (tx) => {
          const ref = await tx.doc(Notebook, task.conversationId);
          currentVersion(ref, task.input);
          if (task.input.kind === "call") {
            const book = readNotebook(ref);
            const descriptor = task.input.descriptor;
            if (descriptor.kind === "explorer") {
              const result = explorerResultFor(descriptor.input.notes).parse(
                value,
              );
              for (const note of result.notes)
                book.notes.push({
                  ...note,
                  id: noteIdAfter(book.notes.length, 0),
                });
            } else if (descriptor.kind === "coordinator") {
              const result = coordinatorResultFor(descriptor.input.notes).parse(
                value,
              );
              for (const filing of result.filings)
                pick(book.notes, filing.note).summary = filing.summary;
            }
            saveNotebook(tx, ref, book);
          }
          return {
            status: "terminal",
            outcome: { status: "completed", result: value },
          };
        }, context);
      },
    },
  });

  const extension = defineExtension({ ...roles.extension, tasks: [Worker] });
  return {
    extension,
    Worker,
    async create(
      tx: Tx,
      root: ConversationId,
      request: WorkerRequest,
      owner?: TaskId,
    ): Promise<TaskId<JsonValue>> {
      let cursor;
      do {
        const page = await tx.scanTasks({ conversationId: root }, 128, cursor);
        if (
          page.items.some(
            (task) => task.id !== owner && task.state.status !== "terminal",
          )
        )
          throw new Error("Campaign already has live work");
        cursor = page.next;
      } while (cursor);
      const config = await definition(tx, root);
      const ref = await tx.doc(Notebook, root);
      const book = readNotebook(ref);
      let { notes, accepted, reconstructed } = project(book);
      if (accepted.length) throw new Error("Campaign is already accepted");
      if (
        (request.kind === "explorer" || request.kind === "coordinator") &&
        admitNotes(book)
      ) {
        saveNotebook(tx, ref, book);
        ({ notes, reconstructed } = project(book));
      }
      if (request.kind !== "retry") {
        using store = new NoteStore(ref.path, { readonly: true });
        if (store.snapshot() !== ref.version)
          throw new ConflictError(
            "Notebook changed. Retry interrupted work or resolve external changes before fresh work",
          );
      }
      let input: WorkerInput;
      if (request.kind === "retry") {
        const prior = await tx.task(request.task as TaskId);
        if (
          !prior ||
          prior.conversationId !== root ||
          prior.kind !== Worker.definition.name ||
          prior.state.status !== "terminal" ||
          !["faulted", "aborted"].includes(prior.state.outcome.status)
        )
          throw new Error(
            "Retry requires a faulted or aborted worker from this campaign",
          );
        input = copy(prior.input) as WorkerInput;
        currentVersion(ref, input);
        input.previousTasks = [...(input.previousTasks ?? []), prior.id];
      } else if (request.kind === "explorer") {
        const explorer: ExplorerInput = {
          task: config.task,
          explorerGuidance: request.guidance ?? "",
          notes: notes.map(
            ({ text: _text, detailedSummary: _detail, ...note }) => note,
          ),
        };
        input = {
          kind: "call",
          descriptor: { kind: "explorer", input: explorer },
          profile: config.settings.explorer,
          version: ref.version,
        };
      } else if (request.kind === "coordinator") {
        input = {
          kind: "call",
          descriptor: {
            kind: "coordinator",
            input: {
              task: config.task,
              notes,
              ...(config.settings.verifyOnSolution
                ? { verifyOnSolution: true }
                : {}),
            },
          },
          profile: config.settings.coordinator,
          version: ref.version,
        };
      } else {
        const selected = coordinatorResultFor(
          notes.map((note) => ({ ...note, summary: note.summary ?? "" })),
        ).parse({ filings: [], verify: request.verify }).verify;
        const batch = verificationPrefix(
          selected,
          notes,
          config.settings.window,
        );
        if (!batch.length)
          throw new Error("Verifier requires a nonempty batch");
        const listed = batch.map((entry) => pick(notes, entry.note));
        const verifier: VerifierInput = {
          task: config.task,
          verify: batch,
          notes: listed,
          support: supportClosure(listed, notes).map((id) => pick(notes, id)),
        };
        input = {
          kind: "verify",
          input: verifier,
          settings: config.settings,
          reconstruction: [...verifier.notes, ...verifier.support].flatMap(
            (note) =>
              reconstructed[note.id] === undefined
                ? []
                : [{ note: note.id, call: reconstructed[note.id]! }],
          ),
          version: ref.version,
        };
      }
      return tx.createTask(Worker, input, {
        conversationId: root,
        ownership:
          owner === undefined
            ? { kind: "conversation" }
            : { kind: "task", taskId: owner },
      });
    },
  };
}
