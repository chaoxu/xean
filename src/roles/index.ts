import type { Context } from "@earendil-works/chord";
import { isDeepStrictEqual } from "node:util";
import { normalizeContext } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { Assert } from "typebox/value";
import {
  batchResults,
  submissionSchemas,
  verdictSchema,
  verificationStageSchema,
  type Check,
  type ExplorerInput,
  type Note,
  type Plan,
  type SolverResult,
  type Source,
  type Task,
  type VerifierInput,
  type ReviewInput,
  type ReconstructionInput,
  type Verdict,
  type VerificationStage,
} from "../math/contracts.ts";
import {
  correctionInstructions,
  noteInfo,
  refresh,
  pendingChecks,
  sourceEvidence,
  stagePending,
  validateNotes,
  validateResult,
} from "../math/notes.ts";
import { closure, keepsPrior } from "../math/argument.ts";
import { conversations, type Submission } from "./conversation.ts";
import {
  explorerResponseLimit,
  defaultMaxExplorerReads,
  type ProfileName,
  type Settings,
} from "../config.ts";
import { codexCalls, type CodexOptions } from "./codex.ts";
import {
  RoleFailure,
  type NoteReference,
  type Profiles,
  type RoleRuntime,
} from "./types.ts";
import {
  codexResearch,
  closedBookResearch,
  type Research,
  type LiteratureInput,
} from "./research.ts";
import { codexWorker } from "./codex-worker.ts";
import { chatgpt } from "./chatgpt.ts";
import type { SubmissionResult } from "../math/results.ts";

/** A replacement function supplies Codex without the built-in worker settings. */
export const unconfiguredCodex: ReturnType<typeof codexWorker> = () => {
  throw new Error("Codex worker is not configured");
};

const mathematicalCheck = `Judge the authoritative full text first. Check both summaries against it: preserve hypotheses, quantitative guarantees, conditionality, negative conclusions, and unresolved gaps. A summary must not strengthen a claim or present an unresolved result as established. For generated notes, PASS requires the original argument to establish the full claimed statement under declared transitive support, listed external premises, and task-permitted assumptions. A substantive argument supplied only in a report or independent proof cannot repair that note. If missing justification is the only blocker, return INCONCLUSIVE even if you can prove the result. Do not omit conclusions to obtain PASS. FAIL requires a concrete defect. Use INCONCLUSIVE when you cannot settle a check. ${correctionInstructions} Treat established support results as given, but verify their applicability against their exact statements, including hypotheses absent from summaries, and check all new reasoning. Do not infer mathematical truth from an earlier model's confidence.`;
const importedStatementInstructions =
  "For notes marked imported, the caller grants the mathematical result. Identify each imported note's exact mathematical result for blind reconstruction, preserving its definitions, hypotheses, quantifiers, conclusions, and conditionality. Check extraction fidelity, not the truth already granted by the caller. Exclude proof recipes, methods, and intermediate proof steps. A construction that is itself the claimed result is legitimate statement content. Return PASS only for a faithful standalone statement; return statement=null and INCONCLUSIVE when no mathematical result is asserted. Do not invent a claim, rewrite the note, or give corrections. Return premises=[]; caller trust supplies the imported result, not additional assumptions for proving that same result.";
const packet = (note: Note) => ({
  id: note.id,
  imported: note.imported,
  text: note.text,
  statement: note.checks.correctness?.statement,
  summary: note.summary,
  detailedSummary: note.detailedSummary,
  support: note.support,
});
/** Source reports and quotations stay out of later mathematical prompts. */
const sourceRecord = (note: Note) => {
  const premises = note.checks.correctness?.premises ?? [];
  const source = note.checks.source;
  if (
    source &&
    "premises" in source &&
    !isDeepStrictEqual(premises, source.premises)
  )
    throw new Error(
      `Source-checked premises do not match correctness for ${note.id}`,
    );
  return {
    premises,
    source: note.imported
      ? { kind: "caller-import" }
      : {
          kind: "source-check",
          verdict: source!.verdict,
          ...(source && "operationId" in source
            ? {
                operationId: source.operationId,
                passages: source.passages.map(({ id, url, premise }) => ({
                  id,
                  url,
                  premise,
                })),
              }
            : {}),
        },
  };
};
type StageResult<Stage extends VerificationStage> = NonNullable<Check[Stage]> &
  Pick<Verdict, "correction">;
