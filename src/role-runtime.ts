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
const Progress = defineDocFamily({
  kind: "xean.role.progress",
  version: 1,
  checkpointWhen: () => false,
  scope: "task",
  family: true,
  initial: (): { conversation?: ConversationId } => ({}),
});
type Receipt = { call: EntryId; value: JsonValue; fresh: boolean };
type FrozenRole = {
  descriptor: CallDescriptor;
  profile: PiRoleProfile;
  receipt?: Receipt;
};
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
          const campaign =
            call.role === "selection"
              ? await api.snapshot(ProviderDoc, ROOT_CONVERSATION_ID, context)
              : undefined;
          const routingId = campaign
            ? createHash("sha256")
                .update(`${campaign.sessionId}\n${call.role}`)
                .digest("hex")
            : undefined;
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
                ...(routingId && model.api === "openai-responses"
                  ? {
                      headers: {
                        ...options?.headers,
                        session_id: routingId,
                        "x-client-request-id": routingId,
                      },
                    }
                  : {}),
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

  /** Recover the admitted stage, without rebuilding it from newer evidence. */
  async function peek(
    runtime: Runtime,
    key: string,
    context: Context,
    previousTasks: readonly number[] = [],
  ): Promise<FrozenRole | undefined> {
    const progress = await runtime.snapshot(
      Progress,
      runtime.taskId,
      key,
      context,
    );
    // A close can precede the generation's settlement after its tool receipt.
    // Finish already-admitted native work before deciding whether a new call is needed.
    if (progress?.conversation !== undefined)
      await (
        await runtime.conversation(progress.conversation, context)
      )?.waitForIdle(context);
    let found: FrozenRole | undefined;
    await runtime.commit(async (tx) => {
      const read = async (conversationId: ConversationId, strict = false) => {
        const saved = await tx.doc(Assignment, conversationId);
        if (saved.key !== key || !saved.descriptor || !saved.profile)
          return false;
        const result = await receipt(
          tx,
          conversationId,
          resolveCall(saved.descriptor),
          !strict,
        );
        if (result || !found)
          found = copyJson(
            {
              descriptor: saved.descriptor,
              profile: saved.profile,
              ...(result ? { receipt: result } : {}),
            },
            { omitUndefinedProperties: true },
          ) as FrozenRole;
        return result !== undefined;
      };
      if (
        progress?.conversation !== undefined &&
        (await read(progress.conversation, true))
      )
        return;
      for (const owner of previousTasks) {
        const prior = await tx.task(owner as TaskId);
        if (
          prior?.state.status !== "terminal" ||
          !["completed", "faulted", "aborted"].includes(
            prior.state.outcome.status,
          )
        )
          continue;
        let cursor: Cursor | undefined;
        do {
          const page = await tx.scanConversations(
            { ownerTaskId: owner as TaskId },
            128,
            cursor,
          );
          for (const conversation of page.items)
            if (await read(conversation.id)) return;
          cursor = page.next;
        } while (cursor);
      }
    }, context);
    return found;
  }

  async function run(
    runtime: Runtime,
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
    context: Context,
    previousTasks: readonly number[] = [],
  ): Promise<Receipt> {
    const call = resolveCall(descriptor);
    const tool = tools.find((tool) => tool.name === call.tool);
    if (!tool) throw new Error(`Unregistered role tool: ${call.tool}`);
    let conversationId!: ConversationId;
    let sessionId: string | undefined;
    let conversation: ConversationHandle | undefined;
    let recovered: Receipt | undefined;
    let fresh = true;
    const assignment = copyJson(
      { key, descriptor, profile },
      { omitUndefinedProperties: true },
    );
    try {
      await runtime.commit(async (tx) => {
        for (const ownerTaskId of previousTasks) {
          const previous = await tx.task(ownerTaskId as TaskId);
          if (
            previous?.state.status !== "terminal" ||
            (previous.state.outcome.status !== "completed" &&
              previous.state.outcome.status !== "faulted" &&
              previous.state.outcome.status !== "aborted")
          )
            continue;
          let cursor: Cursor | undefined;
          do {
            const page = await tx.scanConversations(
              { ownerTaskId: ownerTaskId as TaskId },
              128,
              cursor,
            );
            for (const child of page.items) {
              const saved = await tx.doc(Assignment, child.id);
              if (
                !isDeepStrictEqual(saved, assignment) ||
                (await tx.submissionByRequest(child.id, key))?.status !== "done"
              )
                continue;
              recovered = await receipt(tx, child.id, call, true);
              if (recovered) return;
            }
            cursor = page.next;
          } while (cursor);
        }
        const progress = await tx.doc(Progress, runtime.taskId, key, null);
        if (progress.conversation !== undefined) {
          conversationId = progress.conversation;
          const saved = await tx.doc(Assignment, conversationId);
          if (!isDeepStrictEqual(saved, assignment))
            throw new Error(
              "Recovered role arguments do not match the durable assignment",
            );
          fresh = (await receipt(tx, conversationId, call)) === undefined;
        }
        if (progress.conversation === undefined) {
          const ownership = { kind: "task" as const, taskId: runtime.taskId };
          conversationId = (await tx.createConversation({ ownership })).id;
          Object.assign(await tx.doc(Assignment, conversationId), assignment);
          await configure(tx, conversationId, {
            model: { provider: profile.provider, modelId: profile.model },
            thinkingLevel: profile.reasoning,
            extensions: [extension],
            tools: [
              tool,
              ...(["explorer", "selection"].includes(call.role)
                ? [reader]
                : []),
            ],
            instructions: call.system,
          });
          progress.conversation = conversationId;
        }
        sessionId = (await tx.doc(ProviderDoc, conversationId)).sessionId;
      }, context);
      if (recovered) return recovered;
      conversation = await runtime.conversation(conversationId, context);
      if (!conversation) throw new Error("Role conversation is missing");
      const submission = await conversation.submit(
        {
          type: "input",
          requestId: key,
          content: call.prompt,
        },
        context,
      );
      const settled = await submission.wait(context);
      await conversation.waitForIdle(context);
      if (settled.status !== "done")
        throw new Error(
          `${call.role} failed: ${settled.detail ?? settled.reason}`,
        );
      let result: Receipt | undefined;
      await runtime.commit(async (tx) => {
        result = await receipt(tx, conversationId, call);
      }, context);
      if (result) return { ...result, fresh };
      throw new Error(`${call.role} returned no ${call.tool} submission`);
    } catch (error) {
      try {
        await conversation?.abort(BACKGROUND_CONTEXT);
      } catch (cleanupError) {
        if (!context.abortSignal?.aborted) runtime.report(cleanupError);
      }
      throw error;
    } finally {
      try {
        if (sessionId) cleanupSessionResources(sessionId);
      } catch (cleanupError) {
        if (!context.abortSignal?.aborted) runtime.report(cleanupError);
      }
    }
  }
  return { extension, run, peek };
}
