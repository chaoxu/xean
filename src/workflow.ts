import {
  BACKGROUND_CONTEXT as context,
  type Context,
} from "@earendil-works/chord/context";
import type { SingletonHandle, StoreSelf } from "@earendil-works/chord";
import { admitNotes, project, readNotebook } from "./state.ts";
import {
  copy,
  type Campaign,
  type ResearchData,
  type WorkerArgs,
  type WorkerRecord,
  type WorkerState,
} from "./records.ts";
import { claimOf, type createWorkers, type WorkerRequest } from "./workers.ts";
import { pick } from "./policy/contracts.ts";
import { supportClosure } from "./policy/support.ts";
export type { SourceExecutor } from "./workers.ts";

type Workers = ReturnType<typeof createWorkers>;
export type CampaignResult = {
  outcome: "accepted" | "turn-limit" | "call-failure";
  turns: number;
  accepted?: string;
  error?: string;
};
export const initialCampaign = (): Campaign => ({
  status: "pending",
  guidanceThrough: 0,
  publicationCount: -1,
  epoch: 0,
});
export const turns = (data: ResearchData) =>
  new Set(
    data.history
      .filter(
        (row) =>
          row.args.campaign &&
          row.args.work.kind === "explorer" &&
          row.status === "completed",
      )
      .map((row) => row.origin),
  ).size;
const origin = (row: { id: string; args: WorkerArgs }) =>
  row.args.origin ?? row.id;
const latest = (history: WorkerRecord[]) => [
  ...new Map(history.map((row) => [row.origin, row])).values(),
];

/** A selection consumes its actual batch; a declined offer waits for new knowledge. */
function consumed(
  records: readonly {
    args: WorkerArgs;
    state: WorkerState;
    result?: WorkerRecord["result"];
  }[],
  epoch: number,
  nominated: ReadonlySet<string>,
) {
  const ids = new Set<string>();
  for (const row of records) {
    if (row.args.epoch !== epoch) continue;
    const { work } = row.args;
    const claim = claimOf(row);
    if (claim) for (const entry of claim.verify) ids.add(entry.note);
    else if (work.kind === "selector" && row.result?.status === "no-work")
      for (const id of work.verify?.map(({ note }) => note) ??
        work.input.notes.map(({ id }) => id))
        if (!nominated.has(id) || work.input.nominatedSupport?.includes(id))
          ids.add(id);
  }
  return ids;
}

