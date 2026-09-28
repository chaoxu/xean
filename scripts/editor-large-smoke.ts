import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [sourceArg, directoryArg, continuationId, additionalArg] =
  process.argv.slice(2);
assert(sourceArg && directoryArg, "Expected frozen source and smoke directory");
const additionalCalls = Number(additionalArg ?? 0);
assert(!continuationId || /^[a-z0-9][a-z0-9-]{0,47}$/.test(continuationId));
assert(Number.isSafeInteger(additionalCalls) && additionalCalls >= 0);
assert(continuationId || additionalCalls === 0);
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
const { createEditor, piRuntime, readSettings, codexResearch } = await import(
  resolve(source, "packages/core/src/solve/index.ts")
);
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
  snapshot.corpusSha256,
  deployment.corpusSha256,
  "The complete snapshot must match its recorded hash",
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
assert.deepEqual(stripAdded(adapted), stripAdded(snapshot.notes));
assert.deepEqual(
  refresh(structuredClone(adapted)),
  adapted,
  "Legacy statuses must match current derivation",
);
const input = { task: snapshot.task, notes: adapted };
const originalInput = structuredClone(input);
assert(
  corpusStats(input.notes).estimatedTokens > 200000,
  "The complete large corpus must exceed 200,000 estimated tokens",
);
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
for (const profile of Object.values(settings.profiles) as any[]) {
  assert.equal(profile.model, "gpt-6-astra");
  assert.equal(profile.reasoning, "max");
}
assert.equal(settings.research.model, "gpt-6-astra");
assert.equal(settings.research.reasoning, "max");
assert.equal(settings.editingThresholdTokens, 200000);
assert.equal(settings.limits.providerCalls, 24);
const credential = process.env.XEAN_API_KEY;
assert(credential, "Missing injected Xean credential");
assert(
  deployment.files["context-evidence.json"],
  "Missing frozen context evidence",
);
const contextSelection = {
  provider: "openai-codex",
  model: "gpt-6-astra",
  catalogContextWindow: 272000,
  contextWindow: 872000,
  evidenceSha256: hash(
    await readFile(resolve(directory, "context-evidence.json")),
  ),
};
// The ordinary JSON profile now selects the supported gateway context.
const runtimeFor = (own: Parameters<typeof piRuntime>[0]) => {
  const runtime = piRuntime(own);
  for (const name of ["editor", "correctness", "requirements"] as const) {
    const profile = runtime.profiles[name];
    assert.equal(profile.model.provider, contextSelection.provider);
    assert.equal(profile.model.id, contextSelection.model);
    assert.equal(profile.model.contextWindow, contextSelection.contextWindow);
    assert.equal(profile.model.maxTokens, 128000);
  }
  return runtime;
};
const { fullNote } = await import(
  resolve(source, "packages/core/src/solve/reader.ts")
);
const capacities = runtimeFor(settings).profiles;
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
  const output = resolve(directory, name);
  await mkdir(output, { recursive: true, mode: 0o700 });
  options = {
    ...options,
    limits: settings.limits,
  };
  const destination = resolve(output, "campaign.sqlite");
  assert(
    (await Bun.file(destination).exists()) === Boolean(continuationId),
    "Fresh starts require an absent campaign; continuation requires its existing campaign",
  );
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
          callAllowance: campaign.callAllowance,
          continuationId: continuationId ?? null,
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
    const initial = await engine.inspect();
    if (!continuationId)
      assert.equal(
        initial.providerCalls,
        0,
        "Fresh experiment must not inherit model calls",
      );
    usedCalls = initial.providerCalls;
    if (continuationId && additionalCalls > 0) {
      const receipt = await engine.extendCalls(additionalCalls, continuationId);
      await save(`allowance-${continuationId}.json`, receipt);
    }
    const ready = await engine.inspect();
    const campaign =
      continuationId && ["blocked", "paused"].includes(ready.status)
        ? await engine.resume()
        : await engine.run();
    const records = await engine.records();
    usedCalls = campaign.providerCalls;
    assert(
      campaign.callAllowance !== null && usedCalls <= campaign.callAllowance,
    );
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
      callAllowance: campaign.callAllowance,
      invocationCalls: campaign.providerCalls - initial.providerCalls,
      continuationId: continuationId ?? null,
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
  const { normalizeContext } = await import(
    resolve(source, "node_modules/@earendil-works/pi-ai/dist/index.js")
  );
  const { clampMaxTokensToContext } = await import(
    resolve(
      source,
      "node_modules/@earendil-works/pi-ai/dist/api/simple-options.js",
    )
  );
  // Gate the initial Editor request; same-size replacement cases are diagnostics.
  // The runtime independently checks each exact prompt and actual proposal.
  const capacityInputs = [
    {
      role: "editor",
      phase: "initial",
      input: { ...input, notes: input.notes.map(fullNote) },
    },
    {
      role: "editor",
      phase: "repair",
      input: {
        ...input,
        notes: input.notes.map(fullNote),
        previous: input.notes.map(fullNote),
      },
    },
    {
      role: "correctness",
      phase: "verification",
      input: { task: input.task, notes: input.notes, support: input.notes },
    },
    {
      role: "requirements",
      phase: "corpus-review",
      input: {
        ...input,
        notes: input.notes.map(fullNote),
        previous: input.notes.map(fullNote),
      },
    },
  ];
  const capacityChecks = capacityInputs.map(({ role, phase, input: value }) => {
    const profile = capacities[role];
    const transcript = normalizeContext({
      messages: [
        { role: "system", content: " ".repeat(32768), timestamp: 0 },
        { role: "user", content: JSON.stringify(value), timestamp: 0 },
      ],
    });
    const room = clampMaxTokensToContext(
      profile.model,
      transcript,
      profile.model.maxTokens,
    );
    return {
      role,
      phase,
      answerRoom: room,
      requiredAnswerRoom: profile.model.maxTokens,
      fits: room === profile.model.maxTokens,
    };
  });
  await save("capacity-preflight.json", {
    checks: capacityChecks,
    method:
      "Pinned Pi capacity estimator with 8,192 estimated instruction tokens. Only initial Editor fit is required for admission. Same-size replacement cases are context-capacity diagnostics, not output size targets; exact requests retain runtime checks.",
    contextSelection,
    replacementPayloadHeadroomEstimate:
      contextSelection.contextWindow -
      capacities.editor.model.maxTokens -
      4096 -
      Math.ceil(
        JSON.stringify({ ...input, notes: input.notes.map(fullNote) }).length /
          4,
      ),
    instructionReserveEstimate: 8192,
  });
  assert(
    capacityChecks.find((check) => check.phase === "initial")!.fits,
    "Configured Editor profile cannot fit the complete corpus; see capacity-preflight.json",
  );
  const own = { ...settings, usagePrefix: settings.usagePrefix + "/editor" };
  const edited = await runCase(
    "editor",
    createEditor(
      input,
      runtimeFor(own),
      own,
      codexResearch(own.research, own.usagePrefix),
    ),
  );
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
    callAllowance: edited.campaign.callAllowance,
    checkpoint: edited.campaign.status === "limited",
    continuationId: continuationId ?? null,
    initialAllowance: settings.limits.providerCalls,
    finishedAt: new Date().toISOString(),
    sourceCommit: deployment.sourceCommit,
    deploymentSha256: hash(
      await readFile(resolve(directory, "deployment.json")),
    ),
    cases,
  });
  if (!["completed", "limited"].includes(edited.campaign.status))
    process.exitCode = 1;
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
