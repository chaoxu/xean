import type { Context } from "@earendil-works/chord";
import type { RoleRuntime } from "./types.ts";
import { Assert } from "typebox/value";
import type { AskCodex } from "./codex.ts";
import {
  explorationSchema,
  codexPlan,
  type CodexInput,
  type SolverResult,
} from "../math/contracts.ts";
import { validateResult } from "../math/notes.ts";

/** Codex owns implementation and tool use; Xean publishes its notes as one result. */
export function codexWorker(askCodex: AskCodex) {
  return async (
    input: CodexInput,
    runtime: RoleRuntime,
    context: Context,
  ): Promise<SolverResult> => {
    input = structuredClone(input);
    Assert(codexPlan.properties.assignment, input.assignment);
    context.abortSignal?.throwIfAborted();
    const { value } = await askCodex(
      "worker",
      explorationSchema,
      "Complete the concrete implementation assignment: produce its deliverable for the specified input/domain, expected output, binding constraints, and checks/evidence. Selected notes may define these requirements. The task's completion criteria provide mathematical context; completing the implementation assignment need not solve the whole task. You may write and run programs in your working directory. Native web search is disabled for this worker. Choose your own implementation and tools. Follow the task's proof rules and the operator's execution configuration. For resource-heavy work use an operator-provided supervised compute service; if none is available, record the missing facility in a note instead of launching it locally. Keep programs, inputs, commands, outputs, and environment details in this directory so the work can be rerun. Return useful findings or failed approaches as ordinary notes with local IDs n1, n2, ... . Each note has summary, detailedSummary, full text, and support. Put derivations, artifact filenames, and rerun commands in text, never support. Include the claims, relevant program/output evidence, reasoning, and limitations needed to check the note without opening artifact files. Distinguish observations, exhaustive finite results, and mathematical proofs. Declare as support every supplied or earlier local note whose result you use without proving it. Dead notes are diagnostic only. These are unverified drafts; execution success does not establish mathematical correctness. Set candidate=true only when the last note claims a complete solution of the exact task. Return notes=[] and candidate=false only when there is no new information worth retaining.",
      input,
      runtime,
      context,
    );
    return validateResult({ kind: "notes", ...value }, input.notes);
  };
}
