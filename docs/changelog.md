# Changelog

## 3.5.0 — development

External role backends are opt-in, and multiple campaigns can share a foreground
host while Pi owns each campaign's execution and recovery. This version is unreleased.

- Note IDs are permanent names under the worker's Pi task prefix or the caller's
  command prefix. Producers use the full ID in text, dependencies, reads, and edits.
  Publication preserves IDs and rejects duplicate creations. Local aliases and
  invocation-wide numbering are removed.
- Explorer publication receipts report dependent revision changes. Previously
  observed dependents can use the returned revisions. Unseen intervening edits
  still require a read. Publication and its receipt recover atomically through Pi.
- Source backend failures identify their stage and retain completed verification
  work. Coordinator instructions explain the shared source backend and recommend
  independent work after repeated operational failures.
- Pin Pi to an unreleased snapshot after 1.2.0. It classifies
  `unable to forward upstream` as retryable and repairs invalid Unicode escapes
  in streamed JSON. The frozen model catalog and existing Xean patches remain.
- Import `xean/core` for the workflow, notebook rules, and role contracts without
  loading bundled role implementations, CLI, or adapters. `xean/roles` exports
  the default roles, and `xean/report` provides inspection. `open` from `xean`
  retains the default setup. Core records role settings as JSON, while the
  default setup validates its model profiles and options.
- Campaign workers now enforce the same role/result-kind contract as standalone
  calls. A Verifier cannot publish notes, and Explorer cannot submit verification checks.
- Native correctness, requirements, proof generation, and proof comparison share
  `selectBatch` in `xean/roles`. Large assessments split with support and source
  records scoped to each group. Completed groups survive interruption through Pi.
- Register Codex, Claude, or ChatGPT adapters through `open({ roles })` or an explicit CLI
  `--roles` module. Default installation uses native Pi roles and closed-book
  source checking without external CLI dependencies.
- ChatGPT Pro uses the same external Explorer interface as other backends,
  selected by the caller's role module. Remove its campaign-wide quota and
  browser-specific state from the core.
- Implementation work uses `kind: "implementation"`. External verification uses
  `backend: "external"`. Core retains schemas, frozen inputs,
  dependency checks, and acceptance. Bundled roles perform blind reconstruction.
  External request receipts identify their provider.
- Codex and Claude share Execa process handling and native Pi memos. Completed calls
  are reused and interrupted CLI calls use fresh workspaces. Native Pi memos guard
  worker backend registration and packaged adapter request configuration.
  Standalone results receive role-specific validation.
- `host`, `attach`, and `detach` share a Pi `Models` instance across independently
  owned campaigns. Restart discovers campaign databases under the selected directory.
  Per-campaign controls and Pi checkpoints remain authoritative.
- Pi's existing SQLite adapter uses Bun's native driver through a small application
  adapter. Closing finalizes prepared statements and releases database handles
  without waiting for garbage collection. This adds no Pi patch.
- Start fresh campaign databases. External backend configuration moves from
  `settings.codex` and `settings.research` into role modules.
  Preserve historical campaigns with their pinned runtimes. No migration is provided.

## 3.4.1 — 2026-10-13

Documentation correction for the 3.4.0 qualification boundaries.

## 3.4.0 — 2026-10-13

Fresh-database 3.4.0 runtime release.

Explorer publishes each submission while continuing its conversation. Caller
notes and model-generated notes share verification rules, with external trust
recorded as evidence.

### Notebook and verification

- Malformed verification and source batches now report requested, received,
  missing, unexpected, duplicate, and duplicate-request IDs. Native Pi roles
  receive this feedback in the same conversation. External results retain the
  existing failure handling without weakening exact-ID checks.
- Each native Explorer submission atomically commits its notes, edits, and replay
  receipt. Explorer can read and edit those notes immediately. Later failure or
  cancellation retains committed batches. Coordinator waits for the worker to
  finish before choosing again.
- External trust in `checks.external` references a Pi input entry and replaces
  the `imported` flag. Dependencies still require verification. All notes require
  faithful statement preparation and reconstruction before final acceptance.
- Caller submissions accept `trusted` per note or edit. New notes default to
  trusted, and edits preserve existing trust when omitted. `submit --untrusted`
  overrides every supplied note and edit. Trust changes invalidate affected checks.
