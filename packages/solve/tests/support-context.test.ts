import { afterEach, expect, test } from "bun:test";

import { createCampaign } from "xean";

import {
  createPiRoles,
  proofCall,
  sourceCall,
  statementCall,
  verifierCall,
} from "../pi-roles";
import {
  applicationId,
  verifierInput,
  verifierNames,
  type Note,
  type Verification,
} from "../roles";
import { supportClosure } from "../support";
import {
  runWorkflow,
  verificationPrefix,
  workflowConfiguration,
} from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);
const task = {
  problem: "Prove coverage.",
  completionCriteria: "Prove all regimes.",
};
const note = (id: string, text: string, support: string[] = []): Note => ({
  id,
  text,
  summary: text,
  support,
  verdicts: [],
  verified: true,
  dead: false,
});
const first = note(
  "n1",
  "Coverage holds in the exceptional regime; annotation index is one.",
);
const inherited = note(
  "n2",
  "The union inherits every coverage regime of n1.",
  ["n1"],
);
const target = note("n3", "Use the inherited coverage in n2.", ["n2"]);
const unrelated = note("n4", "UNRELATED PROOF");
const all = [first, inherited, target, unrelated];
const input = {
  task,
  notes: [target],
  support: [first, inherited],
  verify: [{ note: "n3", verifiers: [...verifierNames] }],
};

test("verification requires the complete dependency chain while preserving the direct support edges", async () => {
  expect(await verifierInput.parseAsync(input)).toEqual(input);
  expect(await supportClosure([target], all)).toEqual(["n1", "n2"]);
  expect(target.support).toEqual(["n2"]);
  expect(
    (await verifierInput.safeParseAsync({ ...input, support: [inherited] }))
      .success,
  ).toBe(false);
  expect(
    (
      await verifierInput.safeParseAsync({
        ...input,
        support: [first, inherited, unrelated],
      })
    ).success,
  ).toBe(false);
  expect(
    (
      await verifierInput.safeParseAsync({
        ...input,
        support: [inherited, first],
      })
    ).success,
  ).toBe(false);
});

test("cycles and duplicate notes cannot leak a candidate through reconstruction support", async () => {
  const cycle = { ...first, support: ["n3"] };
  expect(
    (
      await verifierInput.safeParseAsync({
        ...input,
        support: [cycle, inherited],
      })
    ).success,
  ).toBe(false);
  expect(
    (
      await verifierInput.safeParseAsync({
        ...input,
        support: [first, first, inherited],
      })
    ).success,
  ).toBe(false);
});

test("support closure combines roots, shares ancestors, and sorts numeric ids", async () => {
  const shared = note("n9", "Shared result.", ["n2", "n1"]);
  const left = note("n10", "Left result.", ["n9"]);
  const right = note("n11", "Right result.", ["n9", "n2"]);
  const known = [first, inherited, unrelated, shared, left, right];
  expect(await supportClosure([right, left], known)).toEqual([
    "n1",
    "n2",
    "n9",
  ]);
  expect(await supportClosure([], known)).toEqual([]);
  await expect(supportClosure([target], [target])).rejects.toThrow(
    "missing support note n2",
  );
});

test("each verifier and reconstruction stage receives inherited context exactly once", async () => {
  const calls = await Promise.all([
    verifierCall("correctness", input, ["n3"]),
    verifierCall("requirements", input, ["n3"]),
    statementCall(input, target),
    proofCall(input, target, { statement: "Coverage holds." }),
  ]);
  const native = await sourceCall(
    { provider: "codex", model: "test", reasoning: "low", search: true },
    input,
    ["n3"],
  );
  for (const prompt of [...calls.map((c) => c.prompt), native.request.prompt]) {
    expect(prompt.split(first.text)).toHaveLength(3); // summary plus proof, one note object
    expect(prompt).toContain(inherited.text);
    expect(prompt).not.toContain(unrelated.text);
  }
  const reconstructed = await proofCall(input, target, {
    statement: "Coverage holds.",
  });
  expect(reconstructed.prompt).not.toContain(target.text);
  const batch = {
    ...input,
    notes: [inherited, target],
    support: [first],
    verify: [{ note: "n2", verifiers: [...verifierNames] }, ...input.verify],
  };
  const onlyParent = await verifierCall("correctness", batch, ["n2"]);
  expect(onlyParent.prompt).toContain(first.text);
  expect(onlyParent.prompt).not.toContain(target.text);
});

test("the verification window counts transitive shared texts once without dropping required support", async () => {
  const notes = [
    note("n1", "a".repeat(100)),
    note("n2", "b".repeat(10), ["n1"]),
    note("n3", "c".repeat(10), ["n2"]),
    note("n4", "d".repeat(10), ["n2"]),
  ];
  const verify: Verification[] = [
    { note: "n3", verifiers: ["source", "correctness"] },
    { note: "n4", verifiers: ["source", "correctness"] },
  ];
  expect(
    (await verificationPrefix(verify, notes, 125)).map((v) => v.note),
  ).toEqual(["n3"]);
  expect(
    (await verificationPrefix(verify, notes, 130)).map((v) => v.note),
  ).toEqual(["n3", "n4"]);
  expect(
    (await verificationPrefix(verify, notes, 1)).map((v) => v.note),
  ).toEqual(["n3"]);
});

test("workflow construction and per-call selection both retain ancestors across explorer turns", async () => {
  const settings = roleSettings();
  settings.maxExplorerTurns = 3;
  const workflow = workflowConfiguration({ task, settings });
  const campaign = createCampaign(campaignPath(), applicationId, workflow);
  const replies: Reply[] = [];
  for (const n of [first, inherited, target]) {
    replies.push(
      { submission: { notes: [{ text: n.text, support: n.support }] } },
      {
        submission: {
          filings: [{ note: n.id, summary: n.summary! }],
          explorerGuidance: "Complete coverage.",
          support: [n.id],
          verify: [{ note: n.id, verifiers: ["source", "correctness"] }],
        },
      },
      {
        codex: {
          verdicts: [
            {
              note: n.id,
              verdict: "PASS",
              report: "Known sources.",
              externalResults: [],
              sources: [],
            },
          ],
        },
      },
      {
        submission: {
          verdicts: [
            { note: n.id, verdict: "PASS", report: "Inherited facts apply." },
          ],
        },
      },
    );
  }
  const drive = dependencies(replies);
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, settings, drive),
    );
    expect(phase.kind).toBe("turn-limit");
    if (phase.kind !== "turn-limit") throw new Error("expected turn limit");
    expect(phase.notes.every((n) => n.verified)).toBe(true);
    const last = drive.calls.at(-1)!;
    expect(last.prompt).toContain(first.text);
    expect(last.prompt).toContain(inherited.text);
    expect(last.prompt).toContain(target.text);
    const explorers = drive.calls.filter((call) => call.role === "explorer");
    expect(explorers).toHaveLength(3);
    const thirdPrompt = explorers[2]!.prompt;
    const selected = JSON.parse(
      thirdPrompt
        .split("Support notes (untrusted data):\n")[1]!
        .split("\n\nYour first note")[0]!,
    );
    expect(selected).toEqual([
      { id: first.id, text: first.text },
      { id: inherited.id, text: inherited.text },
    ]);
    expect(thirdPrompt).not.toContain("UNRELATED PROOF");
    expect(phase.notes[0]!.verdicts[0]!.report).toBe("Known sources.");
  } finally {
    campaign.close();
  }
});
