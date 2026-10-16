import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import {
  judgedBy,
  missingVerdicts,
  pick,
  proof,
  reconstructionResultFor,
  sourceVerdicts,
  sourceVerdictsFor,
  statement,
  verdictsFor,
  verifierInput,
  verifierNames,
  type Note,
  type Verdict,
  type VerifierInput,
} from "./policy/contracts.ts";
import { sourceCall, type CallDescriptor } from "./policy/prompts.ts";
import {
  codexSource,
  type PiRoleProfile,
  type SolveSettings,
} from "./policy/settings.ts";
import type { CodexRequest } from "./policy/source.ts";

export interface VerificationDependencies {
  call(
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
  ): Promise<{
    call: number;
    value: JsonValue;
    fresh: boolean;
  }>;
  /** The source runtime validates search receipts before returning a submission. */
  source?(
    key: string,
    request: CodexRequest,
  ): Promise<{
    call: number;
    value: z.output<typeof sourceVerdicts>;
  }>;
  recorded(): Promise<Verdict[]>;
  record(call: number, verdicts: Verdict[]): Promise<void>;
}

export class RoleCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleCallError";
  }
}

async function reconstruct(
  input: VerifierInput,
  note: Note,
  profile: PiRoleProfile,
  dependencies: VerificationDependencies,
) {
  const key = `reconstruction/${note.id}`;
  let value = statement.parse(
    (
      await dependencies.call(
        `${key}/statement`,
        { kind: "statement", input, note },
        profile,
      )
    ).value,
  );
  let previous: number | undefined;
  let corrections = 0;
  for (;;) {
    const suffix = previous ?? "initial";
    const proofValue = proof.parse(
      (
        await dependencies.call(
          `${key}/proof/${suffix}`,
          { kind: "proof", input, note, statement: value, previous },
          profile,
        )
      ).value,
    ).proof;
    const result = await dependencies.call(
      `${key}/comparison/${suffix}`,
      {
        kind: "reconstruction",
        input,
        note,
        statement: value,
        proof: proofValue,
        previous,
      },
      profile,
    );
    const parsed = reconstructionResultFor(note.id).parse(result.value);
    if (parsed.statement !== null) {
      value = { statement: parsed.statement };
      previous = result.call;
      // Replayed corrections remain available without spending the fresh-call allowance.
      if (result.fresh && corrections++ >= 1) {
        throw new RoleCallError(
          "reconstruction statement remains unresolved; resume verification to use its latest correction",
        );
      }
      continue;
    }
    return { call: result.call, verdicts: parsed.verdicts };
  }
}

/** The v1 verification order; native callbacks own calls, recovery, and verdicts. */
export async function verify(
  inputValue: VerifierInput,
  settings: SolveSettings,
  dependencies: VerificationDependencies,
): Promise<Verdict[]> {
  const input = await verifierInput.parseAsync(inputValue);
  for (const name of verifierNames) {
    if (name === "reconstruction") {
      for (;;) {
        const have = await dependencies.recorded();
        const next = missingVerdicts(
          have,
          name,
          judgedBy(input, have, name),
        )[0];
        if (next === undefined) break;
        const result = await reconstruct(
          input,
          pick(input.notes, next),
          settings.reconstruction,
          dependencies,
        );
        await dependencies.record(
          result.call,
          result.verdicts.map((value) => ({ ...value, verifier: name })),
        );
        if (result.verdicts[0]!.verdict === "PASS")
          return dependencies.recorded();
      }
      continue;
    }
    const have = await dependencies.recorded();
    const judged = missingVerdicts(have, name, judgedBy(input, have, name));
    if (judged.length === 0) continue;
    const key = `${name}/${judged.join(",")}`;
    let call: number;
    let values: z.output<ReturnType<typeof verdictsFor>>["verdicts"];
    if (name === "source" && codexSource(settings.source)) {
      if (!dependencies.source)
        throw new RoleCallError("Codex source runtime is unavailable");
      const request = await sourceCall(settings.source, input, judged);
      const result = await dependencies.source(key, request.request);
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
  return dependencies.recorded();
}