- Notes use one revision field. The `cosmetic` edit flag is removed. Mathematical
  edits reopen affected checks. Candidate and retirement flags only advance the
  revision. Custom replacement roles return ordinary results, replacing the
  private `{ kind: "submissions", entries }` format.
- With `settings.codex` enabled, Coordinator can select Codex for verification
  using retained workspaces and execution evidence. It can reassess INCONCLUSIVE
  mathematical checks. PASS and FAIL stay closed for unchanged inputs.

### Pi and recovery

- Pi moves to the official 1.2.0 release. Xean uses Pi's context projection with
  the retained continuation patch. Artifact and patch hashes remain in
  [Pi provenance](../vendor/pi/provenance.json).
- Correct the affected OpenAI and Azure GPT model catalogs: the 1,050,000-token
  context window is separate from the 272,000-token pricing tier.
- Retryable provider failures with reusable text, reasoning, or tool arguments
  continue the same submission. Empty retryable failures use bounded retries.
  Incomplete tools never execute. Context and completed-response limits remain.
- Codex implementation, verification, and research share an executor. Completed
  requests are memoized within the worker. Interrupted calls restart in fresh
  workspaces.

### Compatibility

- Notebook and role-conversation document formats have changed. Start fresh
  campaigns and retain earlier campaigns' frozen runtimes. No migration is provided.

## 3.3.0 — 2026-10-12

Pi continues incomplete model responses within the same submission, preserving
usable work until a complete response or an operational limit.

### Continuation and handoff

- `max_messages` and `max_output_tokens` continue automatically when the response
  contains reusable text or reasoning. Continuations have no fixed count and do
  not consume the role's completed-response allowance.
- Pi atomically commits the incomplete response and its continuation. Tools from
  incomplete responses never execute. A limit response without reusable content
  fails explicitly. Provider-error retries remain separate.
- Context and completed-response limits remain in effect. Explorer retains its
  complete submissions and reports an operational handoff to Coordinator.
- Coordinator's Explorer assignments identify the relevant note IDs and the
  remaining gap in the complete task.

### Pi and cleanup

- Pi moves to source commit `ee409a85f6ad92bf8c6ab8ed735c6cd24f2e749e`.
  Native document retention replaces Xean's cache-cap patch. Unobserved trackers
  leave memory after use, and subsequent reads reload them from storage.
  The fix for retired document observers remains. Chord also avoids redundant work when
  appending to document arrays.
- Coordinator reuses scanned task outcomes, reports resolve standalone results
  once, and notebook publication skips dependency traversal when nothing needs
  invalidation. Role assignments use Chord's native JSON copying.

### Compatibility

- The database schema, note edits, per-note candidate status, assignments, and
  `role review` retain their 3.2.0 formats. Cross-version checks passed on
  representative paused and completed model-free databases. Transfer of an
  in-flight model generation remains unqualified.
- Automatic continuation extends the retained Pi patches. Codex strict-schema conversion
  remains the 3.2.0 implementation.

## 3.2.0 — 2026-10-11

Xean unifies note submissions and worker assignments, inspects campaign databases
in place, and moves to a newer Pi snapshot.

### Compatibility and interfaces

- Start fresh campaigns. Pi document versioning rejects 3.0.0 and 3.1.0
  databases. Keep existing campaigns with their frozen runtimes. This release
  includes no database migration.
- Caller `submit` and Explorer use the same `notes` and `edits` schema. The
  `correct` command is removed. Submit an edit with the note's `id`, expected
  `revision`, and changed fields. Caller import grants, revision checks, and
  atomic publication retain their existing rules.
- Candidate status is a per-note field for new notes and edits. The batch-level
  flag and its last-note convention are removed. Omitting the flag on a new
  note means `false`. Literature findings cannot designate candidates.
- Explorer's `guidance` and Literature's `query` become `assignment` in
  Coordinator work plans and standalone inputs. Codex keeps `assignment`.
  In `inspect` output, `work[].guidance` becomes `work[].assignment`.
  Caller campaign guidance remains unchanged.
- The dedicated `review` command is removed. Use `role review` with a JSON input
  containing `task` and `argument`, then `inspect` to read the assessment.

### Inspection and Pi

- `status`, `inspect`, and `export` read the database through a read-only Pi
  Session, holding a consistent SQLite read transaction without recovering work
  or calling models. Pi rejects writes from inspection callbacks, which 3.1.0
  applied to a disposable copy.
