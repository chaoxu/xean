# Changelog

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
