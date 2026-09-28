import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [sourceArg, directoryArg, phase] = process.argv.slice(2);
assert(sourceArg && directoryArg, "Expected frozen source and trial directory");
assert(phase === "smoke" || phase === "trial", "Expected smoke or trial phase");
assert.equal(
  process.argv.length,
  5,
  "Only the frozen phase configuration is accepted",
);
const proposalLimit = 2;
const source = resolve(sourceArg);
const directory = resolve(directoryArg);
const outputDirectory =
  phase === "smoke" ? resolve(directory, "smoke") : directory;
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const save = (name: string, value: unknown) =>
  writeFile(resolve(outputDirectory, name), json(value), { mode: 0o600 });
const mark = (value: object) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
assert.equal(Bun.version, "1.4.2");
const deployment = await Bun.file(resolve(directory, "deployment.json")).json();
const continuation = phase === "trial" ? deployment.continuation : undefined;
const feedback = continuation
  ? await Bun.file(resolve(directory, "external-feedback.json")).json()
  : undefined;
if (continuation) {
  assert.equal(continuation.additionalCalls, 6);
  assert.equal(continuation.parentCalls, 6);
  assert.equal(continuation.parentCallAllowance, 6);
  assert.equal(
    feedback.diagnostics.resultSha256,
    continuation.parentResultSha256,
  );
}
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
const { refresh, corpusStats, closure, materializeNotes } = await import(
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
const originalCorpus = { task: snapshot.task, notes: adapted };
assert.equal(originalCorpus.notes.length, 289);
assert(corpusStats(originalCorpus.notes).estimatedTokens > 200000);
const smokeDraft = (id: string, text: string, support: string[] = []) => ({
  id,
  summary: text,
  detailedSummary: text,
  text,
  support,
});
const input =
  phase === "trial"
    ? originalCorpus
    : {
        task: {
          problem:
            "Maintain a compact, self-contained account of the sum of the first n odd positive integers and the limitation of checking only finitely many instances.",
          completionCriteria:
            "Use elementary algebra and explicit proofs. Preserve the statement for every integer n >= 0 and the distinction between examples and a universal proof.",
        },
        notes: refresh(
          materializeNotes("smoke", [
            smokeDraft(
              "n1",
              "For every integer n >= 0, sum_{k=1}^n (2k-1)=n^2, where the empty sum is zero. Proof: 2k-1=k^2-(k-1)^2, so summing telescopes to n^2-0^2.",
            ),
            smokeDraft(
              "n2",
              "The n=3 instance is 1+3+5=9=3^2. It also follows directly from the general identity.",
              ["n1"],
            ),
            smokeDraft(
              "n3",
              "Agreement at n=0,1,2,3 does not establish a formula for all nonnegative integers. Define f(n)=n^2 for n != 4 and f(4)=17. This agrees with n^2 on those four tested inputs and disagrees at n=4.",
            ),
          ]),
        ),
      };
const originalInput = structuredClone(input);
if (phase === "trial") {
  const smoke = await Bun.file(
    resolve(directory, "smoke/complete.json"),
  ).json();
  assert(
    smoke.passed && smoke.nativeAccepted && smoke.requiredRolesPassed,
    "Full trial requires a passing deployed smoke",
  );
  assert.equal(smoke.sourceCommit, deployment.sourceCommit);
  assert.equal(
    smoke.deploymentSha256,
    hash(await readFile(resolve(directory, "deployment.json"))),
  );
  assert.equal(
    smoke.resultSha256,
    hash(await readFile(resolve(directory, "smoke/editor/result.json"))),
  );
}
await save("input.json", input);
await save("adaptation.json", {
  originalSnapshotSha256: hash(snapshotBytes),
  originalCorpusSha256: deployment.corpusSha256,
  inputSha256: hash(JSON.stringify(input)),
  phase,
  notes: input.notes.length,
  transformation:
    phase === "smoke"
      ? "Three elementary self-contained unverified fixture notes. The original corpus is hash-checked but is not supplied to the smoke Editor."
      : "Only absent detailedSummary fields copy their same object's historical summary. Original full text, IDs, dependencies, revisions, checks, import flags, and statuses remain unchanged. Original files remain immutable.",
  addedFields: adaptedPaths,
});
const settings = readSettings(
  await Bun.file(resolve(directory, "settings.json")).json(),
);
for (const profile of Object.values(settings.profiles) as any[]) {
  assert.equal(profile.model, "gpt-6-sol");
  assert.equal(profile.reasoning, "max");
}
assert.equal(settings.research.model, "gpt-6-astra");
assert.equal(settings.research.reasoning, "max");
assert.equal(settings.editingThresholdTokens, 200000);
assert.equal(settings.limits.providerCalls, 6);
const credential = process.env.XEAN_API_KEY ?? "";
assert(credential, "Missing injected Xean credential");
assert(
  deployment.files["context-evidence.json"],
  "Missing frozen context evidence",
);
const contextSelection = {
  provider: "openai-codex",
  model: "gpt-6-sol",
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
  const output = resolve(outputDirectory, name);
  await mkdir(output, { recursive: true, mode: 0o700 });
  options = {
    ...options,
    limits: settings.limits,
  };
  const destination = resolve(output, "campaign.sqlite");
  assert(
    !(await Bun.file(destination).exists()),
    "An existing destination requires reconciliation, never relaunch",
  );
  if (continuation) {
    const checkpoint = resolve(directory, "continuation.sqlite");
    assert.equal(
      hash(await readFile(checkpoint)),
      continuation.checkpointSha256,
    );
    await copyFile(checkpoint, destination);
  }
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
          phase,
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
    assert.equal(initial.providerCalls, continuation?.parentCalls ?? 0);
    if (continuation) {
      assert.equal(initial.status, "limited");
      assert.equal(initial.callAllowance, continuation.parentCallAllowance);
      assert(
        !initial.work.some((work: any) =>
          ["active", "queued"].includes(work.status),
        ),
      );
      await engine.extendCalls(
        continuation.additionalCalls,
        continuation.allowanceKey,
      );
    }
    const campaign = await engine.run();
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
          (request.model === "gpt-6-sol" ||
            (request.kind === "codex-exec" &&
              request.model === "gpt-6-astra")) &&
          (request.reasoning?.effort ?? request.reasoning) === "max",
      ),
      "Pi requests must use Sol/max and native source requests Astra/max",
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
      phase,
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
  const own = {
    ...settings,
    usagePrefix: settings.usagePrefix + "/" + phase + "/editor",
  };
  const options = createEditor(
    input,
    runtimeFor(own),
    own,
    codexResearch(own.research, own.usagePrefix),
  );
  const { projectEditing } = await import(
    resolve(source, "packages/core/src/solve/editor.ts")
  );
  const native = options.coordinator;
  let repairSuppressed = false;
  const edited = await runCase("editor", {
    ...options,
    coordinator: {
      ...native,
      async run(...args: any[]) {
        const [signal, view] = args;
        const editors = view.work.filter(
          (work: any) => work.role === "xean.editor",
        );
        const editorCount = editors.length;
        let decision;
        if (continuation && signal.kind === "allowance" && editorCount === 1) {
          const last = view.work.at(-1);
          assert(!view.callLimitReached);
          assert(
            !view.work.some((work: any) =>
              ["active", "queued"].includes(work.status),
            ),
          );
          assert.equal(editors[0].id, feedback.editorWorkId);
          assert.equal(editors[0].status, "completed");
          assert.equal(last.id, feedback.failedVerifierId);
          assert.equal(last.role, "xean.editVerifier");
          assert.equal(last.status, "failed");
          assert.equal(last.error, "Provider call limit reached");
          const state = projectEditing(input, view.work);
          assert.equal(state.step, "xean.editor");
          assert(
            state.notes.every(
              (note: any) => !note.verified && note.checks.length === 0,
            ),
          );
          // The failed worker published no checks. Review coverage, then repair
          // using its diagnostic response as feedback, never as trusted state.
          decision = {
            state: null,
            dispatch: [
              {
                id: `edit/w${signal.id}`,
                role: "xean.editionReview",
                input: {
                  task: input.task,
                  notes: state.notes,
                  previous: state.original,
                },
              },
            ],
          };
        } else decision = await native.run(...args);
        if (
          decision.completion &&
          feedback?.report.trim() &&
          editorCount === 1
        ) {
          const state = projectEditing(input, args[1].work);
          // Keep the native verdict intact; independent findings require a repair.
          decision = {
            state: decision.state,
            dispatch: [
              {
                id: `edit/w${args[0].id}`,
                role: "xean.editor",
                input: {
                  task: input.task,
                  notes: state.original,
                  previous: state.notes,
                  review: state.review,
                },
              },
            ],
          };
        }
        const request = decision.dispatch?.find(
          (work: any) => work.role === "xean.editor",
        );
        if (request && editorCount === 0) {
          assert(
            !("previous" in request.input) && !("review" in request.input),
          );
          assert.deepEqual(request.input.task, input.task);
          assert.deepEqual(
            new Map(request.input.notes.map((note: any) => [note.id, note])),
            new Map(input.notes.map((note: any) => [note.id, note])),
          );
        }
        if (request && editorCount >= proposalLimit) {
          repairSuppressed = true;
          return { state: decision.state };
        }
        if (request && feedback) {
          request.input.review = {
            verdict: "FAIL",
            report: [
              request.input.review
                ? `Native corpus review (${request.input.review.verdict}):\n${request.input.review.report}`
                : undefined,
              `Unpublished correctness diagnostics and independent findings on the prior proposal:\n${feedback.report}`,
            ]
              .filter(Boolean)
              .join("\n\n"),
          };
        }
        return decision;
      },
    },
  });
  assert.equal(
    hash(await readFile(resolve(directory, "source-snapshot.json"))),
    hash(snapshotBytes),
    "Source snapshot changed",
  );
  assert.deepEqual(input, originalInput, "Caller input changed");
  const result = edited.campaign.result;
  const editorWork = edited.campaign.work.filter(
    (work: any) => work.role === "xean.editor",
  );
  assert(
    editorWork.length >= 1 && editorWork.length <= proposalLimit,
    "This trial allows a first draft and at most one repair",
  );
  const current = projectEditing(input, edited.campaign.work);
  const proposal = editorWork[0];
  if (proposal.status === "completed") {
    const first = projectEditing(input, [proposal]);
    await save("first-proposal.json", {
      at: new Date().toISOString(),
      work: proposal,
      notes: first.notes,
      scope:
        "Exact first publication reconstructed before subsequent checks or harmless corrections. No earlier edited corpus or audit feedback was supplied.",
    });
  }
  const nativeAccepted = edited.campaign.status === "completed";
  const trialFinished =
    !edited.campaign.work.some(
      (work: any) => work.status === "active" || work.status === "queued",
    ) &&
    (nativeAccepted ||
      repairSuppressed ||
      ["limited", "blocked", "failed"].includes(edited.campaign.status));
  const requiredRolesPassed = [
    "xean.editor",
    "xean.editVerifier",
    "xean.editionReview",
  ].every((role) =>
    edited.campaign.work.some(
      (work: any) => work.role === role && work.status === "completed",
    ),
  );
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
    nativeAccepted,
    trialFinished,
    repairSuppressed,
    corpusReviewReached: reviews.length > 0,
    originalCampaignActivated: false,
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
    after: current.notes.length ? metrics(current.notes) : null,
    providerCalls: usedCalls,
    initialAllowance: settings.limits.providerCalls,
    sourceSnapshotUnchanged: true,
    statusesPreserved: true,
    sourceCommit: deployment.sourceCommit,
    note: "Pi estimates are approximate. Corpus review judges coverage; original internal acceptance is not inherited by rewritten notes.",
  });
  await save("complete.json", {
    status: edited.campaign.status,
    passed: nativeAccepted && (phase !== "smoke" || requiredRolesPassed),
    requiredRolesPassed,
    resultSha256: hash(
      await readFile(resolve(outputDirectory, "editor/result.json")),
    ),
    proposalLimit,
    proposals: editorWork.length,
    limitDescription:
      "At most two Editor proposals across the full history. The copied trial checkpoint receives one frozen six-call grant. Smoke is fresh with six calls. No further extension or relaunch. Native acceptance remains mandatory for success.",
    continuation: continuation ?? null,
    trialFinished,
    repairSuppressed,
    nativeAccepted,
    corpusReviewReached: reviews.length > 0,
    cancelled,
    calls: usedCalls,
    callAllowance: edited.campaign.callAllowance,
    checkpoint: edited.campaign.status === "limited",
    phase,
    initialAllowance: settings.limits.providerCalls,
    finishedAt: new Date().toISOString(),
    sourceCommit: deployment.sourceCommit,
    deploymentSha256: hash(
      await readFile(resolve(directory, "deployment.json")),
    ),
    cases,
  });
  if (
    !trialFinished ||
    (phase === "smoke" && !(nativeAccepted && requiredRolesPassed))
  )
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
