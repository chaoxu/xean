import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { arr, lit, obj, str, union } from "@earendil-works/pi-schema";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import {
  configure,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ProviderDoc,
  ROOT_CONVERSATION_ID,
  ToolResultEntry,
  type ConversationHandle,
  type ConversationId,
  type Cursor,
  type EntryId,
  type Harness,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  applicationId,
  submissionTools,
  type Note,
} from "./policy/contracts.ts";
import {
  promptNote,
  resolveCall,
  type CallDescriptor,
  type RoleCall,
} from "./policy/prompts.ts";
import type { PiRoleProfile } from "./policy/settings.ts";
import { Notebook, project, readNotebook } from "./state.ts";

type Runtime = TaskRuntime<any, any, any, any>;
export const roleGenerationPolicy = {
  maxResponses: 32,
  maxLengthContinuations: 8,
  maxRecoveries: 8,
  continueEmptyLength: true,
  continuationPrompt:
    "The previous response was interrupted before completion. Continue exactly where you left off; do not restart or repeat completed work.",
  retryContent: "completed-reasoning" as const,
};
type Assignment = {
  key?: string;
  descriptor?: CallDescriptor;
  profile?: PiRoleProfile;
};
export const Assignment = defineDoc({
  kind: "xean.role.assignment",
  version: 1,
  checkpointWhen: () => false,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): Assignment => ({}),
});
const Stage = defineDocFamily<{ conversation?: number }, null>({
  kind: "xean.role.stage",
  version: 1,
  scope: "session",
  family: true,
  checkpointWhen: () => false,
  initial: () => ({}),
});
type Receipt = { call: EntryId; value: JsonValue; fresh: boolean };
async function receipt(
  tx: Tx,
  conversationId: ConversationId,
  call: RoleCall,
  skipAmbiguous = false,
): Promise<Receipt | undefined> {
  let cursor: Cursor | undefined;
  let found: Receipt | undefined;
  do {
    const page = await tx.scanEntries(
      { conversationId, order: "ascending" },
      128,
      cursor,
    );
    for (const entry of page.items) {
      const message = entry.model?.[0];
      if (
        ToolResultEntry.is(entry) &&
        message?.role === "toolResult" &&
        message.toolName === call.tool &&
        !message.isError &&
        message.details !== undefined
      ) {
        if (found) {
          if (skipAmbiguous) return undefined;
          throw new Error(`${call.tool} requires exactly one submission`);
        }
        found = {
          call: entry.id,
          value: call.schema.parse(message.details) as JsonValue,
          fresh: false,
        };
      }
    }
    cursor = page.next;
  } while (cursor);
  return found;
}

