import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { defineTool, type Campaign, type EntryId, type Json } from "xean";
import { builtinPi, runPi } from "xean/pi";
import { z } from "zod";

import {
  defaultRoleImplementations,
  type ExplorerExecution,
  type RoleExecution,
  type RoleImplementations,
} from "./role-functions";
import { assertRoleInput, readRoleResult } from "./role-records";
import {
  readPiSubmission,
  RoleCallError,
  solveSettings,
  sourceVerdictsOf,
  unusableSourceVerdict,
  type PiRoleDependencies,
  type RoleCall,
  type SolveSettings,
} from "./pi-roles";
import {
  coordinatorInput,
  coordinatorResultFor,
  correctedVerifierInput,
  correctnessVerdictsFor,
  explorerInput,
  explorerResult,
  explorerResultFor,
  VerdictHistory,
  jsonSnapshot,
  judgedBy,
  literatureInput,
  literatureReport,
  missingVerdicts,
  modelCallLabel,
  noteIdAfter,
  pick,
  proof,
  reconstructionCalls,
  reconstructionResultFor,
  returnedOutput,
  roleCallRecords,
  roleFromLabel,
  roleLabels,
  roleRequest,
  roleTools,
  savedExplorerSubmission,
  sourceGroups,
  sourceInputFor,
  sourceVerdict,
  statement,
  verificationLabel,
  verificationVerdicts,
  verifierInput,
  verifierLabels,
  verifierNames,
  verdictsFor,
  type ExplorerInput,
  type ExplorerResult,
  type Note,
  type RoleHost,
} from "./roles";
import { codexCommand, selectModel, type SolveModels } from "./runtime";
import { withSerialToolCalls } from "./serial-tools";
import {
  codexCall,
  codexSubmission,
  prepareCodex,
  type CodexExec,
} from "./source";
import { supportClosure } from "./support";

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function roleParent(campaign: Campaign, parent?: EntryId) {
  const declaration = campaign.record(1);
  if (
    parent === undefined &&
    declaration?.kind === "campaign" &&
    z.object({ kind: z.literal("workflow") }).safeParse(declaration.config)
      .success
  )
    throw new Error("workflow role requires its parent call");
  return parent === undefined ? {} : { parent };
}

