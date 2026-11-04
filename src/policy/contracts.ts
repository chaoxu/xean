// Conditional local verification policy derived from Xean v1.0.0 (949a385).
import { z } from "zod";

export const nonblank = z.string().refine((value) => value.trim().length > 0, {
  message: "must contain non-whitespace text",
});
const noteId = nonblank;

export const applicationId = "xean-solve";

export type RoleName = "explorer" | "selection" | "verifier";
const establishingVerifiers = ["source", "correctness"] as const;
const localVerifiers = ["source", "correctness", "reconstruction"] as const;
/** The verifiers in the order they run; selection asks for a prefix of this order. */
export const verifierNames = [
  ...establishingVerifiers,
  "requirements",
  "reconstruction",
] as const;
export type VerifierName = (typeof verifierNames)[number];
export const establishes = (passed: (name: VerifierName) => boolean) =>
  localVerifiers.every(passed);
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
// and support edges. `checked` means that source, correctness, and
// reconstruction passed for the note in one attempt (or an external
// attestation supplied the result). `verified` additionally requires every
// declared support note to be verified and the note not to be dead. A note is
// dead when its own source, correctness, or reconstruction check failed, or a
// support note is dead. Acceptance still requires all four verifiers in one
// attempt.
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
  checked: z.boolean(),
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

/** One entry of a verify list: a note and a local-check prefix. */
const verification = z
  .strictObject({
    note: noteId,
    verifiers: z.array(z.enum(verifierNames)).min(1),
  })
  .refine(
    (value) =>
      value.verifiers.every((name, index) => name === verifierNames[index]) ||
      value.verifiers.every((name, index) => name === localVerifiers[index]),
    {
      message: "verifiers must be a valid local-check prefix",
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
  return selectionResult.superRefine((value, ctx) => {
    distinctKnown(
      known,
      value.verify.map(({ note }) => note),
      ctx,
      ["verify"],
    );
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
    }
  });
}

export type VerifierInput = {
  task: Task;
  verify: Verification[];
  notes: Note[];
  support: Note[];
};
export type ReconstructionInput = Pick<
  VerifierInput,
  "task" | "notes" | "support"
>;

/** IDs extracted as exact claims: selected roots followed by direct premises. */
export function reconstructionStatementIds(
  input: ReconstructionInput,
): string[] {
  return [...input.notes, ...input.support].map(({ id }) => id);
}

export function pick<T extends { readonly id: string }>(
  notes: readonly T[],
  id: string,
): T {
  const found = notes.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`unknown note ${id}`);
  return found;
}

/**
 * Requested roots whose own preceding checks permit the next verifier.
 * Declared support is conditional input for local checks; dependency status is
 * resolved by projection after the local receipt rather than gating this call.
 */
export function judgedBy(
  input: Pick<VerifierInput, "verify" | "notes" | "support">,
  recorded: readonly Verdict[],
  verifier: VerifierName,
): string[] {
  const known = new Map(
    [...input.notes, ...input.support].map((note) => [note.id, note]),
  );
  const preceding =
    verifier === "reconstruction"
      ? (["source", "correctness"] as readonly VerifierName[])
      : (verifierNames.slice(
          0,
          verifierNames.indexOf(verifier),
        ) as readonly VerifierName[]);
  const passes = new Set<string>();
  const failures = new Set<string>();
  for (const value of recorded) {
    if (!preceding.includes(value.verifier)) continue;
    if (value.verdict === "PASS") passes.add(`${value.note}/${value.verifier}`);
    if (invalidatesNote(value)) failures.add(value.note);
  }
  const dead = new Set<string>();
  for (const note of known.values())
    if (note.dead || failures.has(note.id)) dead.add(note.id);
  return input.verify
    .filter(
      (entry) =>
        entry.verifiers.includes(verifier) &&
        preceding.every((name) => passes.has(`${entry.note}/${name}`)) &&
        !dead.has(entry.note),
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

export function reconstructionResultFor(
  roots: readonly string[],
  statements: readonly string[] = roots,
) {
  return reconstructionResult.refine(
    (value) =>
      value.statements.length
        ? exactIds(value.statements, statements)
        : exactIds(value.verdicts, roots),
    `Return verdicts only for selected target IDs: ${roots.join(", ")}. Statement corrections must cover IDs: ${statements.join(", ")}.`,
  );
}

/** Separately scoped conditional proofs for the selected statement batch. */
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
