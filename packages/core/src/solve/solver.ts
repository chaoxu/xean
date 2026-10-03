import { isDeepStrictEqual } from "node:util";
import type { EntryId } from "@earendil-works/pi-durable";
import { readView } from "../history.ts";
import type { Role, WorkRequest, XeanOptions } from "../types.ts";
import {
  closure,
  completion,
  noteInfo,
  project,
  sourceEvidence,
} from "./notes.ts";
import {
  decode,
  canExplore,
  chatGptResponseLimit,
  declarationVersion,
  taskSchema,
  verificationTargets,
  type Plan,
  type Task,
  type VerifierInput,
} from "./contracts.ts";
import {
  createRoles,
  unconfiguredCodex,
  type CoordinationInput,
  type RoleOptions,
} from "./roles.ts";
import { type PiRuntime } from "./pi.ts";
import { codexResearch, type Research } from "./research.ts";
import { guidance, validateCommand } from "./commands.ts";
import { chatGptWebProviderId } from "../providers/chatgpt-web.ts";

type StoredInput = { view: EntryId } & (
  | Exclude<Plan["work"][number], { kind: "verifier" }>
  | { kind: "verifier"; targets: VerifierInput["targets"] }
);

export function createSolver(
  taskValue: Task,
  runtime: PiRuntime | (() => PiRuntime),
  settings: Partial<RoleOptions> = {},
  research: Research = codexResearch(),
) {
  const task = decode(taskSchema, taskValue);
  const {
    maxExplorerReads = 4,
    maxExplorerResponses = maxExplorerReads + 4,
    literature = false,
    chatGptSingleShot = false,
  } = settings;
  const options: RoleOptions = {
    ...settings,
    maxExplorerReads,
    maxExplorerResponses,
    literature,
    chatGptSingleShot,
  };
  const requestedExplorerResponses = settings.maxExplorerResponses;
  const load = () => {
    if (typeof runtime === "function") runtime = runtime();
    if (runtime.profiles.explorer.model.provider === chatGptWebProviderId) {
      options.maxExplorerResponses = chatGptResponseLimit(
        requestedExplorerResponses,
      );
      options.chatGptSingleShot = true;
    }
    return runtime;
  };
  const functions = createRoles(load, research, options);
  const builtInExplorer = functions.explorer;
  const roles: Role[] = (
    ["explorer", "verifier", "literature", "codex"] as const
  ).map((name) => ({
    name: `xean.${name}`,
    async run(value, execution, context) {
      const input = value as StoredInput;
      if (input.kind !== name) throw new Error("Solver work kind mismatch");
      const frozen = await execution.durable!.commit(
        (tx) => readView(tx, input.view),
        context,
      );
      const notes = project(frozen);
      const taskInput = structuredClone(task);
      switch (input.kind) {
        case "explorer":
          return functions.explorer(
            { task: taskInput, notes, guidance: input.guidance },
            execution,
            context,
          );
        case "verifier":
          return functions.verifier(
            {
              task: taskInput,
              notes: closure(
                input.targets.map(({ id }) => id),
                notes,
              ),
              targets: input.targets,
              evidence: sourceEvidence(notes),
            },
            execution,
            context,
          );
        case "codex":
          return functions.codex(
            {
              task: taskInput,
              notes: closure(input.notes, notes),
              assignment: input.assignment,
            },
            execution,
            context,
          );
        case "literature":
          return functions.literature(
            { task: taskInput, notes: notes.map(noteInfo), query: input.query },
            execution,
            context,
          );
      }
    },
  }));
  const coordinator: XeanOptions["coordinator"] = {
    name: "xean.coordinator",
    async run(signal, view, execution, context) {
      const notes = project(view);
      const result = completion(task, notes);
      if (result !== undefined)
        return { state: view.state, completion: result };
      if (
        view.work.some(
          (work) => work.status === "active" || work.status === "queued",
        )
      )
        return { state: view.state };
      const literatureUsed = view.work.some(
        (work) =>
          work.role === "xean.literature" && work.status === "completed",
      );
      const input: CoordinationInput = {
        task: structuredClone(task),
        notes,
        guidance: guidance(view),
        literatureUsed,
        explorerUsed:
          functions.explorer === builtInExplorer &&
          view.work.some((work) => work.role === "xean.explorer"),
        failures: view.work
          .filter((work) => work.status === "failed")
          .map(({ id, role, error }) => ({ id, role, error })),
      };
      const frozenInput = execution.inputId;
      if (frozenInput === undefined)
        throw new Error("Solver coordination requires a saved input");
      const plan = await functions.coordinator(input, execution, context);
      // A replaced planner need not initialize Pi. Resolve the built-in
      // Explorer's quota policy before dispatch, including after reopening.
      if (
        functions.explorer === builtInExplorer &&
        plan.work.some((request) => request.kind === "explorer")
      )
        load();
      // Explorer workers may run alongside the single verification batch.
      const targets = verificationTargets(plan);
      let explorerUsed = input.explorerUsed;
      const dispatch: WorkRequest[] = [];
      for (const request of plan.work) {
        if (request.kind === "verifier") continue;
        if (request.kind === "codex" && functions.codex === unconfiguredCodex)
          throw new Error("Codex worker is not configured");
        if (
          request.kind === "explorer" &&
          functions.explorer === builtInExplorer
        ) {
          if (!canExplore(options.chatGptSingleShot === true, explorerUsed))
            throw new Error(
              "Explorer is unavailable: its one-shot allowance was used",
            );
          explorerUsed = true;
        }
        dispatch.push({
          id: `w${signal.id}-${dispatch.length + 1}`,
          role: `xean.${request.kind}`,
          input: { view: frozenInput, ...request } satisfies StoredInput,
        });
      }
      if (targets.length)
        dispatch.push({
          id: `w${signal.id}-${dispatch.length + 1}`,
          role: "xean.verifier",
          input: {
            view: frozenInput,
            kind: "verifier",
            targets,
          } satisfies StoredInput,
        });
      return { state: view.state, dispatch };
    },
  };
  const accept: NonNullable<XeanOptions["accept"]> = (candidate, view) => {
    // Acceptance is reconstructed from committed worker evidence, never a Coordinator claim.
    const expected = completion(task, project(view));
    return expected !== undefined && isDeepStrictEqual(candidate, expected);
  };
  return {
    task: {
      kind: "xean.solve.library",
      version: declarationVersion,
      task: structuredClone(task),
    },
    roles,
    coordinator,
    accept,
    validateInput: validateCommand,
    functions,
    options,
  };
}
