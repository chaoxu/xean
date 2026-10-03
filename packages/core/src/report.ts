import type {
  CallIdentity,
  Campaign,
  EntryId,
  JsonValue,
  RecordProjection,
  Work,
  Xean,
} from "./index.ts";
import {
  isSolverCampaign,
  closure,
  project,
  stagePassed,
  verdict,
} from "./solve/notes.ts";
import { verificationStages } from "./solve/contracts.ts";
import { Type, type Static, type TSchema } from "typebox";

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const counts = Type.Record(Type.String(), count);
const textLimit = 500;
const itemLimit = 10;
const diagnostic = Type.Union([
  Type.String({ maxLength: textLimit }),
  Type.Null(),
]);
const page = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item, { maxItems: itemLimit }),
    omitted: count,
  });
const workSchema = Type.Script(
  { Count: count },
  `{ id: string, role: string, status: string, attempts: Count }`,
);
const modelSchema = Type.Script(
  { Count: count, Numbers: Type.Record(Type.String(), Type.Number()) },
  `{
    provider: string, model: string, api?: string,
    admitted: Count, settled: Count, unknownUsage: Count, unsettled: Count,
    reportedUsage: Numbers
  }`,
);

/** The compact report's shared wire contract, also used for saved observations. */
export const statusSchema = Type.Script(
  {
    Count: count,
    Counts: counts,
    Diagnostic: diagnostic,
    Activity: page(workSchema),
    Failures: page(
      Type.Object({ ...workSchema.properties, error: diagnostic }),
    ),
    Models: Type.Array(modelSchema, { maxItems: itemLimit }),
    Issues: page(
      Type.Object({
        noteId: Type.String(),
        stage: Type.String(),
        verdict: Type.String(),
        report: diagnostic,
      }),
    ),
  },
  `{
  status: string, error: Diagnostic, work: Counts, pendingSignals: Count,
  acceptedNoteId: string | null, activity: Activity, failures: Failures,
  notes?: Counts, verification?: Record<string, Counts>,
  nextAction?: string, verificationIssues?: Issues,
  calls: {
    admitted: Count,
    settled: Count, unknownUsage: Count, unsettled: Count,
    byModel: Models, byModelOmitted: Count
  },
  usageNote: string
}`,
);

/** Diagnostic previews share one limit across status surfaces. */
export function statusText(value: string | null | undefined): string | null {
  return value == null
    ? null
    : value.length > textLimit
      ? `${value.slice(0, textLimit - 1)}…`
      : value;
}

const preview = <T, R>(items: readonly T[], select: (item: T) => R) => ({
  items: items.slice(0, itemLimit).map(select),
  omitted: Math.max(0, items.length - itemLimit),
});
const workMetadata = ({ id, role, status, attempts }: Work) => ({
  id,
  role,
  status,
  attempts,
});

/** Project mathematical notes once for reports built from the same snapshot. */
export function campaignReport(snapshot: {
  campaign: Campaign;
  records?: Awaited<ReturnType<Xean["records"]>>;
}) {
  return {
    ...snapshot,
    ...(isSolverCampaign(snapshot.campaign)
      ? { notes: project(snapshot.campaign) }
      : {}),
  };
}

/** Status needs call metadata, without retaining prompts or response bodies. */
export const usageRecord: RecordProjection = (
  entry,
): ReturnType<RecordProjection> => {
  const data = entry.data as Record<string, JsonValue>;
  if (entry.kind === "xean.call.started")
    return { ...entry, data: { model: data.model! } };
  if (entry.kind === "xean.call.settled")
    return {
      ...entry,
      data: { callId: data.callId!, usage: data.usage ?? null },
    };
  return undefined;
};

function usageGroup({ provider, id, api }: CallIdentity) {
  return {
    provider,
    model: id,
    api,
    admitted: 0,
    settled: 0,
    unknownUsage: 0,
    reportedUsage: Object.create(null) as Record<string, number>,
  };
}
type UsageGroup = ReturnType<typeof usageGroup>;

