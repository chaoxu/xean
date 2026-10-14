import { isDeepStrictEqual } from "node:util";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  defineDoc,
  defineDocFamily,
  defineEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import type { SolverCommand } from "./commands.ts";
import {
  verificationStages,
  type Check,
  type Exploration,
  type Note,
  type SolverResult,
  type VerificationStage,
} from "./contracts.ts";
import { closure, keepsPrior } from "./argument.ts";
import {
  refresh,
  sourceEvidence,
  sourceInputKeys,
  validateExploration,
  validateResult,
} from "./notes.ts";

export type ResearchEvent =
  { type: "input"; command: SolverCommand } | { type: "result" };
export const Events = defineEntry<ResearchEvent>("research.event");
const NotebookInput = defineEntry<{ checks: Check[] }>(
  "research.notebook.input",
);
type CheckRef =
  { worker: number; index: number } | { entry: number; index: number };
type Head = Pick<
  Note,
  "id" | "summary" | "support" | "revision" | "candidate" | "retired"
> & {
  checks: Partial<Record<VerificationStage, CheckRef>> & {
    external?: { entry: number };
  };
  sourceInputs?: string[];
};
type CatalogValue = {
  notes: Head[];
  inputs: { entry: number }[];
};
const emptyCatalog = (): CatalogValue => ({ notes: [], inputs: [] });
export const Catalog = defineDoc({
  kind: "research.notebook",
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  version: 3,
  initial: emptyCatalog,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 31,
});
export const Bodies = defineDocFamily({
  kind: "research.note.body",
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  family: true,
  version: 1,
  initial: (value: { detailedSummary: string; text: string }) => value,
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 15,
});
export type MathView = {
  notes: Note[];
  guidance: string[];
  inputs: { id: EntryId; command: SolverCommand }[];
};
export type ReadOptions = {
  bodies?: boolean;
  ids?: readonly string[];
  inputs?: boolean;
};
type EvidenceTask = {
  state: { status: string; outcome?: { status: string; result?: unknown } };
};
export type SnapshotReader = Pick<
  TaskRuntime<any, any, any, any>,
  "snapshotAsOf"
> & {
  getTask(id: TaskId, context: Context): Promise<EvidenceTask | undefined>;
  entry(id: EntryId, context: Context): Promise<EntryRecord | undefined>;
};
type Reads = {
  body(
    id: string,
  ): Promise<{ detailedSummary: string; text: string } | undefined>;
  check(ref: CheckRef): Promise<Check>;
  input(id: number): Promise<SolverCommand>;
};

async function materialize(
  catalog: CatalogValue,
  reads: Reads,
  options: ReadOptions,
): Promise<MathView> {
  const notes: Note[] = [];
  // Status requires the graph, even when the caller requests only selected bodies.
  for (const head of catalog.notes) {
    const selected = !options.ids || options.ids.includes(head.id);
    const body =
      options.bodies !== false && selected
        ? await reads.body(head.id)
        : undefined;
    const checks: Note["checks"] = head.checks.external
      ? { external: { ...head.checks.external } }
      : {};
    for (const stage of verificationStages) {
      const ref = head.checks[stage];
      if (!ref) continue;
      const check = await reads.check(ref);
      if (check.noteId !== head.id || !check[stage])
        throw new Error(`Invalid check reference: ${head.id}/${stage}`);
      Object.assign(checks, { [stage]: check[stage] });
    }
    notes.push({
      id: head.id,
      summary: head.summary,
      support: [...head.support],
      revision: head.revision,
      candidate: head.candidate,
      retired: head.retired,
      detailedSummary: body?.detailedSummary ?? "",
      text: body?.text ?? "",
      checks,
      verified: false,
      dead: false,
      accepted: false,
    });
  }
  refresh(notes);
  let evidence: ReturnType<typeof sourceEvidence> | undefined;
  for (const [index, note] of notes.entries()) {
    const head = catalog.notes[index]!;
    if (head.checks.source && head.sourceInputs !== undefined)
      note.sourceChanged = sourceInputKeys(
        note,
        (evidence ??= sourceEvidence(notes)),
      ).some((key) => !head.sourceInputs!.includes(key));
  }
  const inputs = [];
  for (const ref of options.inputs === false ? [] : catalog.inputs)
    inputs.push({
      id: ref.entry as EntryId,
      command: await reads.input(ref.entry),
    });
  return {
    notes: options.ids
      ? notes.filter((note) => options.ids!.includes(note.id))
      : notes,
    guidance: inputs.flatMap(({ command }) =>
      command.kind === "guide"
        ? [command.text]
        : command.kind === "recheck"
          ? [
              `Assessments withdrawn for ${command.notes.map(({ id }) => id).join(", ")}: ${command.reason}`,
            ]
          : [],
    ),
    inputs,
  };
}

