import { afterEach, expect, test } from "bun:test";
import { openCampaign, type Campaign } from "xean";
import type { PiRunOptions } from "xean/pi";

import { createPiRoles } from "../pi-roles";
import { guideCampaign, inspectCampaign, submitNotes } from "../role-cli";
import { roleLabels, verifierLabels, verifierNames } from "../roles";
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
  roleSettings,
  type Reply,
} from "./harness";

afterEach(cleanupCampaigns);

const original = "Lemma L: 2 is even because 1 + 1 = 3 and 2 = 2 times 1.";
const corrected = "Lemma L: 2 is even because 1 + 1 = 2 and 2 = 2 times 1.";
const partial = { text: "An application of L.", support: ["n1"] };
const pass = { note: "n1", verdict: "PASS", report: "Checked." };
const gate = () => Promise.withResolvers<void>();

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("overlap did not make progress")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Route replies by role so the test does not impose a concurrent start order. */
function script(replies: Record<string, readonly Reply[]>) {
  const routes = new Map(
    Object.entries(replies).map(([label, values]) => [
      label,
      dependencies(values),
    ]),
  );
  const base = dependencies([]);
  const calls: PiRunOptions[] = [];
  const completed = new Map(
    Object.keys(replies).map((label) => [label, gate()]),
  );
  return {
    models: base.models,
    calls,
    completed,
    codex: base.codex,
    async run(campaign: Campaign, options: PiRunOptions) {
      calls.push(options);
      const route = routes.get(options.label);
      if (route === undefined)
        throw new Error(`unexpected call ${options.label}`);
      const result = await route.run(campaign, options);
      completed.get(options.label)!.resolve();
      return result;
    },
  };
}

const coordinate = (all = false): Reply => ({
  submission: {
    filings: [{ note: "n1", summary: "Lemma L." }],

    action: {
      role: "verifier",
      explorerGuidance: "Develop another argument using L while it is checked.",
      support: ["n1"],
      verify: [
        {
          note: "n1",
          verifiers: all ? [...verifierNames] : ["correctness", "source"],
        },
      ],
    },
  },
});

async function setup(
  turns = 1,
  window = 100_000,
  notes = [{ text: original, support: [] as (string | number)[] }],
) {
  const path = campaignPath();
  const profiles = roleSettings();
  const config = workflowConfiguration({
    task: { problem: "Prove P.", completionCriteria: "Prove P fully." },
    settings: {
      ...profiles,
      window,
      coordinatorBehavior: { ...profiles.coordinatorBehavior, overlap: true },
    },
  });
  const campaign = await createWorkflowCampaign(path, config, turns);
  await submitNotes(path, { notes }, "seed");
  return { path, config, campaign };
}

test.each(["explorer", "verifier"] as const)(
  "overlap starts both roles and uses frozen input when %s finishes first",
  async (first) => {
    const { path, config, campaign } = await setup();
    const explorerStarted = gate(),
      verifierStarted = gate();
    const explorerRelease = gate(),
      verifierRelease = gate();
    const drive = script({
      [roleLabels.coordinator]: [coordinate()],
      [roleLabels.explorer]: [
        {
          onStarted: async () => {
            explorerStarted.resolve();
            await explorerRelease.promise;
          },
          submission: { notes: [partial], solution: false },
        },
      ],
      [verifierLabels.correctness]: [
        {
          onStarted: async () => {
            verifierStarted.resolve();
            await verifierRelease.promise;
          },
          submission: {
            verdicts: [
              { ...pass, correctedText: corrected, externalResults: [] },
            ],
          },
        },
      ],
    });
    const running = runWorkflow(
      campaign,
      createPiRoles(campaign, config.settings, drive),
    );
    try {
      await within(
        Promise.all([explorerStarted.promise, verifierStarted.promise]),
      );
      expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
        "overlap",
      );
      await submitNotes(
        path,
        { notes: [{ text: "Late inbox result.", support: [] }] },
        "late",
      );
      await guideCampaign(path, "Late guidance must wait.", "late-guidance");
      const firstLabel =
        first === "explorer" ? roleLabels.explorer : verifierLabels.correctness;
      (first === "explorer" ? explorerRelease : verifierRelease).resolve();
      await within(drive.completed.get(firstLabel)!.promise);
      (first === "explorer" ? verifierRelease : explorerRelease).resolve();
      expect(await within(running)).toMatchObject({
        kind: "turn-limit",
        turns: 1,
        notes: [
          { id: "n1", text: corrected, verified: true },
          { id: "n2", ...partial },
        ],
      });
      const explorerPrompt = drive.calls.find(
        ({ label }) => label === roleLabels.explorer,
      )!.prompt;
      expect(explorerPrompt).toContain(original);
      expect(explorerPrompt).not.toContain(corrected);
      for (const call of drive.calls) {
        expect(call.prompt).not.toContain("Late inbox result.");
        expect(call.prompt).not.toContain("Late guidance must wait.");
      }
      expect(drive.calls.map(({ label }) => label).sort()).toEqual(
        [
          roleLabels.coordinator,
          roleLabels.explorer,
          verifierLabels.correctness,
        ].sort(),
      );
      const inspection = await inspectCampaign(path, {
        includeSubmissions: true,
        includeGuidance: true,
      });
      expect(inspection).toMatchObject({
        submissions: expect.arrayContaining([
          expect.objectContaining({ id: "late", pending: true }),
        ]),
        guidance: expect.arrayContaining([
          expect.objectContaining({ id: "late-guidance", pending: true }),
        ]),
      });
    } finally {
      explorerRelease.resolve();
      verifierRelease.resolve();
      await running.catch(() => {});
      campaign.close();
    }
  },
);

