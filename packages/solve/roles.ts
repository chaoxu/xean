import {
  returnedToolSubmission,
  type Entry,
  type EntryId,
  type Json,
  type Reader,
} from "xean";
import { z } from "zod";

import { byId, supportClosure } from "./support";

export const nonblank = z.string().refine((value) => value.trim().length > 0, {
  message: "must contain non-whitespace text",
});
const noteId = z.string().regex(/^n[1-9][0-9]*$/u);

export const applicationId = "xean-solve";
export const workflowProtocol = "workflow";

/** Rejects a journal that is not a current solver campaign before its declaration is read. */
export function assertApplication(
  declaration: Entry | undefined,
): asserts declaration is Extract<Entry, { readonly kind: "campaign" }> {
  if (
    declaration?.kind !== "campaign" ||
    declaration.application !== applicationId
  ) {
    throw new Error("not a current Xean solver journal");
  }
}

/** Workflow semantics use role calls and receipts, never provider checkpoint payloads. */
export function workflowRecords(reader: Reader): readonly Entry[] {
  return reader.records({ excludeLabels: ["xean/pi-request"] });
}

/** One role call's durable submission and settlement, without other calls' outputs. */
export function roleCallRecords(
  reader: Reader,
  call: EntryId,
): readonly Entry[] {
  const through = reader.lastSequence();
  const owner = reader.record(call);
  const results = reader.records({
    kinds: ["call-result"],
    parent: call,
    through,
  });
  const settledThrough = results[0]?.seq ?? through;
  const tools = reader.records({
    kinds: ["tool-call"],
    call,
    through: settledThrough,
  });
  const toolIds = new Set(tools.map(({ seq }) => seq));
  return [
    ...(owner === undefined ? [] : [owner]),
    ...tools,
    ...reader
      .records({ kinds: ["tool-result"], after: call, through: settledThrough })
      .filter(
        (entry) => entry.kind === "tool-result" && toolIds.has(entry.parent),
      ),
    ...results,
  ].sort((left, right) => left.seq - right.seq);
}
export const roleNames = [
  "explorer",
  "coordinator",
  "literature",
  "verifier",
] as const;
export type RoleName = (typeof roleNames)[number];
/** The verifiers in the order they run; the coordinator asks for a prefix of this order. */
export const verifierNames = [
  "correctness",
  "source",
  "requirements",
  "reconstruction",
] as const;
export type VerifierName = (typeof verifierNames)[number];
export const roleLabels = {
  explorer: `${applicationId}/explorer`,
  coordinator: `${applicationId}/coordinator`,
  literature: `${applicationId}/literature`,
  verifier: `${applicationId}/verifier`,
} as const satisfies Readonly<Record<RoleName, string>>;
export const verifierLabels = {
  source: `${roleLabels.verifier}/source`,
  correctness: `${roleLabels.verifier}/correctness`,
  requirements: `${roleLabels.verifier}/requirements`,
  reconstruction: `${roleLabels.verifier}/reconstruction`,
} as const satisfies Readonly<Record<VerifierName, string>>;
/** The reconstruction verifier's two calls before its verdict: their labels and submit tools. */
export const reconstructionCalls = {
  statement: {
    label: `${verifierLabels.reconstruction}/statement`,
    tool: "submit_statement",
  },
  proof: {
    label: `${verifierLabels.reconstruction}/proof`,
    tool: "submit_proof",
  },
} as const;
export const roleTools = {
  explorer: "submit_notes",
  coordinator: "submit_coordination",
  verifier: "submit_verdict",
} as const satisfies Readonly<Record<Exclude<RoleName, "literature">, string>>;

export function verifierFromLabel(label: string): VerifierName | undefined {
  return verifierNames.find(
    (name) =>
      verifierLabels[name] === label ||
      label.startsWith(`${verifierLabels[name]}/`),
  );
}

export function roleFromLabel(label: string): RoleName | undefined {
  if (verifierFromLabel(label) !== undefined) return "verifier";
  return roleNames.find((name) => roleLabels[name] === label);
}