/** Native tools rebuild contextual Zod validation from durable call arguments. */
export function createRoleRuntime() {
  const reader = defineTool({
    name: "read_notes",
    description:
      "Read statements and conditions from detailed summaries, or full texts for proofs and missing details. Full reads return an array of texts in requested ID order. Batch independent IDs. Dead notes are diagnostic only.",
    parameters: obj({
      ids: arr(str(), {
        minItems: 1,
        maxItems: 20,
        uniqueItems: true,
      }),
      level: union([lit("detailed"), lit("full")]),
    }),
    callers: ["model"],
    replay: "safe",
    executionMode: "sequential",
    outputLimits: {
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxLines: Number.MAX_SAFE_INTEGER,
    },
    async execute({ ids, level }, api, context) {
      const assignment = await api.snapshot(
        Assignment,
        api.conversationId,
        context,
      );
      if (
        assignment?.descriptor?.kind !== "explorer" &&
        assignment?.descriptor?.kind !== "selection"
      )
        throw new Error("Notebook reads require Explorer or selection");
      const input = assignment.descriptor.input;
      const book = await api.snapshot(Notebook, ROOT_CONVERSATION_ID, context);
      if (!book) throw new Error("Campaign notebook is missing");
      const snapshot = readNotebook(book);
      const notes = level === "full" ? snapshot.notes : project(snapshot).notes;
      const selected = ids.map((id) =>
        input.notes.some((note) => note.id === id)
          ? notes.find((note) => note.id === id)
          : undefined,
      );
      const missing = selected.indexOf(undefined);
      if (missing !== -1) {
        api.output(`Unknown or unavailable note: ${ids[missing]}`);
        return { isError: true };
      }
      api.output(
        JSON.stringify(
          selected.map((note) => {
            if (level === "full") return note!.text;
            const { text, detailedSummary, ...index } = note as Note;
            return {
              ...promptNote(index),
              detailedSummary: detailedSummary ?? null,
            };
          }),
        ),
      );
      return {};
    },
  });
  const tools = Object.values(submissionTools).map((name) =>
    defineTool({
      name,
      description: "Submit the result for the current mathematical assignment.",
      parameters: obj({}, { open: true }),
      callers: ["model"],
      replay: "safe",
      executionMode: "sequential",
      async execute(value, api, context) {
        const assignment = await api.snapshot(
          Assignment,
          api.conversationId,
          context,
        );
        if (!assignment?.descriptor) throw new Error("Missing role assignment");
        const call = resolveCall(assignment.descriptor);
        if (call.tool !== name)
          throw new Error("Submission tool does not match the assignment");
        // A successful receipt exists only after contextual validation, including note references.
        const parsed = call.schema.safeParse(
          validateToolArguments(
            {
              name,
              description: call.description,
              parameters: z.toJSONSchema(call.schema),
            },
            {
              type: "toolCall",
              id: api.callId,
              name,
              arguments: value as Record<string, JsonValue>,
            },
          ),
        );
        if (!parsed.success)
          return {
            output: [{ type: "text", text: parsed.error.message }],
            isError: true,
          };
        return {
          output: [{ type: "text", text: "null" }],
          details: copyJson(parsed.data, {
            omitUndefinedProperties: true,
          }) as JsonValue,
          control: { terminate: true },
        };
      },
    }),
  );
  const extension = defineExtension({
    name: "xean.roles",
    tools: [...tools, reader],
    hooks: [
      hook(GenerationTask, {
        onYield(answer) {
          if (answer.stopReason === "length")
            return { continue: roleGenerationPolicy.continuationPrompt };
        },
        async beforeRequest({ messages, stream }, api, context) {
          const assignment = await api.snapshot(
            Assignment,
            api.conversationId,
            context,
          );
          if (!assignment?.descriptor) return;
          const call = resolveCall(assignment.descriptor);
          const declaration = {
            name: call.tool,
            description: call.description,
            parameters: z.toJSONSchema(call.schema),
            constrainedSampling:
              call.role === "selection"
                ? (false as const)
                : {
                    type: "json_schema" as const,
                    strict: "prefer" as const,
                  },
          };
          return {
            messages: messages.map((message) =>
              message.role !== "system"
                ? message
                : {
                    ...message,
                    // Retain the v1 prompt without Pi's default instructions wrapper.
                    sections: message.sections && {
                      ...message.sections,
                      ...(typeof message.sections.instructions === "string"
                        ? { instructions: call.system }
                        : {}),
                    },
                    toolsAdded: message.toolsAdded?.map((tool) =>
                      tool.name === call.tool ? declaration : tool,
                    ),
                  },
            ),
            stream: (model, transcript, options) =>
              stream(model, transcript, {
                ...options,
                transport:
                  model.api === "openai-codex-responses" ? "auto" : "sse",
              }),
          };
        },
        async beforeProviderRequest({ model, payload }, api, context) {
          if (
            !payload ||
            typeof payload !== "object" ||
            !["openai-responses", "openai-codex-responses"].includes(model.api)
          )
            return;
          const assignment = await api.snapshot(
            Assignment,
            api.conversationId,
            context,
          );
          if (!assignment?.descriptor) return;
          const call = resolveCall(assignment.descriptor);
          const request = { ...payload } as Record<string, unknown>;
          request.parallel_tool_calls = false;
          request.tool_choice = "required";
          if (
            model.api === "openai-responses" &&
            !request.instructions &&
            Array.isArray(request.input)
          ) {
            const [head, ...rest] = request.input;
            if (
              head?.role === "developer" &&
              typeof head.content === "string"
            ) {
              request.instructions = head.content;
              request.input = rest;
            }
          }
          if ("prompt_cache_key" in request)
            request.prompt_cache_key = createHash("sha256")
              .update(`${applicationId}/${call.role}\n${call.system}`)
              .digest("hex");
          return { payload: request };
        },
      }),
    ],
  });

  async function invoke(
    host: Runtime | Harness,
    ref: number,
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
    context: Context,
    report: (error: unknown) => void,
    previousTasks: readonly number[] = [],
  ): Promise<Receipt> {
    const owned = "taskId" in host;
    const requested = copyJson(
      { key, descriptor, profile },
      { omitUndefinedProperties: true },
    ) as Required<Assignment>;
    const strict =
      descriptor.kind === "explorer" || descriptor.kind === "selection";
    let assignment = requested;
    let frozen = false,
      fresh = true;
    let conversationId: ConversationId | undefined;
    let conversation: ConversationHandle | undefined;
    let sessionId: string | undefined;
    let recovered: Receipt | undefined;
    try {
      // The reference and conversation are created together, before model submission.
      await host.commit(async (tx): Promise<undefined> => {
        for (const owner of [ref, ...previousTasks]) {
          const current = owner === ref;
          if (!current) {
            const prior = await tx.task(owner as TaskId);
            if (
              prior?.state.status !== "terminal" ||
              !["completed", "faulted", "aborted"].includes(
                prior.state.outcome.status,
              )
            )
              continue;
          }
          const stage = await tx.doc(
            Stage,
            JSON.stringify([owned ? "task" : "work", owner, key]),
            null,
          );
          if (stage.conversation === undefined) continue;
          const id = stage.conversation as ConversationId;
          const saved = await tx.doc(Assignment, id);
          if (saved.key !== key || !saved.descriptor || !saved.profile)
            continue;
          if ((!owned || strict) && !isDeepStrictEqual(saved, requested)) {
            if (current)
              throw new Error(
                "Recovered role arguments do not match the durable assignment",
              );
            continue;
          }
          const result = await receipt(
            tx,
            id,
            resolveCall(saved.descriptor),
            !current,
          );
          if (current || result || !frozen) {
            assignment = copyJson(saved) as Required<Assignment>;
            frozen = true;
          }
          if (current) {
            conversationId = id;
            fresh = strict
              ? result === undefined
              : (await tx.submissionByRequest(id, key)) === undefined;
            return;
          }
          if (result) {
            recovered = result;
            return;
          }
        }
        const call = resolveCall(assignment.descriptor);
        conversationId = (
          await tx.createConversation({
            ownership: owned
              ? { kind: "task", taskId: host.taskId }
              : { kind: "ownerless" },
          })
        ).id;
        (
          await tx.doc(
            Stage,
            JSON.stringify([owned ? "task" : "work", ref, key]),
            null,
          )
        ).conversation = conversationId;
        Object.assign(await tx.doc(Assignment, conversationId), assignment);
        await configure(tx, conversationId, {
          model: {
            provider: assignment.profile.provider,
            modelId: assignment.profile.model,
          },
          thinkingLevel: assignment.profile.reasoning,
          extensions: [extension],
          tools: [
            tools.find((tool) => tool.name === call.tool)!,
            ...(["explorer", "selection"].includes(call.role) ? [reader] : []),
          ],
          instructions: call.system,
        });
      }, context);
      if (recovered) return recovered;
      const call = resolveCall(assignment.descriptor);
      sessionId = (await host.snapshot(ProviderDoc, conversationId!, context))
        ?.sessionId;
      conversation = await host.conversation(conversationId!, context);
      if (!conversation) throw new Error("Role conversation is missing");
      const submission = await conversation.submit(
        { type: "input", requestId: key, content: call.prompt },
        context,
      );
      const settled = await submission.wait(context);
      await conversation.waitForIdle(context);
      let result: Receipt | undefined;
      await host.commit(async (tx): Promise<undefined> => {
        result = await receipt(tx, conversationId!, call);
      }, context);
      if (result) return { ...result, fresh };
      if (settled.status !== "done")
        throw new Error(
          `${call.role} failed: ${settled.detail ?? settled.reason}`,
        );
      throw new Error(`${call.role} returned no ${call.tool} submission`);
    } catch (error) {
      try {
        // Task ownership cancels its scope; a suspended Chord wait leaves native recovery intact.
        if (owned || !context.abortSignal?.aborted)
          await conversation?.abort(BACKGROUND_CONTEXT);
      } catch (cleanupError) {
        if (!context.abortSignal?.aborted) report(cleanupError);
      }
      throw error;
    } finally {
      try {
        if (sessionId) cleanupSessionResources(sessionId);
      } catch (cleanupError) {
        if (!context.abortSignal?.aborted) report(cleanupError);
      }
    }
  }
  return {
    extension,
    run: (
      runtime: Runtime,
      key: string,
      descriptor: CallDescriptor,
      profile: PiRoleProfile,
      context: Context,
      previousTasks: readonly number[] = [],
    ) =>
      invoke(
        runtime,
        runtime.taskId,
        key,
        descriptor,
        profile,
        context,
        (error) => runtime.report(error),
        previousTasks,
      ),
    call: (
      harness: Harness,
      ref: number,
      key: string,
      descriptor: CallDescriptor,
      profile: PiRoleProfile,
      context: Context,
      report: (error: unknown) => void,
    ) => invoke(harness, ref, key, descriptor, profile, context, report),
  };
}