test("overlap retains a failed Explorer's partial notes, propagates support failure, and resumes only Explorer", async () => {
  const { path, config, campaign: initial } = await setup();
  let campaign = initial;
  const explorerStarted = gate(),
    verifierStarted = gate();
  const release = gate();
  const first = script({
    [roleLabels.coordinator]: [coordinate()],
    [roleLabels.explorer]: [
      {
        state: "failed",
        error: "Explorer disconnected",
        onStarted: async (tools) => {
          await tools[0]!.execute({ notes: [partial], solution: false });
          explorerStarted.resolve();
          await release.promise;
        },
      },
    ],
    [verifierLabels.correctness]: [
      {
        onStarted: async () => {
          verifierStarted.resolve();
          await release.promise;
        },
        submission: {
          verdicts: [
            {
              ...pass,
              verdict: "FAIL",
              report: "L has a blocking defect.",
              externalResults: [],
            },
          ],
        },
      },
    ],
  });
  const running = runWorkflow(
    campaign,
    createPiRoles(campaign, config.settings, first),
  );
  try {
    await within(
      Promise.all([explorerStarted.promise, verifierStarted.promise]),
    );
    expect((await deriveWorkflow(campaign.records())).notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "n2", ...partial }),
      ]),
    );
    release.resolve();
    await expect(within(running)).rejects.toThrow("Explorer disconnected");
    expect(
      (await deriveWorkflow(campaign.records())).notes.map(({ dead }) => dead),
    ).toEqual([true, true]);
    campaign.close();
    campaign = openCampaign(path);
    const resumed = script({
      [roleLabels.explorer]: [{ submission: { notes: [], solution: false } }],
    });
    expect(
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, resumed),
      ),
    ).toMatchObject({
      kind: "turn-limit",
      turns: 1,
      notes: [
        { id: "n1", dead: true },
        { id: "n2", ...partial, dead: true },
      ],
    });
    expect(resumed.calls.map(({ label }) => label)).toEqual([
      roleLabels.explorer,
    ]);
    expect(resumed.calls[0]!.prompt).toContain(original);
    expect(resumed.calls[0]!.prompt).toContain("Your first note is n3.");
  } finally {
    release.resolve();
    await running.catch(() => {});
    campaign.close();
  }
});

test("a completed overlapping Explorer is not repeated when verification fails and resumes", async () => {
  const { path, config, campaign: initial } = await setup();
  let campaign = initial;
  const explorerStarted = gate(),
    verifierStarted = gate();
  const release = gate();
  const first = script({
    [roleLabels.coordinator]: [coordinate()],
    [roleLabels.explorer]: [
      {
        onStarted: async () => {
          explorerStarted.resolve();
          await release.promise;
        },
        submission: { notes: [partial], solution: false },
      },
    ],
    [verifierLabels.correctness]: [
      {
        onStarted: async () => {
          verifierStarted.resolve();
          await release.promise;
        },
        state: "failed",
        error: "Verifier disconnected",
      },
    ],
  });
  const running = runWorkflow(
    campaign,
    createPiRoles(campaign, config.settings, first),
  );
  try {
    await within(
      Promise.all([explorerStarted.promise, verifierStarted.promise]),
    );
    release.resolve();
    await expect(within(running)).rejects.toThrow("Verifier disconnected");
    campaign.close();
    campaign = openCampaign(path);
    const resumed = script({
      [verifierLabels.correctness]: [
        { submission: { verdicts: [{ ...pass, externalResults: [] }] } },
      ],
    });
    expect(
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, resumed),
      ),
    ).toMatchObject({
      kind: "turn-limit",
      turns: 1,
      notes: [
        { id: "n1", verified: true },
        { id: "n2", ...partial },
      ],
    });
    expect(resumed.calls.map(({ label }) => label)).toEqual([
      verifierLabels.correctness,
    ]);
    expect(resumed.calls[0]!.prompt).not.toContain(partial.text);
  } finally {
    release.resolve();
    await running.catch(() => {});
    campaign.close();
  }
});