function readChecks(
  get: (id: TaskId) => Promise<EvidenceTask | undefined>,
  entry: (id: EntryId) => Promise<EntryRecord | undefined>,
): Reads["check"] {
  const cache = new Map<number, Promise<EvidenceTask | undefined>>();
  const inputs = new Map<number, Promise<EntryRecord | undefined>>();
  return async (ref) => {
    if ("entry" in ref) {
      const pending = inputs.get(ref.entry) ?? entry(ref.entry as EntryId);
      inputs.set(ref.entry, pending);
      const input = await pending;
      const check = NotebookInput.is(input) && input.data.checks[ref.index];
      if (!check)
        throw new Error(`Missing input check: ${ref.entry}/${ref.index}`);
      return check;
    }
    const pending = cache.get(ref.worker) ?? get(ref.worker as TaskId);
    cache.set(ref.worker, pending);
    const task = await pending;
    if (
      !task ||
      (task.state.status !== "terminal" && task.state.status !== "completing")
    )
      throw new Error(`Unsettled verification evidence: ${ref.worker}`);
    const outcome = task.state.outcome;
    if (
      !outcome ||
      (outcome.status !== "completed" && outcome.status !== "failed") ||
      outcome.result === undefined
    )
      throw new Error(`Missing verification outcome: ${ref.worker}`);
    // Catalog references commit only after publication validates this immutable outcome.
    const result = outcome.result as SolverResult;
    if (result.kind !== "verification")
      throw new Error(`Not verification evidence: ${ref.worker}`);
    const check = result.checks[ref.index];
    if (!check) throw new Error(`Missing check: ${ref.worker}/${ref.index}`);
    return check;
  };
}

/** Current reads use native documents; no event replay or second mathematical corpus. */
export async function readView(
  tx: Tx,
  root: ConversationId,
  options: ReadOptions = {},
): Promise<MathView> {
  const catalog = await tx.doc(Catalog, root);
  return materialize(
    catalog,
    {
      body: (id) => tx.doc(Bodies, root, id, { detailedSummary: "", text: "" }),
      check: readChecks(
        (id) => tx.task(id),
        (id) => tx.entry(NotebookInput, id),
      ),
      input: async (id) => {
        const entry = await tx.entry(Events, id as EntryId);
        if (entry?.data.type !== "input")
          throw new Error(`Invalid input reference: ${id}`);
        return entry.data.command;
      },
    },
    options,
  );
}

/** Historical reads must run outside a Session commit callback. */
export async function readSnapshot(
  reader: SnapshotReader,
  root: ConversationId,
  cutoff: EntryId,
  context: Context,
  options: ReadOptions = {},
): Promise<MathView> {
  const catalog =
    (await reader.snapshotAsOf(Catalog, root, cutoff, context)) ??
    emptyCatalog();
  return materialize(
    catalog,
    {
      body: (id) => reader.snapshotAsOf(Bodies, root, id, cutoff, context),
      check: readChecks(
        (id) => reader.getTask(id, context),
        (id) => reader.entry(id, context),
      ),
      input: async (id) => {
        const entry = await reader.entry(id as EntryId, context);
        if (!Events.is(entry) || entry.data.type !== "input")
          throw new Error(`Invalid input reference: ${id}`);
        return entry.data.command;
      },
    },
    options,
  );
}

const claim = (check: Check["correctness"]) =>
  check ? { statement: check.statement, premises: check.premises } : undefined;
