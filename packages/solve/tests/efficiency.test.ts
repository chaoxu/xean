import { afterEach, expect, test } from "bun:test";
import { createCampaign, type RecordQuery } from "elenx";

import { CozoDb } from "../cozo";
import { createPiRoles } from "../pi-roles";
import { Projection } from "../projection";
import { applicationId, judgedBy, type Note } from "../roles";
import { SupportGraph } from "../support";
import {
  deriveWorkflow,
  runWorkflow,
  verificationPrefix,
  workflowConfiguration,
} from "../workflow";
import {
  campaignPath,
  cleanupCampaigns,
  dependencies,
  roleSettings,
} from "./harness";

afterEach(cleanupCampaigns);

function note(id: number, support: string[] = []): Note {
  return {
    id: `n${id}`,
    text: `Result ${id}.`,
    support,
    verdicts: [],
    verified: true,
    dead: false,
  };
}

test("eligibility visits shared support once per fixed evidence view", () => {
  let reads = 0;
  const count = 80;
  const known = Array.from({ length: count }, (_, i): Note => ({
    ...note(i + 1),
    get support() {
      if (++reads > count * 3)
        throw new Error("shared support was repeatedly expanded");
      return i === 0 ? [] : i === 1 ? ["n1"] : [`n${i}`, `n${i - 1}`];
    },
  }));
  expect(
    judgedBy(
      {
        verify: known.map(({ id }) => ({ note: id, verifiers: ["source"] })),
        notes: known,
        support: [],
      },
      [],
      "source",
    ),
  ).toEqual(known.map(({ id }) => id));
  expect(reads).toBeLessThanOrEqual(count * 3);
});

test("one support query serves a verification window and later closures", async () => {
  const original = CozoDb.prototype.run;
  let queries = 0;
  CozoDb.prototype.run = function (
    script: string,
    params?: Record<string, unknown>,
  ) {
    queries += 1;
    return original.call(this, script, params);
  };
  const known = Array.from({ length: 100 }, (_, i) =>
    note(i + 1, i === 0 ? [] : [`n${i}`]),
  );
  const graph = new SupportGraph(known);
  try {
    const verify = known.map(({ id }) => ({
      note: id,
      verifiers: ["source" as const],
    }));
    expect(await verificationPrefix(verify, known, 100_000, graph)).toEqual(
      verify,
    );
    expect(await graph.closure([known.at(-1)!])).toEqual(
      known.slice(0, -1).map(({ id }) => id),
    );
    expect(queries).toBe(1);
  } finally {
    graph.close();
    CozoDb.prototype.run = original;
  }
});

test("batching closure roots preserves errors only for notes the window reads", async () => {
  const known = [note(1), note(2), note(4, ["n3"])];
  const verify = known.map(({ id }) => ({
    note: id,
    verifiers: ["source" as const],
  }));
  expect(await verificationPrefix(verify, known, 1)).toEqual(
    verify.slice(0, 1),
  );
  await expect(verificationPrefix(verify, known, 1000)).rejects.toThrow(
    "missing support note n3",
  );
});

test("a released support graph cannot recreate native state", async () => {
  const graph = new SupportGraph([note(1)]);
  expect(await graph.closure([note(1)])).toEqual([]);
  graph.close();
  graph.close();
  await expect(graph.closure([note(1)])).rejects.toThrow(
    "support graph is closed",
  );
});

test("startup reuses its captured derivation only while the journal boundary matches", async () => {
  const task = { problem: "Prove P.", completionCriteria: "A complete proof." };
  const config = workflowConfiguration({ task, settings: roleSettings() });
  const campaign = createCampaign(campaignPath(), applicationId, config);
  const initial = {
    snapshot: await deriveWorkflow(campaign.records()),
    through: campaign.lastSequence(),
  };
  const original = Projection.open;
  let derivations = 0;
  Projection.open = async (verdicts) => {
    derivations += 1;
    return original(verdicts);
  };
  const roles = createPiRoles(campaign, config.settings, dependencies([]));
  try {
    expect(
      (
        await runWorkflow(
          campaign,
          roles,
          { pauseRequested: () => true },
          initial,
        )
      ).kind,
    ).toBe("explorer");
    expect(derivations).toBe(0);
    await campaign.call(
      { label: "new-boundary", request: null },
      async () => null,
    );
    expect(
      (
        await runWorkflow(
          campaign,
          roles,
          { pauseRequested: () => true },
          initial,
        )
      ).kind,
    ).toBe("explorer");
    expect(derivations).toBe(1);
  } finally {
    Projection.open = original;
    campaign.close();
  }
});

test("projection snapshots share queries and invalidate after a filing", async () => {
  const projection = await Projection.open([]);
  const original = CozoDb.prototype.run;
  let queries = 0;
  try {
    await projection.add([note(1)], 2);
    CozoDb.prototype.run = function (
      script: string,
      params?: Record<string, unknown>,
    ) {
      queries += 1;
      return original.call(this, script, params);
    };
    expect((await projection.at(2))[0]?.summary).toBeUndefined();
    expect(await projection.accepted(2)).toEqual([]);
    expect((await projection.at(2))[0]?.text).toBe("Result 1.");
    expect(queries).toBe(6);
    await projection.file([{ note: "n1", summary: "A filed result." }], 3);
    expect((await projection.at(3))[0]?.summary).toBe("A filed result.");
    expect(await projection.accepted(3)).toEqual([]);
    expect(queries).toBe(13);
  } finally {
    CozoDb.prototype.run = original;
    projection.close();
  }
});

test("Explorer receipts reconcile only new owned submissions and reuse durable identities", async () => {
  const campaign = createCampaign(campaignPath(), applicationId, {
    kind: "calls",
  });
  await campaign.call(
    { label: "unrelated", request: { proof: "x".repeat(100_000) } },
    async () => null,
  );
  let checking = false,
    selected = 0;
  const original = campaign.records.bind(campaign);
  campaign.records = (query?: RecordQuery) => {
    if (checking) {
      expect(query?.kinds).toEqual(["tool-call"]);
      expect(query?.call).toBeDefined();
      expect(query?.after).toBeDefined();
      expect(query?.through).toBeDefined();
    }
    const rows = original(query);
    if (checking) selected += rows.length;
    return rows;
  };
  const drive = dependencies([
    {
      onStarted: async (tools) => {
        checking = true;
        try {
          for (let i = 1; i <= 10; i++) {
            const value = {
              notes: [
                {
                  text: `New result ${i}.`,
                  support: i === 1 ? [] : [`n${i - 1}`],
                },
              ],
              solution: false,
            };
            expect(await tools[0]!.execute(value, `call-${i}`)).toEqual({
              noteIds: [`n${i}`],
            });
          }
          const entry = campaign.record(campaign.lastSequence() - 1);
          if (entry?.kind !== "tool-call")
            throw new Error("missing durable submission");
          expect(
            await drive.calls[0]!.tools![0]!.run(entry.input, {
              call: entry.call,
              toolCall: entry.seq,
              signal: new AbortController().signal,
            }),
          ).toEqual({ noteIds: ["n10"] });
          expect(selected).toBe(10);
        } finally {
          checking = false;
        }
      },
    },
  ]);
  try {
    const result = await createPiRoles(
      campaign,
      { ...roleSettings(), explorerContinuation: true },
      drive,
    ).explorer({
      task: { problem: "Prove P.", completionCriteria: "A complete proof." },
      explorerGuidance: "",
      notes: [],
      support: [],
    });
    expect(result.notes).toHaveLength(10);
  } finally {
    campaign.close();
  }
});