test("acceptance cancels and drains the overlapping Explorer while preserving its saved notes", async () => {
  const { config, campaign } = await setup();
  const explorerStarted = gate(),
    aborted = gate(),
    release = gate();
  const drive = script({
    [roleLabels.coordinator]: [coordinate(true)],
    [roleLabels.explorer]: [
      {
        state: "cancelled",
        error: "Accepted proof cancels exploration",
        onStarted: async (tools) => {
          await tools[0]!.execute({ notes: [partial], solution: false });
          const signal = drive.calls.find(
            ({ label }) => label === roleLabels.explorer,
          )!.signal;
          if (signal === undefined)
            throw new Error("overlapping Explorer lacks cancellation signal");
          if (signal.aborted) aborted.resolve();
          else
            signal.addEventListener("abort", () => aborted.resolve(), {
              once: true,
            });
          explorerStarted.resolve();
          await Promise.race([aborted.promise, release.promise]);
          await release.promise;
        },
      },
    ],
    [verifierLabels.correctness]: [
      {
        onStarted: async () => {
          await explorerStarted.promise;
        },
        submission: { verdicts: [{ ...pass, externalResults: [] }] },
      },
    ],
    [verifierLabels.requirements]: [{ submission: { verdicts: [pass] } }],
    [`${verifierLabels.reconstruction}/statement`]: [
      { submission: { statement: "P holds." } },
    ],
    [`${verifierLabels.reconstruction}/proof`]: [
      { submission: { proof: "An independent proof of P." } },
    ],
    [verifierLabels.reconstruction]: [
      { submission: { statement: null, verdicts: [pass] } },
    ],
  });
  const running = runWorkflow(
    campaign,
    createPiRoles(campaign, config.settings, drive),
  );
  let returned = false;
  void running.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    },
  );
  try {
    await within(aborted.promise);
    expect(returned).toBe(false);
    release.resolve();
    const result = await within(running);
    expect(result).toMatchObject({
      kind: "accepted",
      turns: 1,
      note: { id: "n1" },
      notes: [
        { id: "n1", verified: true },
        { id: "n2", ...partial },
      ],
    });
    const records = campaign.records();
    const noCalls = script({});
    expect(
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, noCalls),
      ),
    ).toEqual(result);
    expect(noCalls.calls).toHaveLength(0);
    expect(campaign.records()).toEqual(records);
  } finally {
    release.resolve();
    await running.catch(() => {});
    campaign.close();
  }
});

test("Explorer may save a dependency from its frozen view after that support durably fails", async () => {
  const { config, campaign } = await setup();
  const explorerStarted = gate(),
    failed = gate();
  const drive = script({
    [roleLabels.coordinator]: [coordinate()],
    [roleLabels.explorer]: [
      {
        onStarted: async (tools) => {
          explorerStarted.resolve();
          await failed.promise;
          expect(
            (await deriveWorkflow(campaign.records())).notes[0]!.dead,
          ).toBe(true);
          expect(
            await tools[0]!.execute({ notes: [partial], solution: false }),
          ).toEqual({ noteIds: ["n2"] });
        },
      },
    ],
    [verifierLabels.correctness]: [
      {
        onStarted: async () => {
          await explorerStarted.promise;
        },
        submission: {
          verdicts: [
            {
              ...pass,
              verdict: "FAIL",
              report: "L has a blocking defect.",
              externalResults: [],
            },
          ],
        },
      },
    ],
  });
  const roles = createPiRoles(campaign, config.settings, drive);
  const running = runWorkflow(campaign, {
    ...roles,
    async verifier(...args) {
      const result = await roles.verifier(...args);
      failed.resolve();
      return result;
    },
  });
  try {
    expect(await within(running)).toMatchObject({
      kind: "turn-limit",
      turns: 1,
      notes: [
        { id: "n1", dead: true },
        { id: "n2", ...partial, dead: true },
      ],
    });
  } finally {
    failed.resolve();
    explorerStarted.resolve();
    await running.catch(() => {});
    campaign.close();
  }
});

