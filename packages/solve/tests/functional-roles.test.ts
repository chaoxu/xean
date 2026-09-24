import { afterEach, expect, test } from "bun:test";
import { createCampaign, openCampaign } from "xean";

import { coordinatorCall } from "../pi-roles";
import type { RoleImplementations } from "../role-functions";
import { createRoleHost } from "../role-host";
import {
  applicationId,
  journalVerdicts,
  readJournalVerdicts,
  verifierNames,
} from "../roles";
import { run } from "../runner";
import {
  deriveWorkflow,
  runWorkflow,
  workflowConfiguration,
} from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  createWorkflowCampaign,
  dependencies,
  dispatchExplorer,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);
const task = { problem: "Prove P.", completionCriteria: "Prove P fully." };
const note = { text: "ORIGINAL PROOF of P.", support: [] as string[] };
const pass = (note: string) => ({
  note,
  verdict: "PASS" as const,
  report: "Checked.",
});
const explore = {
  role: "explorer" as const,
  explorerGuidance: "Prove P.",
  support: [],
};

// These implementations have no Campaign or provider dependency.
const implementations: RoleImplementations = {
  async coordinator(input) {
    expect(Object.isFrozen(input.task)).toBe(true);
    expect(Reflect.set(input.task, "problem", "Changed task")).toBe(false);
    expect(input.task).toEqual(task);
    if (input.literatureStatus === "not-started")
      return {
        filings: [],
        action: { role: "literature", request: "Find prior work." },
      };
    if (input.notes.length === 0) return { filings: [], action: explore };
    return {
      filings: [{ note: "n1", summary: "P holds." }],
      action: {
        ...(input.coordinatorBehavior.overlap ? explore : {}),
        role: "verifier",
        verify: [{ note: "n1", verifiers: [...verifierNames] }],
      },
    };
  },
  async literature() {
    return { notes: [] };
  },
  async explorer(input) {
    if (input.notes.length > 0) return { notes: [], solution: false };
    return { notes: [note], solution: true };
  },
  async correctness({ judged }) {
    return {
      verdicts: judged.map((id) => ({ ...pass(id), externalResults: [] })),
    };
  },
  async source() {
    throw new Error("No external premise needs checking");
  },
  async requirements({ judged }) {
    return { verdicts: judged.map(pass) };
  },
  async statement() {
    return { statement: "P holds." };
  },
  async proof(input) {
    expect(input).toEqual({
      task,
      support: [],
      statement: { statement: "P holds." },
    });
    expect(JSON.stringify(input)).not.toContain(note.text);
    return { proof: "An independent proof of P." };
  },
  async reconstruction({ note, proof }) {
    expect(proof).toBe("An independent proof of P.");
    return { statement: null, verdicts: [pass(note.id)] };
  },
};

test.each([false, true])(
  "public run needs no providers for direct role functions (initializer=%s)",
  async (supplyInitializer) => {
    const path = campaignPath();
    const previous = process.env["XEAN_CODEX_COMMAND"];
    process.env["XEAN_CODEX_COMMAND"] = `${path}.missing-codex`;
    const settings = roleSettings();
    const request = {
      task,
      campaignPath: path,
      turns: 3,
      settings: {
        ...settings,
        coordinatorBehavior: {
          ...settings.coordinatorBehavior,
          literature: "optional" as const,
        },
      },
    };
    const providerSetup = supplyInitializer
      ? {
          models: async () => {
            throw new Error("Unused model initializer ran");
          },
        }
      : {};
    try {
      const result = await run(request, {
        roles: implementations,
        ...providerSetup,
      });
      expect(result).toMatchObject({
        outcome: "accepted",
        turns: 3,
        note: { id: "n1", text: note.text },
      });
      expect(
        await run(request, { roles: implementations, ...providerSetup }),
      ).toEqual(result);
    } finally {
      if (previous === undefined) delete process.env["XEAN_CODEX_COMMAND"];
      else process.env["XEAN_CODEX_COMMAND"] = previous;
    }
  },
);

test.each([false, true])(
  "a replacement using Pi resolves its configured model lazily (known=%s)",
  async (known) => {
    const settings = roleSettings();
    const drive = dependencies([dispatchExplorer()]);
    let entered = false;
    let initialized = 0;
    const result = run(
      {
        task,
        campaignPath: campaignPath(),
        turns: 1,
        settings: {
          ...settings,
          coordinator: {
            ...settings.coordinator,
            model: known ? settings.coordinator.model : "missing-test-model",
          },
        },
      },
      {
        models: async () => {
          expect(entered).toBe(true);
          initialized++;
          return drive.models;
        },
        run: drive.run,
        roles: {
          async coordinator(input, execution) {
            entered = true;
            return execution.pi(coordinatorCall(input));
          },
          explorer: implementations.explorer,
        },
      },
    );
    if (known) {
      expect(await result).toMatchObject({ outcome: "turn-limit", turns: 1 });
      expect(drive.calls).toHaveLength(1);
      expect(drive.calls[0]!.model.id).toBe(settings.coordinator.model);
    } else {
      await expect(result).rejects.toThrow("missing-test-model");
      expect(drive.calls).toHaveLength(0);
    }
    expect(initialized).toBe(1);
  },
);

