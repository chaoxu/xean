# Xean Observe

Xean Observe displays campaign notes, checks, workers, failures, and recorded
usage. It is an optional app in this repository, packaged with its dashboard,
snapshot publisher, and theme assets. It uses Xean's public inspection,
note-projection, and `xean/report` APIs. Core and CLI do not depend on it, and
it does not depend on the CLI.

Observe is read-only. Recorded model-call, token, and cost data describe what has
run; they do not impose a campaign stop or a polling decision. Campaign lifecycle
controls remain with the Xean CLI or active owner.

The dashboard reads local campaigns through `inspectCampaign` and remote runs
through exported JSON. Inspection never starts recovery or calls a model.
The dashboard and publisher run separately from solver execution, including
bounded experiments. Publication uses an atomic file rename.
An observer failure is reported in its own process and does not stop mathematical work.
The file is a disposable view of the campaign, not its authoritative record.

## Snapshot publishing

Local dashboards can read the campaign database directly. For remote artifact
readers, run the publisher on the campaign host after the database exists:

```sh
bun packages/observe/src/publish.ts /absolute/run-directory
bun packages/observe/src/publish.ts /absolute/run-directory --watch
```

The first command writes `observation.json` and a compact `status.json` from
the same inspection. `--watch` checks for database changes every ten seconds
and publishes only after a change. Shutdown checks once more after any pending
publication. Failed exports are retried on the next check. The watcher uses
SQLite's connection-local change counter without retaining a read transaction,
and reopens its connection if the database file is replaced. Actual inspection
still opens and closes a coherent Pi snapshot while the solver retains ownership.
The export timestamp remains unchanged while the database is unchanged, so its
age measures the last publication, not process liveness. Deploy
the watcher as a separate supervised process with access to the run directory.
A run manager such as Xean Lab may start and join this process for each attempt.
The solver remains independent of the publisher. Remote campaign details require
`observation.json`, and compact reads require `status.json`. Execution receipts
in `result.json` are separate from observations. Before publication, task and
round files provide a heartbeat. Process logs remain available independently.

The workspace binaries are `xean-observe` for the dashboard and
`xean-observe-publish` for snapshots. The commands above retain the selected Bun
runtime. On Fleet, launch either file through the locked `fleet-run` command
shown below.

Library callers use `snapshot(inspection)` from `xean-observe`. Callers that
already have a `campaignReport` and its `statusReport` can pass
`{ ...report, status }` to `snapshotFromReport` to reuse the prepared notes and
usage totals. Both reports must come from the same inspection.

## Run locally

Create a config file containing the runs to display. Local paths resolve relative
to the config file. Remote paths are absolute and name a provisioned Bun runtime.
Configuration rejects unknown fields and reports invalid fields by their JSON path.
For either source, an optional `job` obtains process status and recent logs through
Fleet's Nomad CLI. `task` selects the Nomad task and defaults to `solver`.
Xean Lab uses `worker`. The process panel identifies a sampled pool allocation
and its job and task. Its logs may include other campaigns. Pool status and
heartbeat counts never substitute for an individual campaign's state or usage.

```json
[
  {
    "id": "local-run",
    "directory": "./my-run",
    "review": "review/receipt.json"
  },
  {
    "id": "jupiter-run",
    "host": "jupiter",
    "directory": "/srv/xean-lab/runs/_xean/my-run",
    "runtime": "/srv/xean-lab/runs/_xean/my-run/runtime/bun",
    "job": "xean-my-run"
  }
]
```

From the installed source checkout:

```sh
bun packages/observe/src/server.ts /absolute/config.json
```