export function jsonSnapshot(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

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

const distinctSupport = [
  (value: { readonly support: readonly (string | number)[] }) =>
    new Set(value.support).size === value.support.length,
  { message: "support ids must be distinct", path: ["support"] },
] as [
  (value: { readonly support: readonly (string | number)[] }) => boolean,
  { message: string; path: string[] },
];
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

export const submittedNotes = z.strictObject({
  notes: z
    .array(
      z
        .strictObject({
          text: nonblank,
          support: z.array(z.union([noteId, z.number().int().positive()])),
          verification: externalVerification.optional(),
        })
        .refine(...distinctSupport),
    )
    .min(1)
    .superRefine((notes, context) => {
      notes.forEach((note, position) => {
        note.support.forEach((reference, index) => {
          if (typeof reference === "number" && reference > position) {
            context.addIssue({
              code: "custom",
              path: [position, "support", index],
              message:
                "local support must name an earlier note in this submission (one-based)",
            });
          }
        });
      });
    }),
});

const noteFields = z.strictObject({
  id: noteId,
  summary: nonblank.optional(),
  text: nonblank,
  support: z.array(noteId),
  verdicts: z.array(verdict),
  verified: z.boolean(),
  dead: z.boolean(),
  verification: externalVerification.optional(),
});
export const note = noteFields.refine(...distinctSupport);
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

/** Notes returned by literature discovery; support names earlier notes of the same response by one-based position. */
const literatureNotes = z
  .array(
    z.strictObject({
      text: nonblank,
      support: z.array(z.number().int().positive()),
    }),
  )
  .superRefine((notes, context) => {
    for (const [position, note] of notes.entries()) {
      const seen = new Set<number>();
      for (const [index, support] of note.support.entries()) {
        if (support > position || seen.has(support)) {
          context.addIssue({
            code: "custom",
            path: [position, "support", index],
            message:
              "literature support must name a distinct earlier note in this submission",
          });
        }
        seen.add(support);
      }
    }
  });

export const literatureReport = z.strictObject({ notes: literatureNotes });
export type LiteratureReport = z.output<typeof literatureReport>;

/** Whether the coordinator has attempted or completed literature discovery. */
export const literatureStatus = z.enum([
  "not-started",
  "completed",
  "inconclusive",
]);
export type LiteratureStatus = z.output<typeof literatureStatus>;

/** Structured scheduling policy plus optional coordinator instructions. */
export const coordinatorBehavior = z.strictObject({
  literature: z.enum(["optional", "never", "required-if-not-started"]),
  verification: z.enum(["decide", "always"]),
  instructions: nonblank.optional(),
});
export type CoordinatorBehavior = z.output<typeof coordinatorBehavior>;

/**
 * The campaign policy new campaigns freeze unless their settings supply one.
 * It carries no prose: instructions are caller-only, so the frozen
 * declaration never changes with prompt wording.
 */
export const defaultCoordinatorBehavior: CoordinatorBehavior = {
  literature: "never",
  verification: "decide",
};

export const literatureInput = z.strictObject({
  task,
  request: nonblank,
});
export type LiteratureInput = z.output<typeof literatureInput>;

export const explorerInput = z
  .strictObject({
    task,
    explorerGuidance: z.string(),
    notes: z.array(noteFields.omit({ text: true }).refine(...distinctSupport)),
    support: z.array(note),
  })
  .superRefine((value, ctx) => {
    distinctKnown(
      new Set(value.notes.map(({ id }) => id)),
      value.support.map(({ id }) => id),
      ctx,
      ["support"],
    );
  });
export type ExplorerInput = z.output<typeof explorerInput>;

export const explorerResult = z.strictObject({
  notes: z.array(z.strictObject({ text: nonblank, support: z.array(noteId) })),
  solution: z.boolean(),
});
export type ExplorerResult = z.output<typeof explorerResult>;

/** The explorer's notes are numbered after the notes it received, in order. */
export function noteIdAfter(count: number, position: number): string {
  return `n${count + position + 1}`;
}

/**
 * Support names a live note the explorer received or an earlier note of the
 * same turn. Mathematical verification checks whether that support suffices;
 * validation does not infer dependencies from the note's prose or notation.
 */
export function explorerResultFor(notes: readonly Pick<Note, "id" | "dead">[]) {
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
      allowed.add(noteIdAfter(notes.length, position));
    }
  });
}

