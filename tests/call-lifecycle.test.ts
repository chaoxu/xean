import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  Type,
  type Models,
} from "@earendil-works/pi-ai";
import {
  MemoryStorage,
  StorageRejected,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Xean,
  openXeanStorage,
  type Coordinator,
  type XeanOptions,
} from "../packages/core/src/index.ts";
import { auditedStream } from "../packages/core/src/pi.ts";
import { ask } from "../packages/core/src/solve/pi.ts";
import { fixtureRuntime, model } from "./fixtures/pi.ts";

const coordinator: Coordinator = {
  name: "fixture",
  run(signal) {
    return signal.kind === "start"
      ? { state: null, dispatch: [{ id: "work", role: "worker", input: null }] }
      : { state: signal.kind };
  },
};

function delayedCalls() {
  const ready = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const streamSimple: Models["streamSimple"] = (model, input, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      await options!.onPayload!(input, model);
      const slow = input.messages[0]!.content !== "fast";
      const message = fauxAssistantMessage("", {
        stopReason: slow ? "aborted" : "error",
        errorMessage: slow ? "cancelled sibling" : "first call failed",
      });
      if (slow) {
        options!.signal!.addEventListener("abort", () => aborted.resolve(), {
          once: true,
        });
        ready.resolve();
        await aborted.promise;
        await release.promise;
        message.usageReported = true;
        message.usage = { ...message.usage, input: 7, totalTokens: 7 };
      } else await ready.promise;
      stream.push({
        type: "error",
        reason: slow ? "aborted" : "error",
        error: message,
      });
      stream.end();
    })();
    return stream;
  };
  return { ready, aborted, release, streamSimple };
}

test.each(["pending admission", "failed settlement"] as const)(
  "%s cannot publish a worker result",
  async (boundary) => {
    let pending: Promise<void> | undefined;
    const engine = await Xean.open(new MemoryStorage(), {
      task: boundary,
      coordinator,
      roles: [
        {
          name: "worker",
          async run(_input, execution) {
            if (boundary === "failed settlement") {
              const call = await execution.recorder.begin(model);
              const message = Object.assign(fauxAssistantMessage(""), {
                toJSON() {
                  throw new Error("Invalid response");
                },
              });
              await expect(
                Promise.resolve(call.settle(message, null)),
              ).rejects.toThrow("Invalid response");
            } else {
              pending = Promise.resolve(execution.recorder.begin(model)).then(
                (call) =>
                  call.settle(
                    fauxAssistantMessage("", { stopReason: "aborted" }),
                    null,
                  ),
                () => {},
              );
            }
            return "must not publish";
          },
        },
      ],
    });
    try {
      const result = await engine.run();
      await pending;
      expect(result.work[0]).toMatchObject({
        status: "failed",
        result: null,
        error:
          boundary === "failed settlement"
            ? "Invalid response"
            : "Role returned with unsettled provider calls",
      });
      expect(result.state).toBe("failed");
    } finally {
      await pending;
      await engine.close();
    }
  },
);

