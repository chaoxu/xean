import type { CampaignView, Decision, Signal, Work } from "../types.ts";
import { json } from "../json.ts";
import {
  editingSchema,
  decode,
  editionReviewSchema,
  type EditorInput,
  type EditionReviewInput,
  type Note,
  type SolverInput,
  type SolverResult,
  type EditionReview,
  type VerifierInput,
} from "./contracts.ts";
import {
  applyChecks,
  materializeNotes,
  retainedNotes,
  sourceEvidence,
} from "./notes.ts";

export type EditingResult = {
  notes: Note[];
  deprecated: string[];
  review: EditionReview;
};

/** Replay an edition from committed proposals and checks, keeping original identities shared. */
export function projectEditing(input: SolverInput, worklist: readonly Work[]) {
  const original = structuredClone(input.notes);
  const all = [...original];
  let notes: Note[] = [];
  let step: string | undefined;
  let review: EditionReview | undefined;
  for (const work of worklist
    .filter((work) => work.status === "completed")
    .sort((a, b) => a.publicationId! - b.publicationId!)) {
    step = work.role;
    if (step === "xean.editor") {
      const result = decode(editingSchema, work.result);
      const retained = retainedNotes(result, all);
      if (!work.attemptId)
        throw new Error("Completed editing work has no attempt identity");
      const written = materializeNotes(`edit/${work.attemptId}`, result.notes);
      all.push(...written);
      notes = [...retained, ...written];
      review = undefined;
    } else if (step === "xean.editVerifier") {
      const result = work.result as unknown as Extract<
        SolverResult,
        { kind: "verification" }
      >;
      if (
        result.kind !== "verification" ||
        result.checks.some(
          (check) => !notes.some((note) => note.id === check.noteId),
        )
      )
        throw new Error(
          "Editing verification refers outside the proposed corpus",
        );
      applyChecks(all, result.checks);
    } else if (step === "xean.editionReview") {
      review = decode(editionReviewSchema, work.result);
    } else throw new Error(`Unknown editing role: ${step}`);
  }
  return { original, all, notes, step, review };
}
type EditingState = ReturnType<typeof projectEditing>;

export function editingResult(state: EditingState): EditingResult | undefined {
  if (
    state.step !== "xean.editionReview" ||
    state.review?.verdict !== "PASS" ||
    !state.notes.length ||
    state.notes.some((note) => !note.verified)
  )
    return undefined;
  return {
    notes: state.notes,
    deprecated: state.original
      .filter((old) => !state.notes.some((note) => note.id === old.id))
      .map((note) => note.id),
    review: state.review,
  };
}

/** The same deterministic loop serves standalone editing and an exclusive solver group. */
export function editingDecision(
  signal: Signal,
  view: CampaignView,
  input: SolverInput,
  worklist: readonly Work[],
  group: string,
): Decision {
  if (
    worklist.some(
      (work) => work.status === "active" || work.status === "queued",
    )
  )
    return { state: null };
  const state = projectEditing(input, worklist);
  const completed = editingResult(state);
  if (completed) return { state: null, completion: json(completed) };
  if (view.callLimitReached) return { state: null };
  const id = `${group}/w${signal.id}`;
  const last = worklist.at(-1);
  if (last?.status === "failed") {
    if (signal.kind !== "allowance")
      throw new Error(last.error ?? "Editing worker failed");
    return {
      state: null,
      dispatch: [{ id, role: last.role, input: last.input }],
    };
  }
  let role: string;
  let value: EditorInput | VerifierInput | EditionReviewInput;
  const verified = state.notes.every((note) => note.verified);
  if (
    !state.step ||
    state.review ||
    (state.step === "xean.editVerifier" && !verified)
  ) {
    role = "xean.editor";
    value = {
      task: input.task,
      notes: state.original,
      ...(state.step
        ? {
            previous: state.notes,
            ...(state.review ? { review: state.review } : {}),
          }
        : {}),
    };
  } else if (!verified) {
    role = "xean.editVerifier";
    value = {
      task: input.task,
      notes: state.notes,
      targets: state.notes.map((note) => ({
        id: note.id,
        through: "source" as const,
      })),
      evidence: sourceEvidence(state.all),
    };
  } else {
    role = "xean.editionReview";
    value = { task: input.task, notes: state.notes, previous: state.original };
  }
  return { state: null, dispatch: [{ id, role, input: json(value) }] };
}