test("an overlap retry restores unselected original support in full with frozen evidence", async () => {
  const indirect = { text: "An unselected proof using L.", support: ["n1"] };
  const saved = {
    text: "A new consequence of the unselected proof.",
    support: ["n2"],
  };
  const { config, campaign } = await setup(1, 100_000, [
    { text: original, support: [] },
    { ...indirect, support: [1] },
  ]);
  const checked = gate();
  const drive = script({
    [roleLabels.coordinator]: [
      {
        submission: {
          filings: [
            { note: "n1", summary: "Lemma L." },
            { note: "n2", summary: "Consequence of L." },
          ],
          action: {
            role: "verifier",
            explorerGuidance: "Develop a different argument.",
            support: [],
            verify: [{ note: "n1", verifiers: ["correctness"] }],
          },
        },
      },
    ],
    [roleLabels.explorer]: [
      {
        state: "failed",
        error: "Explorer disconnected",
        onStarted: async (tools) => {
          await checked.promise;
          await tools[0]!.execute({ notes: [saved], solution: false });
        },
      },
    ],
    [verifierLabels.correctness]: [
      {
        submission: {
          verdicts: [
            {
              ...pass,
              verdict: "FAIL",
              report: "L fails.",
              externalResults: [],
            },
          ],
        },
      },
    ],
  });
  const roles = createPiRoles(campaign, config.settings, drive);
  try {
    await expect(
      within(
        runWorkflow(campaign, {
          ...roles,
          async verifier(...args) {
            try {
              return await roles.verifier(...args);
            } finally {
              checked.resolve();
            }
          },
        }),
      ),
    ).rejects.toThrow("Explorer disconnected");
    const firstPrompt = drive.calls.find(
      ({ label }) => label === roleLabels.explorer,
    )!.prompt;
    expect(firstPrompt).not.toContain(original);
    expect(firstPrompt).not.toContain(indirect.text);
    const snapshot = deriveWorkflow(campaign.records());
    expect(snapshot.notes.map(({ dead }) => dead)).toEqual([true, true, true]);
    if (snapshot.phase.kind !== "overlap")
      throw new Error("expected unfinished overlap");
    expect(snapshot.phase.explorer?.input.support).toMatchObject([
      { id: "n1", text: original, dead: false, verdicts: [] },
      { id: "n2", ...indirect, dead: false, verdicts: [] },
      { id: "n3", ...saved, dead: false, verdicts: [] },
    ]);
    const resumed = script({
      [roleLabels.explorer]: [{ submission: { notes: [], solution: false } }],
    });
    expect(
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, resumed),
      ),
    ).toMatchObject({ kind: "turn-limit", turns: 1 });
  } finally {
    checked.resolve();
    campaign.close();
  }
});

test("parent interruption reaches both overlapping roles, drains them, and leaves the dispatch resumable", async () => {
  const { path, config, campaign: initial } = await setup();
  let campaign = initial;
  const explorerStarted = gate(),
    verifierStarted = gate(),
    release = gate();
  const controller = new AbortController();
  const first = script({
    [roleLabels.coordinator]: [coordinate()],
    [roleLabels.explorer]: [
      {
        state: "cancelled",
        error: "Parent interrupted Explorer",
        onStarted: async () => {
          explorerStarted.resolve();
          await release.promise;
        },
      },
    ],
    [verifierLabels.correctness]: [
      {
        state: "cancelled",
        error: "Parent interrupted verifier",
        onStarted: async () => {
          verifierStarted.resolve();
          await release.promise;
        },
      },
    ],
  });
  const running = runWorkflow(
    campaign,
    createPiRoles(campaign, config.settings, first),
    { signal: controller.signal },
  );
  let returned = false;
  void running.then(
    () => {
      returned = true;
    },
    () => {
      returned = true;
    },
  );
  try {
    await within(
      Promise.all([explorerStarted.promise, verifierStarted.promise]),
    );
    controller.abort();
    for (const label of [roleLabels.explorer, verifierLabels.correctness]) {
      expect(
        first.calls.find((call) => call.label === label)!.signal?.aborted,
      ).toBe(true);
    }
    expect((await deriveWorkflow(campaign.records())).phase).toMatchObject({
      kind: "overlap",
      explorer: { kind: "explorer" },
      verifier: { kind: "verifier" },
    });
    expect(returned).toBe(false);
    release.resolve();
    await expect(within(running)).rejects.toThrow();
    expect((await deriveWorkflow(campaign.records())).phase.kind).toBe(
      "overlap",
    );
    campaign.close();
    campaign = openCampaign(path);
    const resumed = script({
      [roleLabels.explorer]: [
        { submission: { notes: [partial], solution: false } },
      ],
      [verifierLabels.correctness]: [
        { submission: { verdicts: [{ ...pass, externalResults: [] }] } },
      ],
    });
    expect(
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, resumed),
      ),
    ).toMatchObject({
      kind: "turn-limit",
      turns: 1,
      notes: [
        { id: "n1", verified: true },
        { id: "n2", ...partial },
      ],
    });
    expect(resumed.calls.map(({ label }) => label).sort()).toEqual(
      [roleLabels.explorer, verifierLabels.correctness].sort(),
    );
  } finally {
    release.resolve();
    await running.catch(() => {});
    campaign.close();
  }
});

