import type { Context } from "@earendil-works/chord";
import { Assert } from "typebox/value";
import { type Static, type TSchema } from "@earendil-works/pi-ai";
import type { Execution } from "../types.ts";
import {
  correctnessSchema,
  editingSchema,
  editionReviewSchema,
  batchSchema,
  batchResults,
  explorationSchema,
  noteContentSchema,
  planSchema,
  proofSchema,
  statementSchema,
  verdictSchema,
  verificationStageSchema,
  verificationStages,
  verificationTargets,
  type Check,
  type Editing,
  type EditorInput,
  type EditionReviewInput,
  type EditionReview,
  type Exploration,
  type ExplorerInput,
  type Note,
  type Plan,
  type SolverResult,
  type Task,
  type VerifierInput,
  type ReviewInput,
  type ReconstructionInput,
  type VerificationStage,
} from "./contracts.ts";
import {
  closure,
  corpusStats,
  noteInfo,
  refresh,
  retainedNotes,
  requiredStages,
  sourceEvidence,
  stagePassed,
  stagePending,
  stageWithin,
  validateNotes,
  verdict,
} from "./notes.ts";
import { ask, type PiRuntime, type ProfileName } from "./pi.ts";
import { type Research, type LiteratureInput } from "./research.ts";
import type { Settings } from "./config.ts";
import { fullNote, noteReader } from "./reader.ts";

const mathematicalCheck =
  "Check exact statements and hypotheses. PASS requires an established argument. FAIL requires a concrete defect. Use INCONCLUSIVE when you cannot settle a check. On PASS, you may supply correction with the complete text and consistent summary and detailedSummary, changing only harmless typos, formatting, or unambiguous notation. Preserve mathematical meaning and dependencies; never repair a substantive gap this way. A substantial repair requires a new note. Treat established support results as given, but verify their applicability and all new reasoning. Do not infer mathematical truth from an earlier model's confidence.";
const packet = (notes: VerifierInput["notes"]) =>
  notes.map(({ id, text, support }) => ({ id, text, support }));
export type CoordinationInput = {
  task: Task;
  notes: Note[];
  failures: { id: string; role: string; error: string | null }[];
  guidance: string[];
  literatureUsed: boolean;
  corpus: ReturnType<typeof corpusStats>;
  editingAvailable: boolean;
};
export type RoleOptions = Required<
  Pick<Settings, "maxExplorerResponses" | "maxExplorerReads" | "literature">
> &
  Pick<Settings, "editingThresholdTokens">;

