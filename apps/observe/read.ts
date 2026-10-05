import { Type, type Static } from "typebox";
import { inspect } from "../../src/host.ts";
import { readReport } from "../../src/report.ts";
import { snapshot, summary, type Snapshot, type Summary } from "./snapshot.ts";

export const sourceSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$" }),
    database: Type.String({ minLength: 1, pattern: "\\S" }),
  },
  { additionalProperties: false },
);
export type Source = Static<typeof sourceSchema>;
export type Run = Source & {
  observedAt: string;
  stale?: boolean;
  snapshot?: Snapshot;
  summary?: Summary;
  error?: string;
};

/** Read live state through a fresh Session without ownership or recovery. */
export async function readRun(source: Source, compact = false): Promise<Run> {
  const run: Run = { ...source, observedAt: new Date().toISOString() };
  try {
    const report = await inspect(source.database, readReport, { live: true });
    if (compact) run.summary = summary(report);
    else run.snapshot = snapshot(report);
  } catch (error) {
    run.error = String(error);
  }
  return run;
}
