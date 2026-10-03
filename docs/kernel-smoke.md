# Verification

The [development check](../README.md#development-on-fleet) checks types,
formatting, distribution metadata, dependency hashes, documentation links, and
the offline test suite. Run it on the exact source candidate and Bun runtime
intended for distribution. A passing historical run does not qualify later code.

## Offline checks

The suite exercises atomic publication, failed-decision rollback, uncertain
commits, concurrent readers, ownership exclusion, crash recovery, pause,
cancellation, call-cap draining, call grants, and settlement during shutdown.
Solver checks cover dependency ordering, source-verdict finality, trusted
imports, correction races, blinded reconstruction, and exact-task acceptance.
Provider fixtures exercise Pi's native parsers and tools, WebSocket continuation,
retry classification, browser disconnects, and Codex process cleanup.

The [deterministic example](../examples/deterministic.ts) runs without credentials
or model calls. From the source checkout:

```sh
bun examples/deterministic.ts
bun examples/deterministic.ts
```

Both invocations must return `{"status":"completed","result":25}`. The second
invocation reuses committed work. Use an explicit fresh database path when
qualifying a new candidate.

FULL SQLite synchronization is configured and process-crash recovery is tested.
Power-loss durability has not been tested. Installation receipts fingerprint
dependency inputs, Bun version, operating system, and architecture, but do not
attest arbitrary manual edits inside `node_modules`. Use a clean setup for
distribution qualification.

## Live provider checks

For a provider or execution change, smoke-test the affected path with its actual
runtime, model, credentials, and native configuration. Check results and failure
records, then reopen without credentials and verify that committed work and
records are unchanged. Fixtures establish local behavior, while live smokes
establish that the selected deployment can execute it.

On saturn, from Fleet Infra, the maintained gateway and solver smokes are:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/scripts/codex-lb-smoke.ts codex-lb/xean
bin/fleet-nix run .#fleet-run -- ../xean/scripts/solver-smoke.ts codex-lb/xean
```

The launchers verify dependencies, read the gateway key from OpenBao into memory,
and pass it over stdin to the child runtime with the provisioned lab CA.

The gateway smoke uses Pi Durable conversations to check two concurrent workers,
native usage, cached WebSocket connection reuse and delta requests, and reopening
in another process. Successful execution prints `completed` for both phases.
The solver smoke initializes without model calls, then checks the tree edge-count
task through acceptance and unchanged reopening with a forty-call allowance.
Both use Luna at max reasoning. The source-checking Codex path and subscription
providers require separate checks when affected. Their setup is
in the [solver guide](solver.md#configuration-and-functions).

Retain source revision, Bun version, frozen task/settings, campaign, result,
and stderr under ignored `runs/`. The solver launcher saves the accepted argument
as `argument.md` and preserves failed-attempt artifacts. A snapshot left by a
failed assertion is not a successful smoke. Record provider limitations with the
source revision.

## 2026-10-02 workflow and Pi refresh

The subsequent candidate pins Pi `a276dabe5791` and retains the previous frozen
model catalog and all model/reasoning settings. Empty published-note indexes
omit readers. Coordinator guidance avoids whole-task checks on supporting
lemmas, and the existing PASS correction path can restore summaries to unchanged
full mathematics. These prompt changes have deterministic contract coverage,
without a new model-backed capability or savings claim.

On macOS ARM64 with Fleet Bun 1.4.2, the full check passed 144 tests and 2,007
assertions. Two clean upstream builds produced matching hashes for all four Pi
packages. All 19 installed patched files matched independent patch application
to the new artifacts. Pi's 12 tool-change payload tests passed without network
model requests. CLI help/version, README initialization/status, deterministic
completion/reopening, and the README's observer configuration passed without
model calls. Receipts are under `runs/pi-upgrade-20261002-9fba660/`.

The further Pi refresh reproduced all four artifacts and matched all 19 installed
patched files at `a276dabe5791`. Both patches stayed unchanged, and the same 144
tests and 2,007 assertions passed. These receipts are under
`runs/pi-upgrade-20261002-a276dabe/`, before the subsequent developer-tool changes.

The six-problem paired comparison completed with six internally accepted and six
independently reviewed PASS arguments in each arm. The priced solver subtotals
were $97.77 for v2 and $118.82 for v3. Including independent review, they were
$110.79 and $133.22. Another 247 solver/review gateway rows have unknown prices,
so complete costs remain unknown. Each output received one independent review
invocation, without reruns. This small selected set establishes neither broad
capability equivalence nor a cost advantage. The source-frozen campaigns and final
accounting remain under `runs/golden-six-20261002/`, with the hashes in
`final-accounting-handoff.json`. The earlier interim analysis is preserved.

The earlier live and cross-platform receipts below retain their original source
and Pi identities. They do not qualify changed provider behavior. Before publication,
qualify a clean archive of the final source on both target platforms and smoke the
affected provider paths. The prepared archive's qualification record identifies
its exact source and evidence. Preserve campaigns' frozen runtimes. Preparation
does not publish a numbered release or tag.

## Earlier 2026-10-02 candidate qualification

The initial receipts below qualify Xean
`b1515e787a327f9fbe950705c7b597fddbaf6a42`, Pi `7fbbd5f4a1d9`, and Fleet
Bun 1.4.2. Subsequent verifier fixes have separate receipts below. Use the prepared
distribution's accompanying qualification record to identify the final source
commit, archive hashes, and clean platform checks. No numbered release or tag has been
published for this candidate.

Clean archives passed setup, the full check, CLI help/version, README
initialization/status, and deterministic completion and reopening on macOS ARM64
and Linux ARM64. Both checks passed 143 tests and 1,985 assertions with no model
calls. The source archive SHA-256 was
`4b8abcaa2c9d14200d11b10e27533913c7784f842788ae3888163462f2b8f6b9`.
Linux ran under Nomad and retained unchanged source, campaign records, and
deterministic database bytes. Earlier failed staging and installation attempts
remain recorded separately. Receipts are under `runs/release-3.0.0/macos/` and
`runs/release-3.0.0/linux/attempts/r04/`.

The Durable gateway smoke completed four Luna/max calls across two concurrent
workers. Each worker reused its WebSocket connection for a delta request, with
no fallback or WebSocket failure. The solver smoke initialized without calls,
then accepted the tree edge-count argument after 16 calls. Both campaigns
reopened without credentials or additional work. Their receipts are under
`runs/release-3.0.0/macos/xean/runs/`.

Headed Chromium inspection checked Observe's accepted tree, note links, full
proofs, verification disclosures, and refresh behavior. It found no horizontal
document overflow or console errors. The receipt is
`runs/release-3.0.0/observe-qualification.json`, with inspected screenshots under
`output/playwright/release-3.0.0/`. Other browsers and mobile layouts were not
qualified.

### Lifecycle

A supervised Linux ARM64 smoke exercised private recovery, pause/resume,
cancellation after HTTP 200, call-cap draining, and unchanged credentialless
reopening. Explorer retained its full-note read, private intermediate submission,
and original one-read/three-response allowances across separate processes,
publishing one shared result. All five admitted calls settled. The cancelled
call's usage remains unknown.

The interruption used cooperative close at a private-work boundary. Pause
targeted recovered pending work. This qualifies those execution and persistence
paths, without claiming SIGKILL recovery, pause during an active request, or
mathematical verification. Source and artifact hashes, native records, and the
retained failed preflight are bound in
`runs/release-3.0.0/lifecycle/qualification.json`.

### Mathematical comparison

Frozen v2.0.0 at `a53d29f` and the candidate each accepted the tree edge-count
task and the sum-of-odd-integers task. All four arguments passed an independent
blind review supplied only the exact tasks and proofs. The task bytes, Luna/max
model, gateway, and admission allowances were shared. Each version retained its
own scheduler, dependencies, campaign format, and reader.

Each version used 25 calls across the two tasks. The gateway recorded $0.029739
for v2 and $0.034285 for the candidate. Candidate calls decreased on the odd-sum
task and increased on the tree task. One observation per version and elementary
task establishes no statistical capability or efficiency advantage. Native
token counts matched the gateway records. Recorded costs are not provider-bill
reconciliation, and blind review usage is separate. The design, results,
accounting, and opaque review packets are under
`runs/release-3.0.0/comparison/`.

### Codex work and verifier qualification

The source smoke retrieved evidence for Cayley's labelled-tree formula and
received source PASS with three bound quotations. A separate Codex review,
given only the task and argument, obtained its own evidence and returned PASS.
The implementation worker wrote and ran a TypeScript enumerator for
`max 3x + 5y` over nonnegative integers with `2x + 3y <= 19`.
Five Pi calls completed verification and acceptance of its ordinary candidate note.
An independent program
run reproduced the optimum 31 at `(2, 5)`. Credentialless reopens preserved all
three campaigns and database bytes.

The source smoke exposed a requirements defect: the judge
reported missing source verification after the source stage had already passed.
The rejected note remains rejected under the final-per-note-ID contract.

Source `d1cc6df` supplies recorded source verdicts and bound evidence to the
requirements judge. An isolated fresh note explicitly retaining the original
correctness and source evidence passed requirements in one live call. Its
credentialless reopen preserved records and database bytes. This qualifies the
changed stage, without claiming a fresh correctness or source assessment.

A separate reconstruction retained the exact external premises but produced a
malformed extracted statement containing U+001E controls and omitting the note's
application. The comparison incorrectly returned PASS. That operational result
does not qualify mathematical fidelity. Raw response bytes were not retained, so the
origin of the controls cannot be resolved before the recorded model submission.
The original result and all attempts remain under `runs/release-3.0.0/codex/`,
with their interpretation in `qualification-addendum.json`.

Source `29f0d1d` rejects non-whitespace ASCII controls through Pi's native tool
validation and tells extraction to retain the note's application result. The
locked check passed 143 tests and 1,993 assertions, including rejection and
correction of the malformed submission before it reaches the blind prover.
A fresh reconstruction reused the exact prior correctness/source evidence and
passed in three live Pi calls. Its statement retained both the permitted theorem
and the conclusion of 16 trees on the fixed four-label set, with no control
characters. The proof checked the hypotheses and arithmetic. Credentialless
reopening preserved records and database bytes. This was an isolated
reconstruction check with seeded earlier evidence, not a fresh source assessment.
Its receipt is `runs/release-3.0.0/codex/reconstruction-2026-10-02T10-04-53-679Z/complete.json`.

### ChatGPT Web

One built-in Explorer request through the separately managed
`codex-chatgpt-web` 6.1.1 service on mercury published a note. The request
selected `chatgpt-web/gpt-6-pro` at max reasoning. Read-only and credentialless
owning reopens preserved records and database bytes with no replay.

This qualifies a structured Explorer submission and completed reopening.
Mathematical acceptance, served-model identity, measured usage, and subscription
billing were not established. The receipt is
`runs/release-3.0.0/providers/chatgpt/verification.json`.

### Native Anthropic

An ordinary built-in Explorer math submission with `claude-opus-5-5` completed
through native Anthropic subscription OAuth, then reopened without credentials
or another request. This qualifies that submission and reopening, without
mathematical acceptance. The receipt is
`runs/release-3.0.0/anthropic-math/qualification.json`.

An earlier nonce-tool smoke authenticated and received HTTP 200 but was refused
before executing the tool. Its failed campaign and unchanged credentialless
reopen remain under `runs/release-3.0.0/providers/anthropic/`. The earlier
`providers/qualification.json` predates the successful math submission.
The refused nonce-tool round trip remains unqualified on this candidate.

### Other provider limits

Pi's native `openai-responses` path completed one `gpt-6-astra` call and an
unchanged credentialless reopen through the `codex-lb/v1` gateway. This was
not a request to the public OpenAI API. Its receipt is under
`runs/release-3.0.0/macos/xean/runs/native-openai-2026-10-02T09-14-16-236Z/`.

The public OpenAI endpoint, Anthropic API-key path, and Gemini were not live
tested for this candidate. Subscription qualification excludes OAuth refresh,
login expiry, quota exhaustion, large contexts, and browser cancellation.
Pi catalog cost estimates are not subscription bills.

## Historical provenance

Earlier Pi upgrades, source archives, Lab lifecycle runs, and provider smokes
retain their source-bound receipts in local run artifacts and
[Git history](https://github.com/chaoxu/xean/blob/b1515e787a327f9fbe950705c7b597fddbaf6a42/docs/kernel-smoke.md).
They qualify their recorded revisions. Private artifacts are outside the source
distribution. Model execution, solver acceptance, independent mathematical
review, and catalog closure remain distinct evidence.
