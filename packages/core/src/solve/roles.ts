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
  type EditorAuditInput,
  type EditorAuditReviewInput,
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
  editorAuditSchema,
  validateEditorAudit,
  type EditorAudit,
} from "./editor-audit.ts";
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
export const editorContinuation =
  "Revise the submitted replacement as one mathematical reference. First audit the original corpus against the submitted replacement. For every distinct useful capability, compare the input regime, exact hypotheses, quantitative and computational guarantees, implementing construction, scoped obstruction or counterexample, and unresolved status. Preserve each capability, or merge it only when the replacement really carries those details. Similar subject matter does not establish subsumption: a generic conditional theorem does not replace the algorithm that constructs its input, and an unverified or partial result can still be useful research. If the comparison is uncertain, retain the source note or its complete dependency closure. Remove derivations that repeat a proved supporting argument only after its applications remain usable, replacing them with the exact substitution and any additional hypothesis checks. Remove repeated setup and proof narration from summaries. Preserve useful proofs, restricted-input algorithms, stronger parameter bounds, reusable constructions, quantitative guarantees, scoped negative results, and open gaps. Submit one complete replacement, not a patch; all dependencies must resolve within that replacement or the original supplied notes.";
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
  Pick<
    Settings,
    | "maxExplorerResponses"
    | "maxExplorerReads"
    | "maxEditorResponses"
    | "literature"
  >
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
    async editorAudit(
      input: EditorAuditInput,
      execution: Execution,
      context: Context,
    ): Promise<EditorAudit> {
      input = structuredClone(input);
      const instructions = input.previous
        ? "You are revising a preservation audit for a mathematical research corpus. The original notes are authoritative. Return exactly one concise entry for every original note ID, with no grouping, omissions, duplicates, or unknown IDs. The audit is an index of editorial obligations, not a replacement reference: a retain entry preserves the complete source note even when its capability text is brief. The field previous is the prior audit and review contains independent findings. Correct every concrete unsafe disposition, missing capability, status change, or unjustified subsumption identified by review. A merge plans a future organization that preserves the union of source capabilities; it does not require an existing covering theorem. Obsolete or dead requires a concrete reason that the source can be removed, with matching scope where subsumption is claimed. Preserve useful partial, unresolved, and rejected approaches with their exact status and scope. Return only the revised audit."
        : "You are planning a mathematical corpus edit before any rewriting. Read the exact task, proof requirements, and every original note with its support, status, and verification feedback. Return exactly one concise audit entry for each original note ID, never grouping IDs together. For each note, identify the useful capability and the preservation obligation, including exact scope, status, and any important obstruction or gap. The audit is an index of editorial obligations, not a replacement mathematical reference: a retain entry may say to preserve the source intact without reproducing every hypothesis or proof detail. Choose retain when the source should remain unchanged, merge when it can be consolidated later with another note while preserving every source capability, obsolete only when a concrete covering result already subsumes the source with matching hypotheses and guarantees, and dead only for material with no reusable content. Rejected or unverified status does not make useful partial progress disposable. Similar topics do not establish subsumption, and a conditional theorem does not replace an algorithm that constructs its assumptions. If coverage is uncertain, retain the source. The audit is editorial guidance, not a mathematical premise. Return only the audit, with no replacement notes.";
      const value = {
        task: input.task,
        notes: input.notes.map(fullNote),
        ...(input.previous ? { previous: input.previous } : {}),
        ...(input.review ? { review: input.review } : {}),
      };
      return ask(
        runtime,
        "editor",
        instructions,
        value,
        editorAuditSchema,
        execution,
        context,
        {
          submit(result) {
            validateEditorAudit(
              input.notes.map((note) => note.id),
              result,
            );
            return { done: true, receipt: { validated: true } };
          },
        },
      );
    },
    async editorAuditReview(
      input: EditorAuditReviewInput,
      execution: Execution,
      context: Context,
    ): Promise<EditionReview> {
      input = structuredClone(input);
      validateEditorAudit(
        input.notes.map((note) => note.id),
        input.audit,
      );
      return ask(
        runtime,
        "requirements",
        "Review the proposed preservation audit against the complete original mathematical corpus before any rewriting. Check every original note and its one-to-one disposition. The audit is an index of editorial obligations, not a replacement mathematical reference: do not fail a retain entry merely because its concise capability text does not reproduce the source's full proof, since retaining that note preserves its exact details. Verify that useful positive results, restricted-input algorithms, stronger bounds, reusable constructions, scoped counterexamples and obstructions, failed approaches, limitations, and open gaps have safe preservation obligations with the correct status and scope. A merge disposition may plan a future shared proof or organization and does not require an already existing covering theorem; it must still identify the source capabilities that the merged replacement must preserve. Require a concrete covering result and matching scope for obsolete or dead dispositions that discard source material. Similar topics do not establish subsumption. A conditional theorem does not replace construction of its assumptions. Unverified or rejected status does not make useful partial progress disposable; preserve the failure or gap without asserting the claim. Ground every FAIL or INCONCLUSIVE finding in the cited original note IDs and the supplied source text; do not accept an audit assertion that a supplied note or detail is absent without checking the original. PASS approves only the audit coverage plan, not any future proof or the original research task. FAIL must identify original notes and the capability at risk with an actionable correction. Use INCONCLUSIVE when the source evidence is insufficient.",
        {
          task: input.task,
          notes: input.notes.map(fullNote),
          audit: input.audit,
        },
        editionReviewSchema,
        execution,
        context,
      );
    },
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
        input.previous ? "editorRepair" : "editor",
        input.previous
          ? "You are repairing a proposed collection of mathematical research notes. The field previous contains the current proposal with its mathematical verification feedback. The field notes contains the original collection for reference, and review, when present, compares the useful knowledge in the two collections. Repair the current proposal using both sets of findings.\n\nKeep unaffected notes unchanged by their exact IDs, including their proofs and summaries. Rewriting them discards completed verification and requires checking them again. Within a changed note, preserve unaffected passages, formulas, and valid support references verbatim. Make the smallest mathematically sufficient correction, updating summaries and references only where needed. Reuse valid supporting arguments instead of reproducing them. Expand or reorganize a passage only when correctness or missing useful knowledge requires it. Further consolidation and stylistic rewriting are outside this repair pass. Follow the supplied task’s proof rules. Preserve useful methods, scoped negative results, conditional and unresolved status, exact hypotheses, and quantitative and computational guarantees. Every established claim needs a complete argument in the returned collection and its declared support.\n\nDo not retain or depend on a note whose correctness or source status is unresolved. If such a note carries useful negative or diagnostic information, rewrite it as a self-contained note that records the attempted claim, exact scope, evidence, and unresolved status without asserting the claim as established; give that note no unresolved support dependency. Do not merely copy an unresolved claim under a fresh ID.\n\nReturn one complete replacement proposal using the supplied schema. Put only changed or added notes in notes, with fresh local IDs n1, n2, and so on, in dependency order. Put unchanged notes in retained using their exact existing IDs; unchanged notes from previous are available for retention and support. Notes marked dead cannot be retained or used as support. Retained notes keep their dependencies unchanged; using a replacement dependency requires a fresh note ID. Include support on every new note, using [] when empty. Support may name an earlier new note or an existing note by exact ID; referenced existing notes and their dependency closure are retained automatically. A mathematically changed note inherits no checks. Explain the repairs in report. Producing a repaired reference does not establish that the research problem is solved."
          : "You are editing a collection of mathematical research notes using the approved preservation audit. Produce a coherent replacement by consolidating the supplied mathematics. Another mathematician must be able to continue the research using the replacement without consulting removed notes. Read the exact task, all original notes, their statuses and verification feedback, and every audit entry. The audit is a coverage checklist, not a mathematical premise, and its approved dispositions must be realized in the replacement.\n\nPreserve every useful capability named by the audit: input regimes, exact hypotheses, quantitative and computational guarantees, usable constructions and proofs, scoped counterexamples and obstructions, failed approaches, limitations, and open gaps. Keep unresolved or rejected status accurate. A generic theorem does not replace an implementation that constructs its assumptions. If the audit is uncertain, retain the source material. Dead source notes cannot be listed in retained or used as support. If a dead or rejected source contains useful failure information, write a fresh note describing the failed claim, obstruction, and scope without asserting the rejected mathematics.\n\nOrganize the replacement around shared mathematical arguments. When proofs use the same construction or reasoning under different hypotheses, extract the common argument at exactly the generality needed by those uses. Prove it once, including shared implementation and complexity arguments. Derive each application by verifying its hypotheses and proving the steps that differ. Combine a construction and its direct consequences when separate notes would repeat the setup. Use compact mathematical statements and proofs, retaining every distinction that changes a conclusion or computational guarantee. Do not add stronger results or overview notes merely to extend the corpus.\n\nEvery established claim needs a complete argument in the replacement and its declared support, using only task-permitted background or properly sourced premises. Keep summaries concise and explain substantive editorial choices in the report. Count all retained notes and dependencies. Return one complete proposal using the supplied output schema. New or mathematically changed notes use fresh local IDs n1, n2, and so on, in dependency order. Existing notes named in support and their complete dependency closure are included automatically. `retained` names additional unchanged non-dead notes by exact ID. Rewritten notes inherit no verification.\n",
        {
          ...input,
          notes: input.notes.map(fullNote),
          audit: input.audit,
          auditReview: input.auditReview,
          ...(input.previous ? { previous: input.previous.map(fullNote) } : {}),
        },
        editingSchema,
        execution,
        context,
        {
          maxResponses: input.previous ? undefined : options.maxEditorResponses,
          continuation: input.previous ? undefined : editorContinuation,
          submit(result) {
            retainedNotes(result, available);
            return {
              done: Boolean(input.previous) || options.maxEditorResponses === 1,
              receipt: { validated: true },
            };
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
        "Judge the replacement corpus as a whole against the approved preservation audit: does it carry forward the useful mathematical knowledge needed to continue research on the exact task in a clearer, self-contained form? This check does not ask whether the research task has been solved. Read all old and new notes, the audit, and their actual statuses and verification feedback. Systematically compare the useful mathematical capabilities of the original and replacement corpora, reporting all material losses and defects together without requiring every lemma to survive. Assess useful coverage even when mathematical checks failed or remain unresolved; do not treat those claims as established. The audit is a checklist, not a mathematical premise, and approval of it does not excuse a capability it missed. Return actionable findings so Editor can repair mathematical defects and coverage together. Your verdict does not activate a replacement or override per-note checks. Assess important results, restricted-input algorithms, stronger bounds, reusable constructions, informative counterexamples and failed approaches, limitations, and open gaps, preserving their exact scope and quantitative and computational guarantees. For useful negative results, check that summaries and full text identify the failed method, obstruction, and scope, distinguishing failed attempts from proved obstructions. Every note and dependency chain may be rewritten. Allow different proofs, shared lemmas, consolidation, and removal of obsolete intermediate results and unhelpful detail. Treat omitted motivation or routine details as nonblocking when the retained statements and arguments suffice for correct reuse and recovering the explanation requires no substantive new argument. For FAIL, identify the useful capability, substantial obstruction, hypothesis, or guarantee that is no longer available, and explain why the retained corpus does not supply it. Check the scope of claimed subsumption. Claims kept as established knowledge need complete arguments in the replacement and their declared support, without reliance on an editorial report. Earlier PASS checks do not excuse missing arguments or lost hypotheses found during review. Judge simplification including all retained support. There is no preset length or note-count target. PASS requires useful knowledge preserved, sound retained arguments, and clearer organization or simpler proofs. FAIL requires a consequential loss of useful knowledge, incorrect subsumption, a missing argument, or a hidden dependency. Use INCONCLUSIVE when unsure, with actionable feedback for Editor.",
        {
          // Keep the original corpus before the changing replacement for caching.
          task: input.task,
          previous: input.previous.map(fullNote),
          notes: input.notes.map(fullNote),
          audit: input.audit,
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
            ...(profile === "correctness"
              ? {
                  summaries: selected.map(
                    ({ id, summary, detailedSummary }) => ({
                      id,
                      summary,
                      detailedSummary,
                    }),
                  ),
                }
              : {}),
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
        "The summaries field supplies both summaries by note ID. Check their hypotheses, conditionality, guarantees, and claimed proof methods against the authoritative full text. PASS requires both summaries to be faithful. Correct harmless summary inaccuracies through correction before passing; judge substantive inconsistencies under the ordinary FAIL or INCONCLUSIVE rules. Summaries cannot supply missing arguments. " +
          `Judge each note's own claim; supporting lemmas and partial progress need not solve the original task. Only the later requirements check judges the original completion criteria. For an explicit conditional claim P implies Q, check the derivation of Q assuming P. Its hypothetical antecedent P is part of the claim, not an external theorem to establish; omit it from premises. Proving the implication does not establish P. An unstated assumption in an unconditional claim remains a gap: do not silently weaken the claim to an implication or promote a missing proof step to an external theorem. External results actually used to prove an implication still require the normal assessment below. For declared support checked in this batch or not yet verified, judge the dependent reasoning conditionally; code separately requires every dependency to pass before verification or acceptance. Find missing cases, unsupported inferences, and undeclared substantive dependencies. Check routine mathematical steps directly under the task's proof rules. A named fact does not require source verification merely because it has a name. Verify its exact statement, hypotheses, and application; where needed, give a concise mathematical justification in report. This may explain a routine inference already used in the note, but must not supply a missing substantive argument. Familiarity or a claim that something is standard is insufficient. Forbidden black boxes are defects. Keep uncertain or nonroutine external claims in premises with their exact hypotheses, conclusion, and application, including any invoked without citation. ${research.retrieval ? "An unresolved external theorem may be stated without reproducing its proof: assess its statement and application conditionally and retain it in premises for source validation." : "This is a closed-book check: source retrieval is disabled. When the task permits standard background, check it under the rules above. If permission, statement, or applicability is uncertain, retain the claim in premises; source checking will leave it INCONCLUSIVE."} Results explicitly granted as assumptions or permitted background by the supplied task need no external source check. Check their exact scope and application, and omit them from premises. A note merely claiming that permission is insufficient. Do not relist declared support results; check their applicability. Use [] only when no unresolved external premise remains under these rules. Correctness PASS is conditional on support and listed premises.`,
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