export const coordinatorInput = z.strictObject({
  task,
  notes: z.array(note),
  literatureStatus: literatureStatus.default("not-started"),
  coordinatorBehavior: coordinatorBehavior.default(defaultCoordinatorBehavior),
  emptySubmission: z.literal(true).optional(),
  /**
   * No note has been added since the last completed verification, so the
   * verifier action is unavailable.
   */
  afterVerification: z.literal(true).optional(),
});
export type CoordinatorInput = z.output<typeof coordinatorInput>;

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

/** The coordinator's choice of the role that runs next. */
export const coordinatorAction = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("explorer") }),
  z.strictObject({ role: z.literal("literature"), request: nonblank }),
  z.strictObject({ role: z.literal("verifier") }),
]);
export type CoordinatorAction = z.output<typeof coordinatorAction>;
const actionRoles = ["explorer", "literature", "verifier"] as const;

export const coordinatorResult = z
  .strictObject({
    filings: z.array(z.strictObject({ note: noteId, summary: nonblank })),
    // Guidance and full-note support are consumed only when the coordinator
    // dispatches Explorer.  Verifier and literature dispatches return to a
    // fresh coordinator before either field could be used.
    explorerGuidance: nonblank.optional(),
    support: z.array(noteId).optional(),
    verify: z.array(verification),
    action: coordinatorAction,
  })
  .superRefine((value, ctx) => {
    if (
      value.action.role === "explorer" &&
      value.explorerGuidance === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message: "an explorer action must provide explorer guidance",
        path: ["explorerGuidance"],
      });
    }
    if (value.action.role === "explorer" && value.support === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "an explorer action must provide support",
        path: ["support"],
      });
    }
    if (value.action.role !== "explorer") {
      if (value.explorerGuidance !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "non-Explorer actions must omit explorer guidance",
          path: ["explorerGuidance"],
        });
      }
      if (value.support !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: "non-Explorer actions must omit support",
          path: ["support"],
        });
      }
    }
  });
export type CoordinatorResult = z.output<typeof coordinatorResult>;

/**
 * The coordinator submission schema over these notes. `allowedActions` lists
 * the roles the frozen coordinator behavior permits next, the submission must
 * choose one of them, and `requiredVerification` lists the notes that
 * behavior requires in the verify list.
 */
export function coordinatorResultFor(
  notes: readonly Pick<
    Note,
    "id" | "summary" | "support" | "verified" | "dead"
  >[],
  allowedActions: readonly CoordinatorAction["role"][] = actionRoles,
  requiredVerification: readonly string[] = [],
) {
  const known = new Set(notes.map(({ id }) => id));
  const withoutSummary = new Set(
    notes.filter(({ summary }) => summary === undefined).map(({ id }) => id),
  );
  const verified = new Set(
    notes.filter(({ verified }) => verified).map(({ id }) => id),
  );
  return coordinatorResult.superRefine((value, ctx) => {
    if (!allowedActions.includes(value.action.role)) {
      ctx.addIssue({
        code: "custom",
        message: `the action must be among: ${allowedActions.join(", ")}`,
        path: ["action"],
      });
    }
    if (value.action.role === "verifier" && value.verify.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "a verifier action must list a note to verify",
        path: ["verify"],
      });
    }
    if (value.action.role !== "verifier" && value.verify.length > 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "an explorer or literature action cannot carry a verification list",
        path: ["verify"],
      });
    }
    const listed = new Set(value.verify.map(({ note }) => note));
    const missing = requiredVerification.filter((id) => !listed.has(id));
    if (missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `the coordinator behavior requires verifying every unverified live note without a verdict over verified support; missing: ${missing.join(", ")}`,
        path: ["verify"],
      });
    }
    const filed = new Set<string>();
    for (const [index, filing] of value.filings.entries()) {
      if (!withoutSummary.has(filing.note) || filed.has(filing.note)) {
        ctx.addIssue({
          code: "custom",
          message: "each note without a summary must be filed exactly once",
          path: ["filings", index, "note"],
        });
      }
      filed.add(filing.note);
    }
    if (filed.size !== withoutSummary.size) {
      ctx.addIssue({
        code: "custom",
        message: `all ${withoutSummary.size} notes without a summary must be filed`,
        path: ["filings"],
      });
    }
    distinctKnown(known, value.support ?? [], ctx, ["support"]);
    distinctKnown(
      known,
      value.verify.map(({ note }) => note),
      ctx,
      ["verify"],
    );
    // A note is verified only over verified support: every note in its
    // support is verified already or listed earlier with the source
    // verifier, so it is verified in the same verification first.
    const listedWithSource = new Set<string>();
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
          (id) => !verified.has(id) && !listedWithSource.has(id),
        )
      ) {
        ctx.addIssue({
          code: "custom",
          message:
            "a note is verified only after every note in its support is verified or listed earlier with the source verifier",
          path: ["verify", index, "note"],
        });
      }
      if (entry.verifiers.includes("source")) {
        listedWithSource.add(entry.note);
      }
    }
  });
}

