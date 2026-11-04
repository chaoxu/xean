import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { ProviderDoc, type TaskId } from "@earendil-works/pi-durable";
import { inspect, open, readNotes, solveSettings } from "../src/index.ts";
import { Assignment } from "../src/role-runtime.ts";
import { Notebook, readNotebook } from "../src/state.ts";
import type { CallDescriptor } from "../src/policy/prompts.ts";
import type { WorkerRequest } from "../src/workers.ts";
import { reconstructionStatementIds } from "../src/policy/contracts.ts";

export { context };
export const problem = {
  problem: "Prove P.",
  completionCriteria: "Prove P fully.",
};
export const profile = { provider: "test", model: "math", reasoning: "high" };
export const defaultSettings = () =>
  solveSettings.parse({
    explorer: profile,
    source: profile,
    correctness: profile,
    requirements: profile,
    reconstruction: profile,
    maxWorkers: 2,
  });
export type Request = {
  descriptor: CallDescriptor;
  transcript: TranscriptContext;
  signal: AbortSignal | undefined;
};
export type Respond = (
  request: Request,
) => JsonValue | Error | Promise<JsonValue | Error>;
export const note = (
  text = "Complete proof of P.",
  support: string[] = [],
) => ({ text, summary: text, support });
export const checks = (ids: string[], verdict = "PASS") => ({
  verdicts: ids.map((note) => ({
    note,
    verdict,
    report: `${verdict} checked.`,
  })),
});
export const complete: Respond = ({ descriptor }): JsonValue => {
  switch (descriptor.kind) {
    case "explorer":
      return { notes: [note()] };
    case "selection":
      return {
        verify: descriptor.input.notes
          .filter((note) => !note.dead)
          .map((note) => ({
            note: note.id,
            verifiers: [
              "source",
              "correctness",
              "requirements",
              "reconstruction",
            ],
          })),
      };
    case "verifier":
      return checks(descriptor.judged);
    case "statement":
      return {
        statements: reconstructionStatementIds(descriptor.input).map((id) => ({
          note: id,
          statement: `Exact claim ${id}.`,
        })),
      };
    case "proof":
      return { proof: "Independent proof." };
    case "reconstruction":
      return {
        statements: [],
        ...checks(descriptor.input.notes.map((note) => note.id)),
      };
  }
};
export const abortable = (signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

export async function fixture(
  respond: Respond = complete,
  options: { automatic?: boolean; settings?: Record<string, unknown> } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "xean-worker-contract-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "research.sqlite");
  const provider = fauxProvider({
    provider: "test",
    models: [{ id: "math", reasoning: true }],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const requests: Request[] = [];
  let owner: Awaited<ReturnType<typeof open>>;
  provider.setResponses(
    Array.from(
      { length: 128 },
      () =>
        async (
          transcript: TranscriptContext,
          options: { sessionId?: string; signal?: AbortSignal } | undefined,
        ) => {
          const descriptor = await owner.root.commit(async (tx) => {
            const conversations = await tx.scanConversations({}, 256);
            for (const conversation of conversations.items) {
              const provider = await tx.doc(ProviderDoc, conversation.id);
              if (provider.sessionId !== options?.sessionId) continue;
              const assignment = await tx.doc(Assignment, conversation.id);
              if (assignment.descriptor)
                return JSON.parse(
                  JSON.stringify(assignment.descriptor),
                ) as CallDescriptor;
            }
            throw new Error(
              "Provider request has no matching native assignment",
            );
          }, context);
          const request = {
            descriptor,
            transcript: structuredClone(transcript),
            signal: options?.signal,
          };
          requests.push(request);
          const value = await respond(request);
          if (options?.signal?.aborted)
            return fauxAssistantMessage("", { stopReason: "aborted" });
          if (value instanceof Error)
            return fauxAssistantMessage("", {
              stopReason: "error",
              errorMessage: value.message,
            });
          const tool = getCurrentTools(transcript.messages)[0];
          if (!tool) throw new Error("Missing role tool");
          return fauxAssistantMessage(
            [fauxToolCall(tool.name, value as Record<string, JsonValue>)],
            { stopReason: "toolUse" },
          );
        },
    ),
  );
  owner = await open(path, {
    create: {
      task: problem,
      settings: solveSettings.parse({
        ...defaultSettings(),
        ...options.settings,
      }),
    },
    startCampaign: options.automatic ?? false,
    models,
  });
  cleanup.push(() => owner.close());
  return {
    path,
    requests,
    provider,
    get owner() {
      return owner;
    },
    create(request: WorkerRequest) {
      return owner.root.commit(
        (tx) => owner.workers.create(tx, owner.root.id, request),
        context,
      );
    },
    async run(request: WorkerRequest) {
      const id = await this.create(request);
      return {
        id,
        outcome: (await owner.harness.waitForTask(id, context)).state.outcome,
      };
    },
    wait(id: TaskId) {
      return owner.harness.waitForTask(id, context);
    },
    notes() {
      return inspect(path, readNotes);
    },
    book() {
      return inspect(
        path,
        async (tx, root) =>
          JSON.parse(
            JSON.stringify(readNotebook(await tx.doc(Notebook, root))),
          ) as ReturnType<typeof readNotebook>,
      );
    },
    tasks() {
      return inspect(path, async (tx, root) =>
        JSON.parse(
          JSON.stringify(
            (await tx.scanTasks({ conversationId: root }, 256)).items,
          ),
        ),
      );
    },
    async reopen() {
      await owner.close();
      owner = await open(path, { models });
      return owner;
    },
  };
}
