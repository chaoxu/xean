import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [sourceArg, directoryArg] = process.argv.slice(2);
assert(sourceArg && directoryArg, "Expected frozen source and smoke directory");
const source = resolve(sourceArg);
const directory = resolve(directoryArg);
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const save = (name: string, value: unknown) =>
  writeFile(resolve(directory, name), json(value), { mode: 0o600 });
const mark = (value: object) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
assert.equal(Bun.version, "1.4.2");
const deployment = await Bun.file(resolve(directory, "deployment.json")).json();
for (const [path, digest] of Object.entries(deployment.files)) {
  assert.equal(
    hash(await readFile(resolve(directory, path))),
    digest,
    `Frozen smoke artifact differs: ${path}`,
  );
}
for (const [path, digest] of Object.entries(deployment.sourceFiles)) {
  assert.equal(
    hash(await readFile(resolve(source, path))),
    digest,
    `Frozen source differs: ${path}`,
  );
}
const codexRoot = deployment.codex.containerRoot;
assert.equal(
  hash(await readFile(resolve(codexRoot, "runtime.json"))),
  deployment.codex.manifestSha256,
);
for (const [path, entry] of Object.entries(deployment.codex.entries) as [
  string,
  any,
][]) {
  if (entry.type === "file")
    assert.equal(
      hash(await readFile(resolve(codexRoot, path))),
      entry.sha256,
      `Pinned Codex file differs: ${path}`,
    );
}
const { verifyInstall } = await import(
  resolve(source, "scripts/dependencies.ts")
);
await verifyInstall(source);
const { Xean, openXeanStorage } = await import(
  resolve(source, "packages/core/src/index.ts")
);
const { createEditor, createSolver, piRuntime, readSettings, codexResearch } =
  await import(resolve(source, "packages/core/src/solve/index.ts"));
const { refresh, corpusStats, closure } = await import(
  resolve(source, "packages/core/src/solve/notes.ts")
);
const snapshotBytes = await readFile(
  resolve(directory, "source-snapshot.json"),
);
const snapshot = JSON.parse(snapshotBytes.toString());
assert.equal(
  hash(JSON.stringify({ task: snapshot.task, notes: snapshot.notes })),
  deployment.corpusSha256,
);
assert.equal(
  snapshot.notes.length,
  13,
  "The known smoke corpus must remain complete",
);
const adapted = structuredClone(snapshot.notes);
const adaptedPaths: string[] = [];
function adapt(value: any, path: string): void {
  if (!value || typeof value !== "object") return;
  if (
    typeof value.summary === "string" &&
    typeof value.text === "string" &&
    value.detailedSummary === undefined
  ) {
    value.detailedSummary = value.summary;
    adaptedPaths.push(`${path}.detailedSummary`);
  }
  for (const [key, child] of Object.entries(value))
    adapt(child, `${path}.${key}`);
}
adapt(adapted, "notes");
const stripAdded = (value: any): any =>
  Array.isArray(value)
    ? value.map(stripAdded)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "detailedSummary")
            .map(([key, child]) => [key, stripAdded(child)]),
        )
      : value;
