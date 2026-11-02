import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type TranscriptContext } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import {
  getCurrentSystemMessage,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  ROOT_CONVERSATION_ID,
  section,
  type PromptSection,
} from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import {
  ActivityClient,
  createActivityHandler,
  type ActivityOptions,
} from "../src/activity.ts";
import {
  createRoleRuntime,
  roleGenerationPolicy,
} from "../src/role-runtime.ts";
import { resolveCall, type CallDescriptor } from "../src/policy/prompts.ts";
import {
  initializeNotebook,
  Notebook,
  readNotebook,
  saveNotebook,
} from "../src/state.ts";

const context = BACKGROUND_CONTEXT;
const task = { problem: "Prove 1 = 1.", completionCriteria: "Give a proof." };
const note = {
  id: "n1",
  text: "Reflexivity gives 1 = 1.",
  summary: "Reflexivity holds.",
  support: [],
  verdicts: [],
  verified: false,
  dead: false,
};
const explorer: CallDescriptor = {
  kind: "explorer",
  input: { task, notes: [note], explorerGuidance: "Prove the claim." },
};
const value = { notes: [{ text: "Reflexivity gives 1 = 1.", support: [] }] };
const reply = (name: string, args: Record<string, JsonValue>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const submitted = () => reply("submit_notes", value);
const announcement = () =>
  reply("announce_activity", {
    intent: "Check the equality by reflexivity",
    notes: ["n1"],
  });
const observationMessage = (transcript: TranscriptContext) => {
  const last = transcript.messages.at(-1);
  return last?.role === "user" &&
    typeof last.content === "string" &&
    last.content.startsWith("<xean_activity>\n")
    ? last.content
    : undefined;
};
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function service(config?: Parameters<typeof createActivityHandler>[0]) {
  const handler = createActivityHandler(config);
  const renewed = Promise.withResolvers<void>();
  let online = true;
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      const response = online
        ? await handler(request)
        : new Response("offline", { status: 503 });
      if (new URL(request.url).pathname.endsWith("/renew")) renewed.resolve();
      return response;
    },
  });
  cleanup.push(() => server.stop(true));
  const options: ActivityOptions = {
    url: server.url.toString(),
    scope: "problem-v1",
    owner: "shared label",
  };
  return {
    options,
    renewed: renewed.promise,
    get requests() {
      return requests;
    },
    set online(value: boolean) {
      online = value;
    },
    client(owner = options.owner) {
      return new ActivityClient({ ...options, owner });
    },
  };
}

async function fixture(
  responses: FauxResponseStep[],
  activity?: ActivityOptions,
  storedDirectory?: string,
  nativeSections: readonly PromptSection[] = [],
) {
  const directory =
    storedDirectory ?? (await mkdtemp(join(tmpdir(), "xean-activity-role-")));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const provider = fauxProvider({
    provider: "activity-test",
    models: [{ id: "math", reasoning: true }],
  });
  provider.setResponses(responses);
  const models = createModels();
  models.setProvider(provider.provider);
  const role = createRoleRuntime(activity);
  const Invoke = defineTask<
    CallDescriptor,
    { phase: "run" },
    JsonValue,
    object
  >({
    name: "test.activity-role",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      async run(task, runtime, ctx) {
        const result = await role.run(
          runtime,
          "role",
          task.input,
          { provider: "activity-test", model: "math", reasoning: "max" },
          ctx,
        );
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result },
          }),
          ctx,
        );
      },
    },
    async abort(_task, runtime, ctx) {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        ctx,
      );
    },
  });
  const registry = createRegistry();
  registry.install({
    ...role.extension,
    sections: [...(role.extension.sections ?? []), ...nativeSections],
  });
  registry.install(defineExtension({ name: "test.activity", tasks: [Invoke] }));
  const harness = await Harness.open(
    storedDirectory
      ? await openNodeJsonlStorage(storedDirectory, context, { fsync: true })
      : new MemoryStorage(),
    {
      registry,
      models,
      settings: {
        compaction: { enabled: false },
        retry: { enabled: false },
        generation: roleGenerationPolicy,
        toolExecution: "sequential",
      },
    },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    async init(tx, id) {
      await initializeNotebook(tx, id, join(directory, "notes.sqlite"));
      const ref = await tx.doc(Notebook, id);
      const book = readNotebook(ref);
      book.notes.push({
        id: note.id,
        text: note.text,
        summary: note.summary,
        support: [],
      });
      saveNotebook(tx, ref, book);
    },
  });
  return {
    harness,
    provider,
    role,
    invoke(input: CallDescriptor = explorer) {
      return root.commit(
        (tx) =>
          tx.createTask(Invoke, input, { ownership: { kind: "conversation" } }),
        context,
      );
    },
    messages() {
      return harness.commit(async (tx) => {
        const conversations = await tx.scanConversations({}, 128);
        const pages = await Promise.all(
          conversations.items.map(({ id }) =>
            tx.scanEntries({ conversationId: id, order: "ascending" }, 128),
          ),
        );
        return pages.flatMap(({ items }) =>
          items.flatMap((entry) => entry.model ?? []),
        );
      }, context);
    },
  };
}

