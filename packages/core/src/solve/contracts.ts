import {
  Type,
  StringEnum,
  type Static,
  type TSchema,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

export const defaultReasoning = "max";
export const declarationVersion = 13;
const text = Type.String({
  minLength: 1,
  // Reject non-whitespace ASCII controls without rewriting mathematical text.
  pattern: "^[^\\u0000-\\u0008\\u000e-\\u001f\\u007f]+$",
});
export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const batchSchema = <S extends TSchema>(schema: S) =>
  Type.Unsafe<{ results: { noteId: string; result: Static<S> }[] }>(
    object({ results: Type.Array(object({ noteId: text, result: schema })) }),
  );

/** Match each requested note exactly once, independent of response order. */
export function batchResults<T>(
  ids: readonly string[],
  results: { noteId: string; result: T }[],
): T[] {
  const byId = new Map(results.map(({ noteId, result }) => [noteId, result]));
  if (
    new Set(ids).size !== ids.length ||
    byId.size !== results.length ||
    results.length !== ids.length ||
    ids.some((id) => !byId.has(id))
  )
    throw new Error(
      "Batch results must contain exactly one result per requested note",
    );
  return ids.map((id) => byId.get(id)!);
}

export const taskSchema = object({ problem: text, completionCriteria: text });
export type Task = Static<typeof taskSchema>;
export const noteContentSchema = object({
  summary: Type.String({
    minLength: 1,
    pattern: "\\S",
    description:
      "Short index description with decisive hypotheses and limitations. This summary is repeated in later role inputs.",
  }),
  detailedSummary: Type.String({
    minLength: 1,
    pattern: "\\S",
    description:
      "Detailed summary of the actual claims or findings, decisive conditions, bounds, and unresolved gaps. Preserve conditionality and negative conclusions. It may explain methods but does not replace the full note.",
  }),
  text: Type.String({
    minLength: 1,
    pattern: "\\S",
    description:
      "Authoritative full note with complete arguments and evidence.",
  }),
});
export type NoteContent = Static<typeof noteContentSchema>;
export const noteDraftSchema = object({
  id: Type.String({ pattern: "^n[1-9][0-9]*$" }),
  ...noteContentSchema.properties,
  support: Type.Array(text),
});
export const explorationSchema = object({
  notes: Type.Array(noteDraftSchema),
  candidate: Type.Boolean(),
});
export type Exploration = Static<typeof explorationSchema>;
export const verdictSchema = object({
  verdict: StringEnum(["PASS", "FAIL", "INCONCLUSIVE"] as const),
  report: text,
  correction: Type.Optional(noteContentSchema),
});
export type Verdict = Static<typeof verdictSchema>;
const premisesSchema = Type.Array(text, {
  description:
    "Exact standalone external claims, including all hypotheses and qualifications. Source names and citations are allowed. Substantive algorithmic guarantees belong in the claim. Put proof ideas, application explanations, and validation status in report, not here. Exclude explicit hypothetical antecedents, task-granted assumptions, and declared supporting notes.",
});
export const correctnessSchema = object({
  ...verdictSchema.properties,
  premises: premisesSchema,
});
export type Correctness = Static<typeof correctnessSchema>;
export const statementSchema = object({ statement: text });
export const proofSchema = object({ proof: text, complete: Type.Boolean() });
const passageSchema = object({
  premise: Type.Integer({ minimum: 0 }),
  url: text,
  quote: text,
});
export const sourceSchema = object({
  ...verdictSchema.properties,
  // Codex structured output requires every field; null means no correction.
  correction: Type.Union([noteContentSchema, Type.Null()]),
  passages: Type.Array(
    Type.Union([
      passageSchema,
      object({ premise: passageSchema.properties.premise, passageId: text }),
    ]),
  ),
});
export const reviewSchema = object({
  ...Type.Omit(verdictSchema, ["correction"]).properties,
  passages: Type.Array(passageSchema),
  premises: premisesSchema,
});
export type SourceEvidence = Omit<Static<typeof passageSchema>, "premise"> & {
  id: string;
  /** Exact premise at the original source assessment. */
  statement: string;
};
export type ResearchReport = Verdict & {
  premises: Static<typeof reviewSchema>["premises"];
  passages: (SourceEvidence & { premise: number })[];
  kind: "codex-report";
  operationId: string;
  reportedAt: string;
};
export type Source = Verdict | ResearchReport;
export type ReviewInput = { task: Task; argument: string };
export type Check = {
  noteId: string;
  correction?: NoteContent & { revision: number };
  correctness?: Correctness;
  source?: Source;
  requirements?: Verdict;
  reconstruction?: Verdict & Static<typeof statementSchema> & { proof: string };
};
export type Note = Static<typeof noteDraftSchema> & {
  revision: number;
  imported: boolean;
  checks: Check[];
  verified: boolean;
  dead: boolean;
  accepted: boolean;
  candidate: boolean;
};
export const explorePlan = object({
  kind: Type.Literal("explorer"),
  guidance: text,
});
export const verificationStages = [
  "correctness",
  "source",
  "requirements",
  "reconstruction",
] as const;
export type VerificationStage = (typeof verificationStages)[number];
export const verificationStageSchema = StringEnum(verificationStages);
export const verifyPlan = object({
  kind: Type.Literal("verifier"),
  notes: Type.Array(text, { minItems: 1, uniqueItems: true }),
  through: verificationStageSchema,
});
export const literaturePlan = object({
  kind: Type.Literal("literature"),
  query: text,
});
export const codexPlan = object({
  kind: Type.Literal("codex", {
    description:
      "Use Codex rarely for a concrete implementation needed by the mathematical task. Explorer handles mathematical reasoning. Codex writes and runs programs and returns ordinary unverified notes with retained artifacts.",
  }),
  assignment: Type.String({
    minLength: 1,
    pattern: "\\S",
    description:
      "State the concrete deliverable, input/domain, expected output, binding constraints, and checks/evidence that complete this implementation assignment. Selected notes may define these requirements. The task's completion criteria provide mathematical context. Codex chooses the implementation and tools.",
  }),
  notes: Type.Array(text, {
    uniqueItems: true,
    description:
      "Relevant note IDs. Their full text and dependencies are supplied automatically. Use [] when none are needed.",
  }),
});
const workPlan = Type.Union([
  explorePlan,
  verifyPlan,
  literaturePlan,
  codexPlan,
]);
export const canExplore = (singleShot: boolean, used: boolean) =>
  !singleShot || !used;
export function chatGptResponseLimit(requested?: number): 1 {
  if (requested !== undefined && requested !== 1)
    throw new Error(
      "ChatGPT Web Explorer requires maxExplorerResponses=1; each browser response consumes scarce subscription capacity",
    );
  return 1;
}
export const planSchema = (capabilities: {
  literature: boolean;
  codex: boolean;
  explorer: boolean;
}) =>
  object({
    work: Type.Array(
      Type.Union(
        workPlan.anyOf.filter(
          (plan) =>
            plan.properties.kind.const === "verifier" ||
            capabilities[plan.properties.kind.const],
        ),
      ) as typeof workPlan,
      { minItems: capabilities.explorer ? 1 : 0 },
    ),
  });
export type Plan = Static<ReturnType<typeof planSchema>>;
/** One verification batch checks common support once across all requests. */
export const verificationTargets = (plan: Plan) =>
  plan.work.flatMap((request) =>
    request.kind === "verifier"
      ? request.notes.map((id) => ({ id, through: request.through }))
      : [],
  );
export type SolverInput = { task: Task; notes: Note[] };
export type NoteInfo = Pick<
  Note,
  "id" | "summary" | "support" | "imported" | "verified" | "dead" | "candidate"
> & { passed: VerificationStage[]; feedback: string[] };
export type ExplorerInput = SolverInput & {
  guidance: string;
};
export type CodexInput = SolverInput & { assignment: string };
export type VerifierInput = SolverInput & {
  targets: { id: string; through: VerificationStage }[];
  evidence?: SourceEvidence[];
};
export type ReconstructionInput = SolverInput & { targets: string[] };
export type SolverResult =
  | ({ kind: "notes"; workspace?: string } & Exploration)
  | { kind: "verification"; checks: Check[] };

/** Strict validation at trust boundaries: no conversion, defaults, or dropped nulls. */
export function decode<S extends TSchema>(
  schema: S,
  value: unknown,
): Static<S> {
  if (!Value.Check(schema, value))
    throw new Error(
      `Invalid value:\n${Value.Errors(schema, value)
        .map((error) => `  - ${error.instancePath || "/"}: ${error.message}`)
        .join("\n")}`,
    );
  return structuredClone(value) as Static<S>;
}