- Initialization creates the notebook catalog in the same commit as campaign
  control.
- Bundled Pi moves to source commit `ea448f454af474f3e2fe9733b331e17b0662f5d6`,
  an unreleased snapshot after 1.1.0. Its scheduler retains ownership metadata
  only while live work needs it and reloads it from storage when needed.
  Existing patches remain, including the separate document tracker cache bound.
- A new Pi Durable patch supplies read-only SQLite storage. It reuses the caller's
  read transaction, checks the schema version without migrating, rejects writes
  and ID allocation, and skips Pi's explicit closing WAL checkpoint.
  [Pi integration](parity.md#pi-integration) records its removal condition.

### Research

- Fix Codex implementation calls rejected with `invalid_json_schema` when output
  fields are optional. Xean now uses Pi's strict-schema conversion and result
  validation.
- Coordinator instructions explain how to repair a checked statement that
  misstates the intended claim: request a mathematical Explorer edit of the
  authoritative note text, then a new correctness check. Correctness checks
  record checked statements.
- The optional native Codex profile in `examples/xean-research.config.toml` sets
  `features.plugins = false` for source checking, literature, and independent
  review while preserving native web search. Implementation workers select their
  profile separately. The [setup instructions](../README.md#run-a-campaign)
  describe how to select the profile.

## 3.1.0 — 2026-10-10

Xean adds an editable notebook, preserves useful work after provider failures,
and moves campaign inspection to the CLI.

### Compatibility and removals

- Start fresh campaigns. The database format is incompatible with 3.0.0.
  Keep existing campaigns with their frozen runtimes.
  This release includes no database migration.
- The Observe web interface and `bun run observe` are removed. Use `xean status`,
  `xean inspect`, `xean inspect --records`, and `xean export` on the campaign host.
- `status`, `init`, `run`, `role`, `review`, `pause`, `resume`, and `cancel` return
  compact status JSON. Use `inspect` for usage, full work history, notes, checks,
  and standalone results. Update scripts that expected those details in status.
- The note `checks` field is now an object keyed by verification stage, replacing
  the array of check records. Verifier corrections update summaries only. Change
  proof text and dependencies through note edits.
- The prompt-evaluation runner is removed. Use the ordinary `role` command with
  a fresh database for each standalone case.

### Notebook and verification

- Explorer can edit notes in place using their stable IDs and expected revisions.
  New notes and edits publish atomically. Mathematical changes invalidate affected
  checks while preserving unaffected checks and dependency references.
- The editable notebook keeps an index summary, detailed summary, and
  authoritative full text for each note.
- Retirement removes a note from routine discovery and direct verification.
  Historical reads and verification of existing dependents remain available.
- Completed assessments, including INCONCLUSIVE results, stay closed for unchanged
  inputs. Coordinator chooses repairs, source retrieval, other work, or idle.
  Relevant new quotations can reopen an eligible INCONCLUSIVE source check.
  Duplicate receipts and unrelated quotations leave it closed.
- Edits may declare `cosmetic: true` for presentation-only text changes. Xean
  trusts this declaration and preserves checks and import trust. Changes to
  dependencies always require verification.
- Acceptance pins a notebook snapshot. The CLI and library export the accepted
  argument from that snapshot.

### Recovery and resource use

- Native Explorer submissions can publish after a terminal provider failure if
  they still validate against the current notebook. The worker retains its failed
  status and error. Cancellation and invalid publications publish no partial work.
- Codex failures expose the provider's error message when available. Output
  capture is bounded.
- Completed role conversations release idle context and provider session resources.
  Each Pi session caches at most 128 document trackers and reloads evicted
  documents from storage. This bounds cached document count, not total memory.

### Pi and development

- Bundled Pi moves from 1.0.4 to an unreleased snapshot after 1.1.0. The exact
  artifacts and retained patches are recorded in
  [Pi provenance](../vendor/pi/provenance.json).
- Xean uses Pi's model catalog, reasoning schema, and native document snapshots.
  Notebook state lives in Pi Documents,
  with references to native verification receipts.
- Retained provider patches preserve error identity and failed-response usage, handle
  fragmented Codex SSE frames, and retain native WebSocket fallback. The
  [Pi integration inventory](parity.md#pi-integration) explains each retained patch.
- Source-package checks now run Pi and role contract tests against the installed
  production dependencies. CLI startup no longer runs duplicate installation scans.
