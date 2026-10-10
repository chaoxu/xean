import { Type, type Static } from "@earendil-works/pi-ai";
import {
  decode,
  noteContentSchema,
  noteDraftSchema,
  noteEditSchema,
  object,
} from "./contracts.ts";

const id = Type.String({ pattern: "^[A-Za-z0-9_-]{1,128}$" });
const text = Type.String({ minLength: 1, pattern: "\\S" });
export const commandSchema = Type.Union([
  object({
    kind: Type.Literal("submit"),
    id,
    notes: Type.Array(noteDraftSchema),
    edits: Type.Optional(Type.Array(noteEditSchema)),
    candidate: Type.Boolean(),
  }),
  object({ kind: Type.Literal("guide"), id, text }),
  object({
    kind: Type.Literal("correct"),
    id,
    note: text,
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    cosmetic: noteEditSchema.properties.cosmetic,
    ...noteContentSchema.properties,
  }),
]);
export type SolverCommand = Static<typeof commandSchema>;
/** Match Pi's stored JSON, including omitted optional undefined fields. */
export const readCommand = (value: unknown): SolverCommand =>
  JSON.parse(JSON.stringify(decode(commandSchema, value)));
