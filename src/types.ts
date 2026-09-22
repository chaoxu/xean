import { z } from "zod";

import {
  copyJson,
  type Entry,
  type EntryId,
  type Json,
  type ToolDeclaration,
} from "./schemas";

export type {
  Entry,
  EntryDraft,
  EntryId,
  Json,
  ToolDeclaration,
} from "./schemas";

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  /** Every valid repetition after an interrupted phase must be harmless. */
  run(input: unknown, context: ToolExecutionContext): Promise<unknown>;
}

export interface ToolExecutionContext {
  readonly call: EntryId;
  readonly toolCall: EntryId;
  readonly source?: string;
  readonly signal: AbortSignal;
}

export function toolDeclarations(
  tools: readonly Tool[],
): readonly ToolDeclaration[] {
  const seen = new Set<string>();
  return tools.map((tool) => {
    const name = z.string().min(1).parse(tool.name);
    if (seen.has(name)) throw new Error(`duplicate tool name: ${name}`);
    seen.add(name);
    const description = z.string().min(1).parse(tool.description);
    return {
      name,
      description,
      inputSchema: copyJson(z.toJSONSchema(tool.input)),
    };
  });
}

export interface AuditedTool extends ToolDeclaration {
  execute(input: unknown, source?: string): Promise<Json>;
}

export interface Reader {
  records(options?: RecordQuery): readonly Entry[];
  record(seq: EntryId): Entry | undefined;
  lastSequence(): number;
  payload(digest: string): Json;
  close(): void;
}

/** Filters are intersected. Labels select calls and their call-results. */
export interface RecordQuery {
  readonly kinds?: readonly Entry["kind"][];
  readonly labels?: readonly string[];
  readonly excludeLabels?: readonly string[];
  readonly call?: EntryId;
  readonly parent?: EntryId;
  readonly after?: number;
  readonly through?: number;
}

export interface CallOptions {
  readonly label: string;
  readonly role?: string;
  readonly parent?: EntryId;
  readonly request: Json;
  readonly tools?: readonly Tool[];
  readonly signal?: AbortSignal;
}

export interface CallContext {
  readonly call: EntryId;
  readonly request: Json;
  readonly tools: readonly AuditedTool[];
  readonly signal: AbortSignal;
}

export interface CallReceipt {
  readonly call: EntryId;
  readonly output: Json;
}

export interface Campaign extends Reader {
  storePayload(value: Json): string;
  storePayloadJson(encoded: string): string;
  recordEvidence(call: EntryId, evidence: Json): EntryId;
  call(
    options: CallOptions,
    runner: (context: CallContext) => Promise<unknown>,
  ): Promise<CallReceipt>;
}

export interface ToolDefinition<S extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  run(input: z.output<S>, context: ToolExecutionContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(
  definition: ToolDefinition<S>,
): Tool {
  return {
    name: definition.name,
    description: definition.description,
    input: definition.input,
    run(input, context) {
      return definition.run(input as z.output<S>, context);
    },
  };
}
