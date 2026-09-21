#!/usr/bin/env bun
// A stand-in for the Codex CLI used by the source verifier tests. It captures
// its invocation and answers with a fixed verdict per note under verification.

import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { codexStdout } from "./codex-stdout";

const args = Bun.argv.slice(2);
const capturePath = process.env["FAKE_CODEX_CAPTURE"];
if (process.env["CODEX_HOME"] === undefined) {
  throw new Error("missing CODEX_HOME");
}
const executing = args.includes("exec") && !args.includes("--help");
const input = executing ? await Bun.stdin.text() : "";
const option = (name: string): string => {
  const index = args.indexOf(name);
  const value = args[index + 1];
  if (index < 0 || value === undefined) throw new Error(`missing ${name}`);
  return value;
};
if (capturePath !== undefined)
  await appendFile(
    capturePath,
    `${JSON.stringify({
      args,
      input,
      ...(executing
        ? {
            schema: JSON.parse(
              await readFile(option("--output-schema"), "utf8"),
            ),
          }
        : {}),
    })}\n`,
  );

if (args[0] === "--version") {
  console.log("codex-cli fake-1.0");
} else if (args.includes("--help")) {
  console.log(
    "--search --disable --model --config --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check --sandbox --json --color --output-schema --cd",
  );
} else if (args.includes("login") && args.includes("status")) {
  const auth = JSON.parse(
    await readFile(join(process.env["CODEX_HOME"], "auth.json"), "utf8"),
  );
  process.exitCode = auth.tokens || auth.OPENAI_API_KEY ? 0 : 1;
} else if (process.env["FAKE_CODEX_MODE"] === "malformed") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake" }));
  console.log("{");
  process.exitCode = 17;
} else {
  const notes = JSON.parse(input).notes as {
    id: string;
    externalResults: { id: string; text: string }[];
  }[];
  if (notes.length === 0) throw new Error("prompt names no note");
  console.log(
    codexStdout(
      {
        verdicts: notes.map(({ id: note, externalResults }) => ({
          note,
          verdict: "PASS",
          report: "The primary source establishes each assigned result.",
          sources: externalResults.map(({ id, text }) => ({
            resultId: id,
            result: text,
            source: "Primary theorem.",
            url: "https://example.test/theorem",
            quote: "The exact statement.",
          })),
        })),
      },
      process.env["FAKE_CODEX_MODE"] !== "no-search",
    ),
  );
}
