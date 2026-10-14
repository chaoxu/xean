import { selectBatch } from "./batch.ts";
import type { Context } from "@earendil-works/chord";
import type { Profiles } from "./config.ts";
import { isDeepStrictEqual } from "node:util";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { Assert } from "typebox/value";
import {
  batchResults,
  explorationSchema,
  noteResultSchema,
  implementationPlan,
  planSchema,
  type ImplementationInput,
  type Exploration,
  literatureResultSchema,
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
  type ReconstructionInput,
  type Verdict,
  type VerificationStage,
  type VerificationBackend,
  verificationBackendSchema,
} from "../core/math/contracts.ts";
import {
  correctionInstructions,
  noteInfo,
  refresh,
  pendingChecks,
  sourceEvidence,
  stagePending,
  statementPrepared,
  validateNotes,
  validateResult,
} from "../core/math/notes.ts";
import { closure, keepsPrior } from "../core/math/argument.ts";
import { conversations, type Submission } from "./conversation.ts";
import {
  explorerResponseLimit,
  defaultMaxExplorerReads,
  submissionSchemas,
  type ProfileName,
  type Settings,
} from "./config.ts";
import { externalEvidence, type ExternalRoles } from "./backend.ts";
import {
  RoleFailure,
  type NoteReference,
  type RoleRuntime,
} from "../core/roles.ts";
import { closedBookResearch } from "./research.ts";
import type { Research, LiteratureInput } from "./backend.ts";
import {
  publicationResult,
  type PublishedResult,
  type ExplorerLimit,
} from "../core/math/results.ts";
import { noteIdPrefix, readView, seedNotebook } from "../core/math/state.ts";

const mathematicalCheck = `Judge the authoritative full text first. Check both summaries against it: preserve hypotheses, quantitative guarantees, conditionality, negative conclusions, and unresolved gaps. A summary must not strengthen a claim or present an unresolved result as established. For notes without external trust, PASS requires the original argument to establish the full claimed statement under declared transitive support, listed external premises, and task-permitted assumptions. A substantive argument supplied only in a report or independent proof cannot repair that note. If missing justification is the only blocker, return INCONCLUSIVE even if you can prove the result. Do not omit conclusions to obtain PASS. FAIL requires a concrete defect. Use INCONCLUSIVE when you cannot settle a check. ${correctionInstructions} External trust grants the mathematical claims stated in the supplied note at their exact scope. When an externally trusted support has no checked statement, use its authoritative full text. Treat established support results as given, but verify their applicability against their exact statements, including hypotheses absent from summaries, and check all new reasoning. Do not infer mathematical truth from an earlier model's confidence.`;
const externalStatementInstructions =
  "For notes with external trust, the caller grants the mathematical result. Identify each externally trusted note's exact mathematical result for blind reconstruction, preserving its definitions, hypotheses, quantifiers, conclusions, and conditionality. Check extraction fidelity, not the truth already granted by the caller. Exclude proof recipes, methods, and intermediate proof steps. A construction that is itself the claimed result is legitimate statement content. Return PASS only for a faithful standalone statement; return statement=null and INCONCLUSIVE when no mathematical result is asserted. Do not invent a claim, rewrite the note, or give corrections. Return premises=[]; caller trust supplies the externally trusted result, not additional assumptions for proving that same result.";
