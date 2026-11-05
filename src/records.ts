import {
  arr,
  defineState,
  local,
  obj,
  unknown,
  type Schema,
} from "@earendil-works/chord/next";
import type {
  ExplorerInput,
  SelectionInput,
  Verification,
  VerifierInput,
} from "./policy/contracts.ts";
import type { PiRoleProfile, SolveSettings } from "./policy/settings.ts";
import type { CodexRequest, CodexResult } from "./policy/source.ts";
import type { Definition, NotebookReference } from "./state.ts";

export type WorkInput =
  | {
      kind: "explorer";
      input: Omit<ExplorerInput, "namespace">;
      profile: PiRoleProfile;
    }
  | {
      kind: "selector";
      input: SelectionInput;
      settings: SolveSettings;
      verify?: Verification[];
    }
  | { kind: "verify"; input: VerifierInput; settings: SolveSettings };
export type WorkerArgs = {
  campaign: boolean;
  epoch: number;
  attempt: number;
  origin?: string;
  work: WorkInput;
};
export type WorkerState = { claim?: VerifierInput };
export type WorkerResult = {
  status: "completed" | "busy" | "no-work";
  verify: Verification[];
  notes?: string[];
};
export type WorkerRecord = {
  id: string;
  origin: string;
  args: WorkerArgs;
  state: WorkerState;
  status: "completed" | "failed";
  result?: WorkerResult;
  error?: string;
};
export type Campaign = {
  status: "pending" | "running" | "terminal";
  outcome?: "accepted" | "turn-limit" | "call-failure";
  error?: string;
  accepted?: string;
  guidanceThrough: number;
  publicationCount: number;
  epoch: number;
};
export type SourceRecord = {
  id: string;
  origin: string;
  attempt: number;
  key: string;
  request: CodexRequest;
  output: CodexResult;
};
export type ResearchData = {
  definition: Definition | null;
  notebook: NotebookReference;
  campaign: Campaign | null;
  history: WorkerRecord[];
  sources: SourceRecord[];
};
export const ResearchType = local("xean.research", {
  version: 1,
  params: {},
  members: {},
});
export const ResearchState = defineState("xean.research.data", {
  version: 1,
  schema: obj({
    definition: unknown() as Schema<Definition | null>,
    notebook: unknown() as Schema<NotebookReference>,
    campaign: unknown() as Schema<Campaign | null>,
    history: arr(unknown() as Schema<WorkerRecord>),
    sources: arr(unknown() as Schema<SourceRecord>),
  }),
  initial: (): ResearchData => ({
    definition: null,
    notebook: {
      path: "",
      publications: [],
      checks: [],
      guidance: [],
      inputs: [],
    },
    campaign: null,
    history: [],
    sources: [],
  }),
  persist: true,
  checkpointWhen: () => false,
});
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