assert.deepEqual(stripAdded(adapted), snapshot.notes);
assert.deepEqual(
  refresh(structuredClone(adapted)),
  adapted,
  "Legacy statuses must match current derivation",
);
const input = { task: snapshot.task, notes: adapted };
const originalInput = structuredClone(input);
await save("input.json", input);
await save("adaptation.json", {
  originalSnapshotSha256: hash(snapshotBytes),
  originalCorpusSha256: deployment.corpusSha256,
  inputSha256: hash(JSON.stringify(input)),
  notes: adapted.length,
  transformation:
    "Only absent detailedSummary fields copy their same object's historical summary. Original full text, IDs, dependencies, revisions, checks, import flags, and statuses remain unchanged. Original files remain immutable.",
  addedFields: adaptedPaths,
});
const settings = readSettings(
  await Bun.file(resolve(directory, "settings.json")).json(),
);
assert.equal(settings.profiles.default.model, "gpt-6-astra");
assert.equal(settings.profiles.default.reasoning, "max");
assert.equal(settings.research.model, "gpt-6-astra");
assert.equal(settings.research.reasoning, "max");
assert.equal(settings.editingThresholdTokens, 200000);
assert.equal(settings.limits.providerCalls, 12);
const credential = process.env.XEAN_API_KEY ?? "";
assert(credential, "Missing injected Xean credential");
const capacities = piRuntime(settings).profiles;
await save(
  "model-capacities.json",
  Object.fromEntries(
    Object.entries(capacities).map(([name, profile]: [string, any]) => [
      name,
      {
        provider: profile.model.provider,
        model: profile.model.id,
        api: profile.model.api,
        contextWindow: profile.model.contextWindow,
        maxTokens: profile.model.maxTokens,
        reasoning: profile.options.reasoning,
        thinkingLevelMap: profile.model.thinkingLevelMap,
        estimatedInputCeiling:
          profile.model.contextWindow - profile.model.maxTokens - 4096,
      },
    ]),
  ),
);
const codexHome = resolve(process.env.CODEX_HOME ?? "");
assert.equal(codexHome, "/scratch/codex");
await mkdir(codexHome, { recursive: true, mode: 0o700 });
await writeFile(
  resolve(codexHome, "config.toml"),
  await readFile(resolve(directory, "codex.config.toml")),
  { flag: "wx", mode: 0o600 },
);
const version = Bun.spawnSync([settings.research.command, "--version"], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
assert.equal(
  version.exitCode,
  0,
  "Pinned Codex executable is unavailable in the worker",
);
await save("runtime-preflight.json", {
  at: new Date().toISOString(),
  bun: Bun.version,
  codexVersion: version.stdout.toString().trim(),
  sourceCommit: deployment.sourceCommit,
  image: deployment.image,
  dependenciesVerified: true,
  codexHome,
  credentialSource: "Nomad task environment; never saved in artifacts",
  corpus: corpusStats(input.notes),
});
let active: any;
let cancelled = false;
const stop = () => {
  cancelled = true;
  if (active) void active.cancel();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const cases: any[] = [];
let usedCalls = 0;
const metrics = (notes: any[]) => {
  const count = (text: string) => ({
    bytes: Buffer.byteLength(text),
    utf16Chars: text.length,
    piEstimate: Math.ceil(text.length / 4),
  });
  return {
    notes: notes.length,
    supportEdges: notes.reduce((sum, note) => sum + note.support.length, 0),
    bodies: count(notes.map((note) => note.text).join("\n")),
    serialized: count(JSON.stringify(notes)),
    corpus: corpusStats(notes),
  };
};
async function runCase(name: string, options: any) {
  assert(!cancelled, "Cancelled before next case");
  const remaining = settings.limits.providerCalls - usedCalls;
  assert(remaining > 0, "Initial total call allowance is exhausted");
  const output = resolve(directory, name);
  await mkdir(output, { recursive: true, mode: 0o700 });
  options = {
    ...options,
    limits: { concurrency: 1, attempts: 1, providerCalls: remaining },
  };
  const engine = await Xean.open(
    await openXeanStorage(resolve(output, "campaign.sqlite")),
    options,
  );
  active = engine;
  const startedAt = new Date().toISOString();
  const heartbeat = setInterval(() => {
    void engine
      .inspect()
      .then(async (campaign: any) => {
        const value = {
          name,
          startedAt,
          at: new Date().toISOString(),
          status: campaign.status,
          calls: campaign.providerCalls,
          active: campaign.work
            .filter((work: any) => work.status === "active")
            .map((work: any) => ({ id: work.id, role: work.role })),
        };
        await writeFile(resolve(output, "live.json"), json(value), {
          mode: 0o600,
        });
        mark(value);
      })
      .catch((error: unknown) =>
        mark({ name, inspectionError: String(error) }),
      );
  }, 30_000);
  try {
    const campaign = await engine.run();
    const records = await engine.records();
    usedCalls += campaign.providerCalls;
    assert(usedCalls <= settings.limits.providerCalls);
    const requests = records
      .filter((record: any) => record.kind === "xean.call.request")
      .map((record: any) => record.data.payload);
    const settled = records.filter(
      (record: any) => record.kind === "xean.call.settled",
    );
    assert(
      requests.every(
        (request: any) =>
          request.model === "gpt-6-astra" &&
          (request.reasoning?.effort ?? request.reasoning) === "max",
      ),
      "Every request must use Astra/max",
    );
    assert.equal(
      records.filter((record: any) => record.kind === "xean.call.started")
        .length,
      settled.length,
      "All admitted calls must settle",
    );
    const nativeSearches = settled
      .flatMap((record: any) => (record.data.message?.stdout ?? "").split("\n"))
      .filter((line: string) => {
        if (!line.trim()) return false;
        try {
          const event = JSON.parse(line);
          return (
            event.type === "item.completed" && event.item?.type === "web_search"
          );
        } catch {
          return false;
        }
      }).length;
    const result = { campaign, records };
    const encoded = json(result);
    assert(
      !encoded.includes(credential),
      "Credential must not reach artifacts",
    );
    await writeFile(resolve(output, "result.json"), encoded, { mode: 0o600 });
    const summary = {
      name,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: campaign.status,
      error: campaign.error,
      calls: campaign.providerCalls,
      cumulativeCalls: usedCalls,
      nativeSearches,
      usage: settled.map((record: any) => record.data.usage),
      work: campaign.work.map((work: any) => ({
        id: work.id,
        role: work.role,
        status: work.status,
        error: work.error,
      })),
    };
    await writeFile(resolve(output, "summary.json"), json(summary), {
      mode: 0o600,
    });
    cases.push(summary);
    mark(summary);
    return { campaign, records, nativeSearches };
  } finally {
    clearInterval(heartbeat);
    active = undefined;
    await engine.close();
  }
}
try {
  const fresh = (name: string) => {
    const own = { ...settings, usagePrefix: `${settings.usagePrefix}/${name}` };
    const runtime = piRuntime(own);
    const research = codexResearch(own.research, own.usagePrefix);
    return {
      own,
      runtime,
      research,
      solver: createSolver(input.task, runtime, own, research),
    };
  };
  // Only the committed Editor proposal is replayed; every check and repair is live.
  const prior = await Bun.file(resolve(directory, "proposal.json")).json();
  const editor = fresh("editor");
  const options = createEditor(
    input,
    editor.runtime,
    editor.own,
    editor.research,
  );
  let replayed = false;
  options.roles = options.roles.map((role: any) =>
    role.name !== "xean.editor"
      ? role
      : {
          ...role,
          async run(value: any, execution: any, context: any) {
            if (replayed) return role.run(value, execution, context);
            assert.deepEqual(value, input);
            replayed = true;
            mark({
              replayedCommittedProposal: {
                sourceCommit: prior.sourceCommit,
                attemptId: prior.attemptId,
                workId: prior.workId,
              },
            });
            return structuredClone(prior.result);
          },
        },
  );
  const edited = await runCase("editor", options);
  assert.equal(
    hash(await readFile(resolve(directory, "source-snapshot.json"))),
    hash(snapshotBytes),
    "Source snapshot changed",
  );
  assert.deepEqual(input, originalInput, "Caller input changed");
  const result = edited.campaign.result;
  const proposals = edited.campaign.work
    .filter(
      (work: any) => work.role === "xean.editor" && work.status === "completed",
    )
    .map((work: any) => ({
      id: work.id,
      report: work.result.report,
      newNotes: work.result.notes.length,
      retained: work.result.retained,
    }));
  const reviews = edited.campaign.work
    .filter(
      (work: any) =>
        work.role === "xean.editionReview" && work.status === "completed",
    )
    .map((work: any) => ({ id: work.id, ...work.result }));
  await save("coverage-report.json", {
    completeOriginalIds: input.notes.map((note: any) => note.id),
    originalCorpusSha256: deployment.corpusSha256,
    proposals,
    reviews,
    activated: edited.campaign.status === "completed",
    result,
  });
  if (edited.campaign.status === "completed") {
    assert.equal(result.review.verdict, "PASS");
    assert(
      result.notes.length > 0 &&
        result.notes.every((note: any) => note.verified && !note.dead),
    );
    assert.equal(
      closure(
        result.notes.map((note: any) => note.id),
        result.notes,
      ).length,
      result.notes.length,
    );
    for (const note of result.notes) {
      const old = input.notes.find((other: any) => other.id === note.id);
      if (!old) {
        assert(
          !note.imported,
          "New rewritten notes must not be trusted imports",
        );
        continue;
      }
      const expected = structuredClone(old);
      const verifications = edited.campaign.work
        .filter(
          (work: any) =>
            work.role === "xean.editVerifier" && work.status === "completed",
        )
        .sort((a: any, b: any) => a.publicationId - b.publicationId);
      for (const work of verifications)
        for (const check of work.result.checks) {
          if (check.noteId !== note.id || !check.correction) continue;
          const { revision, ...content } = check.correction;
          assert.equal(
            revision,
            expected.revision,
            "Correction must bind the retained revision",
          );
          assert(
            [
              check.correctness,
              check.source,
              check.requirements,
              check.reconstruction,
            ].some(
              (stage) =>
                stage?.verdict === "PASS" &&
                stage.correction &&
                stage.correction.text === content.text,
            ),
            "Retained correction lacks a passing verifier record",
          );
          Object.assign(expected, content, { revision: revision + 1 });
        }
      for (const field of ["text", "summary", "detailedSummary", "revision"])
        assert.deepEqual(
          note[field],
          expected[field],
          "Retained content must match committed harmless corrections",
        );
    }
  }
  await save("metrics.json", {
    before: metrics(input.notes),
    after: result ? metrics(result.notes) : null,
    providerCalls: usedCalls,
    initialAllowance: settings.limits.providerCalls,
    sourceSnapshotUnchanged: true,
    statusesPreserved: true,
    sourceCommit: deployment.sourceCommit,
    note: "Pi estimates are approximate. Corpus review judges coverage; original internal acceptance is not inherited by rewritten notes.",
  });
  await save("complete.json", {
    status: edited.campaign.status,
    passed: edited.campaign.status === "completed",
    cancelled,
    calls: usedCalls,
    initialAllowance: settings.limits.providerCalls,
    finishedAt: new Date().toISOString(),
    sourceCommit: deployment.sourceCommit,
    deploymentSha256: hash(
      await readFile(resolve(directory, "deployment.json")),
    ),
    cases,
  });
  if (edited.campaign.status !== "completed") process.exitCode = 1;
} catch (error) {
  const message = String(error).replaceAll(credential, "[redacted]");
  await save("failed.json", {
    at: new Date().toISOString(),
    error: message,
    cancelled,
    calls: usedCalls,
    cases,
  });
  mark({ failed: true, error: message, calls: usedCalls });
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
