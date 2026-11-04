import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import {
  judgedBy,
  missingVerdicts,
  proof,
  reconstructionResultFor,
  sourceVerdicts,
  sourceVerdictsFor,
  statementsFor,
  verdictsFor,
  verifierNames,
  type ReconstructionInput,
  type Verdict,
  type VerifierInput,
} from "./policy/contracts.ts";
import { reconstructionInput } from "./policy/support.ts";
import { sourceCall, type CallDescriptor } from "./policy/prompts.ts";
import {
  codexSource,
  type PiRoleProfile,
  type SolveSettings,
} from "./policy/settings.ts";
import type { CodexRequest } from "./policy/source.ts";

export interface VerificationDependencies {
  premises?: Readonly<Record<string, string>>;
  /** Replay completed receipts first; undefined stops before a new call on adverse evidence. */
  call(
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
  ): Promise<{ call: number; value: JsonValue; fresh: boolean } | undefined>;
  /** The source runtime validates the structured Codex result. */
  source?(
    key: string,
    request: CodexRequest,
    judged: readonly string[],
  ): Promise<
    { call: number; value: z.output<typeof sourceVerdicts> } | undefined
  >;
  recorded(): Promise<Verdict[]>;
  record(call: number, verdicts: Verdict[]): Promise<void>;
  /** Add only this attempt's own evidence to its frozen input. */
  refresh?(input: VerifierInput, have: Verdict[]): Promise<VerifierInput>;
}

async function reconstruct(
  input: ReconstructionInput,
  profile: PiRoleProfile,
  dependencies: VerificationDependencies,
) {
  const ids = input.notes.map((note) => note.id);
  const key = `reconstruction/${ids.join(",")}`;
  const statement = await dependencies.call(
    `${key}/statement`,
    { kind: "statement", input },
    profile,
  );
  if (!statement) return;
  let value = statementsFor(ids).parse(statement.value);
  let previous: number | undefined;
  let corrections = 0;
  for (;;) {
    const suffix = previous ?? "initial";
    const answer = await dependencies.call(
      `${key}/proof/${suffix}`,
      { kind: "proof", input, statement: value },
      profile,
    );
    if (!answer) return;
    const proofValue = proof.parse(answer.value).proof;
    const result = await dependencies.call(
      `${key}/comparison/${suffix}`,
      {
        kind: "reconstruction",
        input,
        statement: value,
        proof: proofValue,
      },
      profile,
    );
    if (!result) return;
    const parsed = reconstructionResultFor(ids).parse(result.value);
    if (parsed.statements.length > 0) {
      value = { statements: parsed.statements };
      previous = result.call;
      // Replayed corrections remain available without spending the fresh-call allowance.
      if (result.fresh && corrections++ >= 1) {
        throw new Error(
          "reconstruction statement remains unresolved; resume verification to use its latest correction",
        );
      }
      continue;
    }
    return { call: result.call, verdicts: parsed.verdicts };
  }
}

/** Native callbacks own calls, recovery, and atomic batch verdicts. */
export async function verify(
  input: VerifierInput,
  settings: SolveSettings,
  dependencies: VerificationDependencies,
): Promise<void> {
  for (const name of verifierNames) {
    const have = await dependencies.recorded();
    input = (await dependencies.refresh?.(input, have)) ?? input;
    if (name === "reconstruction") {
      // A comparison publishes its entire batch in one commit. Do not regroup
      // that frozen assignment from the outcomes it has already published.
      if (have.some((value) => value.verifier === name)) return;
      const roots = judgedBy(input, have, name);
      if (roots.length === 0) continue;
      const result = await reconstruct(
        reconstructionInput(input, roots, dependencies.premises),
        settings.reconstruction,
        dependencies,
      );
      if (!result) return;
      await dependencies.record(
        result.call,
        result.verdicts.map((value) => ({ ...value, verifier: name })),
      );
      return;
    }
    const judged = missingVerdicts(have, name, judgedBy(input, have, name));
    if (judged.length === 0) continue;
    const key = `${name}/${judged.join(",")}`;
    let call: number;
    let values: z.output<ReturnType<typeof verdictsFor>>["verdicts"];
    if (name === "source" && codexSource(settings.source)) {
      if (!dependencies.source)
        throw new Error("Codex source runtime is unavailable");
      const request = sourceCall(settings.source, input, judged);
      const result = await dependencies.source(key, request, judged);
      if (!result) return;
      call = result.call;
      values = sourceVerdictsFor(judged).parse(result.value).verdicts;
    } else {
      const profile =
        name === "source" ? (settings.source as PiRoleProfile) : settings[name];
      const result = await dependencies.call(
        key,
        { kind: "verifier", name, input, judged },
        profile,
      );
      if (!result) return;
      call = result.call;
      values = verdictsFor(judged).parse(result.value).verdicts;
    }
    await dependencies.record(
      call,
      values.map(({ note, verdict, report }) => ({
        note,
        verdict,
        report,
        verifier: name,
      })),
    );
  }
}