/** Summarize one coherent kernel snapshot without reconciling provider bills. */
export function statusReport({
  campaign,
  records = [],
  notes = isSolverCampaign(campaign) ? project(campaign) : undefined,
}: ReturnType<typeof campaignReport>): Static<typeof statusSchema> {
  const groups = new Map<string, UsageGroup>();
  const calls = new Map<EntryId, UsageGroup>();
  for (const entry of records) {
    if (entry.kind === "xean.call.started") {
      const { model } = entry.data as unknown as { model: CallIdentity };
      const key = JSON.stringify([model.provider, model.id, model.api]);
      const group = groups.get(key) ?? usageGroup(model);
      groups.set(key, group);
      group.admitted++;
      calls.set(entry.id, group);
    } else if (entry.kind === "xean.call.settled") {
      const { callId, usage } = entry.data as {
        callId: EntryId;
        usage: unknown;
      };
      const group = calls.get(callId);
      if (!group) throw new Error(`Call settlement lacks admission: ${callId}`);
      calls.delete(callId);
      group.settled++;
      const fields =
        usage && typeof usage === "object" && !Array.isArray(usage)
          ? Object.entries(usage).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === "number" && Number.isFinite(entry[1]),
            )
          : [];
      if (fields.length === 0) group.unknownUsage++;
      for (const [field, value] of fields)
        group.reportedUsage[field] = (group.reportedUsage[field] ?? 0) + value;
    }
  }
  const byModel = [...groups.values()].map((group) => ({
    ...group,
    unsettled: group.admitted - group.settled,
  }));
  const settled = byModel.reduce((total, group) => total + group.settled, 0);
  const work = { queued: 0, active: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const item of campaign.work) work[item.status]++;
  const solver = isSolverCampaign(campaign);
  const result = campaign.result as { noteId?: unknown } | null;
  const imported = notes?.filter((note) => note.imported).length ?? 0;
  const nextAction = {
    blocked:
      "Resolve the reported Coordinator failure, then resume the campaign.",
    pausing:
      "Check whether the owner is still active. An active owner will finish draining; an interrupted owner requires recovery.",
    paused: "Resume the campaign when ready.",
    cancelled: "This campaign is cancelled. Start a new campaign to continue.",
    completed: solver
      ? "Export the accepted argument. Independent review remains a separate step."
      : "This campaign completed.",
    running: undefined,
  }[campaign.status];
  const issues: {
    noteId: string;
    stage: string;
    verdict: string;
    report: string | null;
  }[] = [];
  const candidates = new Set(
    notes
      ?.filter((note) => note.candidate && !note.accepted)
      .map((note) => note.id),
  );
  for (const note of closure([...candidates], notes ?? [])) {
    for (const stage of verificationStages) {
      if (
        !candidates.has(note.id) &&
        (stage === "requirements" ||
          (stage === "reconstruction" && note.imported))
      )
        continue;
      if (stagePassed(note, stage)) continue;
      const result = verdict(note, stage);
      issues.push({
        noteId: note.id,
        stage,
        verdict: result?.verdict ?? "unchecked",
        report: statusText(result?.report),
      });
    }
  }
  return {
    status: campaign.status,
    error: statusText(campaign.error),
    ...(nextAction ? { nextAction } : {}),
    ...(issues.length
      ? { verificationIssues: preview(issues, (issue) => issue) }
      : {}),
    work,
    pendingSignals: campaign.pendingSignals,
    acceptedNoteId:
      solver &&
      campaign.status === "completed" &&
      typeof result?.noteId === "string"
        ? result.noteId
        : null,
    activity: preview(
      ["active", "queued"].flatMap((status) =>
        campaign.work.filter((item) => item.status === status),
      ),
      workMetadata,
    ),
    failures: preview(
      campaign.work.filter((item) => item.status === "failed").reverse(),
      (item) => ({
        ...workMetadata(item),
        error: statusText(item.error),
      }),
    ),
    ...(notes
      ? {
          notes: {
            total: notes.length,
            imported,
            generated: notes.length - imported,
            verified: notes.filter((note) => note.verified).length,
            dead: notes.filter((note) => note.dead).length,
            accepted: notes.filter((note) => note.accepted).length,
            candidates: notes.filter((note) => note.candidate).length,
          },
          verification: Object.fromEntries(
            verificationStages.map((stage) => {
              const counts = {
                PASS: 0,
                FAIL: 0,
                INCONCLUSIVE: 0,
                trusted: 0,
                unchecked: 0,
              };
              for (const note of notes) {
                const checked = verdict(note, stage);
                counts[
                  checked?.verdict ??
                    (stagePassed(note, stage) ? "trusted" : "unchecked")
                ]++;
              }
              return [stage, counts] as const;
            }),
          ),
        }
      : {}),
    calls: {
      admitted: campaign.providerCalls,
      settled,
      unknownUsage: byModel.reduce(
        (total, group) => total + group.unknownUsage,
        0,
      ),
      unsettled: campaign.providerCalls - settled,
      byModel: byModel.slice(0, itemLimit),
      byModelOmitted: Math.max(0, byModel.length - itemLimit),
    },
    usageNote:
      "Reported native counts may be partial and fields overlap. Codex internal requests and provider bills are not reconciled. Price estimates are omitted.",
  };
}
