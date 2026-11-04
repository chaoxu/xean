// Policy derived from Xean v1.0.0 (949a385), with closure reconstruction.
import { z } from "zod";
import { noteOrder } from "./support";

export const nonblank = z.string().refine((value) => value.trim().length > 0, {
  message: "must contain non-whitespace text",
});
const noteId = nonblank;

export const applicationId = "xean-solve";

export type RoleName = "explorer" | "selection" | "verifier";
const establishingVerifiers = ["source", "correctness"] as const;
/** The verifiers in the order they run; selection asks for a prefix of this order. */
export const verifierNames = [
  ...establishingVerifiers,
  "requirements",
  "reconstruction",
] as const;
export type VerifierName = (typeof verifierNames)[number];
export const establishes = (passed: (name: VerifierName) => boolean) =>
  establishingVerifiers.every(passed);
/** The submit tool for each mathematical assignment. */
export const submissionTools = {
  explorer: "submit_notes",
  selection: "select_verification",
  verifier: "submit_verdict",
  statement: "submit_statement",
  proof: "submit_proof",
} as const satisfies Readonly<Record<RoleName | "statement" | "proof", string>>;

export const task = z.strictObject({
  problem: nonblank,
  completionCriteria: nonblank,
});
export type Task = z.output<typeof task>;

// INCONCLUSIVE leaves a check unresolved without marking the note defective.
export const verdict = z.strictObject({
  verifier: z.enum(verifierNames),
  note: noteId,
  verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  report: nonblank,
});
export type Verdict = z.output<typeof verdict>;
export const invalidatesNote = ({ verifier, verdict }: Verdict) =>
  verdict === "FAIL" && verifier !== "requirements";

const supportIds = z
  .array(noteId)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "support ids must be distinct",
  });
// The projection derives the flags from verifier evidence, caller attestations,
// and support edges. A note is verified after source and correctness pass or
// external verification is supplied, over verified support, and is not dead.
// It is dead when correctness, source, or reconstruction failed it or its support
// is dead, so it can never be verified. A note is accepted when one
// verification passed every verifier.
export const externalVerification = z.strictObject({
  source: nonblank,
  report: nonblank,
});

const summaries = {
  summary: nonblank.optional(),
  detailedSummary: nonblank.optional(),
};

export const submittedNotes = z.strictObject({
  notes: z
    .array(
      z.strictObject({
        ...summaries,
        text: nonblank,
        support: supportIds,
        verification: externalVerification.optional(),
      }),
    )
    .min(1),
});

export const note = z.strictObject({
  id: noteId,
  ...summaries,
  text: nonblank,
  support: supportIds,
  verdicts: z.array(verdict),
  verified: z.boolean(),
  dead: z.boolean(),
  verification: externalVerification.optional(),
});
export type Note = z.output<typeof note>;

function distinctKnown(
  known: ReadonlySet<string>,
  ids: readonly string[],
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  message = "references must name distinct known notes",
): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!known.has(id) || seen.has(id)) {
      ctx.addIssue({ code: "custom", message, path: [...path] });
    }
    seen.add(id);
  }
}

export type ExplorerInput = {
  task: Task;
  explorerGuidance: string;
  namespace: string;
  notes: Omit<Note, "text" | "detailedSummary">[];
};

export const explorerResult = z.strictObject({
  notes: z
    .array(
      z.strictObject({
        ...summaries,
        summary: nonblank,
        text: nonblank,
        support: z.array(noteId),
      }),
    )
    .min(1),
});

/** Each submission keeps its namespace and local note positions across retries. */
export function noteIdAfter(namespace: string, position: number): string {
  return `${namespace}.${position + 1}`;
}

/**
 * Support names a live note the explorer received or an earlier note of the
 * same turn. Mathematical verification checks whether that support suffices;
 * validation does not infer dependencies from the note's prose or notation.
 */
