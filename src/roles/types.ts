import type {
  ConversationId,
  EntryId,
  TaskRuntime,
} from "@earendil-works/pi-durable";
import type { ProfileName, Profile } from "../config.ts";
import type { SolverResult } from "../math/contracts.ts";
import type { SubmissionResult } from "../math/results.ts";

/** Expected execution failure; completed checks or submissions can accompany it. */
export class RoleFailure extends Error {
  result?: Extract<SolverResult, { kind: "verification" }> | SubmissionResult;
}

export type Profiles = Record<ProfileName, Profile>;
/** The native task invocation is the only execution context. */
export type RoleRuntime = TaskRuntime<any, any, any, any>;
export type NoteReference = { root: ConversationId; cutoff: EntryId };
