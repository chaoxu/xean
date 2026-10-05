import type {
  ConversationId,
  EntryId,
  TaskRuntime,
} from "@earendil-works/pi-durable";
import type { ProfileName, Profile } from "../config.ts";
import type { SolverResult } from "../math/contracts.ts";

/** Expected execution failure; Pi can publish completed checks with the error. */
export class RoleFailure extends Error {
  result?: Extract<SolverResult, { kind: "verification" }>;
}

export type Profiles = Record<ProfileName, Profile>;
/** The native task invocation is the only execution context. */
export type RoleRuntime = TaskRuntime<any, any, any, any>;
export type NoteReference = { root: ConversationId; cutoff: EntryId };
