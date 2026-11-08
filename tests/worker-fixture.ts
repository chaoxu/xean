import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord/json";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { ProviderDoc } from "@earendil-works/pi-durable";
import { inspect, open, readNotes, solveSettings } from "../src/index.ts";
import { Assignment } from "../src/role-runtime.ts";
import { readNotebook } from "../src/state.ts";
import type { CallDescriptor } from "../src/policy/prompts.ts";
import type { WorkerRequest, SourceExecutor } from "../src/workers.ts";
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
  options: {
    automatic?: boolean;
    settings?: Record<string, unknown>;
    source?: SourceExecutor;
  } = {},
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
  const reports: unknown[] = [];
  let ready = Promise.withResolvers<void>();
  let owner: Awaited<ReturnType<typeof open>>;
  provider.setResponses(
    Array.from(
      { length: 128 },
      () =>
        async (
          transcript: TranscriptContext,
          options: { sessionId?: string; signal?: AbortSignal } | undefined,
        ) => {
          await ready.promise;
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
    execute: true,
    models,
    source: options.source,
    report: (error) => reports.push(error),
  });
  ready.resolve();
  cleanup.push(() => owner.close());
  return {
    path,
    requests,
    provider,
    reports,
    get owner() {
      return owner;
    },
    start(request: WorkerRequest) {
      return owner.start(request);
    },
    startGroup(requests: WorkerRequest[]) {
      return owner.startGroup(requests);
    },
    async run(request: WorkerRequest) {
      const job = await owner.start(request);
      const outcome = await job.outcome(context);
      return { id: job.id, origin: outcome.args.origin ?? job.id, outcome };
    },
    wait(job: Awaited<ReturnType<typeof owner.start>>) {
      return job.outcome(context);
    },
    async finished(id: string) {
      const deadline = Date.now() + 5000;
      for (;;) {
        const row = owner.history.find((row) => row.id === id);
        if (row) return row;
        if (Date.now() > deadline) throw new Error("Job did not settle");
        await Bun.sleep(5);
      }
    },
    history() {
      return owner.history;
    },
    running() {
      return owner.running.value;
    },
    notes() {
      return inspect(path, readNotes);
    },
    book() {
      return inspect(
        path,
        (data) =>
          JSON.parse(JSON.stringify(readNotebook(data.notebook))) as ReturnType<
            typeof readNotebook
          >,
      );
    },
    data() {
      return inspect(
        path,
        (data) => JSON.parse(JSON.stringify(data)) as typeof data,
      );
    },
    tasks() {
      return inspect(path, async (_data, session) =>
        JSON.parse(
          JSON.stringify(
            (await session.commit((tx) => tx.scanTasks({}, 256), context))
              .items,
          ),
        ),
      );
    },
    async reopen(execute = true) {
      await owner.close();
      ready = Promise.withResolvers<void>();
      owner = await open(path, {
        models,
        execute,
        source: options.source,
        report: (error) => reports.push(error),
      });
      ready.resolve();
      return owner;
    },
  };
}