test("Explorer observes peers, publishes a qualified reference, and records observations before submitting", async () => {
  const remote = service();
  const peer = remote.client();
  await peer.announce("Peer checks a different approach", [
    "another-notebook/n1@7",
  ]);
  cleanup.push(() => peer.close());
  const seen: string[] = [];
  let prefix: TranscriptContext["messages"] = [];
  const run = await fixture(
    [
      async (transcript) => {
        expect(getCurrentSystemPrompt(transcript.messages)).toBe(
          resolveCall(explorer).system,
        );
        expect(
          getCurrentSystemMessage(transcript.messages)?.sections?.instructions,
        ).toBe(resolveCall(explorer).system);
        expect(
          transcript.messages.some(
            (message) =>
              message.role === "system" &&
              Object.hasOwn(message.sections ?? {}, "xean_activity"),
          ),
        ).toBe(false);
        prefix = transcript.messages.slice(0, -1);
        expect(
          getCurrentTools(transcript.messages).map((tool) => tool.name),
        ).toContain("announce_activity");
        expect(observationMessage(transcript)).toContain(
          "Peer checks a different approach",
        );
        expect(observationMessage(transcript)).toContain('"announced":false');
        seen.push(observationMessage(transcript)!);
        await peer.announce("Peer changed direction", []);
        return announcement();
      },
      async (transcript) => {
        expect(getCurrentSystemPrompt(transcript.messages)).toBe(
          resolveCall(explorer).system,
        );
        expect(transcript.messages.slice(0, prefix.length)).toEqual(prefix);
        expect(
          transcript.messages.some(
            (message) =>
              message.role === "system" &&
              Object.hasOwn(message.sections ?? {}, "xean_activity"),
          ),
        ).toBe(false);
        expect(
          transcript.messages
            .slice(0, -1)
            .some(
              (message) =>
                typeof message.content === "string" &&
                message.content.startsWith("<xean_activity>\n"),
            ),
        ).toBe(false);
        expect(observationMessage(transcript)).toContain(
          "Peer changed direction",
        );
        expect(observationMessage(transcript)).not.toContain(
          "Peer checks a different approach",
        );
        expect(observationMessage(transcript)).toContain('"announced":true');
        seen.push(observationMessage(transcript)!);
        const observer = remote.client("observer");
        const observation = await observer.observe();
        expect(observation.status).toBe("available");
        if (observation.status !== "available")
          throw new Error("Missing activity");
        expect(observation.activities).toHaveLength(2);
        const own = observation.activities.find(
          (record) => record.intent === "Check the equality by reflexivity",
        )!;
        expect(own.refs).toHaveLength(1);
        expect(own.refs[0]).toMatch(/^xean:[^/]+\/notes\/n1@1$/);
        return submitted();
      },
    ],
    remote.options,
  );
  expect(
    (await run.harness.waitForTask(await run.invoke(), context)).state.outcome,
  ).toMatchObject({ status: "completed", result: { value } });
  expect(run.provider.state.callCount).toBe(2);
  const messages = await run.messages();
  const saved = messages
    .filter((message) => message.role === "system")
    .map((message) => message.sections?.["xean_activity"]);
  for (const observation of seen) expect(saved).toContain(observation);
  expect(
    messages.filter(
      (message) =>
        message.role === "toolResult" && message.toolName === "submit_notes",
    ),
  ).toHaveLength(1);
  const observation = await remote.client("observer").observe();
  expect(
    observation.status === "available" &&
      observation.activities.map((record) => record.intent),
  ).toEqual(["Peer changed direction"]);
  const book = await run.harness.snapshot(
    Notebook,
    ROOT_CONVERSATION_ID,
    context,
  );
  expect(book?.version).toBe(1);
  expect(book?.notes).toEqual(["n1"]);
});

