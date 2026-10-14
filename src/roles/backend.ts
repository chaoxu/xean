import type { Context } from "@earendil-works/chord";
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { defineEntry } from "@earendil-works/pi-durable";
import type { RoleRuntime } from "../core/roles.ts";

import type {
  Task,
  NoteInfo,
  SourceEvidence,
  Source,
  LiteratureResult,
  ReviewInput,
  ResearchReport,
} from "../core/math/contracts.ts";

export type LiteratureInput = {
  task: Task;
  assignment: string;
  notes: NoteInfo[];
};
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
  ): Promise<LiteratureResult>;
  review(
    input: ReviewInput,
    runtime: RoleRuntime,
    context: Context,
  ): Promise<ResearchReport>;
}

export type ExternalAnswer<S extends TSchema> = {
  value: Static<S>;
  workspace: string;
  operationId: string;
  searches: number;
  reportedAt: string;
};
export type ExternalCall = <S extends TSchema>(
  mode: "worker" | "research",
  schema: S,
  instructions: string,
  input: unknown,
  runtime: RoleRuntime,
  context: Context,
) => Promise<ExternalAnswer<S>>;
export type ExternalRoles = {
  implementation?: ExternalCall;
  verifier?: ExternalCall;
  explorer?: ExternalCall;
  research?: Research;
};
export const externalEvidence = (answer: {
  workspace: string;
  operationId: string;
}) =>
  `\n\nArtifacts: ${answer.workspace}\nExecution receipt: ${answer.operationId}`;
export const computationInstructions =
  "Resource exhaustion leaves a check unresolved, never proves infeasibility. Independently check solver witnesses and certificates before using them as evidence. Preserve programs, inputs, commands, outputs, and relevant environment details for reproduction. A successful process exit or another agent's claim that a checker passed is insufficient.";
export const ExternalLog = defineEntry<{
  operationId: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  usage: Record<string, number> | null;
  outputTruncated?: boolean;
}>("research.external-call");
export const ExternalRequest = defineEntry<{
  provider: string;
  api: string;
  operationId: string;
  model: string;
  workspace: string;
  reasoning: string;
  profile: string | null;
  usageTag: string | null;
}>("research.external-request");