export function explorerResultFor(
  notes: readonly Pick<Note, "id" | "dead">[],
  namespace: string,
) {
  return explorerResult.superRefine((value, ctx) => {
    const allowed = new Set(
      notes.filter(({ dead }) => !dead).map(({ id }) => id),
    );
    for (const [position, entry] of value.notes.entries()) {
      distinctKnown(
        allowed,
        entry.support,
        ctx,
        ["notes", position, "support"],
        "support must name distinct notes that are not dead",
      );
      allowed.add(noteIdAfter(namespace, position));
    }
  });
}

export type SelectionInput = {
  task: Task;
  notes: Note[];
  claimed: string[];
  verifyOnSolution?: boolean;
};

/** One entry of a verify list: a note and the verifiers to run on it, a prefix of the verifier order. */
const verification = z
  .strictObject({
    note: noteId,
    verifiers: z.array(z.enum(verifierNames)).min(1),
  })
  .refine(
    (value) =>
      value.verifiers.every((name, index) => name === verifierNames[index]),
    {
      message: `verifiers must be a prefix of ${verifierNames.join(", ")}`,
      path: ["verifiers"],
    },
  );
export type Verification = z.output<typeof verification>;

export const selectionResult = z.strictObject({
  verify: z.array(verification),
});

export function selectionResultFor(
  notes: readonly Pick<Note, "id" | "support" | "verified" | "dead">[],
) {
  const known = new Set(notes.map(({ id }) => id));
  const verified = new Set(
    notes.filter(({ verified }) => verified).map(({ id }) => id),
  );
  return selectionResult.superRefine((value, ctx) => {
    distinctKnown(
      known,
      value.verify.map(({ note }) => note),
      ctx,
      ["verify"],
    );
    // A note is verified only over verified support: every note in its
    // support is verified already or listed earlier with the correctness
    // verifier, so it is verified in the same verification first.
    const listedWithCorrectness = new Set<string>();
    for (const [index, entry] of value.verify.entries()) {
      const target = notes.find(({ id }) => id === entry.note);
      if (target === undefined) continue;
      if (target.dead) {
        ctx.addIssue({
          code: "custom",
          message: "a dead note is not verified again",
          path: ["verify", index, "note"],
        });
      }
      if (
        target.support.some(
          (id) => !verified.has(id) && !listedWithCorrectness.has(id),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "a note is verified only after every note in its support is verified or listed earlier with the correctness verifier",
          path: ["verify", index, "note"],
        });
      }
      if (establishes((name) => entry.verifiers.includes(name))) {
        listedWithCorrectness.add(entry.note);
      }
    }
  });
}

export type VerifierInput = {
  task: Task;
  verify: Verification[];
  notes: Note[];
  support: Note[];
  order: string[];
};
export type ReconstructionPremise = Statement["statements"][number] &
  Pick<Note, "support">;
export type ReconstructionInput = Pick<
  VerifierInput,
  "task" | "notes" | "support" | "order"
> & { premises?: ReconstructionPremise[] };

export function pick<T extends { readonly id: string }>(
  notes: readonly T[],
  id: string,
): T {
  const found = notes.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`unknown note ${id}`);
  return found;
}

/**
 * Requested roots whose preceding checks and support permit the next verifier.
 * Joint reconstruction expands these roots separately, so supporting lemmas
 * need no requirements PASS or explicit reconstruction request.
 */
export function judgedBy(
  input: Pick<VerifierInput, "verify" | "notes" | "support" | "order">,
  recorded: readonly Verdict[],
  verifier: VerifierName,
): string[] {
  const known = new Map(
    [...input.notes, ...input.support].map((note) => [note.id, note]),
  );
  const preceding = verifierNames.slice(0, verifierNames.indexOf(verifier));
  const supportChecks = establishingVerifiers.filter((name) =>
    preceding.includes(name),
  );
  const passes = new Set<string>();
  const failures = new Set<string>();
  for (const value of recorded) {
    if (!preceding.includes(value.verifier)) continue;
    if (value.verdict === "PASS") passes.add(`${value.note}/${value.verifier}`);
    if (invalidatesNote(value)) failures.add(value.note);
  }
  const dead = new Set<string>(),
    supported = new Set<string>();
  const order = noteOrder(input.order.map((id) => ({ id })));
  for (const note of [...known.values()].sort((a, b) => order(a.id, b.id))) {
    if (
      note.dead ||
      failures.has(note.id) ||
      note.support.some((id) => dead.has(id))
    )
      dead.add(note.id);
    if (
      !dead.has(note.id) &&
      note.support.every(
        (id) =>
          !dead.has(id) &&
          (known.get(id)?.verified === true ||
            (supported.has(id) &&
              supportChecks.every((name) => passes.has(`${id}/${name}`)))),
      )
    )
      supported.add(note.id);
  }
  return input.verify
    .filter(
      (entry) =>
        entry.verifiers.includes(verifier) &&
        preceding.every((name) => passes.has(`${entry.note}/${name}`)) &&
        !dead.has(entry.note) &&
        supported.has(entry.note),
    )
    .map(({ note }) => note);
}