/** Chord delivers completion changes serially; this callback only decides research policy. */
export function createWorkflow(
  self: StoreSelf,
  data: SingletonHandle<ResearchData>,
  workers: Workers,
  abortRoles: (origins: ReadonlySet<string>, ctx: Context) => Promise<void>,
) {
  const blocked = () =>
    workers.running.value.filter((row) => row.phase === "blocked");
  const wake = self.derive([data, workers.running], ([value, running]) => ({
    campaign: value.campaign,
    settled: value.history.length,
    blocked: running.filter((row) => row.phase === "blocked"),
    claimed: running.flatMap((row) =>
      row.phase === "blocked"
        ? []
        : (claimOf(row)?.verify.map(({ note }) => note) ?? []),
    ),
  }));
  self.on(wake, async (_, ctx) => {
    const advance = (cleaned = false) =>
      self.tx(async (tx) => {
        const saved = await tx.draft(data);
        const campaign = saved.campaign;
        if (!saved.definition || !campaign || campaign.status === "terminal")
          return;
        campaign.status = "running";
        const unavailableJobs = blocked();
        if (unavailableJobs.length) {
          campaign.error = unavailableJobs
            .map(({ id, reason }) => `Worker ${id} blocked: ${reason}`)
            .join("\n");
          if (workers.running.value.length === unavailableJobs.length) {
            campaign.status = "terminal";
            campaign.outcome = "call-failure";
          }
          return;
        }
        const view = workers.views();
        const active = view.active;
        const liveOrigins = new Set(active.map(origin));
        const failed = latest(saved.history).filter(
          (row) =>
            row.args.campaign &&
            row.status === "failed" &&
            !liveOrigins.has(row.origin),
        );
        const { settings } = saved.definition;
        admitNotes(saved.notebook);
        const book = readNotebook(saved.notebook),
          { notes, accepted } = project(book);
        if (campaign.publicationCount !== saved.notebook.publications.length) {
          campaign.publicationCount = saved.notebook.publications.length;
          campaign.epoch++;
        }
        if (failed.length || campaign.error || accepted.length) {
          const unresolved = new Set([
            ...view.claimed,
            ...view.offered,
            ...failed.flatMap(
              (row) => claimOf(row)?.verify.map(({ note }) => note) ?? [],
            ),
          ]);
          const candidate = accepted.find((id) =>
            [id, ...supportClosure([pick(notes, id)], notes)].every(
              (note) => !unresolved.has(note),
            ),
          );
          if (
            candidate &&
            !campaign.error &&
            active.every((row) => row.args.campaign)
          ) {
            if (!cleaned)
              return {
                jobs: active.map(({ id }) => id),
                origins: new Set([
                  ...saved.history
                    .filter((row) => row.args.campaign)
                    .map((row) => row.origin),
                  ...active.map(origin),
                ]),
              };
          }
          if (active.length) return;
          campaign.status = "terminal";
          if (!candidate || campaign.error) {
            campaign.outcome = "call-failure";
            campaign.error ??= failed
              .map((row) => row.error ?? `Worker ${row.id} failed`)
              .join("\n");
          } else {
            campaign.outcome = "accepted";
            campaign.accepted = candidate;
          }
          return;
        }
        const nominated = new Set(
          settings.verifyOnSolution ? view.nominatedSupport(notes) : [],
        );
        const unavailable = consumed(
          [...saved.history, ...active],
          campaign.epoch,
          nominated,
        );
        for (const id of [...view.claimed, ...view.offered])
          unavailable.add(id);
        const eligible = notes
          .filter((note) => !note.dead && !unavailable.has(note.id))
          .map(({ id }) => id);
        const free = settings.maxWorkers - active.length;
        const verifying = Math.min(free, eligible.length);
        const exploring = Math.max(
          0,
          Math.min(
            free - verifying,
            settings.maxExplorerTurns -
              turns(saved) -
              active.filter((row) => row.args.work.kind === "explorer").length,
          ),
        );
        const guidance = book.guidance
          .slice(campaign.guidanceThrough)
          .map(({ text }) => text)
          .join("\n\n");
        const requests: WorkerRequest[] = [
          ...Array.from({ length: verifying }, () => ({
            kind: "verifier" as const,
          })),
          ...Array.from({ length: exploring }, () => ({
            kind: "explorer" as const,
            guidance,
          })),
        ];
        if (exploring) campaign.guidanceThrough = book.guidance.length;
        if (requests.length)
          await workers.admit(tx, requests, {
            campaign: true,
            epoch: campaign.epoch,
            eligible,
          });
        else if (!active.length) {
          campaign.status = "terminal";
          campaign.outcome = "turn-limit";
        }
      }, ctx);
    try {
      const completion = await advance();
      if (completion) {
        if (blocked().length)
          throw new Error("Blocked native jobs require recovery");
        await Promise.all(
          completion.jobs.map((id) => workers.job.abort(id, ctx)),
        );
        await abortRoles(completion.origins, ctx);
        await advance(true);
      }
    } catch (error) {
      if (ctx.abortSignal?.aborted) return;
      await data.change((saved) => {
        if (!saved.campaign) return;
        saved.campaign.error =
          error instanceof Error ? error.message : String(error);
        if (!workers.running.value.length) {
          saved.campaign.status = "terminal";
          saved.campaign.outcome = "call-failure";
        }
      }, ctx);
    }
  });
  return {
    async wait(ctx: Context = context): Promise<CampaignResult> {
      const watch = await data.watch(ctx);
      const result = Promise.withResolvers<CampaignResult>();
      const check = (value: ResearchData) => {
        const campaign = value.campaign;
        if (!campaign) throw new Error("Campaign is not initialized");
        if (campaign.status === "terminal") {
          result.resolve(
            copy({
              outcome: campaign.outcome!,
              turns: turns(value),
              ...(campaign.accepted ? { accepted: campaign.accepted } : {}),
              ...(campaign.error ? { error: campaign.error } : {}),
            }),
          );
          void watch.stop();
          return true;
        }
        return false;
      };
      try {
        if (check(watch.value)) return await result.promise;
        watch.start(async (event) => {
          if (event.kind === "value") check(event.value);
          else result.reject(event.error);
        });
        void watch.closed.then((end) => {
          if (end.kind !== "stopped")
            result.reject(new Error("Campaign owner closed before settlement"));
        });
        return await result.promise;
      } finally {
        await watch.stop();
      }
    },
    resume: () =>
      self.tx(async (tx) => {
        const saved = await tx.draft(data),
          campaign = saved.campaign;
        if (!campaign) throw new Error("Campaign is not initialized");
        if (campaign.status !== "terminal") return;
        if (campaign.outcome !== "call-failure")
          throw new Error("Campaign has no failed work to resume");
        if (blocked().length)
          throw new Error("Blocked native jobs require repair before resume");
        const failed = latest(saved.history).filter(
          (row) => row.args.campaign && row.status === "failed",
        );
        campaign.status = "running";
        delete campaign.outcome;
        delete campaign.error;
        delete campaign.accepted;
        if (failed.length)
          await workers.admit(
            tx,
            failed.map((row) => ({ kind: "retry", job: row.id })),
            { campaign: true, epoch: campaign.epoch },
          );
      }, context),
  };
}
