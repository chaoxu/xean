import {
  Type,
  StringEnum,
  type Static,
  type TSchema,
} from "@earendil-works/pi-ai";
import { Value } from "typebox/value";

export const defaultReasoning = "max";
export const declarationVersion = 10;
const text = Type.String({ minLength: 1 });
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
  const expected = new Set(ids);
  const byId = new Map<string, T>();
  const duplicates = new Set<string>();
  for (const { noteId, result } of results) {
    if (byId.has(noteId)) duplicates.add(noteId);
    byId.set(noteId, result);
  }
  if (
    expected.size !== ids.length ||
    byId.size !== results.length ||
    results.length !== ids.length ||
    ids.some((id) => !byId.has(id))
  )
    throw new Error(
      "Batch results must contain exactly one result per requested note. " +
        JSON.stringify({
          expected: ids,
          missing: ids.filter((id) => !byId.has(id)),
          unexpected: [...byId.keys()].filter((id) => !expected.has(id)),
          duplicates: [...duplicates],
        }),
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
export const editionReviewSchema = Type.Omit(verdictSchema, ["correction"]);
export type EditionReview = Static<typeof editionReviewSchema>;
export const correctnessSchema = object({
  ...verdictSchema.properties,
  premises: Type.Array(text, {
    description:
      "Unresolved external results used in the argument. Exclude explicit hypothetical antecedents, task-granted assumptions, and declared supporting notes.",
  }),
});
export type Correctness = Static<typeof correctnessSchema>;
export const statementSchema = object({
  statement: text,
  premises: Type.Array(text, {
    description:
      "Source-checked external results only. Explicit hypothetical antecedents belong in the statement; task-granted assumptions and declared support are not external premises.",
  }),
});
export const proofSchema = object({ proof: text, complete: Type.Boolean() });
const passageSchema = object({
  premise: Type.Integer({ minimum: 0 }),
  url: text,
  quote: text,
});
const sourceProperties = {
  ...verdictSchema.properties,
  // Codex structured output requires every field; null means no correction.
  correction: Type.Union([noteContentSchema, Type.Null()]),
};
export const sourceSchema = object({
  ...sourceProperties,
  passages: Type.Array(
    Type.Union([
      passageSchema,
      object({ premise: passageSchema.properties.premise, passageId: text }),
    ]),
  ),
});
export const reviewSchema = object({
  ...sourceProperties,
  passages: Type.Array(passageSchema),
  premises: Type.Array(text),
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
const editPlan = object({ kind: Type.Literal("editor") });
const workPlans = [explorePlan, verifyPlan, literaturePlan, editPlan] as const;
export const planSchema = (literature: boolean, editing = false) =>
  object({
    work: Type.Array(
      Type.Unsafe<Static<(typeof workPlans)[number]>>(
        Type.Union(
          workPlans.filter(
            (schema) =>
              (schema !== literaturePlan || literature) &&
              (schema !== editPlan || editing),
          ),
        ),
      ),
      { minItems: 1 },
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
export const editingSchema = object({
  notes: Type.Array(noteDraftSchema),
  retained: Type.Array(text, {
    uniqueItems: true,
    description:
      "Existing note IDs kept unchanged. Their declared support is retained automatically. Rewritten notes must use fresh local IDs.",
  }),
  report: text,
});
export type Editing = Static<typeof editingSchema>;
export type EditorInput = SolverInput & {
  previous?: Note[];
  review?: EditionReview;
};
export type EditionReviewInput = SolverInput & { previous: Note[] };
export type VerifierInput = SolverInput & {
  targets: { id: string; through: VerificationStage }[];
  evidence?: SourceEvidence[];
};
export type ReconstructionInput = SolverInput & { targets: string[] };
export type SolverResult =
  ({ kind: "notes" } & Exploration) | { kind: "verification"; checks: Check[] };

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
