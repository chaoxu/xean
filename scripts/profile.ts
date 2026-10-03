import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Xean, openXeanStorage, inspectCampaign } from "xean";
import { createSolver, project } from "xean/solve";
import { statusReport, usageRecord } from "xean/report";

const [roundText, output, ...extra] = process.argv.slice(2);
const rounds = Number(roundText);
if (!output || extra.length || !Number.isSafeInteger(rounds) || rounds < 1)
  throw new Error("Usage: scripts/profile.ts <rounds> <new-output-directory>");
const directory = resolve(output);
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory); // Refuse an existing directory, including an old campaign.
const path = join(directory, "campaign.sqlite");
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const memory = async () => {
  for (let i = 0; i < 2; i++) {
    await Bun.sleep(0);
    Bun.gc(true);
  }
  return process.memoryUsage();
};

const before = await memory();
async function create() {
  const solver = createSolver(
    {
      problem: "Synthetic storage and lifecycle measurement",
      completionCriteria: "No mathematical acceptance is attempted.",
    },
    () => {
      throw new Error("This probe must not initialize a model runtime");
    },
  );
  solver.functions.coordinator = async ({ notes }) => ({
    work:
      notes.length < rounds
        ? [{ kind: "explorer", guidance: "Add one synthetic note" }]
        : [],
  });
  solver.functions.explorer = async ({ notes }) => ({
    kind: "notes",
    candidate: false,
    notes: [
      {
        id: "n1",
        summary: `Synthetic note ${notes.length}`,
        detailedSummary: "For framework measurement only.",
        text: `Synthetic premise ${notes.length}: x=x.\n`
          .repeat(512)
          .slice(0, 8192),
        support: [],
      },
    ],
  });
  const started = performance.now();
  const engine = await Xean.open(await openXeanStorage(path), {
    ...solver,
    limits: { concurrency: 1 },
  });
  try {
    const measurements = await (async () => {
      const campaign = await engine.run();
      const createMs = performance.now() - started;
      const notes = project(campaign);
      if (notes.length !== rounds || campaign.providerCalls !== 0)
        throw new Error(
          "Synthetic campaign did not produce the requested notes",
        );
      return {
        createMs,
        notes: notes.length,
        modelCalls: campaign.providerCalls,
        corpusBytes: notes.reduce(
          (n, note) => n + Buffer.byteLength(note.text),
          0,
        ),
        workerInputBytes: campaign.work.reduce(
          (n, w) => n + jsonBytes(w.input),
          0,
        ),
        snapshotBytes: jsonBytes(campaign),
      };
    })();
    return { ...measurements, open: await memory() };
  } finally {
    await engine.close();
  }
}
const { open, ...creation } = await create();
const closed = await memory(); // Owner and expanded snapshots are out of scope.
const inspection = await (async () => {
  const started = performance.now();
  const status = statusReport(await inspectCampaign(path, usageRecord));
  return {
    inspectMs: performance.now() - started,
    statusBytes: jsonBytes(status),
    status: status.status,
    notes: status.notes?.total,
  };
})();
const report = {
  bun: Bun.version,
  rounds,
  path,
  ...creation,
  inspection,
  memory: { before, open, closed },
  databaseBytes: (await stat(path)).size,
  walBytes: (
    await stat(`${path}-wal`).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { size: 0 };
      throw error;
    })
  ).size,
};
const text = JSON.stringify(report, null, 2) + "\n";
await Bun.write(join(directory, "profile.json"), text);
process.stdout.write(text);
