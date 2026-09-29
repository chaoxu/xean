import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { StringEnum, Type, type Static } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import { json } from "../json.ts";
import { campaignAddress } from "../store.ts";
import type { JsonValue, XeanOptions } from "../types.ts";
import { readSettings, settingsSchema } from "./config.ts";
import { decode, declarationVersion, object, taskSchema } from "./contracts.ts";
import type { PiRuntime } from "./pi.ts";
import { createSolver, createEditor } from "./solver.ts";
import type { SolverInput } from "./contracts.ts";
import { codexResearch } from "./research.ts";

export { declarationVersion } from "./contracts.ts";
const common = {
  version: Type.Literal(declarationVersion),
  task: taskSchema,
  settings: settingsSchema,
};
const declarationSchema = Type.Union([
  object({ ...common, kind: Type.Literal("xean.solve") }),
  object({
    ...common,
    kind: Type.Literal("xean.role"),
    role: StringEnum([
      "explorer",
      "editorAudit",
      "editorAuditReview",
      "editor",
      "editionReview",
      "coordinator",
      "verifier",
      "reconstruct",
      "literature",
    ] as const),
    input: Type.Record(Type.String(), Type.Unknown()),
  }),
  object({
    ...common,
    kind: Type.Literal("xean.edit"),
    input: Type.Record(Type.String(), Type.Unknown()),
  }),
  object({
    ...common,
    kind: Type.Literal("xean.review"),
    argument: Type.String({ minLength: 1 }),
  }),
]);
export type Declaration = Static<typeof declarationSchema>;

/** Only the current declaration is supported; historical journals retain their original format. */
export function readDeclaration(value: unknown): Declaration {
  const declaration = decode(declarationSchema, json(value));
  readSettings(declaration.settings);
  if (
    (declaration.kind === "xean.role" || declaration.kind === "xean.edit") &&
    !isDeepStrictEqual(declaration.task, declaration.input.task)
  )
    throw new Error("Standalone input must contain the declared task");
  return declaration;
}

/** Load the declaration through the same owned storage used to open the engine. */
export async function loadDeclaration(storage: Storage): Promise<Declaration> {
  const record = await storage.findDocument(
    campaignAddress,
    "current",
    BACKGROUND_CONTEXT,
  );
  const document =
    record &&
    (await storage.document(record.id, "current", BACKGROUND_CONTEXT));
  if (!document) throw new Error("No Xean campaign declaration");
  return readDeclaration(document.value.task);
}

/** Solver and standalone commands share the same role functions and durable kernel. */
export function campaignOptions(
  value: Declaration,
  runtime: PiRuntime | (() => PiRuntime),
): XeanOptions {
  const declaration = readDeclaration(value);
  const settings = declaration.settings;
  if (declaration.kind === "xean.edit") {
    return {
      ...createEditor(
        declaration.input as SolverInput,
        runtime,
        settings,
        (ready) => codexResearch(settings.research, ready.usagePrefix),
      ),
      task: declaration as unknown as JsonValue,
      limits: settings.limits,
    };
  }
  const solver = createSolver(declaration.task, runtime, settings, (ready) =>
    codexResearch(settings.research, ready.usagePrefix),
  );
  const options: XeanOptions = {
    task: declaration as unknown as JsonValue,
    roles: solver.roles,
    coordinator: solver.coordinator,
    accept: solver.accept,
    validateInput: solver.validateInput,
    limits: settings.limits,
  };
  if (declaration.kind === "xean.solve") return options;

  const name = declaration.kind === "xean.review" ? "review" : declaration.role;
  const input =
    declaration.kind === "xean.review"
      ? { task: declaration.task, argument: declaration.argument }
      : declaration.input;
  const run = solver.functions[name];
  return {
    ...options,
    validateInput() {
      throw new Error("Only solver campaigns accept input commands");
    },
    roles: [
      {
        name,
        run: (input, execution, context) =>
          run(input as never, execution, context),
      },
    ],
    coordinator: {
      name: declaration.kind,
      run(signal, view) {
        if (signal.kind === "start")
          return {
            state: null,
            dispatch: [{ id: "role", role: name, input: input as JsonValue }],
          };
        const work = view.work.find((work) => work.id === "role");
        if (work?.status === "failed")
          throw new Error(work?.error ?? "Role failed");
        if (work?.status !== "completed") return { state: null };
        return { state: null, completion: work?.result };
      },
    },
    // Completion records successful execution, including FAIL or INCONCLUSIVE reviews.
    accept: (candidate, view) => {
      const work = view.work.find((work) => work.id === "role");
      return (
        work?.status === "completed" &&
        isDeepStrictEqual(candidate, work.result)
      );
    },
  };
}