function consumers(catalog: CatalogValue, ids: Iterable<string>): Set<string> {
  const affected = new Set(ids);
  for (const note of closure(
    catalog.notes.map((note) => note.id),
    catalog.notes,
  ))
    if (note.support.some((id) => affected.has(id))) affected.add(note.id);
  return affected;
}
function invalidate(
  catalog: CatalogValue,
  ids: ReadonlySet<string>,
  marker: number,
): void {
  for (const head of catalog.notes) {
    if (!ids.has(head.id)) continue;
    head.checks = head.checks.external
      ? { external: head.checks.external }
      : {};
    head.revision = marker;
  }
}
/** Pi owns worker identity; note names are permanent from creation. */
export const noteIdPrefix = (workerId: TaskId): string => `${workerId}/`;
async function applyNotes(
  tx: Tx,
  root: ConversationId,
  catalog: CatalogValue,
  known: Note[],
  value: Exploration,
  caller: boolean,
  marker: number,
) {
  const invalid = new Set<string>();
  for (const draft of value.notes) {
    catalog.notes.push({
      id: draft.id,
      summary: draft.summary,
      support: draft.support,
      revision: marker,
      candidate: draft.candidate ?? false,
      retired: draft.retired ?? false,
      checks:
        caller && (!("trusted" in draft) || draft.trusted !== false)
          ? { external: { entry: marker } }
          : {},
    });
    await tx.doc(Bodies, root, draft.id, {
      detailedSummary: draft.detailedSummary,
      text: draft.text,
    });
  }
  for (const edit of value.edits ?? []) {
    const head = catalog.notes.find((note) => note.id === edit.id)!;
    const before = known.find((note) => note.id === edit.id)!;
    const body =
      edit.text !== undefined || edit.detailedSummary !== undefined
        ? await tx.doc(Bodies, root, edit.id, { detailedSummary: "", text: "" })
        : undefined;
    if (body) Object.assign(before, body);
    const { id: _id, revision: _revision, ...fields } = edit;
    const changed = Object.entries(fields).filter(
      ([key, value]) =>
        !isDeepStrictEqual(
          key === "trusted"
            ? !!before.checks.external
            : before[key as keyof Note],
          value,
        ),
    );
    if (!changed.length) continue;
    if (
      changed.some(([key]) =>
        ["summary", "detailedSummary", "text", "support", "trusted"].includes(
          key,
        ),
      )
    ) {
      invalid.add(head.id);
      if (!caller) delete head.checks.external;
      else if (head.checks.external) head.checks.external = { entry: marker };
    }
    if (caller && "trusted" in edit) {
      if (edit.trusted === true) head.checks.external = { entry: marker };
      else delete head.checks.external;
    }
    for (const field of ["summary", "support", "candidate", "retired"] as const)
      if (edit[field] !== undefined)
        Object.assign(head, { [field]: edit[field] });
    if (body) {
      if (edit.text !== undefined) body.text = edit.text;
      if (edit.detailedSummary !== undefined)
        body.detailedSummary = edit.detailedSummary;
    }
    head.revision = marker;
  }
  if (invalid.size) invalidate(catalog, consumers(catalog, invalid), marker);
}

/** Standalone Explorer input joins the same notebook, with immutable check evidence. */
export async function seedNotebook(
  tx: Tx,
  root: ConversationId,
  notes: Note[],
): Promise<void> {
  const catalog = await tx.doc(Catalog, root);
  if (catalog.notes.length || catalog.inputs.length || !notes.length) return;
  const evidence = sourceEvidence(refresh(structuredClone(notes)));
  const marker = (
    await tx.appendEntry(NotebookInput, root, {
      data: {
        checks: notes.map((note) => ({ noteId: note.id, ...note.checks })),
      },
    })
  ).id;
  await applyNotes(tx, root, catalog, [], { notes }, false, marker);
  for (const [index, note] of notes.entries()) {
    const head = catalog.notes[index]!;
    if (note.checks.external) head.checks.external = { entry: marker };
    for (const stage of verificationStages)
      if (note.checks[stage]) head.checks[stage] = { entry: marker, index };
    if (note.checks.source) head.sourceInputs = sourceInputKeys(note, evidence);
  }
}

async function publicationOwner(tx: Tx, root: ConversationId, id: TaskId) {
  const worker = await tx.task(id);
  if (
    !worker ||
    worker.conversationId !== root ||
    worker.state.status === "terminal" ||
    worker.state.status === "completing"
  )
    throw new Error(`Invalid publication owner: ${id}`);
}

