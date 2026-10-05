import type { Context } from "@earendil-works/chord";
import type { RoleRuntime } from "./types.ts";
import {
  batchResults,
  batchSchema,
  explorationSchema,
  object,
  sourceSchema,
  reviewSchema,
  type Exploration,
  type NoteInfo,
  type ReviewInput,
  type ResearchReport,
  type Source,
  type SourceEvidence,
  type Task,
} from "../math/contracts.ts";
import type { AskCodex } from "./codex.ts";
import { bindCodex, taskSource } from "../math/evidence.ts";

export type LiteratureInput = { task: Task; query: string; notes: NoteInfo[] };
export interface Research {
  readonly retrieval: boolean;
  /** PASS approves the exact standalone premises for blind reuse; never normalize after approval. */
  source(
    input: {
      task: Task;
      notes: { id: string; premises: string[] }[];
      evidence?: SourceEvidence[];
    },
    runtime: RoleRuntime,
    context: Context,
  ): Promise<(Source & { noteId: string })[]>;
  literature(
    input: LiteratureInput,
    runtime: RoleRuntime,
    context: Context,
  ): Promise<Pick<Exploration, "notes">>;
  review(
    input: ReviewInput,
    runtime: RoleRuntime,
    context: Context,
  ): Promise<ResearchReport>;
}

const taskEvidence = `The supplied task is authoritative for its explicitly granted assumptions and permitted background. Verify their exact scope and application; a claim merely asserted in a note or requested as a conclusion is not a granted assumption. For a task-granted premise, return a passage with url="${taskSource}" and an exact quote from task.problem or task.completionCriteria. That passage needs no web retrieval.`;
const sourceInstructions =
  "Check each distinct external fact against primary-source evidence. Return one judgment per supplied fact in results; noteId identifies the fact's temporary id. Include verdict, report, and passages. Each fact has one exact statement, so every passage uses premise:0. Assess the statement's exact hypotheses, quantifiers, conclusion, and variant. Correctness handles the notes' derivations and applications of these facts; requirements handles task completion. Preserve conditional claims as implications without establishing their antecedents. Statements must stand alone for a blind prover. Source names and citations are allowed. Mathematical scope, including quantified applicability and constructive guarantees, is part of the claim. Instructions for proving a note and validation commentary belong outside the statement. If the frozen wording includes such guidance or is too ambiguous to stand alone, return INCONCLUSIVE and explain the issue. A concrete mathematical mismatch gives FAIL. Never silently repair or rewrite a frozen statement. PASS approves exactly the supplied statement. First assess the task and supplied evidence. Evidence retains each quotation's original statement and ID. Judge whether each quotation establishes the current fact; an earlier PASS does not establish a different claim. When supplied evidence suffices, return without web activity. Reuse sufficient quotations with {premise:0, passageId}. Retrieve only evidence missing for a specific fact, then stop once that gap is settled. For fresh evidence, open a primary source and return {premise:0, url, quote} with an exact quotation. Search snippets and remembered theorems are insufficient. Missing necessary evidence gives INCONCLUSIVE. Citation typos alone do not fail valid mathematics. " +
  taskEvidence;
const literatureInstructions =
  "Answer the supplied query for the exact mathematical task. Search for the specific missing theorem, hypothesis, or source the query identifies. Stay within that question; do not expand into a general survey or collect adjacent results merely because they share terminology. Use the supplied task and note index to avoid rediscovering established material. This role has no note reader. An index summary is not the authoritative full statement. Task-granted assumptions need no literature search. Stop when the query is answered with primary-source evidence, or report that necessary evidence could not be established. Open sources, report exact hypotheses and conclusions, cite their URLs and relevant passages, and keep uncertain matches explicit. Return useful new ordinary unverified research notes with local IDs n1, n2, ... . Include a source mismatch or bounded unsuccessful search when that finding helps future work: state what was checked and what remains unknown. An unsuccessful search does not establish that a theorem does not exist. Each note has an index summary, a detailedSummary preserving actual claims, conditions, bounds, and unresolved gaps, an authoritative statement, and an argument containing the supporting evidence or analysis. Return notes=[] only when there is no new information worth retaining. Put citation URLs and quotations in argument. The support array contains only existing or earlier local note IDs whose mathematical results are used, never URLs. Use support=[] for an independent finding. Search snippets and memory do not count as inspected sources.";
