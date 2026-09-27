import { Type, type Static } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import type { Xean } from "../kernel.ts";
import type { CampaignInput, CampaignView } from "../types.ts";
import { json } from "../json.ts";
import {
  decode,
  noteContentSchema,
  noteDraftSchema,
  object,
} from "./contracts.ts";
import { validateNotes } from "./notes.ts";
import { project } from "./projection.ts";

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
    revision: Type.Integer({ minimum: 0 }),
    ...noteContentSchema.properties,
  }),
]);
export type SolverCommand = Static<typeof commandSchema>;

export function readCommand(value: unknown): SolverCommand {
  return decode(commandSchema, json(value));
}

/** Runs on the kernel's input commit line against the latest committed view. */
export function validateCommand(value: unknown, view: CampaignView): void {
  if (!Check(commandSchema, value))
    throw new Error("Command values must be normalized before input");
  const command = value;
  if (command.kind === "guide") return;
  if (typeof view.state === "string" && view.state.startsWith("edit-"))
    throw new Error(
      "Notes are frozen while editing; retry after editing finishes",
    );
  const notes = project(view);
  if (command.kind === "submit") {
    if (
      view.inputs.some(({ value }) => {
        const previous = value as SolverCommand;
        return previous.kind === "submit" && previous.id === command.id;
      })
    )
      throw new Error(`Submission already exists: ${command.id}`);
    validateNotes(command.notes, notes);
    for (const note of command.notes) {
      const id = `input/${command.id}/${note.id}`;
      if (notes.some((known) => known.id === id))
        throw new Error(`Note already exists: ${id}`);
    }
  } else {
    const note = notes.find((note) => note.id === command.note);
    if (!note) throw new Error(`Unknown note: ${command.note}`);
    if (note.revision !== command.revision)
      throw new Error(
        `Stale note revision: ${command.note} is at ${note.revision}`,
      );
  }
}

export function submitCommand(
  engine: Xean,
  value: unknown,
): Promise<CampaignInput> {
  const command = readCommand(value);
  return engine.input(command, command.id);
}

/** Guidance is an ordered durable conversation; a later instruction can revise an earlier one. */
export function guidance(view: CampaignView): string[] {
  return view.inputs.flatMap(({ value }) => {
    const command = value as SolverCommand;
    return command.kind === "guide" ? [command.text] : [];
  });
}
