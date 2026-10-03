# Changelog

## 3.0.0 (unreleased)

The main branch contains the 3.0 release candidate. Built-in model roles retain
private work across interruptions through Pi Durable conversations. Explorer
selects its own note reads, and the CLI and observer share public reports from
the core library.

Start fresh campaigns with campaign format 12, solver declaration version 14,
and observer snapshot format `xean-observe/v4`. Notes require
`summary`, `detailedSummary`, and authoritative full `text`. Verifier corrections
use null for unchanged fields, retaining their exact bytes without model output. These changes affect
the public APIs, CLI inputs, and stored solver records. Historical campaigns and
exports require their original source revision, runtime, and reader. No migration
is provided. Existing releases and tags remain historical archives.

- Pin matching Pi `1.0.1` packages at `83692682f095`, preserving frozen model data
  and verified patches. Let Pi replace superseded private-progress revisions,
  gate invocation writes, and wake scheduling on task changes.
  The bounded runner now writes only a compact result receipt, leaving notes and
  records in Pi's database for explicit inspection. Remote observation uses the
  snapshot publisher instead of reading raw runner exports.
- Read individual Pi entries in tool hooks and filter native task scans by kind.
  Return compact execution receipts from CLI lifecycle commands, with full data
  available through `inspect`. Observe polls SQLite's change counter and publishes
  only after changes, retaining the last publication timestamp on unchanged polls.
  Keep note metadata in the initial index and use stable task/summary prefixes
  for both Explorer and Coordinator.

- Resume built-in Pi roles from completed generations, tool results, and private
  submissions after interruption, retaining frozen inputs and read/response
  allowances. Completed verifier source batches survive in native task memos,
  preserving evidence identities and reuse of later checks. Shared notes publish
  only with a complete worker result. Codex subprocesses retain whole-call recovery.
- Use Pi's native initialization, dispatch, cancellation, task recovery, commit
  subscriptions, and SQL transactions. Preserve Coordinator signal order during
  recovery and wait for private-child cleanup before settling exhausted Coordinator
  signals. Drain call accounting before closing storage. Cancellation prevents
  late publication while retaining provider outcomes and measured usage.
- Store solver work as references to the existing frozen Coordinator record,
  with guidance and selected targets. Resolve notes through Pi's native record
  reads once per invocation, preserving revisions and verification feedback on
  recovery without storing another complete corpus in every worker input.
- Give Explorer the exact task, complete note index, and feedback. It chooses
  detailed summaries or full notes through `read_notes`. `maxExplorerReads`
  defaults to four batched calls per invocation, and `maxExplorerResponses`
  defaults to that allowance plus four. Explicit limits override these defaults.
  The one-response ChatGPT profile disables reads. Omit readers from empty
  frozen indexes, and keep private submission IDs outside published-note reads.
  Remove the `explorer` mode setting and Explorer-input `support` selection.
  Mathematical dependencies remain declared by the resulting notes.
- Verify note summaries against their full mathematics while keeping blind
  reconstruction independent of the original proofs and summaries. Allow PASS
  corrections to restore summaries to unchanged full statements and proofs,
  while retaining every stage's checks and final historical verdicts. Record
  external premises as exact standalone claims and pass approved statements
  unchanged to reconstruction. Keep conditional antecedents within the claim.
  Source checkers receive the summaries they may correct, and literature can
  retain useful unsuccessful searches with their remaining uncertainty.
  Reject non-whitespace ASCII controls in structured verifier text through native
  tool validation, and extract the note's result when it applies an external theorem.
  Lead unresolved reconstruction reports with the blocking reason and separate
  assessments of the original argument, independent proof, and supplied inputs.
  Check the original despite an incomplete independent proof, retain secondary
  issues, and distinguish missing source approval from an invalid application.
- Make requirements FAIL final for its note ID while retaining the note as
  useful support. Harmless corrections preserve that rejection, and substantive
  repairs require a new note. Reject verification requests with no pending check.
  Supply recorded source verdicts and bound evidence to requirements checking.
  Guide Coordinator to establish supporting lemmas through source checking and
  request final reconstruction for the complete solution, avoiding whole-task
  requirements checks on each supporting lemma.
  Clarify how imported candidates declare supporting assumptions for reconstruction.
- Add an optional Codex worker for concrete implementation assignments. Coordinator
  selects notes and their support, and Codex uses native tools in a retained
  workspace. Its findings enter the ordinary unverified-note and candidate paths.
  Closed-book experiments reject the worker. Standalone Codex work, review, and
  literature initialize only their required runtime. Independent reviews return
  findings and evidence without the unused whole-note correction field.
- Use Pi's native Anthropic provider for Claude subscription OAuth or API
  credentials and its native Google provider for Gemini API profiles. Remove the
  Claude Code subprocess provider. Research remains Codex-only. Preserve custom
  models when role runtimes share a provider, validate direct runtime profiles,
  and honor explicitly selected credential variables without falling back.
- Use a separately managed `codex-chatgpt-web` Responses endpoint for ChatGPT Web,
  replacing the `chatgpt-cli` Chat Completions path. The built-in Explorer permits
  one attempt per campaign, including after failure or reopening, with no reads
  or automatic retries. Coordinator sees when that Explorer is unavailable,
  and replacement planners cannot bypass the limit. Preserve tool and feedback
  identities, malformed replies, and reported served-model identities. Usage
  remains unknown, and closed-book runs reject browser-backed retrieval.
