import type { Note } from "../../../src/math/contracts.ts";

export const noteStatus = (note: Note, acceptedNoteId: string | null) =>
  note.dead
    ? "Rejected"
    : note.id === acceptedNoteId
      ? "Accepted"
      : note.candidate
        ? "Candidate"
        : "Supporting / partial";
