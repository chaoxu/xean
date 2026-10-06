import {
  Type,
  StringEnum,
  type Static,
  type TSchema,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { TObject } from "typebox";

const text = Type.String({
  minLength: 1,
  // Reject non-whitespace ASCII controls without rewriting mathematical text.
  pattern: "^\\s*[^\\s\\x00-\\x1f\\x7f][^\\x00-\\x08\\x0e-\\x1f\\x7f]*$",
});
export const object = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
export const batchSchema = <P extends Record<string, TSchema>>(
  schema: TObject<P>,
) =>
  object({
    results: Type.Array(object({ noteId: text, ...schema.properties })),
  });

/** Match each requested note exactly once, independent of response order. */
export function batchResults<T extends { noteId: string }>(
  ids: readonly string[],
  results: T[],
): Omit<T, "noteId">[] {
  const byId = new Map(
    results.map(({ noteId, ...result }) => [noteId, result]),
  );
  if (
    new Set(ids).size !== ids.length ||
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
    ...text,
    description:
      "Complete authoritative note: claims, proofs, observations, failed approaches, questions, or analysis. Preserve all hypotheses, qualifications, and unresolved gaps.",
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
const correctionSchema = object({
  summary: Type.Union([noteContentSchema.properties.summary, Type.Null()]),
  detailedSummary: Type.Union([
    noteContentSchema.properties.detailedSummary,
    Type.Null(),
  ]),
  text: Type.Union([noteContentSchema.properties.text, Type.Null()]),
});
export const verdictSchema = object({
  verdict: StringEnum(["PASS", "FAIL", "INCONCLUSIVE"] as const),
  report: text,
  correction: Type.Optional(correctionSchema),
});
export type Verdict = Static<typeof verdictSchema>;
const premisesSchema = Type.Array(text, {
  description:
    "Exact standalone external claims, including all hypotheses and qualifications. Source names and citations are allowed. Substantive algorithmic guarantees belong in the claim. Put proof ideas, application explanations, and validation status in report, not here. Exclude explicit hypothetical antecedents, task-granted assumptions, and declared supporting notes.",
});
export const correctnessSchema = object({
  ...verdictSchema.properties,
  statement: Type.Union([text, Type.Null()], {
    description:
      "Exact claim checked in this note, preserving definitions, hypotheses, quantifiers, and conclusions, without proof recipes or methods. Null when the note asserts no mathematical result; do not invent a claim.",
  }),
  premises: premisesSchema,
});
export const proofSchema = object({
  proof: text,
  complete: Type.Boolean({
    description:
      "True only when this note's mathematical statement is fully proved under its declared support and approved premises. Source retrieval and overall task requirements are checked separately; lack of a fresh source search does not make this proof incomplete.",
  }),
});
const passageSchema = object({
  premise: Type.Integer({ minimum: 0 }),
  url: text,
  quote: text,
});
export const sourceSchema = object({
  ...Type.Omit(verdictSchema, ["correction"]).properties,
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
const sourceEvidenceSchema = object({
  ...Type.Omit(passageSchema, ["premise"]).properties,
  id: text,
  /** Exact premise at the original source assessment. */
  statement: text,
});
export type SourceEvidence = Static<typeof sourceEvidenceSchema>;
export const researchReportSchema = object({
  ...verdictSchema.properties,
  premises: premisesSchema,
  passages: Type.Array(
    object({
      ...sourceEvidenceSchema.properties,
      premise: passageSchema.properties.premise,
    }),
  ),
  kind: Type.Literal("codex-report"),
  operationId: text,
  reportedAt: text,
});
export type ResearchReport = Static<typeof researchReportSchema>;
export type Source = Verdict | ResearchReport;
export type ReviewInput = { task: Task; argument: string };
const recordedVerdict = Type.Omit(verdictSchema, ["correction"], {
  additionalProperties: false,
});
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const checkSchema = object({
  noteId: text,
  correction: Type.Optional(
    object({ ...Type.Partial(noteContentSchema).properties, revision }),
  ),
  correctness: Type.Optional(
    Type.Omit(correctnessSchema, ["correction"], {
      additionalProperties: false,
    }),
  ),
  source: Type.Optional(
    Type.Union([
      recordedVerdict,
      Type.Omit(researchReportSchema, ["correction"], {
        additionalProperties: false,
      }),
    ]),
  ),
  requirements: Type.Optional(recordedVerdict),
  reconstruction: Type.Optional(
    object({
      ...recordedVerdict.properties,
      proof: proofSchema.properties.proof,
    }),
  ),
});
export type Check = Static<typeof checkSchema>;
/** Published IDs include their worker/input prefix; draft IDs are local. */
export type Note = Exploration["notes"][number] & {
  revision: number;
  imported: boolean;
  checks: Omit<Check, "noteId" | "correction">[];
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
export const planSchema = (capabilities: {
  literature: boolean;
  codex: boolean;
  explorer: boolean;
}) =>
  object({
    work: Type.Union([
      Type.Union(
        workPlan.anyOf.filter(
          (plan) =>
            plan.properties.kind.const === "verifier" ||
            capabilities[plan.properties.kind.const],
        ),
      ) as typeof workPlan,
      Type.Null(),
    ]),
  });
export type Plan = Static<ReturnType<typeof planSchema>>;
export const submissionSchemas = {
  explorer: explorationSchema,
  coordinator: planSchema({ explorer: true, literature: true, codex: true }),
  correctness: batchSchema(correctnessSchema),
  requirements: batchSchema(verdictSchema),
  proof: batchSchema(proofSchema),
  reconstruction: batchSchema(verdictSchema),
};
/** One Verifier checks its requested notes and shared support together. */
export const verificationTargets = ({ work }: Plan) =>
  work?.kind === "verifier"
    ? work.notes.map((id) => ({ id, through: work.through }))
    : [];
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
export const solverResultSchema = Type.Union([
  object({
    kind: Type.Literal("notes"),
    ...explorationSchema.properties,
  }),
  object({
    kind: Type.Literal("verification"),
    checks: Type.Array(checkSchema),
  }),
]);
export type SolverResult = Static<typeof solverResultSchema>;

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