async function publishNotes(
  tx: Tx,
  root: ConversationId,
  catalog: CatalogValue,
  known: Note[],
  value: Exploration,
): Promise<EntryId> {
  validateExploration(value, known);
  const marker = (
    await tx.appendEntry(Events, root, { data: { type: "result" } })
  ).id;
  await applyNotes(tx, root, catalog, known, value, false, marker);
  return marker;
}

/** Publish one submission against the notebook the Explorer has actually observed. */
export async function publishExploration(
  tx: Tx,
  root: ConversationId,
  workerId: TaskId,
  delta: Exploration,
  observed: Record<string, number>,
): Promise<{
  notes: { id: string; revision: number }[];
  edits: { id: string; revision: number }[];
  invalidated: { id: string; revision: number; readRequired: boolean }[];
}> {
  await publicationOwner(tx, root, workerId);
  if (!delta.notes.length && !delta.edits?.length)
    return { notes: [], edits: [], invalidated: [] };
  const current = await readView(tx, root, { bodies: false, inputs: false });
  const known = new Set(current.notes.map((note) => note.id));
  validateExploration(delta, current.notes, noteIdPrefix(workerId));
  for (const note of closure(
    [
      ...(delta.edits ?? []).map((edit) => edit.id),
      ...[...delta.notes, ...(delta.edits ?? [])]
        .flatMap((note) => note.support ?? [])
        .filter((id) => known.has(id)),
    ],
    current.notes,
  ))
    if (observed[note.id] !== note.revision)
      throw new Error(
        `${observed[note.id] === undefined ? "Unseen mathematical input" : "Stale note revision"}: ${note.id}`,
      );
  const catalog = await tx.doc(Catalog, root);
  await publishNotes(tx, root, catalog, current.notes, delta);
  const revisions = (values: { id: string }[]) =>
    values.map(({ id }) => ({
      id,
      revision: catalog.notes.find((note) => note.id === id)!.revision,
    }));
  const publication = {
    notes: revisions(delta.notes),
    edits: revisions(delta.edits ?? []),
  };
  const edited = new Set(publication.edits.map(({ id }) => id));
  const invalidated = current.notes.flatMap((before) => {
    const after = catalog.notes.find((note) => note.id === before.id)!;
    if (edited.has(before.id) || before.revision === after.revision) return [];
    const readRequired = observed[before.id] !== before.revision;
    // Only our invalidation changed an observed note. Never hide an unseen edit.
    if (!readRequired) observed[before.id] = after.revision;
    return [{ id: before.id, revision: after.revision, readRequired }];
  });
  for (const { id } of [...publication.notes, ...publication.edits])
    observed[id] = catalog.notes.find((note) => note.id === id)!.revision;
  return { ...publication, invalidated };
}

function assertFrozen(current: Note[], frozen: Note[], ids: string[]): void {
  const signature = (note: Note) => ({
    revision: note.revision,
    support: note.support,
    external: note.checks.external,
    correctness: note.checks.correctness,
    source: note.checks.source,
  });
  for (const old of closure(ids, frozen)) {
    const now = current.find((note) => note.id === old.id);
    if (!now || !isDeepStrictEqual(signature(now), signature(old)))
      throw new Error(`Stale mathematical input: ${old.id}`);
  }
}

