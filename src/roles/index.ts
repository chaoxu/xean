import type { Context, JsonValue } from "@earendil-works/chord";
import { isDeepStrictEqual } from "node:util";
import { Assert } from "typebox/value";
import {
  batchResults,
  noteContentSchema,
  verificationStageSchema,
  type Check,
  type ExplorerInput,
  type Note,
  type NoteContent,
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
  reconstructionTargets,
  requiredStages,
  sourceEvidence,
  stagePassed,
  stagePending,
  stageWithin,
  validateNotes,
  verdict,
} from "../math/notes.ts";
import { closure } from "../math/argument.ts";
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

const mathematicalCheck = `Judge the authoritative statement and its argument first. The statement must contain the exact claim and necessary definitions, not a proof recipe. A construction that is itself the claimed result is legitimate statement content. Check both summaries against that statement and argument: preserve hypotheses, quantitative guarantees, conditionality, negative conclusions, and unresolved gaps. A summary must not strengthen a claim or present an unresolved result as established. PASS requires an established argument. FAIL requires a concrete defect. Use INCONCLUSIVE when you cannot settle a check. ${correctionInstructions} Treat established support results as given, but verify their applicability against their full statements, including hypotheses absent from summaries, and check all new reasoning. Do not infer mathematical truth from an earlier model's confidence.`;
const packet = (note: Note) => ({
  id: note.id,
  statement: note.statement,
  argument: note.argument,
  summary: note.summary,
  detailedSummary: note.detailedSummary,
  support: note.support,
});
/** Source reports and quotations stay out of later mathematical prompts. */
const sourceRecord = (note: Note) => {
  const premises = verdict(note, "correctness")?.premises ?? [];
  const source = verdict(note, "source");
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

/** Corrections share one policy for standalone reconstruction and verifier batches. */
function recordCheck<Stage extends VerificationStage>(
  note: Note,
  check: Check,
  stage: Stage,
  result: StageResult<Stage>,
): void {
  const recorded = { ...result };
  delete recorded.correction;
  check[stage] = recorded;
  if (result.verdict !== "PASS" || result.correction === undefined) return;
  for (const field of Object.keys(
    noteContentSchema.properties,
  ) as (keyof NoteContent)[]) {
    const value: unknown = result.correction[field];
    if (value == null || value === note[field]) continue;
    Assert(noteContentSchema.properties[field], value);
    note[field] = value;
    (check.correction ??= { revision: note.revision })[field] = value;
  }
}

export type CoordinationInput = {
  task: Task;
  notes: Note[];
  failures: { id: string; role: string; error: string | null }[];
  guidance: string[];
  literatureUsed: boolean;
  /** Any prior work for the current built-in Explorer, including failures. */
  explorerUsed: boolean;
  active?: { id: number; input: JsonValue }[];
};
export type RoleOptions = {
  profiles: Profiles;
  maxExplorerResponses?: number;
  maxExplorerReads?: number;
  chatgpt?: Settings["chatgpt"];
  literature?: boolean;
  research?: CodexOptions | false;
  codex?: CodexOptions & { workspace: string };
  usagePrefix?: string;
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
    const result = await ask(
      profile,
      `${instructions} Return exactly one result per requested noteId, and no others.`,
      input,
      runtime,
      context,
      {
        ids,
      },
    );
    return batchResults<Submission<P>["results"][number]>(
      ids,
      result.at(-1)!.value.results,
    );
  };
  const reconstruct = async (
    input: ReconstructionInput,
    runtime: RoleRuntime,
    context: Context,
  ): Promise<Extract<SolverResult, { kind: "verification" }>> => {
    const chain = closure(input.targets, refresh(structuredClone(input.notes)));
    if (chain.some((note) => !note.verified))
      throw new Error("Reconstruction requires verified notes and support");
    const selected = chain.filter(
      (note) =>
        (!note.imported || input.targets.includes(note.id)) &&
        !stagePassed(note, "reconstruction"),
    );
    if (!selected.length) return { kind: "verification", checks: [] };
    // A previously checked descendant must not become an assumption for its ancestor.
    const notes = closure(
      selected.map((note) => note.id),
      chain,
    );
    const premises = notes.map((note) => ({
      noteId: note.id,
      ...sourceRecord(note),
    }));
    const statements = notes.map((note, index) => ({
      id: note.id,
      statement: note.statement,
      premises: premises[index]!.premises,
      support: note.support,
    }));
    const selectedIds = new Set(selected.map((note) => note.id));
    const independent = await batch(
      "proof",
      "Independently prove all requested statements together, returning a proof per note. Original arguments and summaries are withheld. Use only each note's declared transitive support, its listed external premises, and background permitted by the task. Each supplied external premise is a permitted assumption: use its exact statement and hypotheses without reproving or retrieving its external source. This permission does not establish stronger variants or their applicability. To prove P implies Q, assume its explicit antecedent P and derive Q; this does not establish P. The support statements are trusted imports or previously reconstructed claims and may be assumed without reproving them. Claims in notes must be proved in dependency order. A conditional proof may use a declared supporting claim being proved in this batch, but never a descendant or unrelated claim. Check hypotheses at every application. Set complete=false and state the gap when a note's own proof is incomplete. Supporting lemmas need not solve the original task.",
      {
        task: input.task,
        support: statements.filter((note) => !selectedIds.has(note.id)),
        notes: statements.filter((note) => selectedIds.has(note.id)),
      },
      runtime,
      context,
    );
    const compared = await batch(
      "reconstruction",
      `${mathematicalCheck} Compare each note's authoritative statement and argument with its independent proof. Both provers must establish that statement, including its hypotheses, quantitative guarantees, and permitted assumptions. The supplied premises records bind the exact external claims to source PASS or caller-import trust. Use those approved claims without demanding another proof or source search, but check their exact hypotheses and applications. A stronger theorem, an unmet hypothesis, or an undeclared inference is not approved. Supporting claims must follow declared transitive dependencies, in dependency order, without circular or unrelated assumptions. Code requires the whole generated dependency chain to pass; supporting lemmas need not solve the original task. An explicit conditional P implies Q may assume P, but does not establish P. PASS requires a correct original argument and a correct independent proof of the same claim. FAIL requires a concrete defect in the original statement or argument. An incomplete, incorrect, or unsupported independent proof alone gives INCONCLUSIVE, even if it claims completeness. So do missing approval records or proof recipes leaked through the authored statement or external premises. Distinguish a construction that is itself the claimed result from guidance for finding its proof. Never silently edit an approved premise. Audit the original even when reconstruction is incomplete: identify whether it supplies the missing step. For FAIL or INCONCLUSIVE, begin with the exact blocker. Then report Original argument:, Independent proof:, and Statement and premises:. Explain concrete defects with a quotation, formula, or note ID, distinguishing mathematical errors from missing evidence, input problems, and harmless wording. No defect found does not establish correctness. Record unresolved obligations, not work requests.`,
      {
        task: input.task,
        support: notes.filter((note) => !selectedIds.has(note.id)).map(packet),
        notes: selected.map(packet),
        premises,
        independent: selected.map((note, index) => ({
          noteId: note.id,
          result: independent[index]!,
        })),
      },
      runtime,
      context,
    );
    return {
      kind: "verification",
      checks: selected.map((note, index) => {
        const proof = independent[index]!;
        const judgment = compared[index]!;
        const check: Check = { noteId: note.id };
        recordCheck(note, check, "reconstruction", {
          ...judgment,
          proof: proof.proof,
          ...(!proof.complete && judgment.verdict === "PASS"
            ? {
                verdict: "INCONCLUSIVE" as const,
                report: `Independent proof was incomplete. ${judgment.report}`,
              }
            : {}),
        });
        return check;
      }),
    };
  };
  const functions = {
    capabilities(input: CoordinationInput) {
      return {
        explorer: !singleShot || !input.explorerUsed,
        codex: functions.codex !== unconfiguredCodex,
        literature:
          literature &&
          !input.literatureUsed &&
          !input.active?.some(
            ({ input }) =>
              (input as { request?: { kind?: string } }).request?.kind ===
              "literature",
          ),
        sourceRetrieval: research.retrieval,
      };
    },
    reconstruct,
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
      const instructions = `Work on the exact mathematical task. You own the mathematical strategy: choose approaches, change direction, and continue useful work. The input contains the task, the complete index of note IDs and summaries, note states, feedback, guidance, and your read and response allowances. Guidance is fallible. ${explorerInstructions} Follow support IDs when needed. Every response counts, including reads, rejected submissions, and responses without a submission. Do mathematics without external search. Record mathematical results and failed approaches that help continue work on the exact task. Provide an index summary, detailed summary, exact statement, and argument. The statement is the authoritative claim: include definitions, hypotheses, conclusions, and the answer when determining a value. Put derivations and proof strategy only in argument. State substantial reusable lemmas as separate notes with complete arguments and refer to them through support; keep routine steps together. Reuse established results when the task permits, stating their hypotheses and flagging uncertain claims or sources for checking. Develop background arguments when they help advance the task. Identify unresolved assumptions and pivotal claims so Coordinator can arrange appropriate checks. Declare as support every note whose result you use without proving it. Merely reading or discussing a note is not a dependency. Dead notes are diagnostic only; never use them as mathematical support. Existing verified support need not be reproved. Use local IDs n1, n2, ... without reusing one. A note may refer to an earlier note in this invocation or an existing note ID. New notes are private until this worker returns. Set candidate=true only when the last new note claims a complete solution of the exact task. Empty notes end this invocation without a solution.`;
      const prompt = {
        task: input.task,
        notes: input.notes.map(noteInfo),
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
        validateNotes(result.notes, input.notes);
        if (result.candidate && result.notes.length === 0)
          throw new Error("A solution claim needs a new note");
        return { kind: "notes", ...result };
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
          read: maxReads > 0,
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
        notes: notes.map(noteInfo),
        capabilities: {
          ...capabilities,
          explorer:
            capabilities.explorer &&
            !input.active?.some(
              ({ input }) =>
                (input as { request?: { kind?: string } }).request?.kind ===
                "explorer",
            ),
        },
      };
      return ask(
        "coordinator",
        "Schedule work for this mathematical task. You alone create work requests; workers return results. Explorer owns the mathematical strategy and is the default for mathematical reasoning. For Explorer, supply only guidance. The library supplies the exact task, every note summary, verification feedback, and a bounded reader. Explorer chooses which notes to read. Continue exploration without prescribing proof steps. Use only work kinds offered by the submission tool. Explorer has no external retrieval tools. When sourceRetrieval is false, verification cannot look up external premises. Use Codex rarely, for a concrete implementation needed by the task. Its assignment must state the deliverable, input/domain, expected output, binding constraints, and checks/evidence that complete the assignment, referring to selected notes where appropriate. Codex chooses its implementation and tools. Pi mathematical checks remain available. A correctness-only target still requires source checks for its dependencies. If Codex source execution is failing, choose checks whose dependency closure needs no retrieval, or continue independent work. Prioritize checking pivotal claims and unverified claims repeatedly used by exploration. Inspect conditional claims and their assumptions before treating them as established support. Do not verify every speculative note or impose a fixed verification quota. Batch the available claims you want checked in one plan. Split them across decisions when an earlier result would affect your next selection. Verification runs an ordered prefix: correctness, source, requirements, reconstruction. Use correctness to check a note's mathematics and source to establish it as support. Requirements judges the original task's completion criteria, and reconstruction first requires that judgment to pass. Do not request requirements or reconstruction for a supporting lemma merely to check it more thoroughly. For final acceptance, target the claimed complete solution through reconstruction. The verifier checks dependencies through source and reconstructs every generated claim in the solution's transitive support in one blinded batch, without requiring supporting lemmas to solve the original task. Imported supporting theorems remain assumptions, with their declared dependencies still checked. Imported notes are trusted for correctness and source when their support is verified. The passed list includes trusted import stages and completed PASS checks. Reuse both. Every committed source verdict is final for its note ID, including INCONCLUSIVE. Source FAIL prevents the note and its dependents from becoming verified or accepted. It does not itself refute the original argument, because the extracted premise may be wrong. Corrected premises or new evidence require a new note. Only executions without a committed result may retry source checking. Requirements FAIL is final for its note ID but leaves useful mathematics available as support and for dependency reconstruction. Requirements INCONCLUSIVE may be retried. A substantive improvement requires a new note. Imported candidates still require requirements and reconstruction. After operational failure, use the reported cause: repeating an unchanged request does not repair a configuration error. Choose a logical retry when there is a reason it can succeed, or continue useful independent work. Explorer may read dead notes for diagnosis, never as mathematical dependencies or verification targets. Avoid requests whose stages and required dependency checks have all passed. A candidate with its own reconstruction PASS may still need reconstruction of unresolved dependencies. Dispatch at most one Explorer, which may run alongside verification or enabled literature. Literature permits at most one completed search; a failed search may be retried when enabled. Availability does not require a search. Request one only for a specific external theorem or source gap relevant to the task, and state that question in query. Task-granted assumptions and self-contained elementary arguments need no survey. Use the supplied summaries and feedback to decide which exact texts affect scheduling. Use read_notes for detailed summaries or full notes when the index and feedback do not suffice for a scheduling decision. Batch independent IDs in one read, then submit the plan. Mathematical notes are the shared memory. Return useful work. Return work=[] only when an ongoing worker can produce another decision, or Explorer is unavailable and no available work can advance the task. Otherwise return at least one work request. Never declare a solution yourself: code accepts only complete verification evidence.",
        prompt,
        runtime,
        context,
        {
          read: notes.length > 0,
          ...(source ? { noteSource: source } : { notes }),
          capabilities: prompt.capabilities,
          allowEmptyPlan:
            !capabilities.explorer || (input.active?.length ?? 0) > 0,
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
      const checks = new Map<string, Check>();
      for (const target of input.targets)
        Assert(verificationStageSchema, target.through);
      const ordered = requiredStages(input.targets, notes);
      const pending = (stage: VerificationStage) =>
        [...ordered].flatMap(([note, through]) =>
          stageWithin(stage, through) && stagePending(note, stage)
            ? [note]
            : [],
        );
      const record = <Stage extends VerificationStage>(
        note: Note,
        stage: Stage,
        result: StageResult<Stage>,
      ) => {
        let check = checks.get(note.id);
        if (!check) {
          check = { noteId: note.id };
          checks.set(note.id, check);
          note.checks.push(check);
        }
        recordCheck(note, check, stage, result);
      };
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
          `${stage === "correctness" ? mathematicalCheck : correctionInstructions} Check all requested notes together. The verifiedSupport IDs identify established support notes. Judge each note using only its declared transitive support, not unrelated notes in the batch. ${instructions}`,
          {
            task: input.task,
            support: support.map(packet),
            notes: selected.map(packet),
            verifiedSupport: support
              .filter((note) => note.verified)
              .map((note) => note.id),
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
        selected.forEach((note, index) => record(note, stage, results[index]!));
      };
      try {
        await assess(
          "correctness",
          `Judge each note's own claim; supporting lemmas and partial progress need not solve the original task. Only the later requirements check judges the original completion criteria. For an explicit conditional claim P implies Q, check the derivation of Q assuming P. Its hypothetical antecedent P is part of the claim, not an external theorem to establish; omit it from premises. Proving the implication does not establish P. An unstated assumption in an unconditional claim remains a gap: do not silently weaken the claim to an implication or promote a missing proof step to an external theorem. External results actually used to prove an implication still require the normal assessment below. For declared support checked in this batch or not yet verified, judge the dependent reasoning conditionally; code separately requires every dependency to pass before verification or acceptance. Find missing cases, unsupported inferences, and undeclared substantive dependencies. Apply the task's proof rules. Do not excuse a forbidden black box or an unproved substantive step as background, even if the note calls it standard. A forbidden invocation is a defect. ${research.retrieval ? "Establish routine task-permitted background from mathematical knowledge and explain it in report. Do not externalize a fact proved in the argument or established by your check. List only directly needed nonroutine external claims that remain unproved, with their exact hypotheses and conclusions, including any invoked without citation. A cited theorem note may state such a result conditionally without reproving it. Check each application conditionally and explain it in report." : "This is a closed-book check: source retrieval is disabled. When the task permits standard background, check each such result's precise statement, hypotheses, and application from mathematical knowledge and explain that assessment in report. A background result established by this assessment need not be listed in premises. If permission, statement, or applicability is uncertain, retain the claim in premises; source checking will leave it INCONCLUSIVE. List all other unproved external claims with exact hypotheses and conclusion. Explain their applications in report."} Results explicitly granted as assumptions or permitted background by the supplied task need no external source check. Check their exact scope and application, and omit them from premises. A note merely claiming that permission is insufficient. Do not relist declared support results; check their applicability. Each premise must be a standalone statement preserving every relevant domain, dimension, compactness, regularity, and other hypothesis. Do not generalize beyond the form actually used in the argument. Source names and citations are allowed. Put proof ideas, application hints, and validation commentary in report, never in premises. Source checking will assess these exact strings, and reconstruction will receive them unchanged. Use [] only when no unresolved external premise remains under these rules. Correctness PASS is conditional on support and listed premises.`,
        );
        refresh(notes);

        const sources = pending("source");
        if (sources.length) {
          const sourceInput = {
            task: input.task,
            notes: sources.map((note) => ({
              id: note.id,
              premises: verdict(note, "correctness")!.premises,
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
            results = await runtime.memo(
              "research.source",
              JSON.parse(JSON.stringify(results)) as Source[],
              context,
            );
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

        const reconstructed = await reconstruct(
          {
            task: input.task,
            notes,
            targets: reconstructionTargets(ordered),
          },
          runtime,
          context,
        );
        for (const check of reconstructed.checks) {
          const previous = checks.get(check.noteId);
          checks.set(check.noteId, {
            ...previous,
            ...check,
            ...(previous?.correction && check.correction
              ? { correction: { ...previous.correction, ...check.correction } }
              : {}),
          });
        }
        return { kind: "verification", checks: [...checks.values()] };
      } catch (error) {
        if (error instanceof RoleFailure && checks.size)
          error.result = { kind: "verification", checks: [...checks.values()] };
        throw error;
      }
    },

    async literature(
      input: LiteratureInput,
      runtime: RoleRuntime,
      context: Context,
    ): Promise<SolverResult> {
      if (!literature) throw new Error("Literature is disabled");
      const result = await research.literature(input, runtime, context);
      validateNotes(result.notes, input.notes);
      return { kind: "notes", notes: result.notes, candidate: false };
    },

    review(input: ReviewInput, runtime: RoleRuntime, context: Context) {
      return research.review(input, runtime, context);
    },
  };
  return Object.assign(functions, { extension: native.extension });
}