export const verifierInput = z
  .strictObject({
    task,
    verify: z.array(verification).min(1),
    notes: z.array(note),
    support: z.array(note),
  })
  .superRefine(async (value, ctx) => {
    const listed = value.verify.map(({ note }) => note);
    if (new Set(listed).size !== listed.length) {
      ctx.addIssue({
        code: "custom",
        message: "verify must list distinct notes",
        path: ["verify"],
      });
    }
    if (value.notes.map(({ id }) => id).join(",") !== listed.join(",")) {
      ctx.addIssue({
        code: "custom",
        message: "notes must be the notes listed in verify, in order",
        path: ["notes"],
      });
    }
    let closure: string[];
    try {
      closure = await supportClosure(value.notes, [
        ...value.notes,
        ...value.support,
      ]);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
        path: ["support"],
      });
      return;
    }
    if (value.support.map(({ id }) => id).join(",") !== closure.join(",")) {
      ctx.addIssue({
        code: "custom",
        message:
          "support must be the complete transitive support of the notes outside them, in id order",
        path: ["support"],
      });
    }
  });
export type VerifierInput = z.output<typeof verifierInput>;

export function pick<T extends { readonly id: string }>(
  notes: readonly T[],
  id: string,
): T {
  const found = notes.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`unknown note ${id}`);
  return found;
}

const verifierIndex = (name: VerifierName): number =>
  verifierNames.indexOf(name);

/**
 * The notes one verifier judges in a verification, in the order listed,
 * given the verdicts recorded on its candidate: the notes that asked for it,
 * passed every verifier before it, and are not dead in the verification. A
 * note is dead in the verification when correctness, source, or
 * reconstruction failed it or a note in its support, listed or handed over in
 * full, is dead. The
 * verifiers that judge their notes in one call judge from the verdicts of the
 * verifiers before them; reconstruction judges one note at a time, also from
 * the reconstruction verdicts of the notes listed before it.
 */
