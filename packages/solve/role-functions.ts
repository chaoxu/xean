import { defineTool, type Json } from "xean";
import type { z } from "zod";

import {
  coordinatorCall,
  explorerCall,
  literatureCall,
  proofCall,
  reconstructionCall,
  RoleCallError,
  sourceCall,
  statementCall,
  verifierCall,
  type RoleCall,
  type SolveSettings,
} from "./pi-roles";
import {
  correctnessVerdicts,
  explorerResult,
  explorerResultFor,
  literatureReport,
  type CoordinatorInput,
  type CoordinatorResult,
  type ExplorerInput,
  type ExplorerResult,
  type LiteratureInput,
  type LiteratureReport,
  type Note,
  type Statement,
  type Task,
  type VerifierInput,
  type proof,
  type reconstructionResult,
  type sourcePrompt,
  type verdicts,
} from "./roles";
import { codexRequest, type CodexRequest } from "./source";

/** Host capabilities contain transport and cancellation, never campaign state. */
export interface RoleExecution {
  readonly signal?: AbortSignal;
  readonly pi: <S extends z.ZodType>(
    request: RoleCall<S>,
  ) => Promise<z.output<S>>;
  readonly codex: (request: CodexRequest) => Promise<{
    readonly input: Json | null;
    readonly searches: number;
    readonly error?: string;
  }>;
}

export interface ExplorerExecution extends RoleExecution {
  readonly submit: (value: ExplorerResult) => Promise<{ noteIds: string[] }>;
}

export interface CheckInput {
  readonly input: VerifierInput;
  readonly judged: readonly string[];
}

export interface StatementInput {
  readonly input: VerifierInput;
  readonly note: Note;
}

/** Independent proof receives no target note or enclosing verifier input. */
export interface ProofInput {
  readonly task: Task;
  readonly support: readonly Note[];
  readonly statement: Statement;
}

export interface ReconstructionInput extends StatementInput {
  readonly statement: Statement;
  readonly proof: string;
}

export type SourceInput = z.output<typeof sourcePrompt>;

type Role<Input, Output, Execution = RoleExecution> = (
  input: Input,
  execution: Execution,
) => Promise<Output>;

/** Replace mathematical operations independently; verification order is host policy. */
export interface RoleImplementations {
  readonly explorer: Role<ExplorerInput, ExplorerResult, ExplorerExecution>;
  readonly coordinator: Role<CoordinatorInput, CoordinatorResult>;
  readonly literature: Role<LiteratureInput, LiteratureReport | null>;
  readonly correctness: Role<CheckInput, z.output<typeof correctnessVerdicts>>;
  readonly source: Role<SourceInput, Json>;
  readonly requirements: Role<CheckInput, z.output<typeof verdicts>>;
  readonly statement: Role<StatementInput, Statement>;
  readonly proof: Role<ProofInput, z.output<typeof proof>>;
  readonly reconstruction: Role<
    ReconstructionInput,
    z.output<typeof reconstructionResult>
  >;
}

/** Defaults close only over settings; every invocation receives its host capabilities. */
export function defaultRoleImplementations(
  settings: SolveSettings,
): RoleImplementations {
  return {
    async explorer(input, execution) {
      const call = explorerCall(
        input,
        settings.explorerContextBudgetTokens,
        settings.maxExplorerResponses,
      );
      const known: Pick<Note, "id" | "dead">[] = [...input.notes];
      const submit = defineTool({
        name: call.tool,
        description: call.description,
        input: explorerResultFor(known),
        async run(value) {
          const receipt = await execution.submit(explorerResult.parse(value));
          for (const id of receipt.noteIds)
            if (!known.some((note) => note.id === id))
              known.push({ id, dead: false });
          return receipt;
        },
      });
      return execution.pi({ ...call, tools: [submit] });
    },
    coordinator: (input, execution) => execution.pi(coordinatorCall(input)),
    async literature(input, execution) {
      const call = literatureCall(input, settings.source);
      const result = await execution.codex(codexRequest.parse(call.request));
      if (result.error !== undefined) return null;
      const parsed = literatureReport.safeParse(result.input);
      if (!parsed.success)
        throw new RoleCallError("literature returned no valid note candidates");
      return parsed.data;
    },
    async correctness({ input, judged }, execution) {
      return correctnessVerdicts.parse(
        await execution.pi(verifierCall("correctness", input, judged)),
      );
    },
    async source(input, execution) {
      const call = sourceCall(settings.source, input);
      return (await execution.codex(call.request)).input;
    },
    requirements: ({ input, judged }, execution) =>
      execution.pi(verifierCall("requirements", input, judged)),
    statement: ({ input, note }, execution) =>
      execution.pi(statementCall(input, note)),
    proof: (input, execution) => execution.pi(proofCall(input)),
    reconstruction: ({ input, note, statement, proof }, execution) =>
      execution.pi(reconstructionCall(input, note, statement, proof)),
  };
}
