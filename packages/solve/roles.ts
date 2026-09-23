import { isDeepStrictEqual } from "node:util";

import { type Entry, type EntryId, type Json, type Reader } from "xean";
import { z } from "zod";

import { byId, supportClosure } from "./support";

export const nonblank = z.string().refine((value) => value.trim().length > 0, {
  message: "must contain non-whitespace text",
});
const noteId = z.string().regex(/^n[1-9][0-9]*$/u);

export const applicationId = "xean-solve";
export const workflowProtocol = "workflow";

export const roleRequest = z.strictObject({
  protocol: z.literal("xean-solve/role/v1"),
  input: z.json(),
});
export const roleOutput = z.strictObject({
  state: z.literal("succeeded"),
  value: z.json(),
});

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
  correctedText: nonblank.optional(),
});
export type Verdict = z.output<typeof verdict>;

/** A PASS may approve a complete replacement text under the local-correction policy. */
function validCorrection(
  value: Pick<Verdict, "verdict" | "correctedText">,
): boolean {
  return value.correctedText === undefined || value.verdict === "PASS";
}

/** Apply only explicit approved replacements; original submissions stay in the journal. */
export function correctedText(
  text: string,
  verdicts: readonly Verdict[],
): string {
  for (const verdict of verdicts) {
    if (!validCorrection(verdict))
      throw new Error("only PASS may correct a note");
    if (verdict.correctedText !== undefined) text = verdict.correctedText;
  }
  return text;
}

const supportIds = <S extends z.ZodType>(reference: S) =>
  z
    .array(reference)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      "support ids must be distinct",
    );
// The projection derives the flags from verifier evidence, caller attestations,
// and support edges. A note is verified after source and correctness pass or
// external verification is supplied, over verified support, and is not dead.
// It is dead when correctness, source, or reconstruction failed it or its support
// is dead, so it can never be verified. A note is accepted when every verifier
// has passed; established checks may come from earlier dispatches.
export const externalVerification = z.strictObject({
  source: nonblank,
  report: nonblank,
});

const submittedNote = z.strictObject({
  text: nonblank,
  support: supportIds(z.union([noteId, z.number().int().positive()])),
  verification: externalVerification.optional(),
});

function earlierSupport(
  notes: readonly { readonly support: readonly (string | number)[] }[],
  context: z.RefinementCtx,
) {
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
}

export const submittedNotes = z.strictObject({
  notes: z.array(submittedNote).min(1).superRefine(earlierSupport),
});