test("two overlap dispatches rejoin the coordinator and drain multiple verification batches with stable note IDs", async () => {
  const second = { text: "Independent lemma M.", support: [] };
  const third = { text: "An application of M.", support: ["n2"] };
  const combined = {
    text: "Combine the two applications.",
    support: ["n3", "n4"],
  };
  const { config, campaign } = await setup(2, 1, [
    { text: original, support: [] },
    second,
  ]);
  const coordination = (
    ids: string[],
    support: string[],
    filed = ids,
  ): Reply => ({
    submission: {
      filings: filed.map((note) => ({
        note,
        summary: `Statement of ${note}.`,
      })),

      action: {
        role: "verifier",
        explorerGuidance: `Develop the next step from ${support.join(", ")}.`,
        support,
        verify: ids.map((note) => ({
          note,
          verifiers: ["correctness", "source"],
        })),
      },
    },
  });
  const drive = script({
    [roleLabels.coordinator]: [
      coordination(["n1", "n2"], ["n1", "n2"]),
      {
        ...coordination(["n3", "n4"], ["n3", "n4"], ["n1", "n3", "n4"]),
        onStarted: async () => {
          expect(
            (await deriveWorkflow(campaign.records())).notes,
          ).toMatchObject([
            { id: "n1", text: corrected, verified: true },
            { id: "n2", ...second, verified: true },
            { id: "n3", ...partial, verified: false },
            { id: "n4", ...third, verified: false },
          ]);
          expect(
            drive.calls.filter(
              ({ label }) => label === verifierLabels.correctness,
            ),
          ).toHaveLength(2);
        },
      },
    ],
    [roleLabels.explorer]: [
      { submission: { notes: [partial, third], solution: false } },
      { submission: { notes: [combined], solution: false } },
    ],
    [verifierLabels.correctness]: ["n1", "n2", "n3", "n4"].map((note) => ({
      submission: {
        verdicts: [
          {
            ...pass,
            note,
            externalResults: [],
            ...(note === "n1" ? { correctedText: corrected } : {}),
          },
        ],
      },
    })),
  });
  try {
    const phase = await runWorkflow(
      campaign,
      createPiRoles(campaign, config.settings, drive),
    );
    expect(phase).toMatchObject({
      kind: "turn-limit",
      turns: 2,
      notes: [
        { id: "n1", text: corrected, verified: true },
        { id: "n2", ...second, verified: true },
        { id: "n3", ...partial, verified: true },
        { id: "n4", ...third, verified: true },
        { id: "n5", ...combined, verified: false },
      ],
    });
    const coordinators = drive.calls.filter(
      ({ label }) => label === roleLabels.coordinator,
    );
    const explorers = drive.calls.filter(
      ({ label }) => label === roleLabels.explorer,
    );
    expect(coordinators).toHaveLength(2);
    expect(explorers).toHaveLength(2);
    expect(coordinators[1]!.prompt).toContain(corrected);
    expect(coordinators[1]!.prompt).not.toContain(original);
    expect(explorers[0]!.prompt).toContain("Your first note is n3.");
    expect(explorers[1]!.prompt).toContain("Your first note is n5.");
    expect(explorers[1]!.prompt).toContain(corrected);
    const checks = drive.calls.filter(
      ({ label }) => label === verifierLabels.correctness,
    );
    expect(checks).toHaveLength(4);
    expect(new Set(checks.map(({ parent }) => parent)).size).toBe(4);
    const noCalls = script({});
    expect(
      await runWorkflow(
        campaign,
        createPiRoles(campaign, config.settings, noCalls),
      ),
    ).toEqual(phase);
    expect(noCalls.calls).toHaveLength(0);
  } finally {
    campaign.close();
  }
});
