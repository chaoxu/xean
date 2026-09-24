import type { Entry, EntryId, Reader, RecordQuery } from "xean";

/** The same projection reads a live journal or an already captured snapshot. */
export type RecordSource = Pick<
  Reader,
  "record" | "records" | "scan" | "lastSequence"
>;

export function recordSource(
  input: RecordSource | readonly Entry[],
): RecordSource {
  if (!Array.isArray(input)) return input as RecordSource;
  const entries = new Map(input.map((entry: Entry) => [entry.seq, entry]));
  const source: RecordSource = {
    record: (seq) => entries.get(seq),
    lastSequence: () => input.at(-1)?.seq ?? 0,
    records: (query) => [...source.scan(query)],
    *scan(query = {}) {
      for (const entry of input as readonly Entry[]) {
        if (query.kinds && !query.kinds.includes(entry.kind)) continue;
        if (query.after !== undefined && entry.seq <= query.after) continue;
        if (query.through !== undefined && entry.seq > query.through) continue;
        if (
          query.parent !== undefined &&
          (!("parent" in entry) || entry.parent !== query.parent)
        )
          continue;
        if (
          query.call !== undefined &&
          (!("call" in entry) || entry.call !== query.call)
        )
          continue;
        const owner =
          entry.kind === "call-result" ? entries.get(entry.parent) : entry;
        const label = owner?.kind === "call" ? owner.label : undefined;
        if (
          query.labels &&
          (label === undefined || !query.labels.includes(label))
        )
          continue;
        if (
          query.excludeLabels &&
          label !== undefined &&
          query.excludeLabels.includes(label)
        )
          continue;
        yield entry;
      }
    },
  };
  return source;
}

/** Every lookup in a derivation observes the same journal prefix. */
export function historyAt(source: RecordSource, through: number): RecordSource {
  const bounded = (query: RecordQuery = {}) => ({
    ...query,
    through: Math.min(query.through ?? through, through),
  });
  return {
    record: (seq: EntryId) => (seq <= through ? source.record(seq) : undefined),
    records: (query) => source.records(bounded(query)),
    scan: (query) => source.scan(bounded(query)),
    lastSequence: () => through,
  };
}