/** Ordinary functions used by both campaigns and standalone role execution. */
export function createRoles(
  runtime: PiRuntime,
  research: Research,
  options: RoleOptions,
) {
  const literature = options.literature && research.retrieval;
  const batch = async <S extends TSchema>(
    profile: ProfileName,
    instructions: string,
    input: { notes: { id: string }[]; [key: string]: unknown },
    schema: S,
    execution: Execution,
    context: Context,
  ): Promise<Static<S>[]> => {
    if (!input.notes.length) return [];
    const ids = input.notes.map((note) => note.id);
    // Keep shared mathematics before stage instructions for provider cache reuse.
    const result = await ask(
      runtime,
      profile,
      "Carry out the mathematical assignment in the top-level instructions field. Return exactly one result for each ID in requestedNoteIds, and no others. Support notes are context, not additional targets.",
      { ...input, requestedNoteIds: ids, instructions },
      batchSchema(schema),
      execution,
      context,
      {
        submit(value) {
          batchResults(ids, value.results);
          return { done: true, receipt: { validated: true } };
        },
      },
    );
    return batchResults(ids, result.results);
  };
  const reconstruct = async (
    input: ReconstructionInput,
    execution: Execution,
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
    const originals = notes.map((note) => ({
      ...packet([note])[0]!,
      premises: verdict(note, "correctness")?.premises ?? [],
    }));
    const extract = notes.filter(
      (note) => !stagePassed(note, "reconstruction"),
    );
    const extracted = await batch(
      "statement",
      "Extract each note's exact mathematical claim for a blind prover. Preserve every hypothesis, quantifier, definition, and conclusion. An explicit hypothetical antecedent belongs in the statement: preserve P implies Q without asserting P or listing P as an external premise. Omit proofs, proof methods, hints, summaries, and verifier opinions. Do not weaken a claim or turn a step needing proof into an assumption. Restate only the supplied source-checked external premises in premises, without application hints. Use [] when there are none. Supporting note results remain declared dependencies, not external premises. The original task supplies proof rules, but these claims may be supporting lemmas rather than solutions of that task.",
      {
        task: input.task,
        support: originals.filter(
          (note) => !extract.some((other) => other.id === note.id),
        ),
        notes: originals.filter((note) =>
          extract.some((other) => other.id === note.id),
        ),
      },
      statementSchema,
      execution,
      context,
    );
    const statements = notes.map((note) => {
      const { statement, premises } =
        verdict(note, "reconstruction")?.verdict === "PASS"
          ? verdict(note, "reconstruction")!
          : extracted[extract.indexOf(note)]!;
      return { id: note.id, statement, premises, support: note.support };
    });
    const selectedIds = new Set(selected.map((note) => note.id));
    const independent = await batch(
      "proof",
      "Independently prove all requested statements together, returning a proof per note. You have not received their original proofs or methods. Use only each note's declared transitive support, its listed external premises, and background permitted by the task. To prove P implies Q, assume its explicit antecedent P and derive Q; this does not establish P. The support statements are trusted imports or previously reconstructed claims and may be assumed without reproving them. Claims in notes must be proved in dependency order. A conditional proof may use a declared supporting claim being proved in this batch, but never a descendant or unrelated claim. Check hypotheses at every application. Set complete=false and state the gap when a note's own proof is incomplete. Supporting lemmas need not solve the original task.",
      {
        task: input.task,
        support: statements.filter((note) => !selectedIds.has(note.id)),
        notes: statements.filter((note) => selectedIds.has(note.id)),
      },
      proofSchema,
      execution,
      context,
    );
    const compared = await batch(
      "reconstruction",
      `${mathematicalCheck} Compare each original claim and proof with its extracted statement and independent proof. Check that extracted statements, definitions, and external premises faithfully match the originals, including every assumption used from support. Preserve explicit conditional claims: proving P implies Q may assume P, but does not by itself establish P or an unconditional Q. PASS requires the exact original claim and a correct independent proof, using only declared transitive support, source-checked external premises, and task-permitted background. Judge support proved in this batch conditionally: code separately requires the whole dependency chain. Reject circular or undeclared use of another batch claim. These notes may be supporting lemmas and need not solve the original task. FAIL requires a concrete defect in the original claim or argument. An extraction mismatch, leaked proof method, or a gap, error, or unapproved premise in the independent proof alone gives INCONCLUSIVE, even if it claims to be complete.`,
      {
        task: input.task,
        support: packet(notes.filter((note) => !selectedIds.has(note.id))),
        notes: packet(selected),
        premises: originals.map(({ id, premises }) => ({
          noteId: id,
          premises,
        })),
        statements,
        independent: selected.map((note, index) => ({
          noteId: note.id,
          result: independent[index]!,
        })),
      },
      verdictSchema,
      execution,
      context,
    );
    return {
      kind: "verification",
      checks: selected.map((note, index) => {
        const proof = independent[index]!;
        const judgment = compared[index]!;
        const { statement, premises } = statements.find(
          (other) => other.id === note.id,
        )!;
        const reconstruction = {
          ...judgment,
          statement,
          premises,
          proof: proof.proof,
          ...(!proof.complete && judgment.verdict === "PASS"
            ? {
                verdict: "INCONCLUSIVE" as const,
                report: `Independent proof was incomplete. ${judgment.report}`,
              }
            : {}),
        };
        return {
          noteId: note.id,
          reconstruction,
          ...(reconstruction.verdict === "PASS" &&
          reconstruction.correction !== undefined &&
          (reconstruction.correction.text !== note.text ||
            reconstruction.correction.summary !== note.summary ||
            reconstruction.correction.detailedSummary !== note.detailedSummary)
            ? {
                correction: {
                  revision: note.revision,
                  ...reconstruction.correction,
                },
              }
            : {}),
        };
      }),
    };
  };
  return {
    reconstruct,
    async editor(
      input: EditorInput,
      execution: Execution,
      context: Context,
    ): Promise<Editing> {
      input = structuredClone(input);
      const available = [
        ...new Map(
          [...input.notes, ...(input.previous ?? [])].map((note) => [
            note.id,
            note,
          ]),
        ).values(),
      ];
      return ask(
        runtime,
        "editor",
        "Build a coherent, self-contained mathematical proof library of ordinary notes for continued research on the exact task. Read every full note, its status, and verification feedback. Consolidate repeated proofs and dependency chains into shared lemmas, reuse suitable established foundations, and remove obsolete scaffolding. Judge the replacement as a whole by its useful knowledge. Every note and dependency chain may be rewritten, including verified notes; there is no preset length or note-count target or obligation to preserve every old claim. Retain important results, relevant alternative approaches, informative counterexamples and failed approaches, limitations, and open gaps. Preserve exact scope, hypotheses, conditionality, and quantitative and computational guarantees. For useful negative results, identify the failed method, obstruction, and scope in summaries and full text. Distinguish failed attempts from proved obstructions so variants outside their scope remain open. An omitted lemma needs no superseding theorem of its own; justify the scope of any claimed subsumption. Established claims need complete arguments and concrete counterexamples using only task-permitted background, explicitly sourced premises, retained notes, or earlier new notes. Keep proofs in notes and substantive editorial choices and omissions in report. Use fresh local IDs n1, n2, ... and include support on every note, using [] when empty. Rewritten notes receive fresh checks and inherit no trust. Existing notes named in support and their dependency closure are included automatically. retained selects additional unchanged notes by exact ID; all retained dependencies count toward corpus size. On repair, address both mathematical feedback and corpus-review findings together. Retain unaffected notes by their exact IDs; rewrite what repairing defects, restoring useful knowledge, or reorganizing necessary dependencies requires. Further shortening is optional. Return one complete proposal. Editing does not declare the research task solved.",
        {
          ...input,
          notes: input.notes.map(fullNote),
          ...(input.previous ? { previous: input.previous.map(fullNote) } : {}),
        },
        editingSchema,
        execution,
        context,
        {
          submit(result) {
            retainedNotes(result, available);
            return { done: true, receipt: { validated: true } };
          },
        },
      );
    },

    async editionReview(
      input: EditionReviewInput,
      execution: Execution,
      context: Context,
    ): Promise<EditionReview> {
      input = structuredClone(input);
      if (!input.notes.length)
        throw new Error(
          "Editing review requires a nonempty replacement corpus",
        );
      refresh(input.notes);
      return ask(
        runtime,
        "requirements",
        "Judge the replacement corpus as a whole: does it carry forward the useful mathematical knowledge needed to continue research on the exact task in a clearer, self-contained form? This check does not ask whether the research task has been solved. Read all old and new notes with their actual statuses and verification feedback. Systematically compare the useful mathematical capabilities of the original and replacement corpora, reporting all material losses and defects together without a per-note ledger or requiring every lemma to survive. Assess useful coverage even when mathematical checks failed or remain unresolved; do not treat those claims as established. Return actionable findings so Editor can repair mathematical defects and coverage together. Your verdict does not activate a replacement or override per-note checks. Assess important results, relevant alternative approaches, informative counterexamples and failed approaches, limitations, and open gaps, preserving their exact scope and quantitative and computational guarantees. For useful negative results, check that summaries and full text identify the failed method, obstruction, and scope, distinguishing failed attempts from proved obstructions. Every note and dependency chain may be rewritten. Allow different proofs, shared lemmas, consolidation, and removal of obsolete intermediate results and unhelpful detail. No one-to-one mapping, derivation of every old lemma, or separate replacement for every omitted claim is required. An omission is a defect when it loses useful research knowledge; explain concretely what is lost and why it matters. Check the scope of claimed subsumption. Claims kept as established knowledge need complete arguments in the replacement notes and their declared support, without reliance on removed proofs or an editorial report. Earlier correctness and source checks do not excuse newly noticed gaps or lost hypotheses. Judge simplification including all retained support. There is no preset length or note-count target. Modest consolidation is acceptable, and optional further shortening is not a reason to reject an adequate replacement. PASS requires useful knowledge preserved, sound retained arguments, and clearer organization or simpler proofs. FAIL requires a consequential loss of useful knowledge, incorrect subsumption, a missing argument, or a hidden dependency. Use INCONCLUSIVE when unsure, with actionable feedback for Editor.",
        {
          // Keep the original corpus before the changing replacement for caching.
          task: input.task,
          previous: input.previous.map(fullNote),
          notes: input.notes.map(fullNote),
        },
        editionReviewSchema,
        execution,
        context,
      );
    },
    async explorer(
      input: ExplorerInput,
      execution: Execution,
      context: Context,
    ): Promise<SolverResult> {
      input = structuredClone(input);
      const index = input.notes.map(noteInfo);
      const accumulated: Exploration["notes"] = [];
      const result = await ask(
        runtime,
        "explorer",
        "Work on the exact mathematical task. You own the mathematical strategy: choose approaches, change direction, and continue useful work. The preceding messages contain the task and the complete index of note IDs and summaries. The final input supplies note states, feedback, guidance, and your read and response allowances. Guidance is fallible. Use read_notes to choose detailed summaries or full arguments from your frozen snapshot, batching independent IDs. Follow support IDs when needed. Reading is disabled when its allowance is exhausted and on your final response; then work from available context and submit. Every response counts, including reads, rejected submissions, and responses without a submission. Do mathematics without external search. Return self-contained notes with an index summary, detailed summary, and authoritative full text, including useful partial results and failed approaches with their gaps stated. Identify pivotal claims and their unproved assumptions in the notes so Coordinator can arrange appropriate checks. Declare as support every note whose result you use without proving it. Merely reading or discussing a note is not a dependency. Dead notes are diagnostic only; never use them as mathematical support. Existing verified support need not be reproved. Use local IDs n1, n2, ... without reusing one. A note may refer to an earlier note in this invocation or an existing note ID. New notes are private until this worker returns. Set candidate=true only when the last new note claims a complete solution of the exact task. Empty notes end this invocation without a solution.",
        {
          notes: index.map(({ summary: _summary, ...state }) => state),
          guidance: input.guidance,
          allowance: {
            reads: options.maxExplorerReads,
            responses: options.maxExplorerResponses,
          },
        },
        explorationSchema,
        execution,
        context,
        {
          maxResponses: options.maxExplorerResponses,
          maxReads: options.maxExplorerReads,
          prefix: [
            { task: input.task },
            ...index.map(({ id, summary }) => ({ id, summary })),
          ],
          tools: [noteReader(input.notes)],
          submit(value) {
            validateNotes([...accumulated, ...value.notes], input.notes);
            if (value.candidate && value.notes.length === 0)
              throw new Error("A solution claim needs a new note");
            accumulated.push(...value.notes);
            const done = value.candidate || value.notes.length === 0;
            return {
              done,
              receipt: {
                privateNotes: value.notes.map((note) => note.id),
                done,
              },
            };
          },
          continuation:
            "Continue mathematical work from your private notes. Address remaining gaps or try a better approach. Submit only new notes; an empty submission hands off.",
        },
      );
      return { kind: "notes", notes: accumulated, candidate: result.candidate };
    },

    async coordinator(
      input: CoordinationInput,
      execution: Execution,
      context: Context,
    ): Promise<Plan> {
      input = structuredClone(input);
      const notes = input.notes;
      const prompt = {
        ...input,
        notes: notes.map(noteInfo),
        editingThresholdTokens: options.editingThresholdTokens ?? null,
        capabilities: {
          literature: literature && !input.literatureUsed,
          sourceRetrieval: research.retrieval,
          editing:
            options.editingThresholdTokens != null &&
            input.editingAvailable &&
            notes.length > 0,
        },
      };
      return ask(
        runtime,
        "coordinator",
        "corpus reports the complete active note count and estimated tokens, including full texts and checks. When editing is available and estimatedTokens reaches editingThresholdTokens, consider an editor request to simplify the entire corpus. This threshold is advice, not a requirement or context guarantee. You may defer editing or request it earlier when useful. An editor request must be the only work item. Editing verifies and reviews a replacement before exploration resumes. " +
          "Schedule work for this mathematical task. You alone create work requests; workers return results. Explorer owns the mathematical strategy. For Explorer, supply only guidance. The library supplies the exact task, every note summary, verification feedback, and a bounded reader. Explorer chooses which notes to read. Continue exploration without prescribing proof steps. Explorer never has external retrieval tools. Follow capabilities: when literature is false, do not request a literature search or delegate external retrieval to Explorer; when sourceRetrieval is false, verification cannot look up sources. Pi mathematical checks remain available. A correctness-only target still requires source checks for its dependencies. If Codex source execution is failing, choose checks whose dependency closure needs no retrieval, or continue independent work. Prioritize checking pivotal claims identified in notes and unverified claims on which further exploration repeatedly relies. Inspect conditional claims and their assumptions before treating them as established support. Do not verify every speculative note or impose a fixed verification quota. Verification runs an ordered prefix: correctness, source, requirements, reconstruction. Use correctness for a mathematical check alone, source to establish support, requirements to check the exact completion criteria, and reconstruction for final acceptance. Dependencies receive correctness and necessary source checks. Final reconstruction also proves every generated claim in the transitive support, in one blinded batch. Imported supporting theorems remain assumptions, with their declared dependencies still checked. Imported notes are trusted for correctness and source when their support is verified. The passed list includes trusted import stages and completed PASS checks. Reuse both. Every committed source verdict is final for its note ID, including INCONCLUSIVE. New evidence requires a new note. Only executions without a committed result may retry source checking. Imported candidates still require requirements and reconstruction. After operational failure, use the reported cause: repeating an unchanged request does not repair a configuration error. Choose a logical retry when there is a reason it can succeed, or continue useful independent work. Explorer may read dead notes for diagnosis, never as mathematical dependencies or verification targets. Avoid requests whose stages and required dependency checks have all passed. A candidate with its own reconstruction PASS may still need reconstruction of unresolved dependencies. Dispatch at most one Explorer, which may run alongside verification or enabled literature. Literature permits at most one completed search; a failed search may be retried when enabled. Availability does not require a search. Request one only for a specific external theorem or source gap relevant to the task, and state that question in query. Task-granted assumptions and self-contained elementary arguments need no survey. Use the supplied summaries and feedback to decide which exact texts affect scheduling. Use read_notes for detailed summaries or full notes, batching independent IDs in one call. Skip reads when the supplied context already supports the decision, then submit your plan. Mathematical notes are the shared memory. Return at least one useful work request. Never declare a solution yourself: code accepts only complete verification evidence.",
        prompt,
        planSchema(prompt.capabilities.literature, prompt.capabilities.editing),
        execution,
        context,
        {
          tools: [noteReader(notes)],
          submit(plan) {
            if (
              plan.work.some(({ kind }) => kind === "editor") &&
              plan.work.length !== 1
            )
              throw new Error("Editing must run alone");
            if (plan.work.filter(({ kind }) => kind === "explorer").length > 1)
              throw new Error("Dispatch at most one Explorer");
            if (
              plan.work.filter(({ kind }) => kind === "literature").length > 1
            )
              throw new Error("Literature already dispatched");
            const find = (id: string) => notes.find((note) => note.id === id);
            const targets = verificationTargets(plan);
            for (const { id } of targets) {
              const note = find(id);
              if (!note || note.dead)
                throw new Error(`Unknown or dead note: ${id}`);
            }
            const useful =
              [...requiredStages(targets, notes)].some(([note, through]) =>
                verificationStages.some(
                  (stage) =>
                    stageWithin(stage, through) && stagePending(note, stage),
                ),
              ) ||
              closure(
                targets
                  .filter((target) => target.through === "reconstruction")
                  .map((target) => target.id),
                notes,
              ).some(
                (note) =>
                  !note.imported && stagePending(note, "reconstruction"),
              );
            if (targets.length && !useful)
              throw new Error("Requested verification has no pending checks");
            return { done: true, receipt: { validated: true } };
          },
        },
      );
    },

    async verifier(
      input: VerifierInput,
      execution: Execution,
      context: Context,
    ): Promise<SolverResult> {
      const notes = structuredClone(input.notes);
      refresh(notes);
      const checks = new Map<Note, Check>();
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
        result: NonNullable<Check[Stage]>,
      ) => {
        let check = checks.get(note);
        if (!check) {
          check = { noteId: note.id };
          checks.set(note, check);
          note.checks.push(check);
        }
        check[stage] = result;
        if (
          result.verdict === "PASS" &&
          result.correction !== undefined &&
          (result.correction.text !== note.text ||
            result.correction.summary !== note.summary ||
            result.correction.detailedSummary !== note.detailedSummary)
        ) {
          Assert(noteContentSchema, result.correction);
          Object.assign(note, result.correction);
          check.correction = { revision: note.revision, ...result.correction };
        }
      };
      const assess = async <S extends TSchema>(
        profile: ProfileName,
        selected: Note[],
        instructions: string,
        schema: S,
      ): Promise<Static<S>[]> => {
        const support = closure(
          selected.flatMap((note) => note.support),
          notes,
        ).filter((note) => !selected.includes(note));
        return batch(
          profile,
          `${mathematicalCheck} Check all requested notes together. The verifiedSupport IDs identify established support notes. Judge each note using only its declared transitive support, not unrelated notes in the batch. ${instructions}`,
          {
            task: input.task,
            support: packet(support),
            notes: packet(selected),
            verifiedSupport: support
              .filter((note) => note.verified)
              .map((note) => note.id),
          },
          schema,
          execution,
          context,
        );
      };
      const correctness = pending("correctness");
      const judgments = await assess(
        "correctness",
        correctness,
        `Judge each note's own claim; supporting lemmas and partial progress need not solve the original task. Only the later requirements check judges the original completion criteria. For an explicit conditional claim P implies Q, check the derivation of Q assuming P. Its hypothetical antecedent P is part of the claim, not an external theorem to establish; omit it from premises. Proving the implication does not establish P. An unstated assumption in an unconditional claim remains a gap: do not silently weaken the claim to an implication or promote a missing proof step to an external theorem. External results actually used to prove an implication still require the normal assessment below. For declared support checked in this batch or not yet verified, judge the dependent reasoning conditionally; code separately requires every dependency to pass before verification or acceptance. Find missing cases, unsupported inferences, and undeclared substantive dependencies. ${research.retrieval ? "A cited theorem note may state an external result without reproving it: assess its statement and application conditionally and list it in premises for source validation. List every directly needed nonroutine external result with exact hypotheses, conclusion, and application, including any invoked without citation." : "This is a closed-book check: source retrieval is disabled. Apply the task's proof rules. When the task permits standard background, check each such result's precise statement, hypotheses, and application from mathematical knowledge and explain that assessment in report. A background result established by this assessment need not be listed in premises. Do not excuse a forbidden black box or an unproved substantive step as background, even if the note calls it standard. A forbidden invocation is a defect. If permission, statement, or applicability is uncertain, retain the claim in premises; source checking will leave it INCONCLUSIVE. List all other unproved external claims with exact hypotheses, conclusion, and application. The steps producing the requested conclusion must satisfy the task's proof requirements."} Results explicitly granted as assumptions or permitted background by the supplied task need no external source check. Check their exact scope and application, and omit them from premises. A note merely claiming that permission is insufficient. Do not relist declared support results; check their applicability. Use [] only when no unresolved external premise remains under these rules. Correctness PASS is conditional on support and listed premises.`,
        correctnessSchema,
      );
      correctness.forEach((note, index) =>
        record(note, "correctness", judgments[index]!),
      );
      refresh(notes);

      const sources = pending("source");
      if (sources.length) {
        const results = batchResults(
          sources.map((note) => note.id),
          await research.source(
            {
              task: input.task,
              notes: sources.map((note) => ({
                id: note.id,
                text: note.text,
                premises: verdict(note, "correctness")!.premises,
              })),
              evidence: sourceEvidence(notes, input.evidence),
            },
            execution,
            context,
          ),
        );
        sources.forEach((note, index) =>
          record(note, "source", results[index]!),
        );
        refresh(notes);
      }
      const requirements = pending("requirements");
      const required = await assess(
        "requirements",
        requirements,
        "Decide whether each note meets every completion criterion of the original task. Check quantifiers, variants, parameters, computational model, and bounds. A proved implication does not establish its antecedent. If the task requires an unconditional conclusion, an extra hypothesis must be discharged by a proof within the note, established support, or the task's assumptions. Sound partial progress fails this check.",
        verdictSchema,
      );
      requirements.forEach((note, index) =>
        record(note, "requirements", required[index]!),
      );

      const reconstructed = await reconstruct(
        {
          task: input.task,
          notes,
          targets: [...ordered].flatMap(([note, through]) =>
            through === "reconstruction" &&
            note.verified &&
            verdict(note, "requirements")?.verdict === "PASS"
              ? [note.id]
              : [],
          ),
        },
        execution,
        context,
      );
      for (const check of reconstructed.checks)
        record(
          notes.find((note) => note.id === check.noteId)!,
          "reconstruction",
          check.reconstruction!,
        );
      return { kind: "verification", checks: [...checks.values()] };
    },

    async literature(
      input: LiteratureInput,
      execution: Execution,
      context: Context,
    ): Promise<SolverResult> {
      if (!literature) throw new Error("Literature is disabled");
      const result = await research.literature(input, execution, context);
      validateNotes(result.notes, input.notes);
      return { kind: "notes", notes: result.notes, candidate: false };
    },

    review(input: ReviewInput, execution: Execution, context: Context) {
      return research.review(input, execution, context);
    },
  };
}
