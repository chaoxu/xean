import {
  lazyStream,
  createProvider,
  type AssistantMessage,
  type Model,
  type Models,
  type Static,
  type TSchema,
} from "@earendil-works/pi-ai";
import {
  ask as roleAsk,
  profileNames,
  type PiRuntime,
} from "../../packages/core/src/solve/pi.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Context, JsonValue } from "@earendil-works/chord";
import { Xean, type Execution } from "../../packages/core/src/index.ts";

/** Exercise role functions inside the same native campaign used by standalone CLI calls. */
export async function invoke<Input, Output>(
  run: (
    input: Input,
    execution: Execution,
    context: Context,
  ) => Output | Promise<Output>,
  input: Input,
  overrides: Partial<Execution> = {},
): Promise<Output> {
  let failure: { error: unknown } | undefined;
  const engine = await Xean.open(new MemoryStorage(), {
    task: null,
    accept: () => true,
    roles: [],
    coordinator: {
      name: "fixture",
      async run(_signal, _view, execution, context) {
        try {
          const result = await run(
            input,
            { ...execution, ...overrides, durable: execution.durable },
            context,
          );
          return { state: null, completion: result as JsonValue };
        } catch (error) {
          failure = { error };
          throw error;
        }
      },
    },
  });
  try {
    const result = await engine.run();
    if (failure) throw failure.error;
    if (result.status !== "completed")
      throw new Error(`Fixture ${result.status}: ${result.error}`);
    return result.result as Output;
  } finally {
    await engine.close();
  }
}

export function ask<S extends TSchema>(
  ...args: Parameters<typeof roleAsk<S>>
): Promise<Static<S>> {
  const [runtime, name, system, input, schema, execution, _context, options] =
    args;
  return invoke(
    (_, native, context) =>
      roleAsk(runtime, name, system, input, schema, native, context, options),
    null,
    execution,
  );
}

export const model: Model<"openai-codex-responses"> = {
  id: "xean-fixture",
  name: "Xean fixture",
  api: "openai-codex-responses",
  provider: "xean-fixture",
  baseUrl: "https://xean.invalid/backend-api",
  reasoning: true,
  input: ["text"],
  contextWindow: 20_000,
  maxTokens: 1000,
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
  compat: { codexProxyAuth: true },
};

/** Script role replies while Pi owns the stream and its error handling. */
export function fixtureRuntime(
  respond: (
    input: Parameters<Models["streamSimple"]>[1],
    options: Parameters<Models["streamSimple"]>[2],
    selected: Parameters<Models["streamSimple"]>[0],
  ) => AssistantMessage,
): PiRuntime {
  const profiles = Object.fromEntries(
    profileNames.map((name) => [name, { model: { ...model, id: name } }]),
  ) as PiRuntime["profiles"];
  return {
    profiles,
    models: {
      getProvider(id: string) {
        return createProvider({
          id,
          name: id,
          auth: {},
          // Profiles may supply models absent from a provider's catalog.
          models: [],
          api: {
            stream() {
              throw new Error("Use the audited fixture stream");
            },
            streamSimple() {
              throw new Error("Use the audited fixture stream");
            },
          },
        });
      },
      streamSimple(
        selected: Model<string>,
        input: Parameters<Models["streamSimple"]>[1],
        options: Parameters<Models["streamSimple"]>[2],
      ) {
        async function* events() {
          await options!.onPayload!(input, selected);
          const message = respond(input, options, selected);
          yield { type: "start" as const, partial: message };
          for (const [contentIndex, block] of message.content.entries())
            if (block.type === "thinking" && block.thinkingSignature)
              yield {
                type: "thinking_end" as const,
                contentIndex,
                content: block.thinking,
                partial: message,
              };
          yield {
            type: "done" as const,
            reason: message.stopReason as "toolUse",
            message,
          };
        }
        return lazyStream(selected, async () => events());
      },
    } as unknown as Models,
  };
}