test("an outage replaces the current observation with unavailable", async () => {
  const remote = service();
  const peer = remote.client("peer");
  await peer.announce("A formerly visible peer", []);
  cleanup.push(() => peer.close());
  const run = await fixture(
    [
      (transcript) => {
        expect(observationMessage(transcript)).toContain(
          "A formerly visible peer",
        );
        remote.online = false;
        return reply("read_notes", { ids: ["n1"], level: "full" });
      },
      (transcript) => {
        expect(observationMessage(transcript)).toContain(
          '"status":"unavailable"',
        );
        expect(observationMessage(transcript)).not.toContain(
          "A formerly visible peer",
        );
        return submitted();
      },
    ],
    remote.options,
  );
  expect(
    (await run.harness.waitForTask(await run.invoke(), context)).state.outcome
      .status,
  ).toBe("completed");
  const saved = (await run.messages())
    .filter((message) => message.role === "system")
    .map((message) => message.sections?.["xean_activity"]);
  expect(saved.some((text) => text?.includes("A formerly visible peer"))).toBe(
    true,
  );
  expect(saved.some((text) => text?.includes('"status":"unavailable"'))).toBe(
    true,
  );
  remote.online = true;
});

const statement = { statements: [{ note: "n1", statement: "1 = 1." }] };
const input = { task, notes: [note], support: [] };
const verdict = {
  note: "n1",
  verdict: "PASS",
  report: "Reflexivity suffices.",
};
const otherRoles: {
  label: string;
  descriptor: CallDescriptor;
  value: Record<string, JsonValue>;
}[] = [
  {
    label: "coordinator",
    descriptor: { kind: "coordinator", input: { task, notes: [note] } },
    value: { filings: [], verify: [] },
  },
  ...(["source", "correctness", "requirements"] as const).map((name) => ({
    label: name,
    descriptor: {
      kind: "verifier" as const,
      name,
      input: { ...input, verify: [{ note: "n1", verifiers: [name] }] },
      judged: ["n1"],
    },
    value: { verdicts: [verdict] },
  })),
  {
    label: "statement",
    descriptor: { kind: "statement", input },
    value: statement,
  },
  {
    label: "proof",
    descriptor: { kind: "proof", input, statement },
    value: { proof: "Reflexivity." },
  },
  {
    label: "reconstruction",
    descriptor: {
      kind: "reconstruction",
      input,
      statement,
      proof: "Reflexivity.",
    },
    value: { statements: [], verdicts: [verdict] },
  },
];

test.each(otherRoles)(
  "$label receives no activity or announcement tool",
  async ({ descriptor, value }) => {
    const remote = service();
    const run = await fixture(
      [
        (transcript) => {
          expect(observationMessage(transcript)).toBeUndefined();
          expect(getCurrentSystemPrompt(transcript.messages)).toBe(
            resolveCall(descriptor).system,
          );
          expect(
            getCurrentTools(transcript.messages).map((tool) => tool.name),
          ).not.toContain("announce_activity");
          return reply(resolveCall(descriptor).tool, value);
        },
      ],
      remote.options,
    );
    expect(
      (await run.harness.waitForTask(await run.invoke(descriptor), context))
        .state.outcome.status,
    ).toBe("completed");
    expect(remote.requests).toBe(0);
  },
);

test("unconfigured Explorer retains its original prompt and tools", async () => {
  const run = await fixture([
    (transcript) => {
      expect(observationMessage(transcript)).toBeUndefined();
      expect(getCurrentSystemPrompt(transcript.messages)).toBe(
        resolveCall(explorer).system,
      );
      expect(
        getCurrentTools(transcript.messages).map((tool) => tool.name),
      ).toEqual(["submit_notes", "read_notes"]);
      return submitted();
    },
  ]);
  expect(
    (await run.harness.waitForTask(await run.invoke(), context)).state.outcome
      .status,
  ).toBe("completed");
});