/** Checks without a verdict within one candidate. */
export function missingVerdicts(
  recorded: readonly Verdict[],
  name: VerifierName,
  notes: readonly string[],
): string[] {
  return notes.filter(
    (note) =>
      !recorded.some((value) => value.verifier === name && value.note === note),
  );
}

/** Binds a verdict list to the notes one call judges: one verdict per note under verification. */
function verdictsOver<T extends z.ZodType<{ note: string }>>(
  entry: T,
  judged: readonly string[],
) {
  // Keep the provider schema stable across candidates. The runtime still
  // requires exactly the requested note IDs, once each, before recording.
  return z
    .strictObject({ verdicts: z.array(entry) })
    .refine((value) => exactIds(value.verdicts, judged), {
      message: "one verdict per note under verification",
      path: ["verdicts"],
    });
}

export function verdictsFor(judged: readonly string[]) {
  return verdictsOver(verdict.omit({ verifier: true }), judged);
}

const statementEntry = z.strictObject({ note: noteId, statement: nonblank });
/** Exact claims to prove, with generated notes kept as obligations. */
export const statement = z.strictObject({
  statements: z.array(statementEntry).min(1),
});
export type Statement = z.output<typeof statement>;

const exactIds = (
  entries: readonly { note: string }[],
  expected: readonly string[],
) => {
  const ids = new Set(entries.map(({ note }) => note));
  return (
    entries.length === expected.length &&
    ids.size === entries.length &&
    expected.every((id) => ids.has(id))
  );
};

export function statementsFor(judged: readonly string[]) {
  return statement.refine((value) => exactIds(value.statements, judged), {
    message: "one statement per note under reconstruction",
    path: ["statements"],
  });
}

/** Full-batch verdicts, or a complete replacement statement array without verdicts. */
export const reconstructionResult = z
  .strictObject({
    statements: z.array(statementEntry),
    verdicts: z.array(verdict.omit({ verifier: true })),
  })
  .refine(
    (value) =>
      value.statements.length > 0
        ? value.verdicts.length === 0
        : value.verdicts.length > 0,
    "return either all verdicts or a complete statement correction",
  );

export function reconstructionResultFor(judged: readonly string[]) {
  return reconstructionResult.refine(
    (value) =>
      exactIds(
        value.statements.length ? value.statements : value.verdicts,
        judged,
      ),
    "one entry per note under reconstruction",
  );
}

/** Joint proof from the statement batch and admitted source premises. */
export const proof = z.strictObject({ proof: nonblank });

/** What the source verifier confirmed: one entry per external result the text invokes. */
// A plain string in the schema because the provider's structured output
// rejects the JSON Schema "uri" format; the shape is checked after parsing.
export const sources = z.array(
  z.strictObject({
    result: nonblank,
    source: nonblank,
    url: z.string().refine((value) => URL.canParse(value), "must be a URL"),
  }),
);
const sourceVerdict = verdict.omit({ verifier: true }).extend({ sources });
/** The verdicts of one source call. */
export const sourceVerdicts = z.strictObject({
  verdicts: z.array(sourceVerdict),
});
export function sourceVerdictsFor(judged: readonly string[]) {
  return verdictsOver(sourceVerdict, judged);
}
