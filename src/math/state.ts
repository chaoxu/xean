import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineEntry,
  type ConversationId,
  type Cursor,
  type EntryId,
  type TaskId,
  type TaskOutcome,
  type Tx,
  type TypedEntry,
} from "@earendil-works/pi-durable";
import {
  commandSchema,
  validateCommand,
  type SolverCommand,
} from "./commands.ts";
import { decode, object, type Exploration, type Note } from "./contracts.ts";
import { refresh, validateResult } from "./notes.ts";
import { resolveResult } from "./results.ts";

export type ResearchEvent =
  { type: "input"; command: SolverCommand } | { type: "result"; task: TaskId };
export const Events = defineEntry<ResearchEvent>("research.event");
const eventSchema = Type.Union([
  object({ type: Type.Literal("input"), command: commandSchema }),
  object({
    type: Type.Literal("result"),
    task: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }),
]);

export type MathView = {
  notes: Note[];
  guidance: string[];
  inputs: { id: EntryId; command: SolverCommand }[];
  results: { id: EntryId; task: TaskId; outcome: TaskOutcome<JsonValue> }[];
  cutoff?: EntryId;
};

/** Replay immutable root entries and referenced outcomes; persist no second corpus. */
export async function readView(
  tx: Tx,
  root: ConversationId,
  cutoff?: EntryId,
): Promise<MathView> {
  const entries: TypedEntry<ResearchEvent>[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries(
      { conversationId: root, maxEntryId: cutoff },
      128,
      cursor,
    );
    for (const entry of page.items) if (Events.is(entry)) entries.push(entry);
    cursor = page.next;
  } while (cursor);
  entries.reverse();
  const view: MathView = { notes: [], guidance: [], inputs: [], results: [] };
  if (cutoff !== undefined || entries.length)
    view.cutoff = cutoff ?? entries.at(-1)!.id;
  const inputIds = new Set<string>();
  const resultIds = new Set<TaskId>();
  const append = (
    prefix: string,
    drafts: Exploration["notes"],
    candidate: boolean,
    imported: boolean,
  ) => {
    const local = new Set(drafts.map((draft) => draft.id));
    for (const [index, draft] of drafts.entries()) {
      const id = `${prefix}/${draft.id}`;
      view.notes.push({
        ...draft,
        id,
        support: draft.support.map((id) =>
          local.has(id) ? `${prefix}/${id}` : id,
        ),
        revision: 0,
        imported,
        candidate: candidate && index === drafts.length - 1,
        checks: [],
        verified: false,
        accepted: false,
        dead: false,
      });
    }
  };
  for (const entry of entries) {
    const event = decode(eventSchema, entry.data) as ResearchEvent;
    if (event.type === "input") {
      const command = validateCommand(event.command, view);
      if (inputIds.has(command.id))
        throw new Error(`Duplicate input: ${command.id}`);
      inputIds.add(command.id);
      view.inputs.push({ id: entry.id, command });
      if (command.kind === "submit")
        append(`input/${command.id}`, command.notes, command.candidate, true);
      else if (command.kind === "guide") view.guidance.push(command.text);
      else {
        const note = view.notes.find((note) => note.id === command.note)!;
        note.statement = command.statement;
        note.argument = command.argument;
        note.summary = command.summary;
        note.detailedSummary = command.detailedSummary;
        note.revision++;
      }
    } else {
      if (resultIds.has(event.task))
        throw new Error(`Duplicate result publication: ${event.task}`);
      resultIds.add(event.task);
      const worker = await tx.task(event.task);
      if (
        !worker ||
        worker.conversationId !== root ||
        (worker.state.status !== "completing" &&
          worker.state.status !== "terminal")
      )
        throw new Error(
          `Result does not reference a settled worker in this campaign: ${event.task}`,
        );
      const outcome = worker.state.outcome;
      view.results.push({ id: entry.id, task: worker.id, outcome });
      const standalone =
        worker.input !== null &&
        typeof worker.input === "object" &&
        "standalone" in worker.input;
      if (
        standalone ||
        (outcome.status !== "completed" && outcome.status !== "failed") ||
        outcome.result === undefined
      )
        continue;
      const result = validateResult(
        await resolveResult(tx, outcome.result),
        view.notes,
        outcome.status === "failed",
      );
      if (result.kind === "notes")
        append(String(worker.id), result.notes, result.candidate, false);
      else
        for (const check of result.checks) {
          const { noteId, correction, ...recorded } = check;
          const note = view.notes.find((note) => note.id === noteId)!;
          if (correction && note.revision === correction.revision) {
            const { revision: _revision, ...content } = correction;
            Object.assign(note, content);
            note.revision++;
          }
          note.checks.push(recorded);
        }
    }
    refresh(view.notes);
  }
  return view;
}