export const note = z.strictObject({
  id: noteId,
  summary: nonblank.optional(),
  text: nonblank,
  support: supportIds(noteId),
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

/** Notes returned by literature discovery; support names earlier notes of the same response by one-based position. */
export const literatureReport = z.strictObject({
  notes: z
    .array(
      submittedNote.omit({ verification: true }).extend({
        support: supportIds(z.number().int().positive()),
      }),
    )
    .superRefine(earlierSupport),
});
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
  overlap: z.boolean().default(false),
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
  overlap: false,
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
    notes: z.array(note.omit({ text: true })),
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

/** The result of the visible checks on one note. */
function checkEvidence(verdicts: readonly Verdict[]) {
  const passed = new Set<VerifierName>(),
    failed = new Set<VerifierName>();
  for (const { verifier, verdict } of verdicts) {
    if (verdict === "PASS") passed.add(verifier);
    if (verdict === "FAIL") failed.add(verifier);
  }
  return {
    passed,
    failed,
    dead: [...failed].some((name) => name !== "requirements"),
  };
}

/** Outstanding checks in a requested prefix; an inconclusive check may be retried. */
export function pendingVerifiers(
  note: Pick<Note, "dead" | "verdicts">,
  requested: readonly VerifierName[],
): VerifierName[] {
  const evidence = checkEvidence(note.verdicts);
  return note.dead ||
    evidence.dead ||
    requested.some((name) => evidence.failed.has(name))
    ? []
    : requested.filter((name) => !evidence.passed.has(name));
}

type EvidenceNote = Pick<Note, "id" | "support"> &
  Partial<Pick<Note, "verification" | "verified" | "dead">>;

/** Reduce exactly the supplied evidence; callers choose its journal/stage prefix. */
export function noteEvidence(
  notes: readonly EvidenceNote[],
  verdicts: readonly Verdict[],
  supportChecks: readonly VerifierName[] = verifierNames.slice(0, 2),
) {
  const reports = new Map<string, Verdict[]>();
  for (const verdict of verdicts) {
    const history = reports.get(verdict.note) ?? [];
    history.push(verdict);
    reports.set(verdict.note, history);
  }
  const result = new Map<
    string,
    ReturnType<typeof checkEvidence> & {
      verdicts: Verdict[];
      verified: boolean;
      accepted: boolean;
      supportPassed: boolean;
    }
  >();
  // Support precedes its note. One pass handles shared and deep support alike.
  for (const note of [...notes].sort((a, b) => byId(a.id, b.id))) {
    const verdicts = reports.get(note.id) ?? [];
    const checks = checkEvidence(verdicts);
    const support = note.support.map((id) => result.get(id));
    const dead =
      note.dead === true || checks.dead || support.some((value) => value?.dead);
    const verified =
      !dead &&
      (note.verified === true ||
        note.verification !== undefined ||
        (checks.passed.has("correctness") && checks.passed.has("source"))) &&
      support.every((value) => value?.verified);
    result.set(note.id, {
      ...checks,
      verdicts,
      dead,
      verified,
      accepted:
        verified && verifierNames.every((name) => checks.passed.has(name)),
      supportPassed: support.every(
        (value) =>
          value !== undefined &&
          (value.verified ||
            (supportChecks.every((name) => value.passed.has(name)) &&
              value.supportPassed)),
      ),
    });
  }
  return result;
}

const explorerAction = z.strictObject({
  role: z.literal("explorer"),
  explorerGuidance: nonblank,
  support: z.array(noteId),
});
const literatureAction = z.strictObject({
  role: z.literal("literature"),
  request: nonblank,
});
const verifierAction = z.strictObject({
  role: z.literal("verifier"),
  verify: z.array(verification).min(1),
});
const overlapAction = verifierAction.extend(
  explorerAction.omit({ role: true }).shape,
);
/** Each action owns exactly the payload its dispatched roles need. */
export const coordinatorAction = z.union([
  explorerAction,
  literatureAction,
  verifierAction,
  overlapAction,
]);
export type CoordinatorAction = z.output<typeof coordinatorAction>;
export const coordinatorResult = z.strictObject({
  filings: z.array(z.strictObject({ note: noteId, summary: nonblank })),
  action: coordinatorAction,
});
export type CoordinatorResult = z.output<typeof coordinatorResult>;

/** The coordinator's frozen input owns both scheduling policy and submission validity. */
export function coordinatorResultFor({
  notes,
  literatureStatus: status,
  coordinatorBehavior: behavior,
}: CoordinatorInput) {
  const known = new Set(notes.map(({ id }) => id));
  const withoutSummary = new Set(
    notes.filter(({ summary }) => summary === undefined).map(({ id }) => id),
  );
  const evidence = noteEvidence(
    notes,
    notes.flatMap(({ verdicts }) => verdicts),
  );
  const verified = new Set(
    notes.filter(({ id }) => evidence.get(id)!.verified).map(({ id }) => id),
  );
  const ready = notes.filter(
    (note) =>
      !evidence.get(note.id)!.dead &&
      note.support.every((id) => verified.has(id)),
  );
  const readyUnchecked = ready
    .filter((note) => !verified.has(note.id) && note.verdicts.length === 0)
    .map(({ id }) => id);
  const literatureFirst =
    behavior.literature === "required-if-not-started" &&
    status === "not-started";
  const requiredVerification =
    behavior.verification === "always" && !literatureFirst
      ? readyUnchecked
      : [];
  const allowedActions: readonly CoordinatorAction["role"][] = literatureFirst
    ? ["literature"]
    : requiredVerification.length > 0
      ? ["verifier"]
      : (["explorer", "literature", "verifier"] as const).filter(
          (role) =>
            (role !== "literature" ||
              (behavior.literature !== "never" && status !== "completed")) &&
            (role !== "verifier" ||
              ready.some(
                (note) => pendingVerifiers(note, verifierNames).length > 0,
              )),
        );
  const action = z.discriminatedUnion("role", [
    explorerAction,
    literatureAction,
    behavior.overlap ? overlapAction : verifierAction,
  ]);
  return coordinatorResult.extend({ action }).superRefine((value, ctx) => {
    const verify = value.action.role === "verifier" ? value.action.verify : [];
    if (!allowedActions.includes(value.action.role)) {
      ctx.addIssue({
        code: "custom",
        message: `the action must be among: ${allowedActions.join(", ")}`,
        path: ["action"],
      });
    }
    const listed = new Set(verify.map(({ note }) => note));
    const missing = requiredVerification.filter((id) => !listed.has(id));
    if (missing.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `the coordinator behavior requires verifying every unverified live note without a verdict over verified support; missing: ${missing.join(", ")}`,
        path: ["action", "verify"],
      });
    }
    distinctKnown(
      withoutSummary,
      value.filings.map(({ note }) => note),
      ctx,
      ["filings"],
      "each note without a summary must be filed exactly once",
    );
    if (value.filings.length !== withoutSummary.size) {
      ctx.addIssue({
        code: "custom",
        message: `all ${withoutSummary.size} notes without a summary must be filed`,
        path: ["filings"],
      });
    }
    distinctKnown(
      known,
      "support" in value.action ? value.action.support : [],
      ctx,
      ["action", "support"],
    );
    distinctKnown(
      known,
      verify.map(({ note }) => note),
      ctx,
      ["action", "verify"],
    );
    // A note is verified only over verified support: every note in its
    // support is verified already or listed earlier with the source
    // verifier, so it is verified in the same verification first.
    const listedWithSource = new Set<string>();
    for (const [index, entry] of verify.entries()) {
      const target = notes.find(({ id }) => id === entry.note);
      if (target === undefined) continue;
      if (evidence.get(target.id)!.dead) {
        ctx.addIssue({
          code: "custom",
          message: "a dead note is not verified again",
          path: ["action", "verify", index, "note"],
        });
      } else if (pendingVerifiers(target, entry.verifiers).length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "a verification must request an outstanding reachable check",
          path: ["action", "verify", index, "verifiers"],
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
          path: ["action", "verify", index, "note"],
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
  .superRefine((value, ctx) => {
    const listed = value.verify.map(({ note }) => note);
    if (value.notes.map(({ id }) => id).join(",") !== listed.join(",")) {
      ctx.addIssue({
        code: "custom",
        message: "notes must be the notes listed in verify, in order",
        path: ["notes"],
      });
    }
    let closure: string[];
    try {
      closure = supportClosure(value.notes, [...value.notes, ...value.support]);
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
 * given the verdicts recorded in its verification: the notes that asked for it,
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
  const known = [...input.notes, ...input.support];
  const judged: string[] = [];
  let evidence: ReturnType<typeof noteEvidence> | undefined;
  for (const [index, entry] of input.verify.entries()) {
    if (!entry.verifiers.includes(verifier)) continue;
    // Ordinary checks see earlier verifier stages; reconstruction additionally
    // sees earlier listed notes' reconstruction results, never later ones.
    if (evidence === undefined || verifier === "reconstruction") {
      const visible = recorded.filter(
        (value) =>
          verifierIndex(value.verifier) < verifierIndex(verifier) ||
          (verifier === "reconstruction" &&
            value.verifier === "reconstruction" &&
            (position.get(value.note) ?? Number.POSITIVE_INFINITY) < index),
      );
      evidence = noteEvidence(
        known,
        visible,
        verifierNames.slice(0, Math.min(verifierIndex(verifier), 2)),
      );
    }
    const value = evidence.get(entry.note)!;
    if (
      !value.dead &&
      value.supportPassed &&
      verifierNames
        .slice(0, verifierIndex(verifier))
        .every((name) => value.passed.has(name))
    )
      judged.push(entry.note);
  }
  return judged;
}

/** Whether every reachable check has a verdict, including INCONCLUSIVE. */
export function verificationComplete(
  input: Pick<VerifierInput, "verify" | "notes" | "support">,
  recorded: readonly Verdict[],
): boolean {
  recorded = verificationVerdicts(input, recorded);
  return verifierNames.every(
    (name) =>
      missingVerdicts(recorded, name, judgedBy(input, recorded, name))
        .length === 0,
  );
}

/** Reuse established checks across dispatches; inconclusive checks can be requested again. */
export function verificationVerdicts(
  input: Pick<VerifierInput, "notes">,
  recorded: readonly Verdict[],
): Verdict[] {
  return [
    ...input.notes.flatMap(({ verdicts }) =>
      verdicts.filter(({ verdict }) => verdict !== "INCONCLUSIVE"),
    ),
    ...recorded,
  ];
}

/** Each later verifier reads the text approved by all preceding checks. */
export function correctedVerifierInput(
  input: VerifierInput,
  recorded: readonly Verdict[],
): VerifierInput {
  const update = (note: Note): Note => {
    const corrections = recorded.filter((value) => value.note === note.id);
    const { summary, ...rest } = note;
    return {
      ...rest,
      ...(summary === undefined ||
      corrections.some((value) => value.correctedText !== undefined)
        ? {}
        : { summary }),
      text: correctedText(note.text, corrections),
    };
  };
  return {
    ...input,
    notes: input.notes.map(update),
    support: input.support.map(update),
  };
}

/** Checks without a verdict within one verification. */
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
function verdictsOver<
  T extends z.ZodType<Pick<Verdict, "note" | "verdict" | "correctedText">>,
>(entry: T, judged: readonly string[]) {
  const expected = [...judged].sort(byId).join(",");
  // Keep the provider schema stable across verifications. The runtime still
  // requires exactly the requested note IDs, once each, before recording.
  return z
    .strictObject({ verdicts: z.array(entry) })
    .refine(
      (value) =>
        value.verdicts
          .map(({ note }) => note)
          .sort(byId)
          .join(",") === expected,
      {
        message: "one verdict per note under verification",
        path: ["verdicts"],
      },
    )
    .refine(
      (value) => value.verdicts.every(validCorrection),
      "only PASS may correct a note",
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
  )
  .refine(
    (value) => value.verdicts.every(validCorrection),
    "only PASS may correct a note",
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
/** A normalized source verdict, also used by the local source check. */
export const sourceVerdict = verdict
  .omit({ verifier: true })
  .extend({ sources });

// Structured output requires every field. Normalize its explicit null at the
// provider boundary so local conclusions and journal verdicts stay canonical.
function sourceWireVerdict(
  resultId: z.ZodType<string>,
  passageId?: z.ZodType<string>,
) {
  const inspected = z.strictObject({ resultId, ...sourceLocation });
  return sourceVerdict
    .extend({
      correctedText: nonblank.nullable(),
      sources: z.array(
        passageId === undefined
          ? inspected
          : z.union([inspected, z.strictObject({ resultId, passageId })]),
      ),
    })
    .transform(({ correctedText, ...value }) =>
      correctedText === null ? value : { ...value, correctedText },
    );
}

/** Decode a remote source submission before judging its evidence. */
export const sourceSubmission = z.strictObject({
  verdicts: z.array(sourceWireVerdict(nonblank, nonblank)),
});

// One earlier passage is supplied once, with its origin and a packet-local ID.
const sourcePassage = sources.element.omit({ resultId: true }).extend({
  id: nonblank,
  call: z.number().int().positive(),
  note: nonblank,
});
export const sourcePrompt = z.strictObject({
  task: z.strictObject({ problem: nonblank, completionCriteria: nonblank }),
  notes: z
    .array(
      z.strictObject({
        id: nonblank,
        text: nonblank,
        support: z.array(nonblank),
        externalResults: z
          .array(z.strictObject({ id: nonblank, text: nonblank }))
          .min(1),
      }),
    )
    .min(1),
  passages: z.array(sourcePassage),
});

/** Source reads assigned premises and matching passages, never support proofs. */
export function sourceInputFor(
  input: VerifierInput,
  assigned: AssignedExternalResults,
  passages: readonly Omit<z.output<typeof sourcePassage>, "id">[] = [],
): z.output<typeof sourcePrompt> {
  const premises = assignedPremises(assigned);
  return sourcePrompt.parse({
    task: input.task,
    notes: assigned.map(({ note: id }) => {
      const note = pick(input.notes, id);
      return {
        id,
        text: note.text,
        support: note.support,
        externalResults: premises
          .filter((premise) => premise.note === id)
          .map(({ resultId, result }) => ({ id: resultId, text: result })),
      };
    }),
    passages: passages
      .filter((passage) =>
        premises.some(({ result }) => passage.result === result),
      )
      .map((passage, index) => ({ ...passage, id: `p${index + 1}` })),
  });
}

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
  verdict: {
    readonly note: string;
    readonly verdict: string;
    readonly sources: readonly { readonly resultId: string }[];
  },
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
  passageIds: readonly string[] = [],
) {
  const ids = assignedPremises(assigned).map(({ resultId }) => resultId);
  return verdictsOver(
    sourceWireVerdict(
      z.enum(ids),
      passageIds.length === 0 ? undefined : z.enum(passageIds),
    ),
    judged,
  ).refine(
    (value) =>
      value.verdicts.every((verdict) => sourceVerdictBinds(verdict, assigned)),
    "source evidence must reference the assigned external premise IDs",
  );
}

export type VerifierResult = readonly Verdict[];

/** A local call freezes a verification before its first outstanding check. */
export const verificationLabel = `${applicationId}/verification`;

export interface JournalVerdict {
  readonly seq: EntryId;
  readonly call: EntryId;
  readonly verification: EntryId;
  readonly verdict: Verdict;
  readonly externalResults?: z.output<typeof externalResults>;
  readonly sources?: z.output<typeof sources>;
}

/** Correctness admitted in this verification, or explicitly frozen for reuse. */
export function correctnessEvidence(
  history: readonly JournalVerdict[],
  note: Note,
  verification: EntryId,
): JournalVerdict | undefined {
  return history.findLast(
    (entry) =>
      entry.verdict.note === note.id &&
      entry.verdict.verifier === "correctness" &&
      entry.verdict.verdict === "PASS" &&
      (entry.verification === verification ||
        (entry.seq < verification &&
          note.verdicts.some((value) =>
            isDeepStrictEqual(value, entry.verdict),
          ))),
  );
}

/** Group exactly the requested notes by their admitted correctness call. */
export function sourceGroups(
  input: VerifierInput,
  judged: readonly string[],
  verification: EntryId,
  history: readonly JournalVerdict[],
) {
  const groups = new Map<
    EntryId,
    { note: string; externalResults: string[] }[]
  >();
  for (const id of judged) {
    const prior = correctnessEvidence(
      history,
      pick(input.notes, id),
      verification,
    );
    if (prior?.externalResults === undefined)
      throw new Error("source requires admitted correctness premises");
    const group = groups.get(prior.call) ?? [];
    group.push({ note: id, externalResults: prior.externalResults });
    groups.set(prior.call, group);
  }
  return [...groups.values()];
}

/** Bind evidence to the checks eligible when the call began, never prompt text. */
function verifierEvidenceFor(
  history: readonly JournalVerdict[],
  opening: Entry | undefined,
  verifier: VerifierName,
) {
  if (opening?.kind !== "call" || opening.label !== verificationLabel)
    throw new Error("missing verification");
  const input = verifierInput.parse(opening.request);
  const have = verificationVerdicts(
    input,
    history
      .filter((entry) => entry.verification === opening.seq)
      .map((entry) => entry.verdict),
  );
  const judged = missingVerdicts(
    have,
    verifier,
    judgedBy(input, have, verifier),
  );
  if (verifier === "correctness") return correctnessVerdictsFor(judged);
  if (verifier !== "source")
    return verdictsFor(
      verifier === "reconstruction" ? judged.slice(0, 1) : judged,
    );
  const assigned = sourceGroups(input, judged, opening.seq, history)[0];
  if (assigned === undefined)
    throw new Error("source call has no outstanding premises");
  const premises = new Map(
    assignedPremises(assigned).map(({ resultId, result }) => [
      resultId,
      result,
    ]),
  );
  return verdictsOver(
    sourceVerdict,
    assigned.map(({ note }) => note),
  ).refine(
    ({ verdicts }) =>
      verdicts.every(
        (value) =>
          sourceVerdictBinds(value, assigned) &&
          value.sources.every(
            (source) => premises.get(source.resultId) === source.result,
          ),
      ),
    "source evidence must preserve its assigned premise IDs and text",
  );
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
  const deriveSources = (verification: EntryId, seq: EntryId): void => {
    const opening = calls.get(verification);
    if (opening?.label !== verificationLabel)
      throw new Error(`missing verification ${verification}`);
    const input = verifierInput.parse(opening.request);
    const have = verificationVerdicts(
      input,
      verdicts
        .filter((entry) => entry.verification === verification)
        .map(({ verdict }) => verdict),
    );
    for (const note of missingVerdicts(
      have,
      "source",
      judgedBy(input, have, "source"),
    )) {
      const correctness = correctnessEvidence(
        verdicts,
        pick(input.notes, note),
        verification,
      );
      if (correctness?.externalResults?.length !== 0) continue;
      verdicts.push({
        seq,
        call: correctness.call,
        verification,
        verdict: {
          verifier: "source",
          note,
          verdict: "PASS",
          report: `The admitted correctness check in call ${correctness.call} identified no nonroutine external premise.`,
        },
        sources: [],
      });
    }
  };
  for (const entry of records) {
    if (entry.kind === "call" && entry.label === verificationLabel)
      deriveSources(entry.seq, entry.seq);
    if (entry.kind !== "evidence") continue;
    const call = calls.get(entry.call);
    const verifier =
      call?.kind === "call" ? verifierFromLabel(call.label) : undefined;
    if (call?.kind !== "call" || verifier === undefined) continue;
    let schema;
    try {
      schema = verifierEvidenceFor(
        verdicts.filter((entry) => entry.seq < call.seq),
        call.parent === undefined ? undefined : calls.get(call.parent),
        verifier,
      );
    } catch {
      throw new Error(`malformed verdict ${entry.seq}`);
    }
    const parsed = schema.safeParse(entry.evidence);
    const result = returnedOutput(records, call.seq);
    const output = roleOutput.safeParse(result?.output);
    if (
      !parsed.success ||
      parsed.data.verdicts.length === 0 ||
      !roleRequest.safeParse(call.request).success ||
      result === undefined ||
      !output.success ||
      output.data.value === null ||
      typeof output.data.value !== "object" ||
      Array.isArray(output.data.value) ||
      !isDeepStrictEqual(output.data.value.verdicts, parsed.data.verdicts) ||
      result.settled >= entry.seq ||
      call.role !== "verifier" ||
      call.parent === undefined ||
      calls.get(call.parent)?.label !== verificationLabel ||
      verdicts.some(
        (prior) =>
          prior.verification === call.parent &&
          prior.verdict.verifier === verifier &&
          parsed.data.verdicts.some(({ note }) => note === prior.verdict.note),
      ) ||
      !parsed.data.verdicts.every(validCorrection)
    ) {
      throw new Error(`malformed verdict ${entry.seq}`);
    }
    for (const value of parsed.data.verdicts) {
      const { externalResults, sources, ...noteVerdict } = {
        externalResults: undefined,
        sources: undefined,
        ...value,
      };
      verdicts.push({
        seq: entry.seq,
        call: call.seq,
        verification: call.parent,
        verdict: { verifier, ...noteVerdict },
        ...(externalResults === undefined ? {} : { externalResults }),
        ...(sources === undefined ? {} : { sources }),
      });
    }
    if (verifier === "correctness") deriveSources(call.parent, entry.seq);
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

/** A returned solver role result whose execution succeeded. */
export function succeededOutput(records: readonly Entry[], call: EntryId) {
  const returned = returnedOutput(records, call);
  return returned !== undefined &&
    typeof returned.output === "object" &&
    returned.output !== null &&
    (returned.output as { readonly state?: Json }).state === "succeeded"
    ? returned
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

export interface RoleHost {
  readonly explorer: (
    input: ExplorerInput,
    signal?: AbortSignal,
    parent?: EntryId,
  ) => Promise<ExplorerResult>;
  readonly coordinator: (
    input: z.input<typeof coordinatorInput>,
    parent?: EntryId,
    signal?: AbortSignal,
  ) => Promise<CoordinatorResult>;
  readonly literature: (
    input: LiteratureInput,
    parent?: EntryId,
    signal?: AbortSignal,
  ) => Promise<LiteratureReport>;
  readonly verifier: (
    input: VerifierInput,
    verification?: EntryId,
    signal?: AbortSignal,
    parent?: EntryId,
  ) => Promise<VerifierResult>;
}