test.each([false, true])(
  "replacement functions solve and replay without a provider (overlap=%s)",
  async (overlap) => {
    const path = campaignPath();
    const settings = roleSettings();
    const config = workflowConfiguration({
      task,
      settings: {
        ...settings,
        coordinatorBehavior: {
          ...settings.coordinatorBehavior,
          literature: "optional",
          overlap,
        },
      },
    });
    let campaign = await createWorkflowCampaign(path, config, 3);
    const drive = dependencies([]);
    try {
      const phase = await runWorkflow(
        campaign,
        createRoleHost(campaign, config.settings, drive, implementations),
      );
      expect(phase).toMatchObject({
        kind: "accepted",
        turns: 3,
        note: { id: "n1", ...note, verified: true },
      });
      expect(drive.calls).toHaveLength(0);
      expect(drive.codexCalls).toHaveLength(0);
      expect(
        campaign
          .records()
          .filter((entry) => entry.kind === "call" && entry.role !== undefined)
          .every(
            (entry) =>
              entry.kind === "call" &&
              (entry.request as { protocol?: string }).protocol ===
                "xean-solve/role/v1",
          ),
      ).toBe(true);
      const records = campaign.records();
      expect(deriveWorkflow(campaign)).toEqual(deriveWorkflow(records));
      expect(readJournalVerdicts(campaign)).toEqual(journalVerdicts(records));
      campaign.close();
      campaign = openCampaign(path);
      const fail = async () => {
        throw new Error("Replay invoked a role");
      };
      const unreachable: RoleImplementations = {
        coordinator: fail,
        explorer: fail,
        literature: fail,
        correctness: fail,
        source: fail,
        requirements: fail,
        statement: fail,
        proof: fail,
        reconstruction: fail,
      };
      expect(
        await runWorkflow(
          campaign,
          createRoleHost(campaign, config.settings, drive, unreachable),
        ),
      ).toEqual(phase);
      expect(campaign.records()).toEqual(records);
    } finally {
      campaign.close();
    }
  },
);

test("the host rejects invalid replacement outputs before admission", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
    schemaVersion: 1,
  });
  try {
    const host = createRoleHost(campaign, roleSettings(), dependencies([]), {
      explorer: async () => ({
        notes: [{ ...note, support: ["n99"] }],
        solution: true,
      }),
      correctness: async () => ({
        verdicts: [{ ...pass("n99"), externalResults: [] }],
      }),
    });
    await expect(
      host.explorer({
        task,
        notes: [],
        support: [],
        explorerGuidance: "Prove P.",
      }),
    ).rejects.toThrow();
    await expect(
      host.verifier({
        task,
        support: [],
        notes: [
          { id: "n1", ...note, verdicts: [], verified: false, dead: false },
        ],
        verify: [{ note: "n1", verifiers: ["correctness"] }],
      }),
    ).rejects.toThrow();
    expect(campaign.records({ kinds: ["tool-call", "evidence"] })).toEqual([]);
  } finally {
    campaign.close();
  }
});

test("replacement Explorer submissions survive failure and retain IDs on reopening", async () => {
  const path = campaignPath();
  const settings = roleSettings();
  const config = workflowConfiguration({ task, settings });
  let campaign = await createWorkflowCampaign(path, config, 1);
  try {
    await expect(
      runWorkflow(
        campaign,
        createRoleHost(campaign, settings, dependencies([]), {
          coordinator: async () => ({ filings: [], action: explore }),
          async explorer(_input, execution) {
            await execution.submit({ notes: [note], solution: false });
            throw new Error("Interrupted after submission");
          },
        }),
      ),
    ).rejects.toThrow("Interrupted after submission");
    expect(deriveWorkflow(campaign.records()).notes).toMatchObject([
      { id: "n1", ...note },
    ]);
    campaign.close();
    campaign = openCampaign(path);
    const next = { text: "A consequence of n1.", support: ["n1"] };
    const phase = await runWorkflow(
      campaign,
      createRoleHost(campaign, settings, dependencies([]), {
        async explorer(input, execution) {
          expect(input.support).toMatchObject([{ id: "n1", ...note }]);
          const result = { notes: [next], solution: true };
          expect(await execution.submit(result)).toEqual({ noteIds: ["n2"] });
          return result;
        },
      }),
    );
    expect(phase).toMatchObject({
      kind: "turn-limit",
      notes: [
        { id: "n1", ...note },
        { id: "n2", ...next },
      ],
    });
  } finally {
    campaign.close();
  }
});

test("a replacement source role cannot pass invented retrieval evidence", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
    schemaVersion: 1,
  });
  try {
    const host = createRoleHost(campaign, roleSettings(), dependencies([]), {
      correctness: async () => ({
        verdicts: [{ ...pass("n1"), externalResults: ["External theorem P."] }],
      }),
      async source(input) {
        return {
          verdicts: [
            {
              ...pass("n1"),
              correctedText: null,
              sources: [
                {
                  resultId: input.notes[0]!.externalResults[0]!.id,
                  source: "Invented inspection",
                  url: "https://example.org/paper",
                  quote: "P holds.",
                },
              ],
            },
          ],
        };
      },
    });
    const verdicts = await host.verifier({
      task,
      support: [],
      notes: [
        { id: "n1", ...note, verdicts: [], verified: false, dead: false },
      ],
      verify: [{ note: "n1", verifiers: ["correctness", "source"] }],
    });
    expect(verdicts).toMatchObject([
      { verifier: "correctness", verdict: "PASS" },
      { verifier: "source", verdict: "INCONCLUSIVE" },
    ]);
  } finally {
    campaign.close();
  }
});