- Preserve HTTP status for retry classification so permanent Responses,
  Anthropic, and Google errors do not retry because of transport words in their
  messages. Accept CRLF-framed Codex SSE responses across chunk boundaries.
  JSON `Unterminated string` errors no longer trigger transport retries.
- Keep the CLI and observer as optional sibling applications over the core
  library. Move shared reports from `xean-cli/report` to `xean/report`, covering
  online, closed-book, and direct-library solver campaigns. Compact reports add
  note origins, accepted note identity, verification summaries, and work details.
  Show suggested next actions and unresolved candidate checks without changing
  scheduling or acceptance.
  Apply Pi's native SQLite busy timeout before opening campaign state, so
  concurrent observer startup does not abort solver WAL recovery. Competing
  campaign owners still fail immediately.
- Add `doctor SETTINGS` to check local dependencies, settings, frozen model
  names, credential availability, and executables without
  making model calls. Live authentication and provider qualification remain separate.
- Prepare small correctness-prompt cases with frozen settings and source hashes.
  The helper emits commands for the existing standalone Verifier; it makes no
  model calls. Expected outcomes stay separate from model inputs and semantic review.
- Add conditional owner IDs to reject stale lifecycle commands. Validate the
  control socket and its private directory, and let commands wait for the active
  owner without an HTTP idle timeout. Expose uninitialized inspection after
  interrupted startup. Reject foreign Pi storage and dangling database symlinks,
  and preserve read-only inspection after writer close. Apply library defaults
  to explicitly undefined limits and validate Explorer allowances in direct calls.
- Expand Observe with searchable notes, dependency navigation, structured checks,
  worker publication links, direct URLs, and a compact status view. Show detailed
  summaries before full notes and preserve disclosures during refresh. Display
  independent-review receipts separately from campaign evidence. Failed reads
  retain the last observation with its original timestamp, a stale marker, and
  current diagnostics. Invalid snapshots leave available process logs visible.
- Reload observer sources without restarting and share Nomad process reads
  within each refresh. Isolate failed reads, bound SSH and Nomad observations,
  and cancel them on shutdown. Publish snapshots through a separate read-only
  command, using `--watch` for live remote snapshots. Select the newer snapshot
  or result export and publish replacements atomically. Bounded experiments
  export their results and journal without starting an observer or reopening
  the campaign for qualification.
- Integrate the separate Xean Lab runner through public CLI, inspection, and
  reporting APIs. Lab retains frozen task, settings, and guidance inputs,
  immutable attempts, and exact source, image, and Bun identities. It supervises
  the observer publisher separately. The bounded
  Nomad runner provides writable storage for its control socket.
- Pin matching Pi/Chord packages to `a276dabe5791` with the frozen model catalog
  and recorded artifact and patch hashes. Remove the unused `pi-agent-core`
  dependency. Installation receipts include the operating system and architecture,
  requiring clean setup after copying a checkout across platforms. Distribution
  checks validate example settings and tasks against the public schemas and
  require enabled patches to match their provenance. Fleet checks support
  focused test files, and Lab shares a zero-call integration smoke.
  Adopt Pi's Anthropic inline tool definitions and model-capacity retry handling
  with unchanged model and reasoning settings.

Qualification receipts and provider limitations are recorded in
[verification](docs/kernel-smoke.md). Historical checks apply to their recorded
source revisions.

## 2.0.0 — 2026-09-27

Xean now uses Pi's durable storage and agent loop, with a smaller campaign kernel,
a separate CLI, and a read-only observer. The public APIs, CLI, and persisted
campaign formats replace the 1.x implementation. Keep earlier campaigns on their
original release. No migration is provided.

- Workers publish their complete result and Coordinator signal atomically.
  Independent readers can inspect a running campaign without taking ownership.
  Pause, cancellation, whole-worker recovery, and keyed call grants retain
  committed work.
- The solver checks declared dependencies, exact completion criteria, and blind
  reconstruction of generated supporting claims. Source verdicts are final for
  each note ID. Trusted imports, guidance, and harmless corrections have durable
  command receipts.
- Distribution uses a complete source checkout with pinned Pi artifacts and
  patches. `xean --version` identifies the release. Checks cover version
  consistency, dependency provenance, documentation links, and offline behavior.
- Package scripts retain the invoking Bun runtime even when `PATH` contains an
  older installation.
- ChatGPT Web requests are excluded from automatic solver retries after a
  disconnect. A request already running in the browser must not be duplicated.
- The closed-book runner accepts the default disabled literature setting.
  The observer and bounded runner verify the dependency installation before use.
- Local observer reads include configured process status and logs. Missing
  observations no longer imply that a campaign is still running. Process status
  remains visible when snapshots or logs cannot be read, and remote snapshots
  finish writing before their helper exits.
- The CLI waits for large inspection reports and exported arguments to finish
  writing through pipes before exiting.
- Coordinator instructions clarify that exploration can start with no existing
  notes and distinguish context notes from mathematical dependencies.

Model judgments remain fallible. Solver acceptance, independent mathematical
review, and catalog closure remain separate. Provider availability and native
CLI authentication must be verified in the executing environment.

Earlier source versions remain available under the
[historical tags](https://github.com/chaoxu/xean/tags).
