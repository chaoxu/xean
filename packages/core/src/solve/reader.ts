import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { object, type Note } from "./contracts.ts";

const readSchema = object({
  ids: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
  }),
  level: StringEnum(["detailed", "full"] as const),
});

/** Read from the caller's detached, frozen invocation snapshot. */
export function noteReader(notes: Note[]): ToolRegistration<typeof readSchema> {
  const byId = new Map(notes.map((note) => [note.id, note]));
  return {
    name: "read_notes",
    replay: "safe",
    description:
      "Read detailed summaries or authoritative full notes by ID. Status, feedback, and support IDs are in the supplied frozen index. Batch up to 20 IDs. Dead notes are diagnostic only.",
    parameters: readSchema,
    async execute({ ids, level }) {
      const values = ids.map((id) => {
        const note = byId.get(id);
        if (!note) throw new Error(`Unknown note: ${id}`);
        return {
          id: note.id,
          detailedSummary: note.detailedSummary,
          ...(level === "full" ? { text: note.text } : {}),
        };
      });
      return {
        content: [{ type: "text", text: JSON.stringify(values) }],
        details: null,
      };
    },
  };
}