/** Called in the same native commit that settles this worker's outcome. */
export async function publishResult(
  tx: Tx,
  root: ConversationId,
  value: JsonValue,
  workerId: TaskId,
  frozen: MathView,
  failed = false,
): Promise<EntryId> {
  await publicationOwner(tx, root, workerId);
  const result = validateResult(
    value,
    frozen.notes,
    failed,
    noteIdPrefix(workerId),
  );
  const current = await readView(tx, root, { bodies: false, inputs: false });
  const catalog = await tx.doc(Catalog, root);
  if (result.kind === "notes") {
    assertFrozen(current.notes, frozen.notes, [
      ...(result.edits ?? []).map((edit) => edit.id),
      ...(result.edits ?? [])
        .flatMap((edit) => edit.support ?? [])
        .filter((id) => frozen.notes.some((note) => note.id === id)),
      ...result.notes
        .flatMap((note) => note.support)
        .filter((id) => frozen.notes.some((note) => note.id === id)),
    ]);
    return publishNotes(tx, root, catalog, current.notes, result);
  }
  assertFrozen(
    current.notes,
    frozen.notes,
    result.checks.map((check) => check.noteId),
  );
  const changed = new Set<string>();
  for (const before of closure(
    result.checks.map((check) => check.noteId),
    current.notes,
  )) {
    const check = result.checks.find((check) => check.noteId === before.id);
    if (!check) continue;
    if (!check.correctness) continue;
    if (
      !changed.has(before.id) &&
      keepsPrior(before.checks.correctness, check.correctness)
    )
      continue;
    if (
      !isDeepStrictEqual(
        claim(before.checks.correctness),
        claim(check.correctness),
      )
    )
      for (const id of consumers(catalog, [before.id]))
        if (id !== before.id) changed.add(id);
  }
  const marker = (
    await tx.appendEntry(Events, root, { data: { type: "result" } })
  ).id;
  invalidate(catalog, changed, marker);
  for (const note of current.notes)
    if (changed.has(note.id))
      note.checks = note.checks.external
        ? { external: note.checks.external }
        : {};
  let evidence: ReturnType<typeof sourceEvidence> | undefined;
  for (const [index, check] of result.checks.entries()) {
    const head = catalog.notes.find((note) => note.id === check.noteId)!;
    const before = current.notes.find((note) => note.id === check.noteId)!;
    const claimEstablished =
      !changed.has(head.id) || check.correctness?.verdict === "PASS";
    for (const stage of verificationStages) {
      if (stage !== "correctness" && !claimEstablished) continue;
      const incoming = check[stage];
      if (!incoming) continue;
      if (keepsPrior(before.checks[stage], incoming)) continue;
      head.checks[stage] = { worker: workerId, index };
      Object.assign(before.checks, { [stage]: incoming });
      if (stage === "source") {
        head.sourceInputs = sourceInputKeys(before, [
          ...(evidence ??= sourceEvidence(frozen.notes)),
          ...("passages" in incoming ? incoming.passages : []),
        ]);
      }
    }
    if (
      claimEstablished &&
      check.correction &&
      head.revision === check.correction.revision
    ) {
      const { summary, detailedSummary } = check.correction;
      if (summary !== undefined && summary !== head.summary) {
        head.summary = summary;
        head.revision = marker;
      }
      if (detailedSummary !== undefined) {
        const body = await tx.doc(Bodies, root, head.id, {
          detailedSummary: "",
          text: "",
        });
        if (body.detailedSummary !== detailedSummary) {
          body.detailedSummary = detailedSummary;
          head.revision = marker;
        }
      }
    }
  }
  // Validate surviving evidence before Pi atomically publishes these references.
  sourceEvidence(refresh(current.notes));
  return marker;
}

/** Caller inputs share publication, revision checks, and evidence withdrawal. */
export async function publishCommand(
  tx: Tx,
  root: ConversationId,
  command: SolverCommand,
): Promise<{ entry: EntryId; created: boolean }> {
  const current = await readView(tx, root, { bodies: false });
  const prior = current.inputs.find((entry) => entry.command.id === command.id);
  if (prior) {
    if (!isDeepStrictEqual(prior.command, command))
      throw new Error("Input ID already has another value");
    return { entry: prior.id, created: false };
  }
  const catalog = await tx.doc(Catalog, root);
  const exploration = command.kind === "submit" ? command : undefined;
  if (exploration)
    validateExploration(exploration, current.notes, `input/${command.id}/`);
  const recheck = new Set<string>();
  if (command.kind === "recheck")
    for (const target of command.notes) {
      if (recheck.has(target.id))
        throw new Error(`Duplicate recheck target: ${target.id}`);
      const note = current.notes.find((note) => note.id === target.id);
      if (!note) throw new Error(`Unknown recheck target: ${target.id}`);
      if (note.revision !== target.revision)
        throw new Error(`Stale note revision: ${target.id}`);
      recheck.add(target.id);
    }
  const marker = (
    await tx.appendEntry(Events, root, { data: { type: "input", command } })
  ).id;
  if (exploration)
    await applyNotes(
      tx,
      root,
      catalog,
      current.notes,
      exploration,
      true,
      marker,
    );
  if (recheck.size) {
    for (const head of catalog.notes)
      if (recheck.has(head.id)) delete head.checks.external;
    invalidate(catalog, consumers(catalog, recheck), marker);
  }
  catalog.inputs.push({ entry: marker });
  return { entry: marker, created: true };
}
