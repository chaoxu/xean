import { taskSchema, type SolverResult, type Task } from "xean/solve";
import { campaignReport, statusReport, statusSchema } from "xean/report";
import { Type } from "typebox";
import { Value } from "typebox/value";

const snapshotFormat = "xean-observe/v4" as const;

export function snapshot(
  value: Parameters<typeof campaignReport>[0],
  observedAt = new Date().toISOString(),
) {
  const report = campaignReport(value);
  return snapshotFromReport(
    { ...report, status: statusReport(report) },
    observedAt,
  );
}

/** Reuse notes and usage already projected from the same inspection. */
export function snapshotFromReport(
  {
    campaign,
    records,
    notes,
    status,
  }: ReturnType<typeof campaignReport> & {
    status: ReturnType<typeof statusReport>;
  },
  observedAt = new Date().toISOString(),
) {
  const declaration = campaign.task as { kind?: string; task?: Task } | null;
  return {
    schema: snapshotFormat,
    kind:
      typeof declaration?.kind === "string" && declaration.kind.trim()
        ? declaration.kind
        : null,
    observedAt,
    // A generic kernel task may contain an unrelated field named task.
    task:
      notes !== undefined ||
      declaration?.kind === "xean.role" ||
      declaration?.kind === "xean.review"
        ? (declaration?.task ?? null)
        : null,
    status,
    usageAvailable: records !== undefined,
    notes: notes ?? [],
    work: campaign.work.map(
      ({ id, role, status, attempts, error, publicationId, input, result }) => {
        // Generic kernel work has no mathematical result contract.
        const output =
          notes !== undefined && status === "completed"
            ? (result as SolverResult)
            : undefined;
        const request = input as {
          guidance?: unknown;
          query?: unknown;
          assignment?: unknown;
        } | null;
        const guidance =
          notes !== undefined
            ? role === "xean.explorer"
              ? request?.guidance
              : role === "xean.literature"
                ? request?.query
                : role === "xean.codex"
                  ? request?.assignment
                  : null
            : null;
        return {
          id,
          role,
          status,
          attempts,
          error,
          publicationId,
          guidance: typeof guidance === "string" ? guidance : null,
          noteIds:
            output?.kind === "notes"
              ? output.notes.map((note) => `${id}/${note.id}`)
              : output?.kind === "verification"
                ? [...new Set(output.checks.map((check) => check.noteId))]
                : [],
          checkCount:
            output?.kind === "verification" ? output.checks.length : 0,
        };
      },
    ),
    result: campaign.result,
  };
}
export type Snapshot = ReturnType<typeof snapshot>;

const summarySchema = Type.Object({
  observedAt: Type.String(),
  usageAvailable: Type.Boolean(),
  status: statusSchema,
});
export function readSummary(value: unknown) {
  if (!Value.Check(summarySchema, value))
    throw new Error("Malformed compact observation");
  const { observedAt, usageAvailable, status } = value;
  const summary = structuredClone({ observedAt, usageAvailable, status });
  Value.Clean(summarySchema, summary);
  return summary;
}
export type Summary = ReturnType<typeof readSummary>;

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const verdict = Type.Script(
  `{ verdict: "PASS" | "FAIL" | "INCONCLUSIVE", report: string }`,
);
const source = Type.Union([
  Type.Object(verdict.properties, { additionalProperties: false }),
  Type.Script(
    { Verdict: verdict, Count: count },
    `Verdict & {
    kind: "codex-report", operationId: string, reportedAt: string,
    premises: string[],
    passages: { id: string, statement: string, premise: Count, url: string, quote: string }[]
  }`,
  ),
]);
// These are renderer guards, not a second mathematical verification contract.
const check = Type.Script(
  { Verdict: verdict, Source: source },
  `{
  noteId: string,
  correctness?: Verdict & { premises: string[] },
  source?: Source,
  requirements?: Verdict,
  reconstruction?: Verdict & { statement: string, proof: string }
}`,
);
const snapshotSchema = Type.Unsafe<Snapshot>(
  Type.Script(
    { Task: taskSchema, Count: count, Check: check, Status: statusSchema },
    `{
    schema: "${snapshotFormat}",
    kind: string | null,
    observedAt: string,
    usageAvailable: boolean,
    task: Task | null,
    status: Status,
    notes: {
      id: string, summary: string, detailedSummary: string, text: string,
      support: string[],
      revision: Count, checks: Check[],
      imported: boolean, candidate: boolean, verified: boolean,
      dead: boolean, accepted: boolean
    }[],
    work: {
      id: string, role: string, status: string, attempts: Count, error: string | null,
      publicationId: Count | null, guidance: string | null, noteIds: string[], checkCount: Count
    }[]
  }` as string,
  ),
);

export function readSnapshot(value: unknown): Snapshot {
  if (!Value.Check(snapshotSchema, value))
    throw new Error("Unsupported observation schema or malformed snapshot");
  const status = structuredClone(value.status);
  Value.Clean(statusSchema, status);
  return { ...value, status };
}
