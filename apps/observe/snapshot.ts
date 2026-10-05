import type { Report } from "../../src/report.ts";

export type Summary = Pick<Report, "task" | "status">;
export type Snapshot = Summary &
  Pick<Report, "kind" | "notes" | "work" | "result">;

export function summary({ task, status }: Summary): Summary {
  return { task, status };
}

export function snapshot(report: Report): Snapshot {
  return {
    ...summary(report),
    kind: report.kind,
    notes: report.notes,
    work: report.work,
    ...(report.result === undefined ? {} : { result: report.result }),
  };
}
