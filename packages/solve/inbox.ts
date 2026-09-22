import { Database } from "bun:sqlite";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import type { Campaign, Entry, EntryId } from "xean";
import { z } from "zod";

import { jsonSnapshot, roleLabels } from "./roles";

// An inbox holds caller input, guidance or submitted notes, in the campaign
// until a boundary freezes it into the next role input. Its calls are local:
// they make no provider request and leave the workflow's stopping rules
// unchanged.

/** The boundaries that freeze submitted notes into the next coordinator input and guidance into the next Explorer input. */
export const boundaryLabels = {
  overlap: "xean-solve/overlap",
  inbox: "xean-solve/inbox-boundary",
} as const;

const boundaryRequest = z.strictObject({
  schemaVersion: z.literal(2),
  channel: z.enum(["notes", "guidance"]),
  after: z.number().int().positive(),
  through: z.number().int().positive(),
});

export function inbox<R extends { readonly id: string }>(
  channel: z.output<typeof boundaryRequest>["channel"],
  receiptSchema: z.ZodType<R>,
) {
  const receiptLabel = `xean-solve/${channel}`;
  const boundaryLabel = boundaryLabels.inbox;
  type Receipt = R & { readonly call: EntryId; readonly atMs: number };

  /** The call request is the durable receipt, including without its call-result. */
  function receipts(records: readonly Entry[]): Receipt[] {
    return records.flatMap((entry) =>
      entry.kind === "call" && entry.label === receiptLabel
        ? [
            {
              call: entry.seq,
              atMs: entry.atMs,
              ...receiptSchema.parse(entry.request),
            },
          ]
        : [],
    );
  }

  /** Boundaries in journal order, each with the receipts it froze: those after the previous boundary's `through`, up to its own. */
  function boundaries(records: readonly Entry[]) {
    const submitted = receipts(records);
    const seen = new Set<number>();
    let consumedThrough = 0;
    return records.flatMap((entry) => {
      if (entry.kind !== "call" || entry.label !== boundaryLabel) return [];
      const request = boundaryRequest.parse(entry.request);
      if (request.channel !== channel) return [];
      if (
        seen.has(request.after) ||
        request.after >= entry.seq ||
        request.through >= entry.seq ||
        request.through < request.after ||
        request.through < consumedThrough
      )
        throw new Error(`invalid or duplicate ${boundaryLabel} boundary`);
      seen.add(request.after);
      const included = submitted.filter(
        (receipt) =>
          receipt.call > consumedThrough && receipt.call <= request.through,
      );
      consumedThrough = request.through;
      return [{ call: entry.seq, ...request, receipts: included }];
    });
  }

  /** The boundary frozen at `after`, if any. */
  function at(records: readonly Entry[], after: EntryId) {
    return boundaries(records).find((boundary) => boundary.after === after);
  }

  /** Index each receipt's boundary and started role calls once for inspection. */
  function delivery(records: readonly Entry[]) {
    const bound = boundaries(records);
    const started = records.filter((entry) => entry.kind === "call");
    const bindings = bound.map((boundary, index) => {
      const coordinator = started.find(
        (entry) =>
          entry.seq > boundary.call && entry.label === roleLabels.coordinator,
      );
      const until = Math.min(
        coordinator?.seq ?? Infinity,
        bound[index + 1]?.call ?? Infinity,
      );
      const calls =
        channel === "notes"
          ? coordinator
            ? [coordinator.seq]
            : []
          : started
              .filter(
                (entry) =>
                  entry.label === roleLabels.explorer &&
                  entry.seq > boundary.call &&
                  entry.seq < until,
              )
              .map((entry) => entry.seq);
      return { ...boundary, calls };
    });
    return receipts(records).map((receipt) => ({
      receipt,
      binding: bindings.find((boundary) =>
        boundary.receipts.some((entry) => entry.call === receipt.call),
      ),
    }));
  }

  /** The receipt this id already has; a different request under the same id is an error. */
  function existing(
    records: readonly Entry[],
    request: R,
  ): Receipt | undefined {
    const receipt = receipts(records).find((entry) => entry.id === request.id);
    if (receipt !== undefined) {
      const { call: _, atMs: __, ...journaled } = receipt;
      if (!isDeepStrictEqual(journaled, jsonSnapshot(request)))
        throw new Error(
          `${receiptLabel}: id already has a different request: ${request.id}`,
        );
    }
    return receipt;
  }

  /** Append for a caller that already holds the runner lock. */
  async function append(campaign: Campaign, request: R): Promise<Receipt> {
    const prior = existing(
      campaign.records({ kinds: ["call"], labels: [receiptLabel] }),
      request,
    );
    if (prior !== undefined) return prior;
    const result = await campaign.call(
      { label: receiptLabel, request: jsonSnapshot(request) },
      async () => null,
    );
    return receipts([campaign.record(result.call)!])[0]!;
  }

  /**
   * Append under the short lock every submitter of this campaign shares; the
   * workflow keeps its independent runner lock and may be awaiting a provider
   * throughout. Validation uses a captured prefix outside that lock and
   * retries if the journal changes before appending.
   */
  async function appendLocked(
    path: string,
    campaign: Campaign,
    request: R,
    validate?: (records: readonly Entry[]) => Promise<void>,
  ): Promise<Receipt> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const through = campaign.lastSequence();
      if (validate !== undefined) {
        const records = campaign.records({
          excludeLabels: ["xean/pi-request"],
          through,
        });
        const prior = existing(records, request);
        if (prior !== undefined) return prior;
        await validate(records);
      }
      using lock = new Database(`${realpathSync(path)}.inbox.lock`, {
        create: true,
      });
      lock.run("PRAGMA busy_timeout = 5000");
      lock.run("BEGIN EXCLUSIVE");
      if (validate !== undefined && campaign.lastSequence() !== through) {
        const prior = existing(
          campaign.records({ kinds: ["call"], labels: [receiptLabel] }),
          request,
        );
        if (prior !== undefined) return prior;
        continue;
      }
      // append() writes before its first await; returning its promise releases
      // this lock while the local call settles.
      return append(campaign, request);
    }
    throw new Error(
      `campaign changed while validating ${channel}; retry the same id`,
    );
  }

  /**
   * Freeze the receipts pending at `after` into one boundary, once for all
   * retries of the same role input. Refuses when nothing is pending or a
   * boundary or role call after `after` has already started the next input.
   */
  async function freeze(campaign: Campaign, after: EntryId): Promise<boolean> {
    const through = campaign.lastSequence();
    const records = campaign.records({
      kinds: ["call"],
      labels: [
        receiptLabel,
        boundaryLabel,
        boundaryLabels.overlap,
        roleLabels.explorer,
        roleLabels.coordinator,
      ],
      through,
    });
    const consumedThrough = boundaries(records).at(-1)?.through ?? 0;
    if (
      !receipts(records).some((entry) => entry.call > consumedThrough) ||
      records.some(
        (entry) =>
          entry.kind === "call" &&
          entry.seq > after &&
          entry.label !== receiptLabel,
      )
    )
      return false;
    await campaign.call(
      {
        label: boundaryLabel,
        request: { schemaVersion: 2, channel, after, through },
      },
      async () => null,
    );
    return true;
  }

  return { receipts, delivery, at, append, appendLocked, freeze };
}
