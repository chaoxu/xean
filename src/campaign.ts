import { z } from "zod";

import { Journal } from "./db";
import { copyJson, entryId, verdict as verdictSchema } from "./schemas";
import type {
  AuditedTool,
  CallContext,
  CallOptions,
  CallReceipt,
  Campaign,
  Entry,
  EntryId,
  Json,
  Reader,
  RecordQuery,
  Tool,
  Verdict,
} from "./types";
import { toolDeclarations } from "./types";

interface PreparedTool {
  readonly declaration: Omit<AuditedTool, "execute">;
  readonly input: Tool["input"];
  readonly run: Tool["run"];
}

interface CallState {
  readonly pending: Set<Promise<Json>>;
  accepting: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function names(values: readonly string[]): readonly string[] {
  return [...new Set(z.array(z.string().min(1)).min(1).parse(values))].sort();
}

class CampaignReader implements Reader {
  constructor(protected readonly journal: Journal) {}

  records(options?: RecordQuery): readonly Entry[] {
    return this.journal.records(options);
  }

  record(seq: EntryId): Entry | undefined {
    return this.journal.record(seq);
  }

  lastSequence(): number {
    return this.journal.lastSequence();
  }

  payload(digest: string): Json {
    return this.journal.payload(digest);
  }

  material(candidate: EntryId): Uint8Array {
    return this.journal.material(candidate);
  }

  close(): void {
    this.journal.close();
  }
}

class CampaignWriter extends CampaignReader implements Campaign {
  #activeCalls = 0;

  storePayload(value: Json): string {
    return this.journal.storePayload(value);
  }

  submitCandidate(
    material: Uint8Array,
    requiredVerifiers: readonly string[],
  ): EntryId {
    const required = names(requiredVerifiers);
    return this.journal.append(
      {
        kind: "candidate",
        requiredVerifiers: required,
      },
      material,
    ).seq;
  }

  recordVerdict(
    callValue: EntryId,
    verdictValue: Verdict,
    evidenceValue: Json,
  ): EntryId {
    const call = entryId.parse(callValue);
    const verdict = verdictSchema.parse(verdictValue);
    const start = this.record(call);
    const candidate = start?.kind === "call" ? start.candidate : undefined;
    const declaration =
      candidate === undefined ? undefined : this.record(candidate);
    const result = this.records({ kinds: ["call-result"], parent: call })[0];
    if (
      start?.kind !== "call" ||
      candidate === undefined ||
      declaration?.kind !== "candidate" ||
      start.seq <= declaration.seq ||
      !declaration.requiredVerifiers.includes(start.label) ||
      result?.kind !== "call-result" ||
      result.state !== "returned" ||
      !isObject(result.output) ||
      result.output.state !== "succeeded"
    ) {
      throw new Error("verdict requires a fresh successful verifier call");
    }
    return this.journal.append({
      kind: "verdict",
      call,
      verdict,
      evidence: evidenceValue,
    }).seq;
  }

  async call(
    options: CallOptions,
    runner: (context: CallContext) => Promise<unknown>,
  ): Promise<CallReceipt> {
    const label = z.string().min(1).parse(options.label);
    const role =
      options.role === undefined
        ? undefined
        : z.string().min(1).parse(options.role);
    const candidate =
      options.candidate === undefined
        ? undefined
        : entryId.parse(options.candidate);
    const signal = options.signal ?? new AbortController().signal;
    const prepared = this.prepareTools(options.tools ?? []);
    const state: CallState = { pending: new Set(), accepting: true };
    const start = this.journal.append({
      kind: "call",
      label,
      ...(role === undefined ? {} : { role }),
      ...(candidate === undefined ? {} : { candidate }),
      request: options.request,
      tools: prepared.map(({ declaration }) => declaration),
    });
    if (start.kind !== "call") throw new Error("invalid stored call");
    const request = start.request;
    const call = start.seq;
    const tools = prepared.map((tool) =>
      this.wrapTool(call, tool, signal, state),
    );
    this.#activeCalls += 1;
    let output: Json | undefined;
    let failure: unknown;
    try {
      output = copyJson(await runner({ call, request, tools, signal }));
    } catch (error) {
      failure = error;
    } finally {
      state.accepting = false;
      await Promise.allSettled([...state.pending]);
    }
    try {
      if (failure !== undefined || output === undefined) {
        this.journal.append({
          kind: "call-result",
          parent: call,
          state: "threw",
          error: errorText(failure),
        });
        throw failure;
      }
      this.journal.append({
        kind: "call-result",
        parent: call,
        state: "returned",
        output,
      });
      return { call, output };
    } finally {
      this.#activeCalls -= 1;
    }
  }

  private prepareTools(tools: readonly Tool[]): readonly PreparedTool[] {
    const declarations = toolDeclarations(tools);
    return tools.map((tool, index) => {
      return {
        declaration: declarations[index]!,
        input: tool.input,
        run: tool.run.bind(tool),
      };
    });
  }

  private wrapTool(
    call: EntryId,
    tool: PreparedTool,
    signal: AbortSignal,
    state: CallState,
  ): AuditedTool {
    const { name, description, inputSchema } = tool.declaration;
    return {
      name,
      description,
      inputSchema,
      execute: (raw, sourceValue) => {
        const execution = (async () => {
          if (!state.accepting) {
            throw new Error(`call is no longer accepting ${name}`);
          }
          const parsed = tool.input.parse(raw);
          const source =
            sourceValue === undefined
              ? undefined
              : z.string().min(1).parse(sourceValue);
          const stored = this.journal.append({
            kind: "tool-call",
            call,
            tool: name,
            ...(source === undefined ? {} : { source }),
            input: parsed as Json,
          });
          if (stored.kind !== "tool-call")
            throw new Error("invalid stored tool call");
          const { input, seq: toolCall } = stored;
          let output: Json;
          try {
            output = copyJson(
              await tool.run(input, {
                call,
                toolCall,
                ...(source === undefined ? {} : { source }),
                signal,
              }),
            );
          } catch (error) {
            this.journal.append({
              kind: "tool-result",
              parent: toolCall,
              state: "threw",
              error: errorText(error),
            });
            throw error;
          }
          this.journal.append({
            kind: "tool-result",
            parent: toolCall,
            state: "returned",
            output,
          });
          return output;
        })();
        state.pending.add(execution);
        void execution
          .finally(() => state.pending.delete(execution))
          .catch(() => {});
        return execution;
      },
    };
  }

  override close(): void {
    if (this.#activeCalls > 0) throw new Error("campaign has active calls");
    super.close();
  }
}

function isObject(value: Json): value is { readonly [key: string]: Json } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createCampaign(
  path: string,
  application: string,
  config: Json,
): Campaign {
  const checked = z.string().min(1).parse(application);
  return new CampaignWriter(Journal.create(path, checked, copyJson(config)));
}

export function openCampaign(path: string): Campaign {
  return new CampaignWriter(Journal.open(path, "write"));
}

export function openReader(path: string): Reader {
  return new CampaignReader(Journal.open(path, "read"));
}