test("closing the native invocation removes a published activity during a silent provider call", async () => {
  const remote = service();
  const started = Promise.withResolvers<void>();
  const run = await fixture(
    [
      announcement(),
      async (_transcript, options) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ],
    remote.options,
  );
  const pending = run.harness
    .waitForTask(await run.invoke(), context)
    .catch(() => {});
  await started.promise;
  const observer = remote.client("observer");
  const before = await observer.observe();
  expect(before.status === "available" && before.activities.length).toBe(1);
  await run.harness.close(context);
  await pending;
  const after = await observer.observe();
  expect(after.status === "available" && after.activities).toEqual([]);
  expect(
    run.role.extension.tools?.find((tool) => tool.name === "announce_activity")
      ?.replay,
  ).toBe("unsafe");
});

test("an interrupted announcement is not replayed and recovery requires a new model announcement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-activity-recovery-"));
  const handler = createActivityHandler();
  const created = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let creates = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = await handler(request);
      if (
        request.method === "POST" &&
        new URL(request.url).pathname === "/v1/activities"
      ) {
        creates++;
        if (creates === 1) {
          created.resolve();
          await release.promise;
        }
      }
      return response;
    },
  });
  cleanup.push(() => server.stop(true));
  cleanup.push(() => release.resolve());
  const options = {
    url: server.url.toString(),
    scope: "problem-v1",
    owner: "recovering explorer",
  };
  const first = await fixture([announcement()], options, directory);
  const id = await first.invoke();
  const pending = first.harness.waitForTask(id, context).catch(() => {});
  await created.promise;
  await first.harness.close(context);
  release.resolve();
  await pending;
  expect(creates).toBe(1);
  const resumed = await fixture(
    [
      (transcript) => {
        expect(observationMessage(transcript)).toContain('"announced":false');
        const result = transcript.messages.find(
          (message) =>
            message.role === "toolResult" &&
            message.toolName === "announce_activity",
        );
        expect(result).toMatchObject({ isError: true });
        expect(creates).toBe(1);
        return announcement();
      },
      (transcript) => {
        expect(observationMessage(transcript)).toContain('"announced":true');
        expect(creates).toBe(2);
        return submitted();
      },
    ],
    options,
    directory,
  );
  expect(
    (await resumed.harness.waitForTask(id, context)).state.outcome,
  ).toMatchObject({ status: "completed", result: { value } });
  expect(resumed.provider.state.callCount).toBe(2);
  const observation = await new ActivityClient({
    ...options,
    owner: "observer",
  }).observe();
  // The first POST's lost receipt leaves a bounded orphan, never a replayed write.
  expect(
    observation.status === "available" && observation.activities.length,
  ).toBe(1);
}, 10_000);

