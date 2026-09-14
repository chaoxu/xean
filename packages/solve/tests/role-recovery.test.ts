import { afterEach, expect, test } from "bun:test";
import { inspectCampaign, guideCampaign } from "../role-cli";
import { run } from "../runner";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const failure: Reply = {
  state: "failed",
  error: "The provider lost this continuation.",
  transcript: [
    {
      role: "assistant",
      stopReason: "length",
      responseId: "old-provider-response",
      content: [{ type: "text", text: "UNSAVED_PROVIDER_CONTEXT" }],
    },
    { role: "assistant", stopReason: "error", content: [] },
  ],
};

test("a failed provider continuation starts a fresh Explorer call with saved notes and frozen guidance", async () => {
  const path = campaignPath();
  const first = { text: "A saved lemma.", support: [] };
  const next = { text: "A consequence of n1.", support: ["n1"] };
  const drive = dependencies([
    {
      ...failure,
      onStarted: async (tools) => {
        expect(
          await tools[0]!.execute({ notes: [first], solution: false }),
        ).toEqual({ noteIds: ["n1"] });
        await guideCampaign(path, "Advice for a later turn.", "later");
      },
    },
    { submission: { notes: [next], solution: true } },
    {
      submission: {
        filings: ["n1", "n2"].map((note) => ({ note, summary: "A result." })),
        explorerGuidance: "Continue.",
        support: [],
        verify: [],
      },
    },
  ]);
  const result = await run(
    {
      task,
      campaignPath: path,
      settings: {
        ...roleSettings(),
        explorerContinuation: true,
        maxExplorerTurns: 1,
      },
    },
    drive,
  );
  expect(result).toMatchObject({ outcome: "turn-limit", turns: 1 });
  expect(drive.calls.map((call) => call.role)).toEqual([
    "explorer",
    "explorer",
    "coordinator",
  ]);
  expect(drive.calls[1]!.prompt).toContain(first.text);
  expect(drive.calls[1]!.prompt).toContain("Your first note is n2.");
  expect(drive.calls[1]!.prompt).not.toContain("UNSAVED_PROVIDER_CONTEXT");
  expect(drive.calls[1]!.prompt).not.toContain("old-provider-response");
  expect(drive.calls[1]!.prompt).not.toContain("Advice for a later turn.");
  const inspection: any = await inspectCampaign(path);
  expect(inspection.notes.map((note: any) => [note.id, note.text])).toEqual([
    ["n1", first.text],
    ["n2", next.text],
  ]);
  expect(inspection.calls[0].outcome).toBe("failed");
  expect(inspection.calls[1].outcome).toBe("succeeded");
});

test("fresh role retries are bounded even when every continuation fails", async () => {
  const drive = dependencies(Array.from({ length: 4 }, () => failure));
  const result = await run(
    { task, campaignPath: campaignPath(), settings: roleSettings() },
    drive,
  );
  expect(result).toMatchObject({ outcome: "call-failure", at: "explorer" });
  expect(drive.calls).toHaveLength(4);
}, 15_000);

test.each([
  {
    name: "an initial provider failure",
    reply: {
      ...failure,
      transcript: [{ role: "assistant", stopReason: "error", content: [] }],
    },
  },
  {
    name: "a provider error after a failed tool result",
    reply: {
      ...failure,
      transcript: [
        { role: "assistant", stopReason: "toolUse", content: [] },
        { role: "toolResult", isError: true, content: [] },
        { role: "assistant", stopReason: "error", content: [] },
      ],
    },
  },
  {
    name: "an invalid tool submission after earlier progress",
    reply: {
      ...failure,
      transcript: [
        { role: "assistant", stopReason: "length", content: [] },
        { role: "assistant", stopReason: "toolUse", content: [] },
        { role: "toolResult", isError: true, content: [] },
      ],
    },
  },
  { name: "a cancelled call", reply: { ...failure, state: "cancelled" } },
] as const)("$name is not automatically retried", async ({ reply }) => {
  const drive = dependencies([reply]);
  const result = await run(
    { task, campaignPath: campaignPath(), settings: roleSettings() },
    drive,
  );
  expect(result.outcome).toBe("call-failure");
  expect(drive.calls).toHaveLength(1);
});

test("operator cancellation interrupts retry backoff before a new role call", async () => {
  const controller = new AbortController();
  const drive = dependencies([failure]);
  const result = await run(
    { task, campaignPath: campaignPath(), settings: roleSettings() },
    {
      ...drive,
      signal: controller.signal,
      status(message) {
        if (message.includes("fresh call")) controller.abort();
      },
    },
  );
  expect(result.outcome).toBe("interrupted");
  expect(drive.calls).toHaveLength(1);
});

test("operator pause preserves a failed role without dispatching its retry", async () => {
  let pause = false;
  const drive = dependencies([
    {
      ...failure,
      onStarted: async () => {
        pause = true;
      },
    },
  ]);
  const result = await run(
    { task, campaignPath: campaignPath(), settings: roleSettings() },
    { ...drive, pauseRequested: () => pause },
  );
  expect(result).toMatchObject({ outcome: "paused", at: "explorer" });
  expect(drive.calls).toHaveLength(1);
});
