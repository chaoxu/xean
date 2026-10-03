import type { Context, JsonValue } from "@earendil-works/chord";
import type {
  EntryId,
  EntryRecord,
  Registry,
  TaskId,
  TaskRuntime,
  ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import { Type, type Static } from "typebox";
import type { CallRecorder } from "./calls.ts";

export type { JsonValue };

/** Select or reduce detached records in Pi's newest-first scan order. */
export type RecordProjection = (entry: EntryRecord) => EntryRecord | undefined;

export const campaignVersion = 12;

/** Opt in to whole-attempt recovery only for a known transient execution failure. */
export class TransientError extends Error {
  override name = "TransientError";
}

/** No campaign initialization has committed; inspection remains read-only. */
export class UninitializedCampaignError extends Error {
  override name = "UninitializedCampaignError";
  constructor() {
    super("A new Xean campaign requires a task");
  }
}

export type XeanStatus =
  "running" | "pausing" | "paused" | "cancelled" | "blocked" | "completed";

/** Attempt-owned operations, separate from Chord's invocation context. */
export interface Execution {
  readonly attemptId: string;
  /** Frozen callback input entry, present for Coordinator invocations. */
  readonly inputId?: EntryId;
  /** One-based invocation ordinal, including attempts interrupted by close/crash. */
  readonly attempt: number;
  /** Shared call accounting for the chosen execution backend. */
  readonly recorder: CallRecorder;
  /** Native Pi parent span for model and tool calls. */
  readonly telemetry?: TelemetryContext;
  /** Native, invocation-bound access to this task's private durable work. */
  readonly durable?: Pick<
    ToolExecutionApi,
    "taskId" | "conversation" | "commit" | "snapshot" | "memo"
  > &
    Pick<TaskRuntime<never, never, never, object>, "context"> & {
      readonly registry: Registry;
      readonly models: MutableModels;
    };
}

export interface Role {
  readonly name: string;
  run(
    input: JsonValue,
    execution: Execution,
    context: Context,
  ): JsonValue | Promise<JsonValue>;
}

export type WorkRequest = {
  /** Stable identity. Repeating the identical request reuses its committed result. */
  id: string;
  role: string;
  input: JsonValue;
};

export type Work = WorkRequest & {
  status: "queued" | "active" | "completed" | "failed" | "cancelled";
  taskId: TaskId<JsonValue>;
  attempts: number;
  attemptId: string | null;
  /** Completion signal ID, present only after successful shared publication. */
  publicationId: TaskId<JsonValue> | null;
  result: JsonValue;
  error: string | null;
};

export type Signal = {
  id: TaskId<JsonValue>;
  kind: "start" | "completed" | "failed" | "input";
  value: JsonValue;
  /** Present on keyed external input signals. */
  key?: string;
};

export type CampaignInput = {
  id: TaskId<JsonValue>;
  key: string | null;
  value: JsonValue;
};

export type CampaignView = Pick<CampaignState, "task" | "status" | "state"> & {
  work: Work[];
  /** Accepted external input receipts in ascending receipt ID order. */
  inputs: CampaignInput[];
};

export type Decision = {
  state: JsonValue;
  dispatch?: WorkRequest[];
  /** Requires the application's explicit accept function. */
  completion?: JsonValue;
};

export interface Coordinator {
  readonly name: string;
  run(
    signal: Signal,
    view: CampaignView,
    execution: Execution,
    context: Context,
  ): Decision | Promise<Decision>;
}

const nonnegativeIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
export const positiveIntegerSchema = Type.Integer({
  ...nonnegativeIntegerSchema,
  minimum: 1,
});
export const limitsSchema = Type.Object(
  {
    /** Concurrent admitted workers; Coordinator may run alongside them. */
    concurrency: positiveIntegerSchema,
    /** Transient recovery allowance, including attempts interrupted by close/crash. */
    attempts: positiveIntegerSchema,
  },
  { additionalProperties: false },
);
export type Limits = Static<typeof limitsSchema>;

export type CampaignState = {
  version: typeof campaignVersion;
  task: JsonValue;
  coordinator: string;
  status: XeanStatus;
  state: JsonValue;
  limits: Limits;
  /** Number of logical provider calls admitted, retained for observation only. */
  providerCalls: number;
  result: JsonValue;
  error: string | null;
};

export type Campaign = CampaignState &
  CampaignView & {
    pendingSignals: number;
  };

export interface XeanOptions {
  /** Required for a new campaign; checked for equality if supplied on reopen. */
  task?: JsonValue;
  roles: readonly Role[];
  coordinator: Coordinator;
  /** New-campaign limits. If supplied on reopen, must match the recorded limits. */
  limits?: Partial<Limits>;
  /** Application-owned acceptance, evaluated against the committed view. */
  accept?: (candidate: JsonValue, view: CampaignView) => boolean;
  /** Pure synchronous validation before a new external input is admitted. */
  validateInput?: (value: JsonValue, view: CampaignView) => void;
  telemetry?: TelemetryContext;
}
