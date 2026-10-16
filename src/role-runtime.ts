import { copyJson, type Context, type JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  cleanupSessionResources,
  Type,
  type TSchema,
} from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  GenerationTask,
  hook,
  ProviderDoc,
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
  reconstructionCalls,
  roleLabels,
  roleTools,
} from "./policy/contracts.ts";
import {
  resolveCall,
  type CallDescriptor,
  type RoleCall,
} from "./policy/prompts.ts";
import type { PiRoleProfile } from "./policy/settings.ts";

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
type Assignment = { descriptor?: CallDescriptor; profile?: PiRoleProfile };
const Assignment = defineDoc({
  kind: "xean.role.assignment",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): Assignment => ({}),
});
const Progress = defineDocFamily({
  kind: "xean.role.progress",
  version: 1,
  scope: "task",
  family: true,
  initial: (): { conversation?: ConversationId } => ({}),
});
type Receipt = { call: EntryId; value: JsonValue; fresh: boolean };
async function receipt(
  tx: Tx,
  conversationId: ConversationId,
  call: RoleCall,
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
        if (found)
          throw new Error(`${call.tool} requires exactly one submission`);
        found = {
          call: entry.id,
          value: copyJson(call.schema.parse(message.details), {
            omitUndefinedProperties: true,
          }) as JsonValue,
          fresh: false,
        };
      }
    }
    cursor = page.next;
  } while (cursor);
  return found;
}

/** Native tools rebuild contextual Zod validation from durable call arguments. */
export function createRoleRuntime(
  resolve: (descriptor: CallDescriptor) => Promise<RoleCall> = resolveCall,
) {
  const names = [
    ...Object.values(roleTools),
    reconstructionCalls.statement.tool,
    reconstructionCalls.proof.tool,
  ];
  const tools = names.map((name) =>
    defineTool({
      name,
      description: "Submit the result for the current mathematical assignment.",
      parameters: Type.Object({}, { additionalProperties: true }),
      callers: ["model"],
      replay: "safe",
      executionMode: "sequential",
      constrainedSampling: { type: "json_schema", strict: "prefer" },
      async execute(value, api, context) {
        const assignment = await api.snapshot(
          Assignment,
          api.conversationId,
          context,
        );
        if (!assignment?.descriptor) throw new Error("Missing role assignment");
        const call = await resolve(assignment.descriptor);
        if (call.tool !== name)
          throw new Error("Submission tool does not match the assignment");
        // A successful receipt exists only after contextual validation, including note references.
        const parsed = call.schema.safeParse(value);
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
    tools,
    hooks: [
      hook(GenerationTask, {
        async beforeRequest({ messages, stream }, api, context) {
          const assignment = await api.snapshot(
            Assignment,
            api.conversationId,
            context,
          );
          if (!assignment?.descriptor) return;
          const call = await resolve(assignment.descriptor);
          const declaration = {
            name: call.tool,
            description: call.description,
            parameters: z.toJSONSchema(call.schema) as TSchema,
            constrainedSampling: {
              type: "json_schema" as const,
              strict: "prefer" as const,
            },
          };
          return {
            // Pi stores the assignment; the provider sees v1's exact prompt and tool schema.
            messages: [
              {
                role: "system" as const,
                content: call.system,
                toolsAdded: [declaration],
                timestamp: 0,
              },
              ...messages.filter((message) => message.role !== "system"),
            ],
            stream: (model, transcript, options) =>
              stream(model, transcript, {
                ...options,
                transport:
                  model.api === "openai-codex-responses" ? "auto" : "sse",
                onPayload: async (payload, requestModel) => {
                  const original =
                    (await options?.onPayload?.(payload, requestModel)) ??
                    payload;
                  if (
                    !original ||
                    typeof original !== "object" ||
                    !["openai-responses", "openai-codex-responses"].includes(
                      model.api,
                    )
                  )
                    return original;
                  const request = { ...original } as Record<string, unknown>;
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
                      .update(`${roleLabels[call.role]}\n${call.system}`)
                      .digest("hex");
                  return request;
                },
              }),
          };
        },
      }),
    ],
  });

  async function run(
    runtime: Runtime,
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
    context: Context,
    previousTasks: readonly number[] = [],
  ): Promise<Receipt> {
    const call = await resolve(descriptor);
    if (call.submissionGate)
      throw new Error(
        "This v1.0.0 port requires Explorer continuation to be off",
      );
    const tool = tools.find((tool) => tool.name === call.tool);
    if (!tool) throw new Error(`Unregistered role tool: ${call.tool}`);
    let conversationId!: ConversationId;
    let sessionId: string | undefined;
    let conversation: ConversationHandle | undefined;
    let recovered: Receipt | undefined;
    let fresh = true;
    const assignment = copyJson(
      { descriptor, profile },
      { omitUndefinedProperties: true },
    );
    try {
      await runtime.commit(async (tx) => {
        for (const ownerTaskId of previousTasks) {
          const previous = await tx.task(ownerTaskId as TaskId);
          if (
            previous?.state.status !== "terminal" ||
            previous.state.outcome.status !== "completed"
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
              recovered = await receipt(tx, child.id, call);
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
        } else {
          conversationId = (
            await tx.createConversation({
              ownership: { kind: "task", taskId: runtime.taskId },
            })
          ).id;
          Object.assign(await tx.doc(Assignment, conversationId), assignment);
          await configure(tx, conversationId, {
            model: { provider: profile.provider, modelId: profile.model },
            thinkingLevel: profile.reasoning,
            extensions: [extension],
            tools: [tool],
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
        { type: "input", requestId: key, content: call.prompt },
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
  return { extension, run };
}
