import type { JsonValue } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import type { Roles } from "../src/workflow.ts";

export function recoveryRoles(builtins: Roles): Partial<Roles> {
  const capabilities = builtins.capabilities!;
  return {
    capabilities(input) {
      const available = capabilities(input);
      return {
        ...available,
        explorer: available.explorer && input.notes.length === 0,
      };
    },
  };
}

export const context = BACKGROUND_CONTEXT;
export const task = {
  problem: "Prove 1 = 1.",
  completionCriteria: "A self-contained proof of the exact equality.",
};
export const settings = {
  profiles: { default: { provider: "openai" as const, model: "fixture" } },
  research: false as const,
};
export const noteResult = {
  notes: [
    {
      id: "n1",
      summary: "Reflexivity",
      detailedSummary: "Equality is reflexive.",
      statement: "1 = 1",
      argument: "By reflexivity, 1 = 1.",
      support: [],
    },
  ],
  candidate: true,
};

export function fixture(
  respond: (role: string, input: any) => unknown | Promise<unknown>,
) {
  const models = createModels();
  const faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: "fixture",
        reasoning: true,
        contextWindow: 131072,
        maxTokens: 8192,
      },
    ],
  });
  const calls: { role: string; session?: string; input: any }[] = [];
  const response: FauxResponseFactory = async (transcript, options) => {
    faux.appendResponses([response]);
    const tool = getCurrentTools(transcript.messages).find((tool) =>
      tool.name.startsWith("submit_"),
    )!;
    const role = tool.name.slice("submit_".length);
    const input = JSON.parse(
      transcript.messages.filter((message) => message.role === "user").at(-1)!
        .content as string,
    );
    calls.push({ role, session: options?.sessionId, input });
    const value = await awaitWithContext(
      Promise.resolve().then(() => respond(role, input)),
      options?.signal ? withAbortSignal(options.signal, context) : context,
    );
    return fauxAssistantMessage(
      [fauxToolCall(tool.name, value as Record<string, JsonValue>)],
      { stopReason: "toolUse" },
    );
  };
  faux.setResponses([response]);
  models.setProvider(faux.provider);
  return { models, calls };
}
