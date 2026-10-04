import type { JsonValue } from "@earendil-works/chord";
import type { EntryId, TaskId } from "@earendil-works/pi-durable";

/** Native transcript location before a Pi generation sends its request. */
export type GenerationReference = {
  taskId: TaskId;
  cutoff: EntryId;
};

/** Runtime credentials and headers are deliberately absent. */
export interface CallIdentity {
  provider: string;
  id: string;
  api: string;
}

export interface RecordedCall {
  /** Record dispatch intent. Pi uses its transcript reference. Opaque calls supply their payload. */
  recordRequest(payload?: JsonValue): void | Promise<void>;
  /**
   * Record the outcome and native usage. Calls with a generation reference retain
   * compact outcome metadata and use Pi's transcript for responses it publishes.
   * Other calls supply their result.
   * Null usage means no measurement. Reported counts can be partial on failure;
   * they are not a reconciliation of the provider's final bill.
   * Every admitted call must settle, including when recordRequest() fails.
   */
  settle(message: unknown, usage: unknown | null): void | Promise<void>;
}

export interface CallRecorder {
  /**
   * Admit one logical call before dispatch. Backend-internal requests are opaque.
   * Every successful begin must eventually settle so cooperative shutdown can
   * join it; the backend adapter owns this obligation.
   */
  begin(
    identity: CallIdentity,
    generation?: GenerationReference,
  ): RecordedCall | Promise<RecordedCall>;
}