const packet = (note: Note) => ({
  id: note.id,
  external: note.checks.external,
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
    source: note.checks.external
      ? { kind: "external-trust", ...note.checks.external }
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
    if (
      stage === "correctness" &&
      note.checks.external &&
      "premises" in recorded
    ) {
      if (
        recorded.premises.length ||
        (result.correction &&
          Object.values(result.correction).some((value) => value !== null))
      )
        throw new Error(
          "External statement preparation cannot add premises or corrections",
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
  capabilities?: Parameters<typeof planSchema>[0];
  failures: { id: string; role: string; error: string | null }[];
  limits?: { id: string; reason: ExplorerLimit }[];
  guidance: string[];
  literatureUsed: boolean;
  recent?: {
    id: string;
    role: string;
    completed: boolean;
    failed: boolean;
    error: string | null;
    request?: unknown;
  }[];
};
export type RoleOptions = Omit<Settings, "profiles"> & { profiles: Profiles };

export function createRoles(options: RoleOptions) {
  const maxExplorerResponses = explorerResponseLimit(options);
  const maxExplorerReads = options.maxExplorerReads ?? defaultMaxExplorerReads;
  const native = conversations(options.profiles);
  const { ask } = native;
  const research = () => functions.external.research ?? closedBookResearch;
  const literature = () =>
    (options.literature ?? false) && research().retrieval;
  const nextBatch = async <
    P extends Exclude<ProfileName, "explorer" | "coordinator">,
  >(
    profile: P,
    instructions: string,
    pending: Note[],
    inputFor: (group: Note[]) => {
      notes: { id: string }[];
      [key: string]: unknown;
    },
    runtime: RoleRuntime,
    context: Context,
    backend: VerificationBackend,
    writtenTokens = (note: Note) => estimateTextTokens(note.text),
  ) => {
    const ref = options.profiles[profile].model;
    const model =
      backend === "native"
        ? runtime.models.getModel(ref.provider, ref.modelId)!
        : undefined;
    // External backends own their model capacity; Pi profiles may name another model.
    const group =
      backend === "native"
        ? selectBatch(
            pending,
            model!,
            (selected) => [
              instructions,
              inputFor(selected),
              submissionSchemas[profile],
              selected.map((note) => note.id),
            ],
            writtenTokens,
          )
        : profile === "proof" || profile === "reconstruction"
          ? pending.slice(0, 1)
          : pending;
    const input = inputFor(group);
    const ids = group.map((note) => note.id);
    const system = `Return exactly one result for every requested ID in notes, never additional results for support. ${instructions}`;
    let results: Submission<P>["results"];
    if (backend === "external") {
      const answer = await functions.external.verifier!(
        "worker",
        submissionSchemas[profile],
        `${system}\nPerform the mathematical check or independent proof required by this assignment, using its stated criteria and output schema. Review the checker against the exact mathematical claim, cover every required case, and use exact arithmetic or certified error bounds where needed. A successful exit or another agent's claim that a checker passed is insufficient. Identify the execution evidence and explain why the checks establish the claim in your result. Supply missing verification, not a missing proof step: substantive repairs belong in the authoritative note. ${profile === "proof" ? "This is blind reconstruction. Use only the supplied task, exact statements, approved premises, and declared support. Do not inspect original proofs, campaign transcripts, or other workspaces. Keep your own programs and results in this fresh workspace; installed tools and libraries may be used." : "Read relevant supplied artifacts as evidence and assess their correspondence to the frozen argument. Preserve original artifacts and do your checking in this fresh workspace. Address the unresolved checks identified in any prior assessment."}`,
        input,
        runtime,
        context,
      );
      Assert(submissionSchemas[profile], answer.value);
      results = answer.value.results;
      for (const result of results) {
        if ("report" in result) result.report += externalEvidence(answer);
        else if ("proof" in result) result.proof += externalEvidence(answer);
      }
    } else {
      const result = await ask(
        profile,
        system,
        {
          ...input,
          capacity: {
            contextTokens: model!.contextWindow,
            outputTokens: model!.maxTokens,
          },
        },
        runtime,
        context,
        {
          ids,
        },
      );
      results = result.submissions.at(-1)!.results;
    }
    return {
      group,
      results: batchResults<Submission<P>["results"][number]>(ids, results),
    };
  };
  const reconstruction = (
    input: ReconstructionInput,
    runtime: RoleRuntime,
    context: Context,
  ) => {
    const backend = input.backend ?? "native";
    Assert(verificationBackendSchema, backend);
    if (backend === "external" && !functions.external.verifier)
      throw new Error("External verification is disabled");
    const notes = closure(input.targets, refresh(input.notes));
    if (notes.some((note) => !note.verified || !statementPrepared(note)))
      throw new Error(
        "Reconstruction requires verified notes and support with checked statements",
      );
    let pending = notes.filter((note) =>
      stagePending(note, "reconstruction", backend),
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
      const instructions =
        "Independently prove every requested statement, returning one complete proof per note. Declared support outside the assigned group may be assumed at its exact stated scope without reproving it. Check applicability and submit results for every assigned note. Write complete arguments, not abbreviated sketches. Original arguments, methods, summaries, and comparison reports are withheld. Use only each note's declared transitive support, its listed external premises, and background permitted by the task. Approved external premises may be assumed at exactly their stated scope; check their hypotheses and applications. Previously attempted support may be assumed conditionally, but final acceptance still requires reconstruction throughout the dependency chain. Never use a descendant or unrelated claim. Prove every new step, including composition and theorem applicability. To prove P implies Q, assume P and derive Q; this does not establish P. Set complete=false and state the unresolved gap when you cannot complete a proof. Supporting lemmas need not solve the original task.";
      const comparisonInstructions = `${mathematicalCheck} First check that the extracted statement faithfully represents the result asserted in the full text, preserving scope without leaking proof instructions. Also check externally trusted support statements against their supplied full text. A bad extraction gives INCONCLUSIVE and is not a defect in the original mathematics. For notes without external trust, compare the original argument in the full text with the independent proof. Both arguments must establish that statement, including its hypotheses, quantitative guarantees, and permitted assumptions. The supplied premises records bind the exact external claims to source PASS or external trust. Use those approved claims without demanding another proof or source search, but check their exact hypotheses and applications. A stronger theorem, an unmet hypothesis, or an undeclared inference is not approved. Supporting claims must follow declared transitive dependencies, in dependency order, without circular or unrelated assumptions. Code requires the whole dependency chain to pass; supporting lemmas need not solve the original task. An explicit conditional P implies Q may assume P, but does not establish P. For notes without external trust, PASS requires a correct original argument and a correct independent proof of the same claim. For an externally trusted target, caller trust grants the original result and sources; no original proof is required. PASS requires faithful statement extraction and a complete correct independent proof of that exact claim. External trust does not replace reconstruction. FAIL requires a concrete defect in the original statement or argument. An incomplete, incorrect, or unsupported independent proof alone gives INCONCLUSIVE, even if it claims completeness. So do missing approval records or proof recipes leaked through the extracted statement or external premises. Distinguish a construction that is itself the claimed result from guidance for finding its proof. Never silently edit an approved premise. For notes without external trust, audit the original even when reconstruction is incomplete: identify whether it supplies the missing step. For FAIL or INCONCLUSIVE, begin with the exact blocker. Then report Original argument:, Independent proof:, and Statement and premises:. Explain concrete defects with a quotation, formula, or note ID, distinguishing mathematical errors from missing evidence, input problems, and harmless wording. No defect found does not establish correctness. Record unresolved obligations, not work requests.`;
      while (pending.length) {
        const proofInput = (group: Note[]) => ({
          task: input.task,
          notes: group.map(statement),
          support: supportFor(group).map(statement),
        });
        const { group, results: proofs } = await nextBatch(
          "proof",
          instructions,
          pending,
          proofInput,
          runtime,
          context,
          backend,
          (note) =>
            3 *
            Math.max(
              estimateTextTokens(note.text),
              estimateTextTokens(JSON.stringify(statement(note))),
            ),
        );
        let remaining = group;
        while ((remaining = unblocked(remaining)).length) {
          const comparisonInput = (selected: Note[]) => {
            const support = supportFor(selected);
            return {
              task: input.task,
              support: support.map((note) =>
                note.checks.external ? packet(note) : statement(note),
              ),
              notes: selected.map(packet),
              previous: selected.flatMap((note) =>
                note.checks.reconstruction
                  ? [{ noteId: note.id, ...note.checks.reconstruction }]
                  : [],
              ),
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
          const { group: selected, results: judgments } = await nextBatch(
            "reconstruction",
            comparisonInstructions,
            remaining,
            comparisonInput,
            runtime,
            context,
            backend,
            (note) =>
              estimateTextTokens(note.text) +
              estimateTextTokens(proofs[group.indexOf(note)]!.proof),
          );
          for (const [index, judgment] of judgments.entries()) {
            const note = selected[index]!;
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
          remaining = remaining.slice(selected.length);
        }
        pending = unblocked(pending.slice(group.length));
        if (
          supportFor(pending).some(
            (note) =>
              group.includes(note) &&
              note.checks.reconstruction?.verdict === "INCONCLUSIVE",
          )
        )
          break;
      }
    };
  };
  const functions = {
    external: {} as ExternalRoles,
    capabilities(input: CoordinationInput) {
      return {
        implementation:
          !!functions.external.implementation ||
          functions.implementation !== implementation,
        externalVerifier: !!functions.external.verifier,
        literature: literature() && !input.literatureUsed,
        sourceRetrieval: research().retrieval,
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
    async implementation(
      input: ImplementationInput,
      runtime: RoleRuntime,
      context: Context,
    ): Promise<SolverResult> {
      Assert(implementationPlan.properties.assignment, input.assignment);
      context.abortSignal?.throwIfAborted();
      if (!functions.external.implementation)
        throw new Error("Implementation backend is disabled");
      const prefix = noteIdPrefix(runtime.taskId);
      const schema = noteResultSchema(explorationSchema, prefix);
      const answer = await functions.external.implementation(
        "worker",
        schema,
        "Complete the concrete implementation assignment: produce its deliverable for the specified input/domain, expected output, binding constraints, and checks/evidence. Selected notes may define these requirements. The task's completion criteria provide mathematical context; completing the implementation assignment need not solve the whole task. Choose your own implementation and tools. Return useful findings or failed approaches as ordinary notes. Give each new note a permanent ID starting with the supplied noteIdPrefix followed by a fresh short name. Use that exact full ID in text, support, and edits; IDs are never rewritten. Each note has summary, detailedSummary, full text, and support. Put derivations, artifact filenames, and rerun commands in text, never support. Include the claims, relevant program/output evidence, reasoning, and limitations needed to check the note without opening artifact files. Distinguish observations, exhaustive finite results, and mathematical proofs. Declare as support every supplied or newly created note whose result you use without proving it, using its exact full ID. Dead notes are diagnostic only. These are unverified drafts. Set candidate=true on a note only when that note claims a complete solution of the exact task. Return notes=[] only when there is no new information worth retaining.",
        { ...input, noteIdPrefix: prefix },
        runtime,
        context,
      );
      Assert(schema, answer.value);
      for (const note of answer.value.notes)
        note.text += externalEvidence(answer);
      return validateResult(
        { kind: "notes", ...answer.value },
        input.notes,
        false,
        prefix,
      );
    },
    async explorer(
      input: ExplorerInput,
      runtime: RoleRuntime,
      context: Context,
      source?: NoteReference,
    ): Promise<PublishedResult | SolverResult> {
      const singleShot = !!functions.external.explorer;
      const maxResponses = singleShot ? 1 : maxExplorerResponses;
      input = structuredClone(input);
      const root = source?.root ?? runtime.conversationId;
      if (!singleShot && !source) {
        await runtime.commit(async (tx) => {
          await seedNotebook(tx, root, input.notes);
        }, context);
        // Pi transactions forbid table reads after appendEntry; materialize the
        // seeded evidence through readView only after that commit is durable.
        await runtime.commit(async (tx) => {
          input.notes = (await readView(tx, root, { inputs: false })).notes;
        }, context);
      }
      const maxReads = singleShot ? 0 : maxExplorerReads;
      const explorerInstructions = singleShot
        ? "All note summaries are supplied in the initial context. Do not read notes or request continuation; submit the complete useful result in this one response."
        : maxReads === 0
          ? "Reading is disabled. Work from the supplied context and your published submissions."
          : "Use read_notes to choose detailed summaries or full arguments from the current notebook, including your own submissions, batching independent IDs. Reading is disabled when its allowance is exhausted and on your final response; then work from available context and submit.";
      const editingInstructions = singleShot
        ? "Create new notes only. Existing full texts are not supplied, so do not edit existing notes. Omit edits or return an empty edits array. Record proposed repairs as new findings with their limitations; they do not change existing notes."
        : "Repair existing notes with edits, keeping their stable IDs. Read a published note's full text before changing it. Each edit supplies only changed fields and the current revision returned by submission or read_notes. Every changed mathematical field reopens its checks; candidate and retirement flags only advance the revision. Each successful submission publishes its notes and edits immediately and returns their IDs and revisions. The invalidated list reports dependent notes whose checks were cleared. Use its revisions when readRequired=false; otherwise reread the note before using or editing it. Continue thinking and submitting useful work in this conversation. Earlier submissions remain published if the invocation later fails or is cancelled. When repairing a proof or dependency gap, first look for an existing note supplying the missing result, then repair the consuming argument and its support declarations. A new lemma alone does not repair a consumer that still lacks the dependency. Unchanged consumers need no copied replacement notes. Retired notes remain readable for diagnosis; retiring a note does not redirect its consumers. Changing an externally trusted note revokes its caller grant. The edited argument must pass generated-note checks. Do not copy an unchanged failed argument under a new ID or submit no-op edits as progress. read_notes supplies its checked statement when available. Use that statement as the granted result. If you need an additional fact from its proof, prove the fact in your note or establish it as a separate lemma and declare it as support. To mark an existing note as a candidate, set candidate=true in its edit.";
      const instructions = `Work on the exact mathematical task. You own the mathematical strategy: choose approaches, change direction, and continue useful work. The input contains the task, the complete index of note IDs and summaries, note states, feedback, your assignment, and your read and response allowances. The assignment is fallible. ${explorerInstructions} Follow support IDs when needed. Every completed response counts, including reads, rejected submissions, and responses without a submission. Provider message and output-token limits continue automatically without consuming this allowance. Do mathematics without external search. Record mathematical results and failed approaches that help continue work on the exact task. Provide an index summary, detailed summary, and complete free-form text. Notes may contain proved results, conjectures, observations, questions, failed approaches, or unresolved gaps. Distinguish them explicitly; never present an unproved claim as established. State substantial reusable lemmas as separate notes with complete arguments and refer to them through support; keep routine steps together. Reuse established results when the task permits, stating their hypotheses and flagging uncertain claims or sources for checking. Develop background arguments when they help advance the task. Identify unresolved assumptions and pivotal claims so Coordinator can arrange appropriate checks. Declare as support every note whose result you use without proving it, including factual claims in scope remarks or comparisons. Reading, mentioning, or questioning a note without relying on its result is not a dependency. Dead notes are diagnostic only; never use them as mathematical support. Existing verified support need not be reproved. ${editingInstructions} Give each new note a permanent ID starting with the supplied noteIdPrefix followed by a fresh short name. Keep names unique within this invocation. Use that exact full ID in prose, support, reads, and edits, including references between new notes in one submission. IDs are never rewritten. Repair an existing note through edits with its existing ID and current revision. Set candidate=true on a new note only when that note claims a complete solution of the exact task. An empty notes-and-edits submission hands off.`;
      const prompt = {
        task: input.task,
        noteIdPrefix: noteIdPrefix(runtime.taskId),
        notes: input.notes.filter((note) => !note.retired).map(noteInfo),
        assignment: input.assignment,
        allowance: { reads: maxReads, responses: maxResponses },
      };
      if (functions.external.explorer) {
        const schema = noteResultSchema(explorationSchema, prompt.noteIdPrefix);
        const { value: result } = await functions.external.explorer(
          "worker",
          schema,
          instructions,
          prompt,
          runtime,
          context,
        );
        Assert(schema, result);
        if (result.edits?.length)
          throw new Error(
            "External Explorer cannot edit notes without their full text",
          );
        return validateResult(
          { kind: "notes", ...result },
          input.notes,
          false,
          prompt.noteIdPrefix,
        );
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
          notebook: {
            root,
            worker: runtime.taskId,
            observed: Object.fromEntries(
              input.notes.map((note) => [note.id, note.revision]),
            ),
          },
        },
      );
      return publicationResult(
        result.submissions as Exploration[],
        result.limit,
      );
    },

    async coordinator(
      input: CoordinationInput,
      runtime: RoleRuntime,
      context: Context,
      source?: NoteReference,
    ): Promise<Plan> {
      input = structuredClone(input);
      const { notes, task, ...state } = input;
      const capabilities = input.capabilities ?? functions.capabilities(input);
      const prompt = {
        ...state,
        task,
        notes: notes.filter((note) => !note.retired).map(noteInfo),
        capabilities,
      };
      return ask(
        "coordinator",
        `Choose the next useful worker for this mathematical task. The outer loop is Coordinator, one worker, Coordinator. You run after the prior worker commits its complete result or failure. You choose mathematical strategy from the supplied index, feedback, and recent outcomes. For Explorer, state the mathematical objective and relevant note IDs. ${functions.external.explorer ? "The external Explorer receives the note index but has no note reader. Read relevant notes and include the authoritative passages needed for its assignment, preserving IDs and exact hypotheses." : "Explorer receives the note index, verification feedback, and a note reader. Reference IDs instead of restating claims or copying historical proofs. Explorer chooses which notes to read and how to develop or edit their arguments."} If an existing claim must appear in the assignment, use its checked statement when available, otherwise its authoritative text, with its note ID and verification status. Preserve hypotheses and scope, and label proposed extensions as unproved. In each assignment, state the remaining obstacle to the exact task, what the work could establish, and how its outcome would affect the next step. Use the latest results to justify continuing or changing approach. Before extending a special case, explain what the extension could teach us about that obstacle, including any missing reduction to the full task. Use only offered work kinds. If externalVerifier is available, select backend=external on a verifier request when access to code, artifacts, or computation is likely to complete the mathematical checks. When the deliverable is a verdict on existing notes, use this Verifier backend, which judges PASS, FAIL, or INCONCLUSIVE directly under the same rules. The ordinary kind=implementation worker returns unverified notes and cannot publish verification checks. You may select the external Verifier initially or to settle an INCONCLUSIVE check without changing the argument. Choose it for a specific useful check, not automatically after every uncertainty. Explorer has no external retrieval tools. Use implementation for a concrete implementation deliverable with its domain, constraints, and evidence of completion. Literature is available for at most one completed search and only when enabled. When sourceRetrieval is false, verification cannot retrieve external evidence.

Verification runs correctness, source, requirements, then reconstruction. Correctness judges each note's exact mathematics conditionally on its declared support and listed premises. Source checks those exact external premises. All declared dependencies must pass before a note is verified. Requirements judges the original task's full completion criteria. A supporting lemma need not solve the task. For final acceptance, target the complete-solution candidate through reconstruction; code also requires reconstruction throughout its dependency chain. Externally trusted results retain only the caller's exact grant, with declared dependencies checked, and an externally trusted candidate still requires requirements and reconstruction. Reuse applicable PASS checks. A missing proof, changed statement, or changed dependency is repaired in the authoritative note, not by adding an argument to a check report. Verifier may clarify summaries but cannot edit proof text or dependencies. Source approval does not grant a stronger claim or different premises. A source or requirements failure does not by itself refute the mathematical argument. Never declare acceptance yourself.

Stable note IDs are editable. Ask Explorer to repair the affected argument and any consuming dependency declarations, reusing existing lemmas when appropriate. The checked statement is a correctness result, not an Explorer-editable field. If it misstates a note, ask Explorer to clarify the intended mathematical claim in the authoritative text using a mathematical edit, then send the revised note through correctness again. Do not request direct edits to the checked statement. Do not require copied consumer chains or new IDs merely to repair an existing note. Retirement affects discovery, not mathematical truth or dependency redirects. Dead and retired notes can be read for diagnosis. Mathematical edits invalidate affected evidence; unchanged summaries and repeated assessments do not establish new mathematics. Use the actual unresolved stage in feedback, not just the requested final stage. Recent outcomes report completed work and operational failures. Submitted edit counts do not establish that the mathematics changed; inspect the current note feedback before requesting another check.

You may select the external Verifier to reassess INCONCLUSIVE correctness, requirements, or reconstruction whenever a specific computational check could resolve the uncertainty. Decide whether another attempt is useful from the prior reports and available evidence. Xean does not automatically retry these checks. Source checks still require relevant new source evidence. A missing proof or supporting statement requires an authoritative note or dependency repair by Explorer. Preserve diagnostic distinctions between a concrete defect and incomplete checking. Use the observed failure and retained execution evidence when deciding whether another attempt is useful. A failed final response does not establish that no commands ran or no artifacts were produced. Native provider failures may recover through Pi retries. External CLI calls report their own terminal failures. Both verifier backends use the same source-retrieval backend, so switching verifier backend does not bypass a source-checking outage. After repeated capacity or transport failures, prefer useful work independent of that backend, or idle if none is available. A later retry needs a reason to expect recovery. Persistent blockers need a relevant change: changing URL paths on the same host does not repair failed DNS, and repeating a solver request does not supply missing software. Identify what could make another attempt succeed, or select useful work that avoids the blocker.

Prioritize pivotal claims and useful dependencies rather than checking every speculative note. Before returning work=null, assess the latest substantive results and remaining useful work: verification of new claims worth retaining, repairs identified by checks, and focused exploration or computation. Finishing a worker's local objective does not exhaust the campaign. If a concrete admissible step is reasonably likely to advance the exact task or establish useful progress toward it, select it. Return work=null only when no such step is currently available, and briefly explain why in your response before submitting. Unchecked speculative or irrelevant notes alone do not require further work. Use read_notes for detailed summaries or full arguments when this assessment requires them, batching independent IDs. An idle decision does not claim a solution.`,
        prompt,
        runtime,
        context,
        {
          maxReads: notes.length > 0 ? defaultMaxExplorerReads : 0,
          ...(source ? { noteSource: source } : { notes }),
          capabilities: prompt.capabilities,
        },
      ).then((result) => result.submissions.at(-1)!);
    },

    async verifier(
      input: VerifierInput,
      runtime: RoleRuntime,
      context: Context,
    ): Promise<SolverResult> {
      const notes = structuredClone(input.notes);
      refresh(notes);
      Assert(verificationStageSchema, input.through);
      const backend = input.backend ?? "native";
      Assert(verificationBackendSchema, backend);
      if (backend === "external" && !functions.external.verifier)
        throw new Error("External verification is disabled");
      const pending = pendingChecks(
        input.targets,
        input.through,
        notes,
        backend,
      );
      return collectChecks(context, async (record) => {
        const assess = async (
          stage: "correctness" | "requirements",
          instructions: string,
          remaining = pending(stage),
        ) => {
          instructions = `Check all requested notes together. Judge each note using only its declared transitive support, not unrelated notes in the batch. ${instructions}`;
          const inputFor = (selected: Note[]) => {
            const support = closure(
              selected.flatMap((note) => note.support),
              notes,
            ).filter((note) => !selected.includes(note));
            return {
              task: input.task,
              support: support.map((note) =>
                stage === "requirements"
                  ? {
                      id: note.id,
                      external: note.checks.external,
                      statement: note.checks.correctness?.statement,
                      support: note.support,
                    }
                  : packet(note),
              ),
              notes: selected.map(packet),
              previous: selected.flatMap((note) =>
                note.checks[stage]
                  ? [{ noteId: note.id, ...note.checks[stage] }]
                  : [],
              ),
              ...(stage === "requirements"
                ? {
                    sources: [...support, ...selected].map((note) => ({
                      noteId: note.id,
                      ...sourceRecord(note),
                    })),
                  }
                : {}),
            };
          };
          while (remaining.length) {
            const { group, results } = await nextBatch(
              stage,
              instructions,
              remaining,
              inputFor,
              runtime,
              context,
              backend,
            );
            group.forEach((note, index) =>
              record(note, stage, results[index]!),
            );
            refresh(notes);
            remaining = remaining
              .slice(group.length)
              .filter((note) => !note.dead);
          }
        };
        await assess(
          "correctness",
          externalStatementInstructions,
          pending("correctness").filter((note) => note.checks.external),
        );
        refresh(notes);
        await assess(
          "correctness",
          `${mathematicalCheck} All requested notes are generated; their results are not caller-granted. For each target: identify the mathematical result expressly claimed by each note and return its exact statement, including definitions, hypotheses, quantifiers, conclusions, and conditionality. Exclude proof recipes, methods, and intermediate proof steps; a construction that is itself the claimed result is legitimate statement content. A research log, question, or strategy suggestion need not assert a result: return statement=null and INCONCLUSIVE when there is no mathematical claim to check. Do not invent a claim or turn conjecture into established fact. The statement will be frozen on PASS and sent to a prover without the full text. Judge each note's own claim; supporting lemmas and partial progress need not solve the original task. Only the later requirements check judges the original completion criteria. For an explicit conditional claim P implies Q, check the derivation of Q assuming P. Its hypothetical antecedent P is part of the claim, not an external theorem to establish; omit it from premises. Proving the implication does not establish P. An unstated assumption in an unconditional claim remains a gap: do not silently weaken the claim to an implication or promote a missing proof step to an external theorem. External results actually used to prove an implication still require the normal assessment below. For declared support checked in this batch or not yet verified, judge the dependent reasoning conditionally; code separately requires every dependency to pass before verification or acceptance. Check borrowed facts against each support's checked statement or the statement you extract in this batch. For support with external trust and no checked statement, use the granted claims in its supplied full text. Additional facts from a support's proof need their own declared support or a proof in the consuming note. If the only unresolved issue is that a needed fact appears in declared support's proof but is omitted from its checked statement, return INCONCLUSIVE and identify the missing statement. Find missing cases, unsupported inferences, and undeclared substantive dependencies. When a claimed fact relies on campaign notes outside declared transitive support, including in scope remarks or comparisons, return INCONCLUSIVE and identify the missing claim or reference in report; never list that fact as an external premise. Apply the task's proof rules. Do not excuse a forbidden black box or an unproved substantive step as background, even if the note calls it standard. A forbidden invocation is a defect. ${research().retrieval ? "Establish routine task-permitted background from mathematical knowledge and explain it in report. Do not externalize a fact proved in the argument, or routine task-permitted background established by your check. List only directly needed nonroutine external claims that remain unproved, with their exact hypotheses and conclusions, including any invoked without citation. A cited theorem note may state such a result conditionally without reproving it. Check each application conditionally and explain it in report." : "This is a closed-book check: source retrieval is disabled. When the task permits standard background, check each such result's precise statement, hypotheses, and application from mathematical knowledge and explain that assessment in report. A background result established by this assessment need not be listed in premises. If permission, statement, or applicability is uncertain, retain the claim in premises; source checking will leave it INCONCLUSIVE. List all other unproved external claims with exact hypotheses and conclusion. Explain their applications in report."} Results explicitly granted as assumptions or permitted background by the supplied task need no external source check. Check their exact scope and application, and omit them from premises. A note merely claiming that permission is insufficient. Do not relist declared support results; check their applicability. Each premise must be a standalone statement preserving every relevant domain, dimension, compactness, regularity, and other hypothesis. Do not generalize beyond the form actually used in the argument. Source names and citations are allowed. Put proof ideas, application hints, and validation commentary in report, never in premises. Source checking will assess these exact strings, and reconstruction will receive them unchanged. Use [] only when no unresolved external premise remains under these rules. Correctness PASS is conditional on support and listed premises.`,
          pending("correctness").filter((note) => !note.checks.external),
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
              await research()
                .source(sourceInput, runtime, context)
                .catch((error) => {
                  throw new Error(
                    `Source checking failed: ${error instanceof Error ? error.message : String(error)}`,
                    { cause: error },
                  );
                }),
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
          `${correctionInstructions} Decide whether each note meets every completion criterion of the original task. All supplied notes have established correctness and sources, through completed checks or external trust. The sources records supply their exact approved external premises, approval references, and passage IDs and URLs, or external trust. Use this evidence metadata when the task explicitly requires external retrieval. Treat established mathematical results as given; do not repeat correctness or source verification. Check whether the stated result and supplied evidence satisfy the task. Historical prose about awaiting validation cannot override those records. Source PASS does not establish a stronger theorem, an unmet hypothesis, or an unrelated completion criterion. External trust alone is not evidence of external retrieval when the task explicitly requires it. Check quantifiers, variants, parameters, computational model, and bounds. A proved implication does not establish its antecedent. If the task requires an unconditional conclusion, an extra hypothesis must be discharged by a proof within the note, established support, or the task's assumptions. A specific unmet completion criterion is a concrete reason for FAIL, even when the note is mathematically sound partial progress.`,
        );

        await reconstruction(
          {
            task: input.task,
            notes,
            backend,
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
      if (!literature()) throw new Error("Literature is disabled");
      const result = await research().literature(
        { ...input, notes: input.notes.filter((note) => !note.retired) },
        runtime,
        context,
      );
      Assert(
        noteResultSchema(literatureResultSchema, noteIdPrefix(runtime.taskId)),
        result,
      );
      validateNotes(result.notes, input.notes);
      return { kind: "notes", notes: result.notes };
    },

    review: (...args: Parameters<Research["review"]>) =>
      research().review(...args),
  };
  const implementation = functions.implementation;
  return Object.assign(functions, { extension: native.extension });
}

export {
  createRuntime,
  readSettings,
  defaultSettings,
  type Settings,
} from "./config.ts";
export { externalResearch, closedBookResearch } from "./research.ts";
export type {
  ExternalAnswer,
  ExternalCall,
  ExternalRoles,
  Research,
} from "./backend.ts";
export { selectBatch } from "./batch.ts";