test("failed parallel calls keep run and close open until cancellation usage settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-call-cleanup-"));
  const path = join(directory, "campaign.sqlite");
  const { aborted, release, streamSimple } = delayedCalls();
  let runFinished = false;
  let closeFinished = false;
  const options: XeanOptions = {
    task: "parallel call cleanup",
    coordinator,
    roles: [
      {
        name: "worker",
        async run(_input, execution, context) {
          const stream = auditedStream({ streamSimple }, execution.recorder);
          await Promise.all(
            ["fast", "slow"].map(async (content) => {
              const message = await stream(
                model,
                {
                  messages: [{ role: "user", content, timestamp: 0 }],
                },
                { signal: context.abortSignal },
              ).result();
              if (message.stopReason === "error")
                throw new Error(message.errorMessage);
            }),
          );
          return "must not publish";
        },
      },
    ],
  };
  let engine: Xean | undefined;
  try {
    engine = await Xean.open(await openXeanStorage(path), options);
    const running = engine.run().then((result) => {
      runFinished = true;
      return result;
    });
    await aborted.promise;
    const closing = engine.close().then(() => {
      closeFinished = true;
    });
    await yieldToEvents();
    await yieldToEvents();
    expect(runFinished).toBe(false);
    expect(closeFinished).toBe(false);
    release.resolve();
    await Promise.all([running, closing]);

    engine = await Xean.open(await openXeanStorage(path), options);
    const records = await engine.records();
    const settlements = records.filter(
      (record) => record.kind === "xean.call.settled",
    );
    expect(settlements).toHaveLength(2);
    expect(settlements.map((record) => record.data)).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ stopReason: "aborted" }),
        usage: expect.objectContaining({ input: 7, totalTokens: 7 }),
      }),
    );
    expect((await engine.inspect()).work[0]!.result).toBeNull();
  } finally {
    release.resolve();
    await engine?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const rejectCleanup of [false, true])
  test(`a role failure drains native calls after ${rejectCleanup ? "rejected" : "successful"} cleanup`, async () => {
    const { ready, aborted, release, streamSimple } = delayedCalls();
    const storage = new MemoryStorage();
    const commit = storage.commit.bind(storage);
    let rejected = false;
    storage.commit = async (writes, context) => {
      if (
        rejectCleanup &&
        !rejected &&
        writes.some(
          (write) =>
            write.type === "task" &&
            write.value.kind === "pi.generation" &&
            write.value.abortRequested,
        )
      ) {
        rejected = true;
        throw new StorageRejected("abort commit rejected");
      }
      return commit(writes, context);
    };
    let queued!: SubmissionId;
    let write!: SubmissionId;
    const runtime = fixtureRuntime(() => {
      throw new Error("Use the asynchronous stream");
    });
    runtime.models.streamSimple = streamSimple;
    const engine = await Xean.open(storage, {
      task: "native call cleanup",
      coordinator,
      roles: [
        {
          name: "worker",
          async run(_input, execution, context) {
            await Promise.all([
              ask(
                runtime,
                "correctness",
                "Return a result",
                {},
                Type.Object({ answer: Type.Number() }),
                execution,
                context,
              ),
              (async () => {
                await ready.promise;
                const host = execution.durable!;
                const id = await host.commit(
                  async (tx) =>
                    (
                      await tx.scanConversations(
                        { ownerTaskId: host.taskId },
                        1,
                      )
                    ).items[0]!.id,
                  context,
                );
                const conversation = (await host.conversation(id, context))!;
                queued = (
                  await conversation.submit(
                    {
                      type: "input",
                      content: "queued followup",
                      whenBusy: "followUp",
                    },
                    context,
                  )
                ).id;
                write = await host.commit(
                  async (tx) =>
                    (
                      await tx.createSubmission({
                        conversationId: id,
                        type: "write",
                        status: "queued",
                      })
                    ).id,
                  context,
                );
                throw new Error("parallel branch failed");
              })(),
            ]);
            return null;
          },
        },
      ],
    });
    try {
      const running = engine.run();
      running.catch(() => {});
      await aborted.promise;
      const before = await engine.inspectWithRecords();
      expect(before.campaign.work[0]!.result).toBeNull();
      expect(
        before.records.filter((entry) => entry.kind === "xean.call.settled"),
      ).toHaveLength(0);
      expect(
        before.records.filter((entry) => entry.kind === "xean.attempt.failed"),
      ).toHaveLength(0);
      release.resolve();
      if (rejectCleanup) {
        await expect(running).rejects.toThrow("abort commit rejected");
        expect(rejected).toBe(true);
        expect((await engine.inspect()).work[0]).toMatchObject({
          status: "active",
          result: null,
        });
      } else {
        expect((await running).work[0]).toMatchObject({
          status: "failed",
          error: "parallel branch failed",
        });
      }
      expect(
        await storage.submission(queued, BACKGROUND_CONTEXT),
      ).toMatchObject({
        status: rejectCleanup ? "queued" : "unanswered",
        ...(rejectCleanup ? {} : { reason: "aborted" }),
      });
      expect(await storage.submission(write, BACKGROUND_CONTEXT)).toMatchObject(
        {
          status: "queued",
        },
      );
      const records = await engine.records();
      const settlement = records.find(
        (entry) => entry.kind === "xean.call.settled",
      )!;
      expect(settlement.data).toMatchObject({ usage: { input: 7 } });
      const failure = records.find(
        (entry) => entry.kind === "xean.attempt.failed",
      );
      if (rejectCleanup) expect(failure).toBeUndefined();
      else expect(settlement.id).toBeLessThan(failure!.id);
    } finally {
      release.resolve();
      await engine.close();
    }
  });
