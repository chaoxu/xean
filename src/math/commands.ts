import { Type, type Static } from "@earendil-works/pi-ai";
import {
  decode,
  noteContentSchema,
  noteDraftSchema,
  object,
  type Note,
} from "./contracts.ts";
import { validateNotes } from "./notes.ts";

const id = Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" });
const text = Type.String({ minLength: 1, pattern: "\\S" });
export const commandSchema = Type.Union([
  object({
    kind: Type.Literal("submit"),
    id,
    notes: Type.Array(noteDraftSchema, { minItems: 1 }),
    candidate: Type.Boolean(),
  }),
  object({ kind: Type.Literal("guide"), id, text }),
  object({
    kind: Type.Literal("correct"),
    id,
    note: text,
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ...noteContentSchema.properties,
  }),
]);
export type SolverCommand = Static<typeof commandSchema>;
export const readCommand = (value: unknown): SolverCommand =>
  decode(commandSchema, value);

/** Called in the same native commit that admits the input and its Coordinator. */
export function validateCommand(
  command: SolverCommand,
  view: { notes: readonly Note[] },
): SolverCommand {
  if (command.kind === "submit") {
    validateNotes(command.notes, view.notes);
  } else if (command.kind === "correct") {
    const note = view.notes.find((note) => note.id === command.note);
    if (!note) throw new Error(`Unknown note: ${command.note}`);
    if (note.revision !== command.revision)
      throw new Error(
        `Stale note revision: ${command.note} is at ${note.revision}`,
      );
  }
  return command;
}