test.each([false, true])(
  "recovery can change activity configuration from enabled=%s",
  async (enabled) => {
    const directory = await mkdtemp(join(tmpdir(), "xean-activity-config-"));
    const remote = service();
    const peer = remote.client("peer");
    await peer.announce("Peer activity across recovery", []);
    cleanup.push(() => peer.close());
    const started = Promise.withResolvers<void>();
    const first = await fixture(
      [
        async (_transcript, options) => {
          started.resolve();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else
              options?.signal?.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
      ],
      enabled ? remote.options : undefined,
      directory,
    );
    const id = await first.invoke();
    const pending = first.harness.waitForTask(id, context).catch(() => {});
    await started.promise;
    await first.harness.close(context);
    await pending;
    const resumed = await fixture(
      [
        (transcript) => {
          const offered = getCurrentTools(transcript.messages).map(
            (tool) => tool.name,
          );
          if (enabled) {
            expect(observationMessage(transcript)).toBeUndefined();
            expect(offered).not.toContain("announce_activity");
            expect(getCurrentSystemPrompt(transcript.messages)).toBe(
              resolveCall(explorer).system,
            );
          } else {
            // The interrupted request keeps its original frozen cutoff.
            expect(observationMessage(transcript)).toBeUndefined();
            expect(offered).not.toContain("announce_activity");
            return reply("read_notes", { ids: ["n1"], level: "full" });
          }
          return submitted();
        },
        ...(enabled
          ? []
          : [
              (transcript: TranscriptContext) => {
                expect(observationMessage(transcript)).toContain(
                  "Peer activity across recovery",
                );
                expect(
                  getCurrentTools(transcript.messages).map((tool) => tool.name),
                ).toContain("announce_activity");
                return submitted();
              },
            ]),
      ],
      enabled ? undefined : remote.options,
      directory,
    );
    expect(
      (await resumed.harness.waitForTask(id, context)).state.outcome,
    ).toMatchObject({ status: "completed" });
  },
);

test("host heartbeat renews a silent model's lease without refreshing its intention", async () => {
  let now = 1_000;
  const remote = service({ now: () => now });
  const original = globalThis.setInterval;
  let heartbeat: (() => void) | undefined;
  const timer = spyOn(globalThis, "setInterval").mockImplementation(((
    handler: (...args: any[]) => void,
    delay?: number,
    ...args: any[]
  ) => {
    if (delay === 30_000) heartbeat = () => handler(...args);
    return original(handler, delay, ...args);
  }) as typeof globalThis.setInterval);
  cleanup.push(() => timer.mockRestore());
  const started = Promise.withResolvers<void>();
  const run = await fixture(
    [
      announcement(),
      async (_transcript, options) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else
            options?.signal?.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ],
    remote.options,
  );
  const pending = run.harness
    .waitForTask(await run.invoke(), context)
    .catch(() => {});
  await started.promise;
  const observer = remote.client("observer");
  const before = await observer.observe();
  if (before.status !== "available") throw new Error("Missing observation");
  expect(before.activities).toHaveLength(1);
  const announced = before.activities[0]!;
  now = 91_000;
  expect(heartbeat).toBeDefined();
  heartbeat!();
  await remote.renewed;
  const after = await observer.observe();
  if (after.status !== "available") throw new Error("Missing observation");
  expect(after.activities[0]).toMatchObject({
    id: announced.id,
    intentAt: announced.intentAt,
    intent: announced.intent,
  });
  expect(after.activities[0]!.expiresAt).toBe(now + 120_000);
  expect(after.activities[0]!.expiresAt).toBeGreaterThan(announced.expiresAt);
  await run.harness.close(context);
  await pending;
  const requests = remote.requests;
  heartbeat!();
  await Promise.resolve();
  expect(remote.requests).toBe(requests);
});

test("activity delivery preserves unrelated native system sections and their removal", async () => {
  const remote = service();
  let nativeContext: string | undefined = "Independent native context";
  const run = await fixture(
    [
      (transcript) => {
        const system = getCurrentSystemMessage(transcript.messages);
        expect(system?.sections?.instructions).toBe(
          resolveCall(explorer).system,
        );
        expect(system?.sections?.fixture_context).toBe(
          "<fixture_context>\nIndependent native context\n</fixture_context>",
        );
        expect(observationMessage(transcript)).toContain(
          '"status":"available"',
        );
        nativeContext = undefined;
        return reply("read_notes", { ids: ["n1"], level: "full" });
      },
      (transcript) => {
        expect(
          getCurrentSystemMessage(transcript.messages)?.sections
            ?.fixture_context,
        ).toBeUndefined();
        expect(getCurrentSystemPrompt(transcript.messages)).toBe(
          resolveCall(explorer).system,
        );
        expect(
          transcript.messages.some(
            (message) =>
              message.role === "system" &&
              message.sections?.fixture_context === null,
          ),
        ).toBe(true);
        expect(
          transcript.messages.some(
            (message) =>
              message.role === "system" &&
              Object.hasOwn(message.sections ?? {}, "xean_activity"),
          ),
        ).toBe(false);
        expect(observationMessage(transcript)).toContain(
          '"status":"available"',
        );
        return submitted();
      },
    ],
    remote.options,
    undefined,
    [section("fixture_context", () => nativeContext)],
  );
  expect(
    (await run.harness.waitForTask(await run.invoke(), context)).state.outcome
      .status,
  ).toBe("completed");
  const messages = await run.messages();
  expect(
    messages.some(
      (message) =>
        message.role === "system" && message.sections?.fixture_context === null,
    ),
  ).toBe(true);
});
