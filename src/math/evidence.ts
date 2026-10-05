import type { Static } from "@earendil-works/pi-ai";
import {
  type ResearchReport,
  type SourceEvidence,
  type Task,
  type reviewSchema,
  type sourceSchema,
} from "./contracts.ts";
import { sourceEvidence } from "./notes.ts";

export const taskSource = "urn:xean:task";

/** Retain reported passages directly; web activity alone does not authenticate quotes. */
export function bindCodex(
  result: {
    value: Static<typeof sourceSchema> | Static<typeof reviewSchema>;
    operationId: string;
    searches: number;
    reportedAt?: string;
  },
  premises: readonly string[],
  evidence: readonly SourceEvidence[] = [],
  passagePrefix = result.operationId,
  task?: Task,
): ResearchReport {
  const { operationId, searches, value } = result;
  const fromTask = (passage: { url: string; quote: string }) =>
    passage.url === taskSource &&
    !!passage.quote.trim() &&
    [task?.problem, task?.completionCriteria].some((text) =>
      text?.includes(passage.quote),
    );
  const available = new Map(
    sourceEvidence([], evidence).map((passage) => [passage.id, passage]),
  );
  const passages = value.passages.flatMap((passage, index) => {
    const bound =
      "passageId" in passage
        ? available.get(passage.passageId)
        : searches > 0 || fromTask(passage)
          ? {
              id: `${passagePrefix}/${index}`,
              statement: premises[passage.premise]!,
              url: passage.url,
              quote: passage.quote,
            }
          : undefined;
    if (!bound) return [];
    const url = URL.parse(bound.url);
    const valid =
      (fromTask(bound) ||
        (url !== null &&
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password)) &&
      Number.isInteger(passage.premise) &&
      passage.premise >= 0 &&
      passage.premise < premises.length &&
      !!bound.quote.trim();
    return valid ? [{ ...bound, premise: passage.premise }] : [];
  });
  const valid = premises.every((_, index) =>
    passages.some((passage) => passage.premise === index),
  );
  return {
    ...value,
    premises: [...premises],
    passages,
    kind: "codex-report",
    operationId,
    reportedAt: result.reportedAt ?? new Date().toISOString(),
    ...(value.verdict === "PASS" && !valid
      ? {
          verdict: "INCONCLUSIVE",
          report: `Codex PASS lacked valid task or source evidence for every premise. ${value.report}`,
        }
      : {}),
  };
}
