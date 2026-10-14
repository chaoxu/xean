import { copyJson, type JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import { Check } from "typebox/value";
import { taskSchema, type Task } from "./math/contracts.ts";

export type Definition = {
  task: Task;
  settings: JsonValue;
  mode?: { role: string; input: JsonValue };
};
export class UninitializedResearchError extends Error {
  constructor() {
    super("Research definition has not been committed");
    this.name = "UninitializedResearchError";
  }
}
export const DefinitionDoc = defineDoc<Partial<Definition>>({
  kind: "research.definition",
  version: 4,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({}),
});

export function validateDefinition(value: Partial<Definition>): Definition {
  if (value.task === undefined || value.settings === undefined)
    throw new UninitializedResearchError();
  if (!Check(taskSchema, value.task)) throw new Error("Invalid research task");
  const mode = value.mode;
  if (mode && (typeof mode.role !== "string" || mode.input === undefined))
    throw new Error("Invalid research mode");
  return copyJson({
    task: value.task,
    settings: value.settings,
    ...(mode ? { mode } : {}),
  }) as Definition;
}

export async function readDefinition(
  tx: Tx,
  root: ConversationId,
): Promise<Definition> {
  return validateDefinition(await tx.doc(DefinitionDoc, root));
}
