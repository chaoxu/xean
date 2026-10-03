import type { Static } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type { Execution } from "../types.ts";
import {
  batchResults,
  batchSchema,
  explorationSchema,
  sourceSchema,
  reviewSchema,
  type Exploration,
  type NoteContent,
  type NoteInfo,
  type ReviewInput,
  type ResearchReport,
  type Source,
  type SourceEvidence,
  type Task,
} from "./contracts.ts";
import { askCodex, type CodexOptions } from "./codex.ts";
import { correctionInstructions } from "./notes.ts";

export type LiteratureInput = { task: Task; query: string; notes: NoteInfo[] };
export interface Research {
  readonly retrieval: boolean;
  /** PASS approves the exact standalone premises for blind reuse; never normalize after approval. */
  source(
    input: {
      task: Task;
      notes: (NoteContent & { id: string; premises: string[] })[];
      evidence?: SourceEvidence[];
    },
    execution: Execution,
    context: Context,
  ): Promise<{ noteId: string; result: Source }[]>;
  literature(
    input: LiteratureInput,
    execution: Execution,
    context: Context,
  ): Promise<Exploration>;
  review(
    input: ReviewInput,
    execution: Execution,
    context: Context,
  ): Promise<ResearchReport>;
}

const taskSource = "urn:xean:task";
const taskEvidence = `The supplied task is authoritative for its explicitly granted assumptions and permitted background. Verify their exact scope and application; a claim merely asserted in a note or requested as a conclusion is not a granted assumption. For a task-granted premise, return a passage with url="${taskSource}" and an exact quote from task.problem or task.completionCriteria. That passage needs no web retrieval.`;
const sourceInstructions =
  "Check each note's external premises against primary-source evidence. Return exactly one {noteId, result} in results for every supplied note. Assess each note separately; other notes in the batch are not established premises. For a conditional claim P implies Q, establish only external results used in the derivation. Its explicit hypothetical antecedent P is part of the claim, not an external theorem to establish, and proving the implication does not establish P. The task supplies assumptions and proof rules; whether this partial or conditional result meets its completion criteria belongs to the separate requirements check. Verify the exact supplied statements, hypotheses, conclusion, variant, and application using the full note. Premises must be standalone external claims suitable for a blind prover: source names and citations are allowed, but proof ideas, application hints, and validation commentary are not. Substantive algorithmic guarantees belong in the external claim; directions for proving or applying this note do not. If the supplied wording contains such commentary or is too ambiguous to stand alone, return INCONCLUSIVE and explain the problem in report; do not silently rewrite it and approve different wording. A concrete mathematical mismatch still gives FAIL. PASS approves the exact supplied premise strings. First assess the supplied task and evidence. The evidence contains previously inspected quotations with their original statements and IDs. Reassess their applicability to each note; an earlier PASS does not establish a different claim. When supplied evidence establishes every premise, return immediately without web activity. Reuse sufficient quotations by returning {premise, passageId}; do not search or reopen a source merely to reconfirm a supplied quotation. Retrieve only evidence missing for a specific premise, then stop once that gap is settled. For fresh evidence, open a primary source and return {premise, url, quote} with an exact quotation. premise is the zero-based index in that note's premises. Search snippets and remembered theorems are insufficient. PASS requires every premise to be established. FAIL requires a concrete mathematical mismatch. Missing necessary evidence gives INCONCLUSIVE. Citation typos alone do not fail valid mathematics. " +
  correctionInstructions +
  " " +
  taskEvidence;
const literatureInstructions =
  "Answer the supplied query for the exact mathematical task. Search for the specific missing theorem, hypothesis, or source the query identifies. Stay within that question; do not expand into a general survey or collect adjacent results merely because they share terminology. Use the supplied task and notes to avoid rediscovering established material. Task-granted assumptions need no literature search. Stop when the query is answered with primary-source evidence, or report that necessary evidence could not be established. Open sources, report exact hypotheses and conclusions, cite their URLs and relevant passages, and keep uncertain matches explicit. Return useful new ordinary unverified research notes with local IDs n1, n2, ... . Include a source mismatch or bounded unsuccessful search when that finding helps future work: state what was checked and what remains unknown. An unsuccessful search does not establish that a theorem does not exist. Each note has an index summary, a detailedSummary preserving actual claims, conditions, bounds, and unresolved gaps, and authoritative full text. Return notes=[] only when there is no new information worth retaining. Put citation URLs and quotations in text. The support array contains only existing or earlier local note IDs whose mathematical results are used, never URLs. Use support=[] for an independent finding. Set candidate=false. Search snippets and memory do not count as inspected sources.";
