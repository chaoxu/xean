import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import { positiveIntegerSchema } from "../types.ts";
import type { Role, WorkRequest, XeanOptions } from "../types.ts";
import { json } from "../json.ts";
import { project } from "./projection.ts";
import { editingDecision, editingResult, projectEditing } from "./editor.ts";
import {
  closure,
  completion,
  corpusStats,
  noteInfo,
  refresh,
  sourceEvidence,
  validateNotes,
} from "./notes.ts";
import {
  decode,
  declarationVersion,
  taskSchema,
  verificationTargets,
  type ExplorerInput,
  type SolverInput,
  type Task,
  type VerifierInput,
} from "./contracts.ts";
import {
  createRoles,
  type CoordinationInput,
  type RoleOptions,
} from "./roles.ts";
import { type PiRuntime } from "./pi.ts";
import { codexResearch, type Research } from "./research.ts";
import { guidance, validateCommand } from "./commands.ts";

export function createSolver(
  taskValue: Task,
  runtime: PiRuntime | (() => PiRuntime),
  settings: Partial<RoleOptions> = {},
  research?: Research | ((runtime: PiRuntime) => Research),
) {
  const task = decode(taskSchema, taskValue);
  const maxExplorerReads = settings.maxExplorerReads ?? 4;
  const options: RoleOptions = {
    maxExplorerResponses: maxExplorerReads + 4,
    literature: false,
    maxExplorerReads,
    ...settings,
  };
  if (!Check(positiveIntegerSchema, options.maxExplorerResponses))
    throw new Error("maxExplorerResponses must be a positive integer");
  if (!Check(positiveIntegerSchema, options.maxExplorerReads))
    throw new Error("maxExplorerReads must be a positive integer");
  if (
    options.editingThresholdTokens != null &&
    !Check(positiveIntegerSchema, options.editingThresholdTokens)
  )
    throw new Error(
      "editingThresholdTokens must be a positive integer or null",
    );
  let implementation: ReturnType<typeof createRoles> | undefined;
  const load = () => {
    if (!implementation) {
      const ready = typeof runtime === "function" ? runtime() : runtime;
      implementation = createRoles(
        ready,
        typeof research === "function"
          ? research(ready)
          : (research ?? codexResearch(undefined, ready.usagePrefix)),
        options,
      );
    }
    return implementation;
  };
  const functions: ReturnType<typeof createRoles> = {
    explorer: async (...args) => load().explorer(...args),
    editor: async (...args) => load().editor(...args),
    editionReview: async (...args) => load().editionReview(...args),
    coordinator: async (...args) => load().coordinator(...args),
    verifier: async (...args) => load().verifier(...args),
    reconstruct: async (...args) => load().reconstruct(...args),
    literature: async (...args) => load().literature(...args),
    review: async (...args) => load().review(...args),
  };
  const roles: Role[] = (
    [
      "explorer",
      "verifier",
      "literature",
      "editor",
      "editVerifier",
      "editionReview",
    ] as const
  ).map((name) => ({
    name: `xean.${name}`,
    run: (input, execution, context) =>
      functions[name === "editVerifier" ? "verifier" : name](
        input as never,
        execution,
        context,
      ),
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
      if (typeof view.state === "string") {
        const work = view.work.filter((work) =>
          work.id.startsWith(`${view.state}/`),
        );
        const original = work[0]!.input as unknown as SolverInput;
        const edition = projectEditing(original, work);
        if (
          !editingResult(edition) &&
          isDeepStrictEqual(notes, edition.original) &&
          (work.at(-1)?.status !== "failed" ||
            view.callLimitReached ||
            signal.kind === "allowance")
        ) {
          const decision = editingDecision(
            signal,
            view,
            original,
            work,
            view.state,
          );
          return { ...decision, state: view.state };
        }
        // Finished, stale, or operationally failed edits return to ordinary planning.
      }
      if (view.callLimitReached) return { state: null };
      const literatureUsed = view.work.some(
        (work) =>
          work.role === "xean.literature" && work.status === "completed",
      );
      const lastEdition = view.work.findLast(
        (work) =>
          work.role === "xean.editionReview" &&
          work.status === "completed" &&
          (work.result as { verdict?: string } | null)?.verdict === "PASS" &&
          (work.input as unknown as SolverInput).notes.every(
            (note) => note.verified,
          ),
      );
      const input: CoordinationInput = {
        task,
        notes,
        corpus: corpusStats(notes),
        editingAvailable:
          options.editingThresholdTokens != null &&
          notes.length > 0 &&
          !isDeepStrictEqual(
            (lastEdition?.input as unknown as SolverInput | undefined)?.notes,
            notes,
          ),
        guidance: guidance(view),
        literatureUsed,
        failures: view.work
          .filter((work) => work.status === "failed")
          .map(({ id, role, error }) => ({ id, role, error })),
      };
      const plan = await functions.coordinator(input, execution, context);
      if (plan.work.some((request) => request.kind === "editor")) {
        if (!input.editingAvailable || plan.work.length !== 1)
          throw new Error("Editing must be enabled, useful, and run alone");
        const group = `edit-${signal.id}`;
        return {
          ...editingDecision(signal, view, { task, notes }, [], group),
          state: group,
        };
      }
      const common = { task, notes: notes.map(noteInfo) };
      // Explorer workers may run alongside the single verification batch.
      const targets = verificationTargets(plan);
      const dispatch: WorkRequest[] = plan.work
        .filter(
          (request) => request.kind !== "verifier" && request.kind !== "editor",
        )
        .map((request, index): WorkRequest => ({
          id: `w${signal.id}-${index + 1}`,
          role: `xean.${request.kind}`,
          input:
            request.kind === "explorer"
              ? ({
                  task,
                  notes,
                  guidance: request.guidance,
                } satisfies ExplorerInput)
              : { ...common, query: request.query },
        }));
      if (targets.length)
        dispatch.push({
          id: `w${signal.id}-${dispatch.length + 1}`,
          role: "xean.verifier",
          input: {
            task,
            notes: closure(
              targets.map((target) => target.id),
              notes,
            ),
            targets,
            evidence: sourceEvidence(notes),
          } satisfies VerifierInput,
        });
      return { state: null, dispatch };
    },
  };
  const accept: NonNullable<XeanOptions["accept"]> = (candidate, view) => {
    // Acceptance is reconstructed from committed worker evidence, never a Coordinator claim.
    const expected = completion(task, project(view));
    return expected !== undefined && isDeepStrictEqual(candidate, expected);
  };
  return {
    task: { kind: "xean.solve.library", version: declarationVersion, task },
    roles,
    coordinator,
    accept,
    validateInput: validateCommand,
    functions,
    options,
  };
}

/** Run the shared editing loop directly on a frozen corpus. */
export function createEditor(
  input: SolverInput,
  runtime: PiRuntime | (() => PiRuntime),
  settings: Partial<RoleOptions> = {},
  research?: Research | ((runtime: PiRuntime) => Research),
): XeanOptions {
  input = structuredClone(input);
  if (!input.notes.length)
    throw new Error("Editing requires a nonempty corpus");
  input.notes = closure(
    input.notes.map((note) => note.id),
    input.notes,
  );
  validateNotes(input.notes, []);
  refresh(input.notes);
  const solver = createSolver(input.task, runtime, settings, research);
  return {
    task: json({
      kind: "xean.edit.library",
      version: declarationVersion,
      ...input,
    }),
    roles: solver.roles.filter((role) =>
      ["xean.editor", "xean.editVerifier", "xean.editionReview"].includes(
        role.name,
      ),
    ),
    coordinator: {
      name: "xean.edit",
      run: (signal, view) =>
        editingDecision(signal, view, input, view.work, "edit"),
    },
    accept: (candidate, view) => {
      const expected = editingResult(projectEditing(input, view.work));
      return (
        expected !== undefined && isDeepStrictEqual(candidate, json(expected))
      );
    },
    validateInput() {
      throw new Error(
        "Editing uses a frozen corpus; start a new run for changed input",
      );
    },
  };
}
