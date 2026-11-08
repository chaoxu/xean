import type { JsonValue } from "@earendil-works/chord/json";
import {
  judgedBy,
  missingVerdicts,
  proof,
  reconstructionResultFor,
  reconstructionStatementIds,
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
  /** Replay completed native receipts before making another model call. */
  call(
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
  ): Promise<{ call: number; value: JsonValue }>;
  /** Validate and atomically publish the source result and its verdicts. */
  source?(
    key: string,
    request: CodexRequest,
    judged: readonly string[],
  ): Promise<void>;
  recorded(): Promise<Verdict[]>;
  record(call: number, verdicts: Verdict[]): Promise<void>;
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
  const statementIds = reconstructionStatementIds(input);
  let value = statementsFor(statementIds).parse(statement.value);
  let previous: number | undefined;
  for (;;) {
    const suffix = previous ?? "initial";
    const answer = await dependencies.call(
      `${key}/proof/${suffix}`,
      { kind: "proof", input, statement: value },
      profile,
    );
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
    const parsed = reconstructionResultFor(ids, statementIds).parse(
      result.value,
    );
    if (parsed.statements.length > 0) {
      value = { statements: parsed.statements };
      previous = result.call;
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
    if (name === "reconstruction") {
      // A comparison publishes its entire batch in one commit. Do not regroup
      // that frozen assignment from the outcomes it has already published.
      if (have.some((value) => value.verifier === name)) return;
      const roots = judgedBy(input, have, name);
      if (roots.length === 0) continue;
      const result = await reconstruct(
        reconstructionInput(input, roots),
        settings.reconstruction,
        dependencies,
      );
      await dependencies.record(
        result.call,
        result.verdicts.map((value) => ({ ...value, verifier: name })),
      );
      return;
    }
    const judged = missingVerdicts(have, name, judgedBy(input, have, name));
    if (judged.length === 0) continue;
    const key = `${name}/${judged.join(",")}`;
    if (name === "source" && codexSource(settings.source)) {
      if (!dependencies.source)
        throw new Error("Codex source runtime is unavailable");
      const request = sourceCall(settings.source, input, judged);
      await dependencies.source(key, request, judged);
      continue;
    }
    const profile =
      name === "source" ? (settings.source as PiRoleProfile) : settings[name];
    const result = await dependencies.call(
      key,
      { kind: "verifier", name, input, judged },
      profile,
    );
    const { verdicts } = verdictsFor(judged).parse(result.value);
    await dependencies.record(
      result.call,
      verdicts.map(({ note, verdict, report }) => ({
        note,
        verdict,
        report,
        verifier: name,
      })),
    );
  }
}