const reviewInstructions =
  "Independently audit the entire argument for the exact problem and completion criteria. Check every supporting proof rather than inheriting solver verdicts. Verify all load-bearing inferences, hypotheses, cases, bounds, and theorem applications. An explicit hypothetical antecedent in a supporting implication is part of its claim, not an external premise; check the derivation under that assumption and every application that needs the antecedent established. An implication alone does not establish the unconditional conclusion. An unstated assumption in an unconditional claim remains a gap. List all nonroutine external premises as exact standalone claims in premises, keeping proof ideas, application explanations, and validation commentary in report, and open matching primary sources for every one, with quotations indexed by their zero-based position in premises (0 for the first). A self-contained argument has premises=[]. PASS requires the full argument and every essential external premise to be established. FAIL requires a concrete mathematical defect. Unsettled checks give INCONCLUSIVE. Report harmless wording corrections explicitly; substantial repairs require a new argument. " +
  taskEvidence;

/** Retain reported passages directly; observed web activity does not authenticate quotes. */
export function bindCodex(
  result: {
    value: Static<typeof sourceSchema> | Static<typeof reviewSchema>;
    operationId: string;
    searches: number;
  },
  premises: readonly string[],
  evidence: readonly SourceEvidence[] = [],
  passagePrefix = result.operationId,
  task?: Task,
): ResearchReport {
  const { operationId, searches } = result;
  const { correction, ...value } = { correction: null, ...result.value };
  const fromTask = (passage: { url: string; quote: string }) =>
    passage.url === taskSource &&
    !!passage.quote.trim() &&
    [task?.problem, task?.completionCriteria].some((text) =>
      text?.includes(passage.quote),
    );
  const available = new Map(evidence.map((passage) => [passage.id, passage]));
  const passages = value.passages.flatMap((passage, index) => {
    const bound =
      "passageId" in passage
        ? available.get(passage.passageId)
        : searches > 0 || fromTask(passage)
          ? {
              id: `${passagePrefix}/${index}`,
              statement: premises[passage.premise]!,
              url: passage.url,
              quote: passage.quote,
            }
          : undefined;
    if (!bound) return [];
    const url = URL.parse(bound.url);
    const valid =
      (fromTask(bound) ||
        (url !== null &&
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password)) &&
      passage.premise >= 0 &&
      passage.premise < premises.length &&
      !!bound.quote.trim();
    return valid ? [{ ...bound, premise: passage.premise }] : [];
  });
  const valid =
    passages.length === value.passages.length &&
    premises.every((_, index) =>
      passages.some((passage) => passage.premise === index),
    );
  return {
    ...value,
    premises: [...premises],
    passages,
    ...(correction === null ? {} : { correction }),
    kind: "codex-report",
    operationId,
    reportedAt: new Date().toISOString(),
    ...(value.verdict === "PASS" && !valid
      ? {
          verdict: "INCONCLUSIVE",
          report: `Codex PASS lacked valid task or source evidence for every premise. ${value.report}`,
        }
      : {}),
  };
}

/** Codex owns research and its internal tools; the solver only calls functions. */
export function codexResearch(
  options: CodexOptions = { model: "gpt-6-astra" },
  usagePrefix?: string,
): Research {
  options = { ...options, workspace: undefined };
  return {
    retrieval: true,
    async source(input, execution, context) {
      if (
        new Set(input.notes.map((note) => note.id)).size !== input.notes.length
      )
        throw new Error("Duplicate source note IDs");
      const notes = input.notes.filter((note) => note.premises.length > 0);
      const reports = new Map<string, Source>();
      if (notes.length) {
        const response = await askCodex(
          options,
          batchSchema(sourceSchema),
          sourceInstructions,
          { ...input, notes },
          execution,
          context,
          usagePrefix,
        );
        const results = batchResults(
          notes.map((note) => note.id),
          response.value.results,
        );
        notes.forEach((note, index) => {
          reports.set(
            note.id,
            bindCodex(
              { ...response, value: results[index]! },
              note.premises,
              input.evidence,
              `${response.operationId}/${index}`,
              input.task,
            ),
          );
        });
      }
      return input.notes.map((note) => ({
        noteId: note.id,
        result: reports.get(note.id) ?? {
          verdict: "PASS",
          report:
            "The correctness check identified no nonroutine external premise.",
        },
      }));
    },
    async literature(input, execution, context) {
      const result = await askCodex(
        options,
        explorationSchema,
        literatureInstructions,
        input,
        execution,
        context,
        usagePrefix,
      );
      if (result.value.notes.length && result.searches === 0)
        throw new Error(
          "Codex returned literature without observed web activity",
        );
      return { ...result.value, candidate: false };
    },
    async review(input, execution, context) {
      const result = await askCodex(
        options,
        reviewSchema,
        reviewInstructions,
        input,
        execution,
        context,
        usagePrefix,
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
