import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runScriptedVerifier } from "../examples/scripted-verifier";

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true });
  directory = undefined;
});

test("scripted deterministic verifier records application-owned evidence", async () => {
  directory = mkdtempSync(join(tmpdir(), "xean-reference-"));
  const report = await runScriptedVerifier(join(directory, "campaign.db"));
  expect(report).toMatchObject({ verdict: "PASS", verified: true });
});