export function judgedBy(
  input: Pick<VerifierInput, "verify" | "notes" | "support">,
  recorded: readonly Verdict[],
  verifier: VerifierName,
): string[] {
  const position = new Map(
    input.verify.map(({ note }, index) => [note, index]),
  );
  const known = new Map(
    [...input.notes, ...input.support].map((note) => [note.id, note]),
  );
  const judged: string[] = [];
  const passes = new Set<string>();
  const failures = new Set<string>();
  const deadMemo = new Map<string, boolean>();
  const supportMemo = new Map<string, boolean>();
  let evidenceReady = false;
  for (const [index, entry] of input.verify.entries()) {
    if (!entry.verifiers.includes(verifier)) continue;
    // Ordinary verifiers share one evidence view for the entire list.
    // Reconstruction also sees earlier notes' reconstruction verdicts.
    if (!evidenceReady || verifier === "reconstruction") {
      passes.clear();
      failures.clear();
      deadMemo.clear();
      supportMemo.clear();
      const prior = recorded.filter(
        (value) =>
          verifierIndex(value.verifier) < verifierIndex(verifier) ||
          (verifier === "reconstruction" &&
            value.verifier === "reconstruction" &&
            (position.get(value.note) ?? Number.POSITIVE_INFINITY) < index),
      );
      for (const value of prior) {
        if (value.verdict === "PASS")
          passes.add(`${value.note}/${value.verifier}`);
        if (value.verifier !== "requirements" && value.verdict === "FAIL")
          failures.add(value.note);
      }
      evidenceReady = true;
    }
    const passed = (id: string, name: VerifierName): boolean =>
      passes.has(`${id}/${name}`);
    const dead = (id: string): boolean => {
      const saved = deadMemo.get(id);
      if (saved !== undefined) return saved;
      const result =
        failures.has(id) || (known.get(id)?.support ?? []).some(dead);
      deadMemo.set(id, result);
      return result;
    };
    const supportPassed = (id: string): boolean => {
      const saved = supportMemo.get(id);
      if (saved !== undefined) return saved;
      const result = (known.get(id)?.support ?? []).every(
        (support) =>
          known.get(support)?.verified === true ||
          (verifierNames
            .slice(0, Math.min(verifierIndex(verifier), 2))
            .every((name) => passed(support, name)) &&
            supportPassed(support)),
      );
      supportMemo.set(id, result);
      return result;
    };
    if (deadMemo.size === 0) {
      for (const id of [...known.keys()].sort(byId)) {
        dead(id);
        supportPassed(id);
      }
    }
    if (
      verifierNames
        .slice(0, verifierIndex(verifier))
        .every((name) => passed(entry.note, name)) &&
      !dead(entry.note) &&
      supportPassed(entry.note)
    ) {
      judged.push(entry.note);
    }
  }
  return judged;
}