const reviewInstructions =
  "Independently audit every supplied statement and argument for the exact problem and completion criteria. Check every supporting proof rather than inheriting solver verdicts. Verify all load-bearing inferences, hypotheses, cases, bounds, and theorem applications. An explicit hypothetical antecedent in a supporting implication is part of its claim, not an external premise; check the derivation under that assumption and every application that needs the antecedent established. An implication alone does not establish the unconditional conclusion. An unstated assumption in an unconditional claim remains a gap. List all nonroutine external premises as exact standalone claims in premises, keeping proof ideas, application explanations, and validation commentary in report, and open matching primary sources for every one, with quotations indexed by their zero-based position in premises (0 for the first). A self-contained argument has premises=[]. PASS requires the full argument and every essential external premise to be established. FAIL requires a concrete mathematical defect. Unsettled checks give INCONCLUSIVE. Report harmless wording corrections explicitly; substantial repairs require a new argument. This role has no execution tool. Justify essential finite checks analytically or with supplied execution receipts matching the claim. Prose asserting execution is insufficient. If the check remains unsupported, return INCONCLUSIVE. " +
  taskEvidence;

/** Codex owns research and its internal tools; the solver only calls functions. */
export function codexResearch(askCodex: AskCodex): Research {
  return {
    retrieval: true,
    async source(input, runtime, context) {
      if (
        new Set(input.notes.map((note) => note.id)).size !== input.notes.length
      )
        throw new Error("Duplicate source note IDs");
      const facts = [
        ...new Set(input.notes.flatMap((note) => note.premises)),
      ].map((statement, index) => ({ id: `f${index + 1}`, statement }));
      const reports = new Map<string, ResearchReport>();
      if (facts.length) {
        const response = await askCodex(
          "research",
          batchSchema(sourceSchema),
          sourceInstructions,
          { task: input.task, facts, evidence: input.evidence },
          runtime,
          context,
        );
        const results = batchResults(
          facts.map((fact) => fact.id),
          response.value.results,
        );
        facts.forEach((fact, index) => {
          reports.set(
            fact.statement,
            bindCodex(
              { ...response, value: results[index]! },
              [fact.statement],
              input.evidence,
              `${response.operationId}/${fact.id}`,
              input.task,
            ),
          );
        });
      }
      return input.notes.map((note): Source & { noteId: string } => {
        if (!note.premises.length)
          return {
            noteId: note.id,
            verdict: "PASS",
            report:
              "The correctness check identified no nonroutine external premise.",
          };
        const judgments = note.premises.map((premise) => reports.get(premise)!);
        return {
          ...judgments[0]!,
          noteId: note.id,
          verdict: (["FAIL", "INCONCLUSIVE", "PASS"] as const).find((verdict) =>
            judgments.some((judgment) => judgment.verdict === verdict),
          )!,
          report: judgments
            .map(
              (judgment, index) =>
                `Premise ${index}: ${judgment.verdict}. ${judgment.report}`,
            )
            .join("\n\n"),
          premises: [...note.premises],
          passages: judgments.flatMap((judgment, premise) =>
            judgment.passages.map((passage) => ({ ...passage, premise })),
          ),
        };
      });
    },
    async literature(input, runtime, context) {
      const result = await askCodex(
        "research",
        object({ notes: explorationSchema.properties.notes }),
        literatureInstructions,
        input,
        runtime,
        context,
      );
      if (result.value.notes.length && result.searches === 0)
        throw new Error(
          "Codex returned literature without observed web activity",
        );
      return result.value;
    },
    async review(input, runtime, context) {
      const result = await askCodex(
        "research",
        reviewSchema,
        reviewInstructions,
        input,
        runtime,
        context,
      );
      return bindCodex(
        result,
        result.value.premises,
        [],
        result.operationId,
        input.task,
      );
    },
  };
}

export const closedBookResearch: Research = {
  retrieval: false,
  async source(input) {
    return input.notes.map((note) => ({
      noteId: note.id,
      ...(note.premises.length
        ? {
            verdict: "INCONCLUSIVE" as const,
            report:
              "External premises remain unresolved because source retrieval is disabled.",
          }
        : {
            verdict: "PASS" as const,
            report:
              "The correctness check identified no nonroutine external premise.",
          }),
    }));
  },
  async literature() {
    throw new Error("Literature is disabled");
  },
  async review() {
    throw new Error("Independent source review is disabled");
  },
};