Local campaign inspection uses the source checkout and Bun. The optional `job`
field additionally requires Fleet's Nomad tooling. On Fleet, use the locked runtime:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/observe/src/server.ts /absolute/config.json
```

Open <http://127.0.0.1:8797>. The listener is local, with a read-only JSON API at
`/api/runs` and `/api/runs/RUN_ID`. Configured IDs are the only addressable runs.
The run list polls compact status, including the problem text for search and
excerpts. Opening a run fetches its details and polls only that run. Returning
to the list releases those details. Each source shares its own in-flight read
and ten-second cache. Full snapshots expire from the server cache after ten
seconds. Individual run requests wait only for that source. Configuration reloads
independently, so a stalled source cannot prevent its removal. SSH and Nomad observation subprocesses
time out after ten seconds and are cancelled on server shutdown. These limits
apply to read-only observation commands. Invalid configuration leaves the browser's last received view visible
with an error. Removing a selected run makes its URL unavailable.
Within each refresh, runs with the same Nomad job and task share one process
observation. Failed process reads are retried on the next refresh.

The browser pauses polling while hidden. A source-read failure preserves the
selected run's last received evidence and marks it stale. HTTP or network failures
keep the view visible with a refresh error. The API retains only
compact status across refreshes, with the same stale marker and original evidence
timestamp. Fresh diagnostics and process observations remain visible. A successful
read replaces stale evidence, and an initial failure has no cached evidence.
The reader never substitutes an older disk artifact for a malformed selected artifact. Each run displays the age and source of its evidence.
Nomad's process status is separate from the campaign's last observed state.
An old snapshot saying `running` alone does not establish process liveness.

### Compact status

For routine agent checks, request a compact status for the selected run:

```sh
curl -fsS 'http://127.0.0.1:8797/api/runs/RUN_ID?view=status'
```

`/api/runs?view=status` returns the same view for every configured run. Local
databases use the public status report. Artifact readers load only `status.json`
and compare its timestamp with the observation. A missing or older status file
requires a publication. Heartbeat-only runs use task metadata and round filenames.
Compact and full reads cache evidence separately and share process observations.
The compact view includes the problem text, campaign status, accepted note ID,
note and verification counts, bounded worker activity and failures, and recorded
usage. Published compact artifacts include the task for this projection.
`usageAvailable` distinguishes missing usage records from zero calls.
Evidence `observedAt` and `stale`, sampled process status, and external review
verdict remain separate. Heartbeat-only sources provide a round count. Proofs,
completion criteria, logs, and review reports are omitted, and diagnostics
are clipped.
Remove `?view=status` when those details are needed. Check a long run on request
or at a suitable interval, such as ten minutes, rather than reading every refresh.
Detailed notes require a current local campaign database or a published observation.
Use the run's matching source checkout and runtime for historical campaigns.

Compact status is the routine agent read. Its activity, failure, and usage-group
lists are bounded and report omitted entries explicitly; an omitted count means
the view is incomplete, not that the omitted entries are absent. Request the full
view only when the additional notes, checks, task text, or logs are needed, and
use the run's matching reader for historical campaigns.

Runs launched before snapshot publishing retain their original runner. Observe
shows their task, round markers, and Nomad logs until a result export appears.
Detailed notes during execution require a compatible local campaign database
or an observation snapshot.
Snapshots use `xean-observe/v4` and include committed index and detailed summaries,
full note text and checks, worker outcomes and note links, and native
usage counts. Private model reasoning and complete request bodies stay in the
campaign journal. Snapshots created without usage records show usage as
unavailable. Gateway billing reconciliation remains separate.

Run search filters the configured source list. Notes can be searched and filtered
by status, with paged lists to keep large corpora readable. Run, note, and work
URLs support browser history and direct links. A note shows its detailed summary,
supporting notes, and dependents. Full text and structured checks render when
opened. Refresh preserves the selected view and open disclosures.

An optional `review` source field names a receipt file relative to the run
directory. The same contract works locally and over SSH:

```json
{
  "reviewer": "independent-reviewer",
  "reviewedAt": "2026-10-01T12:00:00Z",
  "verdict": "PASS",
  "report": "The exact statement and proof were checked independently."
}
```

`verdict` is `PASS`, `FAIL`, or `INCONCLUSIVE`. A missing receipt is reported as
missing. An unreadable or malformed receipt has its own diagnostic and does not
erase campaign evidence. Independent review appears separately from solver
acceptance. Lab supplies this path through its public discovery output.
Observe shows the [Codex worker's](../../docs/solver.md#codex-worker) published
notes and work results. Its files remain in the recorded workspace, outside
Observe's browsing interface.

## Verify

The workspace's locked `scripts/dev.ts check` covers this package. Browser smoke
artifacts belong under ignored `output/playwright/`.

`web/chao-ui.css` is copied unchanged from chao-ui commit
`52698d2f8a43bc0567fba1ba1b53c6a07635e73e`. Mathematical text uses KaTeX with
untrusted commands disabled. Lit escapes dynamic content. The dashboard has no
campaign mutation controls.
