import { afterEach, expect, test } from "bun:test";
import { inspectCampaign, guideCampaign } from "../role-cli";
import { run } from "../runner";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  dispatchExplorer,
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

test("explicit resume after provider failure preserves saved notes and frozen guidance", async () => {
  const path = campaignPath();
  const first = { text: "A saved lemma.", support: [] };
  const next = { text: "A consequence of n1.", support: ["n1"] };
  const drive = dependencies([
    dispatchExplorer(),
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
  ]);
  const request = {
    task,
    campaignPath: path,
    settings: { ...roleSettings(), maxExplorerResponses: 4 },
    turns: 1,
  };
  expect(await run(request, drive)).toMatchObject({
    outcome: "call-failure",
    at: "explorer",
  });
  expect(drive.calls).toHaveLength(2);
  const result = await run(request, drive);
  expect(result).toMatchObject({ outcome: "turn-limit", turns: 1 });
  expect(drive.calls.map((call) => call.role)).toEqual([
    "coordinator",
    "explorer",
    "explorer",
  ]);
  expect(drive.calls[2]!.prompt).toContain(first.text);
  expect(drive.calls[2]!.prompt).toContain("Your first note is n2.");
  expect(drive.calls[2]!.prompt).not.toContain("UNSAVED_PROVIDER_CONTEXT");
  expect(drive.calls[2]!.prompt).not.toContain("old-provider-response");
  expect(drive.calls[2]!.prompt).not.toContain("Advice for a later turn.");
  const inspection: any = await inspectCampaign(path);
  expect(inspection.notes.map((note: any) => [note.id, note.text])).toEqual([
    ["n1", first.text],
    ["n2", next.text],
  ]);
  expect(inspection.calls[1].outcome).toBe("failed");
  expect(inspection.calls[2].outcome).toBe("succeeded");
});

test.each([
  { name: "a failed call", reply: failure },
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