/** Persistence, cancellation and acceptance are host responsibilities, not role capabilities. */
export function createRoleHost(
  campaign: Campaign,
  settingsValue: z.input<typeof solveSettings>,
  dependencies: PiRoleDependencies = {},
  replacements: Partial<RoleImplementations> = {},
): RoleHost {
  const settings = solveSettings.parse(settingsValue);
  const history = new VerdictHistory(campaign);
  const roles = { ...defaultRoleImplementations(settings), ...replacements };
  let preparedModels: Promise<SolveModels> | undefined;
  let prepared: Promise<CodexExec> | undefined;
  const codex: CodexExec =
    dependencies.codex ??
    (async (request, signal) => {
      prepared ??= prepareCodex({
        command: codexCommand(process.env),
        ...(signal === undefined ? {} : { signal }),
      }).catch((error: unknown) => {
        prepared = undefined;
        throw error;
      });
      return (await prepared)(request, signal);
    });

  async function invoke<I, S extends z.ZodType>(
    label: string,
    input: I,
    schema: S,
    implementation: (
      input: I,
      execution: ExplorerExecution,
    ) => Promise<unknown>,
    profile: keyof Pick<
      SolveSettings,
      | "explorer"
      | "coordinator"
      | "correctness"
      | "requirements"
      | "reconstruction"
    >,
    parent?: EntryId,
    signal = dependencies.signal,
    normalize?: (value: unknown, searches: number) => unknown,
  ): Promise<{ call: EntryId; value: z.output<S> }> {
    const frozen = freeze(jsonSnapshot(input)) as I;
    const exploring = label === roleLabels.explorer;
    const known: Pick<Note, "id" | "dead">[] = exploring
      ? [...(frozen as ExplorerInput).notes]
      : [];
    const receipts = new Map<EntryId, string[]>();
    let reconciledThrough = 0;
    const submit = defineTool({
      name: roleTools.explorer,
      description: "Save a batch of Explorer notes and receive their IDs",
      input: explorerResultFor(known),
      async run(_value, { call, toolCall }) {
        const prior = receipts.get(toolCall);
        if (prior !== undefined) return { noteIds: prior };
        for (const entry of campaign.records({
          kinds: ["tool-call"],
          call,
          after: reconciledThrough,
          through: toolCall,
        })) {
          if (entry.kind !== "tool-call" || entry.tool !== roleTools.explorer)
            continue;
          const value = explorerResult.parse(entry.input);
          const ids = value.notes.map((_, position) =>
            noteIdAfter(known.length, position),
          );
          receipts.set(entry.seq, ids);
          known.push(...ids.map((id) => ({ id, dead: false })));
          reconciledThrough = entry.seq;
        }
        const noteIds = receipts.get(toolCall);
        if (noteIds === undefined)
          throw new Error("missing saved Explorer submission");
        return { noteIds };
      },
    });
    const receipt = await campaign.call(
      {
        label,
        role: roleFromLabel(label)!,
        ...roleParent(campaign, parent),
        request: roleRequest.parse({
          protocol: "xean-solve/role/v1",
          input: frozen,
        }),
        ...(exploring ? { tools: [submit] } : {}),
        ...(signal === undefined ? {} : { signal }),
      },
      async (context) => {
        let searches = 0;
        const execution: ExplorerExecution = {
          signal: context.signal,
          async pi<S extends z.ZodType>(
            request: RoleCall<S>,
          ): Promise<z.output<S>> {
            const models = await (preparedModels ??= Promise.resolve().then(
              () =>
                typeof dependencies.models === "function"
                  ? dependencies.models()
                  : (dependencies.models ?? withSerialToolCalls(builtinPi())),
            ));
            const selected = settings[profile];
            const model = selectModel(models, {
              provider: selected.provider,
              modelId: selected.model,
            });
            const submitTool =
              request.tools?.find((tool) => tool.name === request.tool) ??
              defineTool({
                name: request.tool,
                description: request.description,
                input: request.schema,
                async run() {
                  return null;
                },
              });
            const tools = [
              submitTool,
              ...(request.tools ?? []).filter(
                (tool) => tool.name !== request.tool,
              ),
            ];
            const result = await (dependencies.run ?? runPi)(campaign, {
              models,
              model,
              label: modelCallLabel(label),
              parent: context.call,
              system: request.system,
              prompt: request.prompt,
              reasoning: selected.reasoning,
              ...(selected.replayReasoning === false
                ? { replayReasoning: false }
                : {}),
              tools,
              ...(tools.length > 1 ? { terminalTool: request.tool } : {}),
              submissionGate: request.submissionGate,
              maxRecoveries: 8,
              maxLengthContinuations: 8,
              cacheKey: createHash("sha256")
                .update(`${roleLabels[request.role]}\n${request.system}`)
                .digest("hex"),
              signal: context.signal,
            });
            if (result.state !== "succeeded")
              throw new RoleCallError(
                `${request.role} failed: ${result.error}`,
              );
            const saved = readPiSubmission(
              roleCallRecords(campaign, result.call),
              result.call,
              request,
            );
            if (saved === undefined)
              throw new RoleCallError(
                `${request.role} returned no ${request.tool} submission`,
              );
            return saved;
          },
          async codex(request) {
            const result = await codexCall(
              campaign,
              {
                label: modelCallLabel(label),
                parent: context.call,
              },
              request,
              codex,
              context.signal,
            );
            if (result.output.state !== "succeeded") {
              if (
                label === roleLabels.literature &&
                result.output.state === "failed"
              )
                return { input: null, searches: 0, error: result.output.error };
              throw new RoleCallError(
                `${roleFromLabel(label)} failed: ${result.output.error}`,
              );
            }
            try {
              const value = codexSubmission(
                roleCallRecords(campaign, result.call),
                result.call,
              );
              if (value === undefined)
                throw new Error("missing Codex submission");
              searches += value.searches;
              return { input: value.input, searches: value.searches };
            } catch (error) {
              if (label === roleLabels.literature)
                throw new RoleCallError(
                  "literature returned no valid note candidates",
                );
              return { input: null, searches: 0, error: String(error) };
            }
          },
          async submit(value) {
            if (!exploring)
              throw new Error("only Explorer can submit intermediate notes");
            return (await context.tools[0]!.execute(jsonSnapshot(value))) as {
              noteIds: string[];
            };
          },
        };
        const returned = await implementation(frozen, execution);
        const value = schema.parse(
          normalize === undefined ? returned : normalize(returned, searches),
        );
        if (exploring) {
          const result = value as ExplorerResult;
          const saved = savedExplorerSubmission(
            roleCallRecords(campaign, context.call),
            context.call,
          );
          const prefix = saved?.input.notes ?? [];
          if (!isDeepStrictEqual(result.notes.slice(0, prefix.length), prefix))
            throw new Error("Explorer return changed already submitted notes");
          if (result.notes.length > prefix.length || saved === undefined)
            await execution.submit({
              notes: result.notes.slice(prefix.length),
              solution: result.solution,
            });
        }
        return { state: "succeeded", value: jsonSnapshot(value) };
      },
    );
    return {
      call: receipt.call,
      value: schema.parse((receipt.output as { value: Json }).value),
    };
  }

  return {
    async explorer(value, signal = dependencies.signal, parent) {
      const input = explorerInput.parse(value);
      return (
        await invoke(
          roleLabels.explorer,
          input,
          explorerResultFor(input.notes),
          roles.explorer,
          "explorer",
          parent,
          signal,
        )
      ).value;
    },
    async coordinator(value, parent, signal = dependencies.signal) {
      const input = coordinatorInput.parse(value);
      return (
        await invoke(
          roleLabels.coordinator,
          input,
          coordinatorResultFor(input),
          roles.coordinator,
          "coordinator",
          parent,
          signal,
        )
      ).value;
    },
    async literature(value, parent, signal = dependencies.signal) {
      const input = literatureInput.parse(value);
      return (
        (
          await invoke(
            roleLabels.literature,
            input,
            literatureReport.nullable(),
            roles.literature,
            "coordinator",
            parent,
            signal,
          )
        ).value ?? { notes: [] }
      );
    },
    async verifier(
      value,
      verificationValue,
      signal = dependencies.signal,
      parent,
    ) {
      const input = verifierInput.parse(value);
      const verification =
        verificationValue ??
        (
          await campaign.call(
            {
              label: verificationLabel,
              ...roleParent(campaign, parent),
              request: jsonSnapshot(input),
            },
            async () => ({ state: "succeeded" }),
          )
        ).call;
      const opening = campaign.record(verification);
      if (
        opening?.kind !== "call" ||
        !isDeepStrictEqual(opening.request, jsonSnapshot(input))
      )
        throw new Error("verification input differs from its frozen opening");
      let cursor = verification;
      async function check<I, S extends z.ZodType>(
        label: string,
        data: I,
        schema: S,
        implementation: (
          input: I,
          execution: RoleExecution,
        ) => Promise<unknown>,
        profile: "correctness" | "requirements" | "reconstruction",
        normalize?: (value: unknown, searches: number) => unknown,
      ) {
        for (const call of campaign.scan({
          kinds: ["call"],
          parent: verification,
          after: cursor,
        })) {
          if (
            call.kind !== "call" ||
            call.role !== "verifier" ||
            call.label !== label
          )
            throw new Error(
              "verifier call is out of order or has the wrong owner",
            );
          cursor = call.seq;
          const result = readRoleResult(
            roleCallRecords(campaign, call.seq),
            call.seq,
          );
          if (result === undefined) continue;
          assertRoleInput(call, data);
          cursor = result.settled;
          return { call: call.seq, value: schema.parse(result.value) };
        }
        const result = await invoke(
          label,
          data,
          schema,
          implementation,
          profile,
          verification,
          signal,
          normalize,
        );
        cursor = returnedOutput(
          roleCallRecords(campaign, result.call),
          result.call,
        )!.settled;
        return result;
      }
      const recorded = () =>
        history
          .read(cursor)
          .filter(
            (entry) =>
              entry.verification === verification && entry.seq <= cursor,
          )
          .map(({ verdict }) => verdict);
      const record = (call: EntryId, values: readonly unknown[]) => {
        cursor =
          campaign.records({ kinds: ["evidence"], call })[0]?.seq ??
          campaign.recordEvidence(call, jsonSnapshot({ verdicts: values }));
      };
      for (const name of verifierNames) {
        for (;;) {
          const current = recorded();
          const have = verificationVerdicts(input, current);
          const judged = missingVerdicts(
            have,
            name,
            judgedBy(input, have, name),
          );
          if (judged.length === 0) break;
          const working = correctedVerifierInput(input, current);
          if (name === "source") {
            for (const assigned of sourceGroups(
              input,
              judged,
              verification,
              history.read(cursor),
            )) {
              const packet = sourceInputFor(
                working,
                assigned,
                inspectedPassages(history, verification),
              );
              const result = await check(
                verifierLabels.source,
                packet,
                z.strictObject({ verdicts: z.array(sourceVerdict) }),
                roles.source,
                "correctness",
                (returned, searches) =>
                  sourceVerdictsOf(
                    { input: jsonSnapshot(returned), searches },
                    packet.passages,
                    assigned,
                  ) ?? {
                    verdicts: assigned.map(({ note }) =>
                      unusableSourceVerdict(
                        note,
                        "the source verdicts do not match the judged notes or the evidence schema.",
                      ),
                    ),
                  },
              );
              record(result.call, result.value.verdicts);
            }
            break;
          }
          let result;
          if (name === "reconstruction") {
            const note = pick(working.notes, judged[0]!);
            const boundary = campaign.lastSequence();
            let extracted = (
              await check(
                reconstructionCalls.statement.label,
                { input: working, note },
                statement,
                roles.statement,
                "reconstruction",
              )
            ).value;
            let corrections = 0;
            for (;;) {
              const support = supportClosure(
                [note],
                [...working.notes, ...working.support],
              ).map((id) => pick([...working.notes, ...working.support], id));
              const independent = await check(
                reconstructionCalls.proof.label,
                { task: working.task, support, statement: extracted },
                proof,
                roles.proof,
                "reconstruction",
              );
              result = await check(
                verifierLabels.reconstruction,
                {
                  input: working,
                  note,
                  statement: extracted,
                  proof: independent.value.proof,
                },
                reconstructionResultFor(note.id),
                roles.reconstruction,
                "reconstruction",
              );
              if (result.value.statement === null) break;
              extracted = { statement: result.value.statement };
              if (result.call > boundary && corrections++ >= 1)
                throw new RoleCallError(
                  "reconstruction statement remains unresolved; resume verification to use its latest correction",
                );
            }
          } else if (name === "correctness") {
            result = await check(
              verifierLabels.correctness,
              { input: working, judged },
              correctnessVerdictsFor(judged),
              roles.correctness,
              "correctness",
            );
          } else {
            result = await check(
              verifierLabels.requirements,
              { input: working, judged },
              verdictsFor(judged),
              roles.requirements,
              "requirements",
            );
          }
          record(result.call, result.value.verdicts);
          if (name !== "reconstruction") break;
          if (result.value.verdicts[0]!.verdict === "PASS")
            return verificationVerdicts(input, recorded());
        }
      }
      return verificationVerdicts(input, recorded());
    },
  };
}

/** Previously admitted passages are immutable factual inputs to a source role. */
function inspectedPassages(history: VerdictHistory, before: EntryId) {
  const passages: Array<{
    call: EntryId;
    note: string;
    result: string;
    source: string;
    url: string;
    quote: string;
  }> = [];
  for (const entry of history
    .read(before - 1)
    .toSorted((a, b) => a.call - b.call)) {
    if (entry.verdict.verifier !== "source" || entry.verdict.verdict !== "PASS")
      continue;
    for (const { result, source, url, quote } of entry.sources!) {
      if (
        !passages.some(
          (value) =>
            value.result === result &&
            value.source === source &&
            value.url === url &&
            value.quote === quote,
        )
      )
        passages.push({
          call: entry.call,
          note: entry.verdict.note,
          result,
          source,
          url,
          quote,
        });
    }
  }
  return passages;
}
