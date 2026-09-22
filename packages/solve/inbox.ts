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
   * throughout. With `unchangedSince`, return undefined instead of appending
   * once the journal has grown past that sequence, so a caller can validate
   * against a captured prefix and retry.
   */
  async function appendLocked(
    path: string,
    campaign: Campaign,
    request: R,
  ): Promise<Receipt>;
  async function appendLocked(
    path: string,
    campaign: Campaign,
    request: R,
    options: { readonly unchangedSince: EntryId },
  ): Promise<Receipt | undefined>;
  async function appendLocked(
    path: string,
    campaign: Campaign,
    request: R,
    options: { readonly unchangedSince?: EntryId } = {},
  ): Promise<Receipt | undefined> {
    let pending: ReturnType<Campaign["call"]>;
    {
      using lock = new Database(`${realpathSync(path)}.inbox.lock`, {
        create: true,
      });
      lock.run("PRAGMA busy_timeout = 5000");
      lock.run("BEGIN EXCLUSIVE");
      const prior = existing(
        campaign.records({ kinds: ["call"], labels: [receiptLabel] }),
        request,
      );
      if (prior !== undefined) return prior;
      if (
        options.unchangedSince !== undefined &&
        campaign.lastSequence() !== options.unchangedSince
      )
        return undefined;
      // call() appends the request synchronously before its first await.
      // Release the lock after that append, so retrying an id cannot append
      // it twice.
      pending = campaign.call(
        { label: receiptLabel, request: jsonSnapshot(request) },
        async () => null,
      );
    }
    const result = await pending;
    return receipts([campaign.record(result.call)!])[0]!;
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

  return { receipts, boundaries, at, existing, append, appendLocked, freeze };
}