type RecordCheck = <Stage extends VerificationStage>(
  note: Note,
  stage: Stage,
  result: StageResult<Stage>,
) => void;

async function collectChecks(
  context: Context,
  run: (record: RecordCheck) => Promise<void>,
): Promise<Extract<SolverResult, { kind: "verification" }>> {
  const checks = new Map<string, Check>();
  const record: RecordCheck = (note, stage, result) => {
    const check = checks.get(note.id) ?? { noteId: note.id };
    const recorded = { ...result };
    delete recorded.correction;
    if (stage === "correctness" && note.imported && "premises" in recorded) {
      if (
        recorded.premises.length ||
        (result.correction &&
          Object.values(result.correction).some((value) => value !== null))
      )
        throw new Error(
          "Imported statement preparation cannot add premises or corrections",
        );
      if (recorded.verdict === "FAIL") recorded.verdict = "INCONCLUSIVE";
    }
    if (
      stage === "correctness" &&
      "statement" in recorded &&
      recorded.statement === null &&
      recorded.verdict === "PASS"
    ) {
      recorded.verdict = "INCONCLUSIVE";
      recorded.report = `No mathematical claim was identified for verification. ${recorded.report}`;
    }
    validateResult(
      {
        kind: "verification",
        checks: [{ noteId: note.id, [stage]: recorded }],
      },
      [note],
    );
    if (result.correction !== undefined)
      Assert(verdictSchema.properties.correction, result.correction);
    check[stage] = recorded;
    checks.set(note.id, check);
    if (!keepsPrior(note.checks[stage], recorded))
      note.checks[stage] = recorded;
    if (recorded.verdict !== "PASS" || result.correction === undefined) return;
    for (const field of ["summary", "detailedSummary"] as const) {
      const value = result.correction[field];
      if (value == null || value === note[field]) continue;
      note[field] = value;
      (check.correction ??= { revision: note.revision })[field] = value;
    }
  };
  try {
    await run(record);
  } catch (error) {
    if (context.abortSignal?.aborted) throw error;
    const failure = new RoleFailure(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
    if (checks.size)
      failure.result = { kind: "verification", checks: [...checks.values()] };
    throw failure;
  }
  return { kind: "verification", checks: [...checks.values()] };
}

export type CoordinationInput = {
  task: Task;
  notes: Note[];
  failures: { id: string; role: string; error: string | null }[];
  guidance: string[];
  literatureUsed: boolean;
  /** Any prior work for the current built-in Explorer, including failures. */
  explorerUsed: boolean;
  recent?: {
    id: string;
    role: string;
    completed: boolean;
    failed: boolean;
    error: string | null;
    request?: unknown;
  }[];
};
export type RoleOptions = Omit<Settings, "profiles" | "research" | "codex"> & {
  profiles: Profiles;
  research?: CodexOptions | false;
  codex?: CodexOptions & { workspace: string };
};

export function createRoles(options: RoleOptions, researchOverride?: Research) {
  const maxExplorerResponses = explorerResponseLimit(options);
  const maxExplorerReads = options.maxExplorerReads ?? defaultMaxExplorerReads;
  const native = conversations(options.profiles);
  const { ask } = native;
  const askCodex = codexCalls({
    ...options,
    research: options.research ?? { model: "gpt-6-astra" },
  });
  const research =
    researchOverride ??
    (options.research === false ? closedBookResearch : codexResearch(askCodex));
  const literature = (options.literature ?? false) && research.retrieval;
  const singleShot = options.chatgpt !== undefined;
  const batch = async <
    P extends Exclude<ProfileName, "explorer" | "coordinator">,
  >(
    profile: P,
    instructions: string,
    input: { notes: { id: string }[]; [key: string]: unknown },
    runtime: RoleRuntime,
    context: Context,
  ): Promise<Omit<Submission<P>["results"][number], "noteId">[]> => {
    if (!input.notes.length) return [];
    const ids = input.notes.map((note) => note.id);
    const ref = options.profiles[profile].model;
    const model = runtime.models.getModel(ref.provider, ref.modelId)!;
    const result = await ask(
      profile,
      `Return exactly one result for every requested ID in notes, never additional results for support. ${instructions}`,
      {
        ...input,
        capacity: {
          contextTokens: model.contextWindow,
          outputTokens: model.maxTokens,
        },
      },
      runtime,
      context,
      {
        ids,
      },
    );
    const results = result.at(-1)!.value.results;
    return batchResults<Submission<P>["results"][number]>(ids, results);
  };
  const reconstruction = (
    input: ReconstructionInput,
    runtime: RoleRuntime,
    context: Context,
  ) => {
    const notes = closure(input.targets, refresh(input.notes));
    if (notes.some((note) => !note.verified))
      throw new Error(
        "Reconstruction requires verified notes and support with checked statements",
      );
    let pending = notes.filter(
      (note) =>
        (!note.imported || input.targets.includes(note.id)) &&
        stagePending(note, "reconstruction"),
    );
    return async (record: RecordCheck) => {
      const unblocked = (pending: Note[]) => {
        refresh(notes);
        return pending.filter((note) => {
          if (!note.dead) return true;
          record(note, "reconstruction", {
            verdict: "INCONCLUSIVE",
            report:
              "A declared dependency was refuted. This dependent claim remains unresolved.",
            proof:
              "Further reconstruction was skipped after its support was refuted.",
          });
          return false;
        });
      };
      const statement = (note: Note) => ({
        id: note.id,
        statement: note.checks.correctness?.statement,
        premises: sourceRecord(note).premises,
        support: note.support,
      });
      const supportFor = (group: Note[]) =>
        closure(
          group.flatMap((note) => note.support),
          notes,
        ).filter((note) => !group.includes(note));
      const select = (
        profile: "proof" | "reconstruction",
        pending: Note[],
        instructions: string,
        inputFor: (group: Note[]) => unknown,
        writtenTokens: (note: Note) => number,
      ) => {
        const ref = options.profiles[profile].model;
        const model = runtime.models.getModel(ref.provider, ref.modelId)!;
        let count = 1;
        let output = 0;
        for (let size = 1; size <= pending.length; size++) {
          const group = pending.slice(0, size);
          // Reserve complete writing, JSON framing, and three times as much
          // reasoning. These estimates are scheduling hints, never output caps.
          output += Math.max(512, writtenTokens(group.at(-1)!)) + 128;
          if (output * (model.reasoning ? 4 : 1) > model.maxTokens * 0.8) break;
          const content = JSON.stringify([
            instructions,
            inputFor(group),
            submissionSchemas[profile],
            group.map((note) => note.id),
          ]);
          const room = clampMaxTokensToContext(
            { ...model, contextWindow: model.contextWindow * 0.8 },
            normalizeContext({
              messages: [{ role: "user", content, timestamp: 0 }],
            }),
            model.maxTokens,
          );
          if (room < model.maxTokens) break;
          count = size;
        }
        // An oversized estimate gets one note, subject to Pi's input guard.
        return pending.slice(0, count);
      };
      const instructions =
        "Independently prove every requested statement, returning one complete proof per note. Declared support outside the assigned group may be assumed at its exact stated scope without reproving it. Check applicability and submit results for every assigned note. Write complete arguments, not abbreviated sketches. Original arguments, methods, summaries, and comparison reports are withheld. Use only each note's declared transitive support, its listed external premises, and background permitted by the task. Approved external premises may be assumed at exactly their stated scope; check their hypotheses and applications. Previously attempted support may be assumed conditionally, but final acceptance still requires reconstruction throughout the generated dependency chain. Never use a descendant or unrelated claim. Prove every new step, including composition and theorem applicability. To prove P implies Q, assume P and derive Q; this does not establish P. Set complete=false and state the unresolved gap when you cannot complete a proof. Supporting lemmas need not solve the original task.";
      const comparisonInstructions = `${mathematicalCheck} First check that the extracted statement faithfully represents the result asserted in the full text, preserving scope without leaking proof instructions. Also check imported support statements against their supplied full text. A bad extraction gives INCONCLUSIVE and is not a defect in the original mathematics. For generated notes, compare the original argument in the full text with the independent proof. Both arguments must establish that statement, including its hypotheses, quantitative guarantees, and permitted assumptions. The supplied premises records bind the exact external claims to source PASS or caller-import trust. Use those approved claims without demanding another proof or source search, but check their exact hypotheses and applications. A stronger theorem, an unmet hypothesis, or an undeclared inference is not approved. Supporting claims must follow declared transitive dependencies, in dependency order, without circular or unrelated assumptions. Code requires the whole generated dependency chain to pass; supporting lemmas need not solve the original task. An explicit conditional P implies Q may assume P, but does not establish P. For generated notes, PASS requires a correct original argument and a correct independent proof of the same claim. For an imported target, caller trust grants the original result and sources; no original proof is required. PASS requires faithful statement extraction and a complete correct independent proof of that exact claim. Caller trust does not replace reconstruction. FAIL requires a concrete defect in the original statement or argument. An incomplete, incorrect, or unsupported independent proof alone gives INCONCLUSIVE, even if it claims completeness. So do missing approval records or proof recipes leaked through the extracted statement or external premises. Distinguish a construction that is itself the claimed result from guidance for finding its proof. Never silently edit an approved premise. For generated notes, audit the original even when reconstruction is incomplete: identify whether it supplies the missing step. For FAIL or INCONCLUSIVE, begin with the exact blocker. Then report Original argument:, Independent proof:, and Statement and premises:. Explain concrete defects with a quotation, formula, or note ID, distinguishing mathematical errors from missing evidence, input problems, and harmless wording. No defect found does not establish correctness. Record unresolved obligations, not work requests.`;
      while (pending.length) {
        const proofInput = (group: Note[]) => ({
          task: input.task,
          notes: group.map(statement),
          support: supportFor(group).map(statement),
        });
        const group = select(
          "proof",
          pending,
          instructions,
          proofInput,
          (note) =>
            3 *
            Math.max(
              estimateTextTokens(note.text),
              estimateTextTokens(JSON.stringify(statement(note))),
            ),
        );
        const proofs = await batch(
          "proof",
          instructions,
          proofInput(group),
          runtime,
          context,
        );
        let remaining = group;
        while ((remaining = unblocked(remaining)).length) {
          const comparisonInput = (selected: Note[]) => {
            const support = supportFor(selected);
            return {
              task: input.task,
              support: support.map((note) =>
                note.imported ? packet(note) : statement(note),
              ),
              notes: selected.map(packet),
              premises: [...support, ...selected].map((note) => ({
                noteId: note.id,
                ...sourceRecord(note),
              })),
              independent: selected.map((note) => ({
                noteId: note.id,
                result: proofs[group.indexOf(note)]!,
              })),
            };
          };
          const comparisonGroup = select(
            "reconstruction",
            remaining,
            comparisonInstructions,
            comparisonInput,
            (note) =>
              estimateTextTokens(note.text) +
              estimateTextTokens(proofs[group.indexOf(note)]!.proof),
          );
          const judgments = await batch(
            "reconstruction",
            comparisonInstructions,
            comparisonInput(comparisonGroup),
            runtime,
            context,
          );
          for (const [index, judgment] of judgments.entries()) {
            const note = remaining[index]!;
            const proof = proofs[group.indexOf(note)]!;
            record(note, "reconstruction", {
              ...judgment,
              proof: proof.proof,
              ...(!proof.complete && judgment.verdict === "PASS"
                ? {
                    verdict: "INCONCLUSIVE" as const,
                    report: `Independent proof was incomplete. ${judgment.report}`,
                  }
                : {}),
            });
          }
          remaining = remaining.slice(judgments.length);
        }
        pending = unblocked(pending.slice(group.length));
        if (
          supportFor(pending).some(
            (note) =>
              !note.imported &&
              group.includes(note) &&
              note.checks.reconstruction?.verdict === "INCONCLUSIVE",
          )
        )
          break;
      }
    };
  };
  const functions = {
    capabilities(input: CoordinationInput) {
      return {
        verifier: true,
        explorer: !singleShot || !input.explorerUsed,
        codex: functions.codex !== unconfiguredCodex,
        literature: literature && !input.literatureUsed,
        sourceRetrieval: research.retrieval,
      };
    },
    async reconstruct(
      input: ReconstructionInput,
      runtime: RoleRuntime,
      context: Context,
    ) {
      input = structuredClone(input);
      return collectChecks(context, reconstruction(input, runtime, context));
    },
    codex: options.codex ? codexWorker(askCodex) : unconfiguredCodex,
    async explorer(
      input: ExplorerInput,
      runtime: RoleRuntime,
      context: Context,
      source?: NoteReference,
    ): Promise<SubmissionResult | SolverResult> {
      const maxResponses = singleShot ? 1 : maxExplorerResponses;
      input = structuredClone(input);
      const maxReads =
        singleShot || input.notes.length === 0 ? 0 : maxExplorerReads;
      const explorerInstructions = singleShot
        ? "All note summaries are supplied in the initial context. Do not read notes or request continuation; submit the complete useful result in this one response."
        : maxReads === 0
          ? "The published note index is empty. No notes are available to read in this invocation. Private submissions stay in this conversation."
          : "Use read_notes to choose detailed summaries or full arguments from the supplied published index, batching independent IDs. Private submissions stay in this conversation, outside that index. Reading is disabled when its allowance is exhausted and on your final response; then work from available context and submit.";
      const editingInstructions = singleShot
        ? "Create new notes only. Existing full texts are not supplied, so do not edit existing notes. Omit edits or return an empty edits array. Record proposed repairs as new findings with their limitations; they do not change existing notes."
        : "Repair existing notes with edits, keeping their stable IDs. Read the affected full text before changing it. Each edit supplies the public revision from the frozen index and only the fields you change. Mark presentation-only text edits cosmetic=true to preserve checks. This trusted classification must preserve all mathematical content. Support changes always invalidate affected checks. Repeated private edits to the same existing ID merge field by field and keep that same expected public revision. New notes and edits remain private until this worker returns and publish atomically. When repairing a proof or dependency gap, first look for an existing note supplying the missing result, then repair the consuming argument and its support declarations. A new lemma alone does not repair a consumer that still lacks the dependency. Unchanged consumers need no copied replacement notes. Retired notes remain readable for diagnosis; retiring a note does not redirect its consumers. Changing an imported note's mathematical content or support revokes its caller grant. The edited argument must pass generated-note checks. Cosmetic text changes preserve that grant. Do not copy an unchanged failed argument under a new ID or submit no-op edits as progress. read_notes supplies its checked statement when available. Use that statement as the granted result. If you need an additional fact from its proof, prove the fact in your note or establish it as a separate lemma and declare it as support. To mark an existing note as a candidate, set candidate=true in its edit.";
      const instructions = `Work on the exact mathematical task. You own the mathematical strategy: choose approaches, change direction, and continue useful work. The input contains the task, the complete index of note IDs and summaries, note states, feedback, guidance, and your read and response allowances. Guidance is fallible. ${explorerInstructions} Follow support IDs when needed. Every response counts, including reads, rejected submissions, and responses without a submission. Do mathematics without external search. Record mathematical results and failed approaches that help continue work on the exact task. Provide an index summary, detailed summary, and complete free-form text. Notes may contain proved results, conjectures, observations, questions, failed approaches, or unresolved gaps. Distinguish them explicitly; never present an unproved claim as established. State substantial reusable lemmas as separate notes with complete arguments and refer to them through support; keep routine steps together. Reuse established results when the task permits, stating their hypotheses and flagging uncertain claims or sources for checking. Develop background arguments when they help advance the task. Identify unresolved assumptions and pivotal claims so Coordinator can arrange appropriate checks. Declare as support every note whose result you use without proving it, including factual claims in scope remarks or comparisons. Reading, mentioning, or questioning a note without relying on its result is not a dependency. Dead notes are diagnostic only; never use them as mathematical support. Existing verified support need not be reproved. ${editingInstructions} Use local IDs n1, n2, ... without reusing one. A note may refer to an earlier note in this invocation or an existing note ID. New notes are private until this worker returns. Set candidate=true only when the last new note claims a complete solution of the exact task. An empty notes-and-edits submission hands off.`;
      const prompt = {
        task: input.task,
        notes: input.notes.filter((note) => !note.retired).map(noteInfo),
        guidance: input.guidance,
        allowance: { reads: maxReads, responses: maxResponses },
      };
      if (options.chatgpt) {
        const result = await chatgpt(
          options.chatgpt,
          instructions,
          prompt,
          runtime,
          context,
        );
        if (result.edits?.length)
          throw new Error(
            "ChatGPT Web Explorer cannot edit notes without their full text",
          );
        return validateResult({ kind: "notes", ...result }, input.notes);
      }
      const result = await ask(
        "explorer",
        instructions,
        prompt,
        runtime,
        context,
        {
          maxResponses,
          maxReads,
          ...(source ? { noteSource: source } : { notes: input.notes }),
        },
      );
      return { kind: "submissions", entries: result.map(({ id }) => id) };
    },

    async coordinator(
      input: CoordinationInput,
      runtime: RoleRuntime,
      context: Context,
      source?: NoteReference,
    ): Promise<Plan> {
      input = structuredClone(input);
      const { notes, task, explorerUsed: _explorerUsed, ...state } = input;
      const capabilities = functions.capabilities(input);
      const prompt = {
        ...state,
        task,
        notes: notes.filter((note) => !note.retired).map(noteInfo),
        capabilities,
      };
      return ask(
        "coordinator",
        `Choose one worker for this mathematical task, or return work=null to leave the campaign idle. The outer loop is Coordinator, one worker, Coordinator. You run after the prior worker commits its complete result or failure. You choose mathematical strategy from the supplied index, feedback, and recent outcomes. For Explorer, supply guidance; Explorer chooses which notes to read and how to develop or edit their arguments. Use only offered work kinds. Explorer has no external retrieval tools. Use Codex for a concrete implementation deliverable with its domain, constraints, and evidence of completion. Literature is available for at most one completed search and only when enabled. When sourceRetrieval is false, verification cannot retrieve external evidence.

Verification runs correctness, source, requirements, then reconstruction. Correctness judges each note's exact mathematics conditionally on its declared support and listed premises. Source checks those exact external premises. All declared dependencies must pass before a note is verified. Requirements judges the original task's full completion criteria. A supporting lemma need not solve the task. For final acceptance, target the complete-solution candidate through reconstruction; code also requires reconstruction throughout its generated dependency chain. Imported results retain only the caller's exact grant, with declared dependencies checked, and an imported candidate still requires requirements and reconstruction. Reuse applicable PASS checks. A missing proof, changed statement, or changed dependency is repaired in the authoritative note, not by adding an argument to a check report. Verifier may clarify summaries but cannot edit proof text or dependencies. Source approval does not grant a stronger claim or different premises. A source or requirements failure does not by itself refute the mathematical argument. Never declare acceptance yourself.

Stable note IDs are editable. Ask Explorer to repair the affected argument and any consuming dependency declarations, reusing existing lemmas when appropriate. Do not require copied consumer chains or new IDs merely to repair an existing note. Retirement affects discovery, not mathematical truth or dependency redirects. Dead and retired notes can be read for diagnosis. Mathematical edits invalidate affected evidence; unchanged summaries and repeated assessments do not establish new mathematics. Use the actual unresolved stage in feedback, not just the requested final stage. Recent outcomes report completed work and operational failures. Submitted edit counts do not establish that the mathematics changed; inspect the current note feedback before requesting another check.

A completed non-PASS assessment of unchanged inputs is not automatically pending again. Repeated verification cannot supply a missing proof or supporting statement. Direct Explorer toward a material argument or dependency repair, or obtain relevant new source evidence, before another check. Preserve diagnostic distinctions between a concrete defect and incomplete checking. Provider execution failures can recover through Pi; repeating an unchanged request does not repair a configuration error.

Prioritize pivotal claims and useful dependencies rather than checking every speculative note. Use read_notes for detailed summaries or full arguments when scheduling requires them, batching independent IDs. Return one work request or work=null. An idle decision does not claim a solution.`,
        prompt,
        runtime,
        context,
        {
          maxReads: notes.length > 0 ? defaultMaxExplorerReads : 0,
          ...(source ? { noteSource: source } : { notes }),
          capabilities: prompt.capabilities,
        },
      ).then((result) => result.at(-1)!.value);
    },

    async verifier(
      input: VerifierInput,
      runtime: RoleRuntime,
      context: Context,
    ): Promise<SolverResult> {
      const notes = structuredClone(input.notes);
      refresh(notes);
      Assert(verificationStageSchema, input.through);
      const pending = pendingChecks(input.targets, input.through, notes);
      return collectChecks(context, async (record) => {
        const assess = async (
          stage: "correctness" | "requirements",
          instructions: string,
        ) => {
          const selected = pending(stage);
          const support = closure(
            selected.flatMap((note) => note.support),
            notes,
          ).filter((note) => !selected.includes(note));
          const results = await batch(
            stage,
            `${stage === "correctness" ? mathematicalCheck : correctionInstructions} Check all requested notes together. Judge each note using only its declared transitive support, not unrelated notes in the batch. ${instructions}`,
            {
              task: input.task,
              support: support.map((note) =>
                stage === "requirements"
                  ? {
                      id: note.id,
                      imported: note.imported,
                      statement: note.checks.correctness?.statement,
                      support: note.support,
                    }
                  : packet(note),
              ),
              notes: selected.map(packet),
              ...(stage === "requirements"
                ? {
                    sources: [...support, ...selected].map((note) => ({
                      noteId: note.id,
                      ...sourceRecord(note),
                    })),
                  }
                : {}),
            },
            runtime,
            context,
          );
          selected.forEach((note, index) =>
            record(note, stage, results[index]!),
          );
        };
        await assess(
          "correctness",
          `${importedStatementInstructions} For generated notes: identify the mathematical result expressly claimed by each note and return its exact statement, including definitions, hypotheses, quantifiers, conclusions, and conditionality. Exclude proof recipes, methods, and intermediate proof steps; a construction that is itself the claimed result is legitimate statement content. A research log, question, or strategy suggestion need not assert a result: return statement=null and INCONCLUSIVE when there is no mathematical claim to check. Do not invent a claim or turn conjecture into established fact. The statement will be frozen on PASS and sent to a prover without the full text. Judge each note's own claim; supporting lemmas and partial progress need not solve the original task. Only the later requirements check judges the original completion criteria. For an explicit conditional claim P implies Q, check the derivation of Q assuming P. Its hypothetical antecedent P is part of the claim, not an external theorem to establish; omit it from premises. Proving the implication does not establish P. An unstated assumption in an unconditional claim remains a gap: do not silently weaken the claim to an implication or promote a missing proof step to an external theorem. External results actually used to prove an implication still require the normal assessment below. For declared support checked in this batch or not yet verified, judge the dependent reasoning conditionally; code separately requires every dependency to pass before verification or acceptance. Check borrowed facts against each support's checked statement or the statement you extract in this batch. Additional facts from a support's proof need their own declared support or a proof in the consuming note. If the only unresolved issue is that a needed fact appears in declared support's proof but is omitted from its checked statement, return INCONCLUSIVE and identify the missing statement. Find missing cases, unsupported inferences, and undeclared substantive dependencies. When a claimed fact relies on campaign notes outside declared transitive support, including in scope remarks or comparisons, return INCONCLUSIVE and identify the missing claim or reference in report; never list that fact as an external premise. Apply the task's proof rules. Do not excuse a forbidden black box or an unproved substantive step as background, even if the note calls it standard. A forbidden invocation is a defect. ${research.retrieval ? "Establish routine task-permitted background from mathematical knowledge and explain it in report. Do not externalize a fact proved in the argument, or routine task-permitted background established by your check. List only directly needed nonroutine external claims that remain unproved, with their exact hypotheses and conclusions, including any invoked without citation. A cited theorem note may state such a result conditionally without reproving it. Check each application conditionally and explain it in report." : "This is a closed-book check: source retrieval is disabled. When the task permits standard background, check each such result's precise statement, hypotheses, and application from mathematical knowledge and explain that assessment in report. A background result established by this assessment need not be listed in premises. If permission, statement, or applicability is uncertain, retain the claim in premises; source checking will leave it INCONCLUSIVE. List all other unproved external claims with exact hypotheses and conclusion. Explain their applications in report."} Results explicitly granted as assumptions or permitted background by the supplied task need no external source check. Check their exact scope and application, and omit them from premises. A note merely claiming that permission is insufficient. Do not relist declared support results; check their applicability. Each premise must be a standalone statement preserving every relevant domain, dimension, compactness, regularity, and other hypothesis. Do not generalize beyond the form actually used in the argument. Source names and citations are allowed. Put proof ideas, application hints, and validation commentary in report, never in premises. Source checking will assess these exact strings, and reconstruction will receive them unchanged. Use [] only when no unresolved external premise remains under these rules. Correctness PASS is conditional on support and listed premises.`,
        );
        refresh(notes);

        const sources = pending("source");
        if (sources.length) {
          const sourceInput = {
            task: input.task,
            notes: sources.map((note) => ({
              id: note.id,
              premises: note.checks.correctness!.premises,
            })),
            evidence: sourceEvidence(notes, input.evidence),
          };
          let results = await runtime.memo<Source[]>(
            "research.source",
            context,
          );
          if (results === undefined) {
            results = batchResults(
              sources.map((note) => note.id),
              await research.source(sourceInput, runtime, context),
            );
            results = await runtime.memo("research.source", results, context);
          }
          sources.forEach((note, index) =>
            record(note, "source", structuredClone(results[index]!)),
          );
          refresh(notes);
        }
        await assess(
          "requirements",
          "Decide whether each note meets every completion criterion of the original task. All supplied notes have established correctness and sources, through completed checks or caller import. The sources records supply their exact approved external premises, approval references, and passage IDs and URLs, or caller-import trust. Use this evidence metadata when the task explicitly requires external retrieval. Treat established mathematical results as given; do not repeat correctness or source verification. Check whether the stated result and supplied evidence satisfy the task. Historical prose about awaiting validation cannot override those records. Source PASS does not establish a stronger theorem, an unmet hypothesis, or an unrelated completion criterion. Caller import alone is not evidence of external retrieval when the task explicitly requires it. Check quantifiers, variants, parameters, computational model, and bounds. A proved implication does not establish its antecedent. If the task requires an unconditional conclusion, an extra hypothesis must be discharged by a proof within the note, established support, or the task's assumptions. A specific unmet completion criterion is a concrete reason for FAIL, even when the note is mathematically sound partial progress.",
        );

        await reconstruction(
          {
            task: input.task,
            notes,
            targets: pending("reconstruction").map((note) => note.id),
          },
          runtime,
          context,
        )(record);
      });
    },

    async literature(
      input: LiteratureInput,
      runtime: RoleRuntime,
      context: Context,
    ): Promise<SolverResult> {
      if (!literature) throw new Error("Literature is disabled");
      const result = await research.literature(
        { ...input, notes: input.notes.filter((note) => !note.retired) },
        runtime,
        context,
      );
      validateNotes(result.notes, input.notes);
      return { kind: "notes", notes: result.notes, candidate: false };
    },

    review(input: ReviewInput, runtime: RoleRuntime, context: Context) {
      return research.review(input, runtime, context);
    },
  };
  return Object.assign(functions, { extension: native.extension });
}
