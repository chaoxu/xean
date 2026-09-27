import { isDeepStrictEqual } from "node:util";
import type { CampaignView } from "../types.ts";
import type { SolverCommand } from "./commands.ts";
import {
  declarationVersion,
  type Note,
  type SolverInput,
  type SolverResult,
} from "./contracts.ts";
import { applyChecks, materializeNotes, refresh } from "./notes.ts";
import { editingResult, projectEditing } from "./editor.ts";

/** Project shared notes in commit order. Proposed editions stay outside the active corpus. */
export function project(view: CampaignView): Note[] {
  const declaration = view.task as { version?: number } | null;
  if (declaration?.version !== declarationVersion)
    throw new Error("Unsupported solver declaration; use its matching runtime");
  let notes: Note[] = [];
  const events = [
    ...view.work
      .filter((work) => work.status === "completed")
      .map((work) => {
        if (work.publicationId === null)
          throw new Error(`Missing publication ID: ${work.id}`);
        return { id: work.publicationId, work };
      }),
    ...view.inputs.map((input) => ({
      id: input.id,
      command: input.value as SolverCommand,
    })),
  ].sort((a, b) => a.id - b.id);
  for (const event of events) {
    if ("work" in event) {
      const work = event.work;
      if (work.role === "xean.editor") continue;
      if (work.role === "xean.editionReview") {
        const group = work.id.split("/")[0]!;
        const worklist = view.work.filter(
          (item) =>
            item.id.startsWith(`${group}/`) &&
            item.publicationId !== null &&
            item.publicationId <= event.id,
        );
        const input = worklist[0]!.input as unknown as SolverInput;
        const state = projectEditing(input, worklist);
        const replacement = editingResult(state);
        // A command may have committed while Coordinator was planning the edit.
        // Own editing checks are reflected on both sides of this comparison.
        if (replacement && isDeepStrictEqual(refresh(notes), state.original))
          notes = replacement.notes;
        continue;
      }
      const result = work.result as unknown as SolverResult;
      if (result.kind === "notes")
        notes.push(
          ...materializeNotes(work.id, result.notes, result.candidate),
        );
      else if (result.kind === "verification") {
        // Source judgments on retained originals are final even if editing fails.
        const checks =
          work.role === "xean.editVerifier"
            ? result.checks.filter((check) =>
                notes.some((note) => note.id === check.noteId),
              )
            : result.checks;
        applyChecks(notes, checks);
      } else throw new Error(`Invalid solver result from ${work.id}`);
      continue;
    }
    const command = event.command;
    if (command.kind === "submit")
      notes.push(
        ...materializeNotes(
          `input/${command.id}`,
          command.notes,
          command.candidate,
          true,
        ),
      );
    else if (command.kind === "correct") {
      const note = notes.find((note) => note.id === command.note);
      if (!note || note.revision !== command.revision)
        throw new Error(
          `Invalid correction history: ${command.note}@${command.revision}`,
        );
      note.text = command.text;
      note.summary = command.summary;
      note.detailedSummary = command.detailedSummary;
      note.revision++;
    } else if (command.kind !== "guide")
      throw new Error("Invalid solver input");
  }
  return refresh(notes);
}
