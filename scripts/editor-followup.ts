import assert from "node:assert/strict";

/** Experiment-only scheduling adapter; all roles and acceptance remain native. */
export function followup(options: any, seed: any, feedback: any) {
  const coordinator = options.coordinator;
  const coverage = new Set<string>(seed.coverageIds);
  const forbidden = new Set<string>(feedback.replaceMathematicallyDefectiveIds);
  const review = (previous?: any, retained: string[] = []) => ({
    verdict: "FAIL",
    report: [
      feedback.review.report,
      ...(previous
        ? [`Native corpus review of the current proposal:\n${previous.report}`]
        : []),
      ...(retained.length
        ? [
            `The current replacement still contains these independently identified defective notes, directly or through retained support: ${JSON.stringify(retained)}. Repair their mathematics under fresh identities; do not retain them unchanged.`,
          ]
        : []),
    ].join("\n\n"),
  });
  return {
    ...options,
    coordinator: {
      ...coordinator,
      async run(...args: any[]) {
        const decision = await coordinator.run(...args);
        for (const work of decision.dispatch ?? []) {
          const value = work.input;
          if (work.role === "xean.editor") {
            const previous =
              value.previous ??
              seed.previousIds.map((id: string) => {
                const note = value.notes.find((note: any) => note.id === id);
                assert(note, `Seeded previous note is missing: ${id}`);
                return note;
              });
            work.input = {
              task: value.task,
              notes: value.notes.filter((note: any) => coverage.has(note.id)),
              previous,
              review: review(value.review),
            };
          } else if (work.role === "xean.editionReview") {
            const original = value.previous.filter((note: any) =>
              coverage.has(note.id),
            );
            const retained = value.notes
              .filter((note: any) => forbidden.has(note.id))
              .map((note: any) => note.id);
            if (retained.length) {
              work.role = "xean.editor";
              work.input = {
                task: value.task,
                notes: original,
                previous: value.notes,
                review: review(undefined, retained),
              };
            } else work.input = { ...value, previous: original };
          }
        }
        return decision;
      },
    },
  };
}