/** Whether every reachable check has a verdict, including INCONCLUSIVE. */
export function verificationComplete(
  input: Pick<VerifierInput, "verify" | "notes" | "support">,
  recorded: readonly Verdict[],
): boolean {
  return verifierNames.every(
    (name) =>
      missingVerdicts(recorded, name, judgedBy(input, recorded, name))
        .length === 0,
  );
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
function verdictsOver<T extends z.ZodRawShape & { note: z.ZodString }>(
  entry: z.ZodObject<T>,
  judged: readonly string[],
) {
  const expected = [...judged].sort(byId).join(",");
  // Keep the provider schema stable across candidates. The runtime still
  // requires exactly the requested note IDs, once each, before recording.
  return z.strictObject({ verdicts: z.array(entry) }).refine(
    (value) =>
      (
        value as unknown as {
          readonly verdicts: readonly { readonly note: string }[];
        }
      ).verdicts
        .map(({ note }) => note)
        .sort(byId)
        .join(",") === expected,
    {
      message: "one verdict per note under verification",
      path: ["verdicts"],
    },
  );
}

/** The verdicts of one correctness or requirements call. */
export const verdicts = z.strictObject({
  verdicts: z.array(verdict.omit({ verifier: true })),
});
export function verdictsFor(judged: readonly string[]) {
  return verdictsOver(verdict.omit({ verifier: true }), judged);
}

/** Exact external premises identified while checking the complete argument. */
export const externalResults = z
  .array(nonblank)
  .refine(
    (values) => new Set(values).size === values.length,
    "external results must be distinct",
  );
const correctnessVerdict = verdict
  .omit({ verifier: true })
  .extend({ externalResults });
export const correctnessVerdicts = z.strictObject({
  verdicts: z.array(correctnessVerdict),
});
export function correctnessVerdictsFor(judged: readonly string[]) {
  return verdictsOver(correctnessVerdict, judged);
}

/** A note verdict, or a corrected statement with no mathematical verdict. */
export const reconstructionResult = z
  .strictObject({
    statement: nonblank.nullable(),
    verdicts: z.array(verdict.omit({ verifier: true })).max(1),
  })
  .refine(
    (value) => value.verdicts.length === (value.statement === null ? 1 : 0),
    "return either one verdict or a corrected statement",
  );

export function reconstructionResultFor(noteId: string) {
  return reconstructionResult.refine(
    (value) => value.verdicts.every(({ note }) => note === noteId),
    "verdict must name the note under verification",
  );
}

/** What a text establishes, with nothing of how: one or several propositions. */
export const statement = z.strictObject({ statement: nonblank });
export type Statement = z.output<typeof statement>;

/** The proof the reconstruction verifier writes from the statement and the support notes alone. */
export const proof = z.strictObject({ proof: nonblank });

/** A source page and the passage read there. */
// A plain string in the schema because the provider's structured output
// rejects the JSON Schema "uri" format; the shape is checked after parsing.
export const sourceLocation = {
  source: nonblank,
  url: z.string().refine((value) => URL.canParse(value), "must be a URL"),
  quote: nonblank,
};
/** One inspected passage, bound by `resultId` to an assigned external result, including evidence of a mismatch. */
const passage = (resultId: z.ZodType<string>) =>
  z.strictObject({ resultId, result: nonblank, ...sourceLocation });
/** Passages inspected by the source verifier, each bound to an assigned external result. */
export const sources = z.array(passage(nonblank));
/** The journaled shape of one source submission, before its evidence is judged against the assigned premises. */
export const sourceSubmission = z.strictObject({
  verdicts: z.array(verdict.omit({ verifier: true }).extend({ sources })),
});

/** The external premises a completed correctness check assigned to each judged note. */
export type AssignedExternalResults = readonly {
  readonly note: string;
  readonly externalResults: readonly string[];
}[];

/** The ID of one assigned premise within one source call: its note and one-based position, as `n4#1`. */
function premiseId(note: string, position: number): string {
  return `${note}#${position + 1}`;
}

/** Every premise of one source call under its ID, in note order. */
export function assignedPremises(assigned: AssignedExternalResults) {
  return assigned.flatMap(({ note, externalResults }) =>
    externalResults.map((result, position) => ({
      note,
      resultId: premiseId(note, position),
      result,
    })),
  );
}

/** One source verdict per judged note, before evidence binding. */
export function sourceVerdictsOver(judged: readonly string[]) {
  return verdictsOver(sourceSubmission.shape.verdicts.element, judged);
}

/**
 * Whether one source verdict's passages bind to its note's assigned premise
 * IDs, with a passage for every ID on PASS. The output schema already limits
 * IDs to this call's; a PASS missing a passage remains possible.
 */
export function sourceVerdictBinds(
  verdict: z.output<typeof sourceSubmission>["verdicts"][number],
  assigned: AssignedExternalResults,
): boolean {
  const expected = assigned.find(({ note }) => note === verdict.note);
  if (expected === undefined) return false;
  const ids = assignedPremises([expected]).map(({ resultId }) => resultId);
  const sourceIds = verdict.sources.map(({ resultId }) => resultId);
  return (
    sourceIds.every((id) => ids.includes(id)) &&
    (verdict.verdict !== "PASS" || ids.every((id) => sourceIds.includes(id)))
  );
}

/** The Codex output schema of one source call: verdicts over the judged notes, each passage bound to one of this call's premise IDs. */
export function sourceVerdictsFor(
  judged: readonly string[],
  assigned: AssignedExternalResults,
) {
  const ids = assignedPremises(assigned).map(({ resultId }) => resultId);
  return verdictsOver(
    verdict
      .omit({ verifier: true })
      .extend({ sources: z.array(passage(z.enum(ids))) }),
    judged,
  ).refine(
    (value) =>
      value.verdicts.every((verdict) => sourceVerdictBinds(verdict, assigned)),
    "source evidence must reference the assigned external premise IDs",
  );
}

export type VerifierResult = readonly Verdict[];

export function candidateMaterial(input: VerifierInput): Uint8Array {
  const text = [...input.notes, ...input.support]
    .map(({ id, text }) => `--- ${id} ---\n\n${text}`)
    .join("\n\n");
  return new TextEncoder().encode(text);
}

export interface JournalVerdict {
  readonly seq: EntryId;
  readonly candidate: EntryId;
  readonly verdict: Verdict;
}

// The kernel records one verdict per call, on the candidate. A verifier call
// judges one or several notes, so its kernel verdict is the verdict on the
// candidate, PASS only when every note it judged passed, and its evidence
// lists the verdict of each note. The projection reads the evidence.
const verdictEvidence = verdicts.extend({
  verdicts: verdicts.shape.verdicts.min(1),
});
export function candidateVerdict(
  values: readonly Pick<Verdict, "verdict">[],
): Verdict["verdict"] {
  if (values.every(({ verdict }) => verdict === "PASS")) return "PASS";
  return values.some(({ verdict }) => verdict === "FAIL")
    ? "FAIL"
    : "INCONCLUSIVE";
}

export function journalVerdicts(
  records: readonly Entry[],
): readonly JournalVerdict[] {
  const calls = new Map(
    records
      .filter((entry) => entry.kind === "call")
      .map((entry) => [entry.seq, entry]),
  );
  const verdicts: JournalVerdict[] = [];
  for (const entry of records) {
    if (entry.kind !== "verdict") continue;
    const call = calls.get(entry.call);
    const verifier =
      call?.kind === "call" ? verifierFromLabel(call.label) : undefined;
    if (call?.kind !== "call" || verifier === undefined) continue;
    const parsed = verdictEvidence.safeParse(entry.evidence);
    if (
      !parsed.success ||
      call.candidate === undefined ||
      candidateVerdict(parsed.data.verdicts) !== entry.verdict
    ) {
      throw new Error(`malformed verdict ${entry.seq}`);
    }
    for (const value of parsed.data.verdicts) {
      verdicts.push({
        seq: entry.seq,
        candidate: call.candidate,
        verdict: { verifier, ...value },
      });
    }
  }
  return verdicts;
}

/** The returned call-result of a call, if it settled by returning. */
export function returnedOutput(
  records: readonly Entry[],
  call: EntryId,
): { readonly settled: EntryId; readonly output: Json } | undefined {
  const result = records.find(
    (entry) => entry.kind === "call-result" && entry.parent === call,
  );
  return result?.kind === "call-result" && result.state === "returned"
    ? { settled: result.seq, output: result.output }
    : undefined;
}

/** Validated Explorer tool inputs are durable, even if the receipt or outer
 * call-result was interrupted. Numbering follows their journal order. */
export function savedExplorerSubmission(
  records: readonly Entry[],
  call: EntryId,
):
  | {
      readonly settled: EntryId;
      readonly input: ExplorerResult;
      readonly emptySubmission: boolean;
    }
  | undefined {
  const submissions = records.flatMap((entry) =>
    entry.kind === "tool-call" &&
    entry.call === call &&
    entry.tool === roleTools.explorer
      ? [
          {
            seq: entry.seq,
            value: explorerResult.parse(entry.input),
          },
        ]
      : [],
  );
  const last = submissions.at(-1);
  return last === undefined
    ? undefined
    : {
        settled: last.seq,
        emptySubmission: last.value.notes.length === 0,
        input: {
          notes: submissions.flatMap(({ value }) => value.notes),
          solution: last.value.solution,
        },
      };
}

export function succeededSubmission(
  records: readonly Entry[],
  call: EntryId,
  tool: string,
  savedExplorer?: ReturnType<typeof savedExplorerSubmission>,
): { readonly settled: EntryId; readonly input: Json } | undefined {
  const returned = returnedOutput(records, call);
  if (
    returned === undefined ||
    typeof returned.output !== "object" ||
    returned.output === null ||
    (returned.output as { readonly state?: Json }).state !== "succeeded"
  ) {
    return undefined;
  }
  try {
    if (tool === roleTools.explorer) {
      const saved = savedExplorer ?? savedExplorerSubmission(records, call);
      return saved === undefined
        ? undefined
        : { settled: returned.settled, input: saved.input };
    }
    return {
      settled: returned.settled,
      input: returnedToolSubmission(records, call, tool).input,
    };
  } catch {
    return undefined;
  }
}

export interface Roles {
  readonly explorer: (input: ExplorerInput) => Promise<ExplorerResult>;
  readonly coordinator: (
    input: z.input<typeof coordinatorInput>,
  ) => Promise<CoordinatorResult>;
  readonly literature: (
    input: LiteratureInput,
    after?: EntryId,
  ) => Promise<LiteratureReport>;
  readonly verifier: (
    input: VerifierInput,
    candidate?: EntryId,
  ) => Promise<VerifierResult>;
}
