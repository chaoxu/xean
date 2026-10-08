# Xean

Xean runs a mathematical research workflow on Pi Durable. Explorer develops
notes, Verifier checks their claims and dependencies, and Coordinator chooses
further work. Each campaign runs Coordinator, one worker, then Coordinator again.
The next Coordinator task is admitted with its worker and waits for the worker's
terminal outcome before deciding. A worker may
parallelize its own internal work. Pi owns tasks, conversations, checkpoints,
cancellation, and storage.

The implementation includes staged verification, blind reconstruction, imported
notes, harmless corrections, optional literature and Codex implementation work,
independent review, a CLI, and Observe. Exact-task acceptance requires the
candidate and its generated support to pass the required checks. Independent
review remains a separate result. The [capability inventory](docs/parity.md)
maps this behavior to implementation and tests.
Unimplemented proposals live in [design ideas](docs/design-ideas.md).

## Run a campaign

Use Bun 1.4.2 or later on macOS or Linux, then install dependencies from the root
of the extracted source archive:

```sh
bun install --production --frozen-lockfile --ignore-scripts
```

Set `OPENAI_API_KEY` in your environment, or use a saved Pi login as described
below. The [example settings](examples/settings.json)
use public OpenAI with `gpt-6-astra` and `max` reasoning. They set `research: false`
for a closed-book elementary example: no external source retrieval or independent
Codex review. Explorer and Verifier still use the configured model. Keep credential
values outside task and settings files.

```sh
bun run xean doctor examples/settings.json
bun run xean init examples/task.json .xean/demo/campaign.sqlite examples/settings.json
bun run xean run .xean/demo/campaign.sqlite
bun run xean status .xean/demo/campaign.sqlite
```

`init` freezes the task and settings without model calls. `doctor` checks local
setup without testing a live provider or Codex login. `run` performs research.
Pausing retains inputs and worker outcomes. Resume makes a fresh decision over
that accumulated state and explicitly replaces any failed decision.
Campaign arguments accept explicit paths or names under `--campaign-dir`, which
defaults to `.xean` relative to the calling directory.

The same CLI provides `pause`, `resume`, `cancel`, `inspect [--records]`, and
accepted-only Markdown `export`. `submit`, `guide`, and `correct` take a file and
a stable `--id` for exact retries. Live mutations reach the active owner.
`role NAME INPUT CAMPAIGN SETTINGS` runs a standalone procedure, and
`review TASK ARGUMENT CAMPAIGN SETTINGS` records an independent review. Use
`--help` for arguments and owner, credential, and usage-attribution options.

[Settings](src/config.ts) use native Pi profiles for OpenAI, `openai-codex`,
Anthropic, and Google, with per-role overrides. Custom Responses gateways use
`openai` with `baseUrl` and an explicit `apiKeyEnv` or `--key-stdin` credential.
This keeps saved subscription credentials on their native provider route.
For a custom CA, set `NODE_EXTRA_CA_CERTS` to its PEM
certificate bundle.

For ChatGPT or Claude subscriptions, start the bundled Pi CLI with
`bun run pi`, enter `/login`, and select OpenAI or Anthropic. Set the Xean
profile's provider to `openai` or `anthropic` and choose a model available to that
account. Existing OpenAI Codex logins use `openai-codex` instead of `openai`.
Xean's CLI and `doctor` reuse Pi's `~/.pi/agent/auth.json`, including
native token refresh. `PI_CODING_AGENT_DIR` selects another Pi directory for both
commands. Explicit `apiKeyEnv` or `--key-stdin` credentials take precedence.
Login and logout remain Pi commands, and Xean model selection remains in its
settings file. Codex CLI login is separate. Library callers can pass authenticated
Pi `Models` to `open`.
The supplied instance owns all configured providers and is reused by native
conversations and replacement roles.

To enable the default Codex research backend, remove `research: false` and install
and authenticate the Codex CLI. Source checking and independent review use its
native configuration. Literature is disabled by default, but `literature: false`
alone leaves source checking and review enabled. External premises remain
INCONCLUSIVE when research is disabled. `settings.codex` separately enables
implementation work in a retained workspace.

For a one-response ChatGPT Web Explorer, set
`chatgpt: {"baseUrl":"http://127.0.0.1:17841/v1","model":"chatgpt-web/gpt-6-pro"}`
in settings. Xean calls the external `codex-chatgpt-web` service's non-streaming
Responses API and validates its JSON answer. Run that service separately in
`browser-only` mode. This Explorer receives the
note index and has no note reader or further browser attempt.

## Library

[The public entry point](src/index.ts) exports `open`, `inspect`, `createResearch`,
mathematical types, note projections, and reports. Construct the built-in solver
through `open`, which returns the native Harness, root Conversation, workflow,
and `close`. Coordinator returns one `work` request, or `work: null` to wait.
Replacement roles follow the same sequential outer loop. `open` accepts native Pi `models`, a `roles` callback that
receives the built-in functions, and a custom `Research` implementation through
`research`. Register custom tools and tasks through Pi's native `registry` option.

Notes store `summary`, `detailedSummary`, and authoritative free-form `text`.
The text can record proofs, conjectures, observations, questions, or failed
approaches. Correctness records a separate nullable `statement` for later
verification. Notes with no mathematical claim remain context and cannot
become verified support or an accepted solution.
The note reader includes the existing checked statement. Explorer and Verifier
use it to distinguish granted support from additional facts that need a proof
or a separate supporting lemma.

Explorer continues its Pi conversation after partial submissions. A claimed
complete solution, an empty submission, or reaching the response allowance ends
the invocation. Pi retains earlier private submissions and publishes the
accumulated notes when the worker returns.

Blind reconstruction assigns batches in dependency order. Code greedily packs
notes using original text lengths, Pi's token estimator, and the configured
model's context and output capacities. It reserves space for complete writing,
reasoning, structured results, and headroom. Comparisons use the actual returned
proof lengths and may need smaller batches. Each call must submit every assigned
note. These estimates guide grouping and do not cap responses or guarantee that
a proof fits. An oversized note is assigned alone, subject to Pi's input guard.
Pi checks context use and the provider guard reserves the full output allowance.
Token-truncated responses continue the same assignment within the
[response and continuation allowances](docs/parity.md#pi-integration).
Tools from truncated responses never execute.
Pi reuses committed proofs and comparisons after reopening, and an ordinary
failure retains earlier completed checks.
If an unresolved generated claim supports a later proof group, Verifier finishes
the current group's comparisons and returns its checks. Coordinator then decides
whether to retry, repair the mathematics, or continue other work. Further worker
admissions use the existing outer round allowance.

The [model-free example](examples/model-free.ts) supplies scripted roles and
prints the resulting campaign status without provider credentials. Its fixed
judgments demonstrate the workflow, not mathematical performance. From the
package root, give it a new database path:

```sh
bun examples/model-free.ts .xean/scripted/campaign.sqlite
```

```ts
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defaultSettings, inspect, open, readReport } from "xean";

const path = "campaign.sqlite";
const owner = await open(path, {
  create: {
    task: {
      problem: "For every real x >= 1, prove x squared >= x.",
      completionCriteria: "Give a self-contained elementary proof.",
    },
    settings: { ...defaultSettings, research: false },
  },
});
try {
  await owner.root.waitForIdle(context);
} finally {
  await owner.close();
}
console.log((await inspect(path, readReport)).status);
```

The host uses Pi's native SQLite adapter with FULL synchronization and excludes
a second owner. Notes resolve from Pi's committed submissions and task outcomes.
Imports and corrections are Pi entries. By default, `inspect` reads a consistent backup
through a Pi Session without recovering live work.
Closing suspends unfinished execution. Reopening reuses Pi's committed private
progress. A request interrupted before its answer commits may repeat, except
that an ambiguously sent ChatGPT Web request is rejected on recovery.
Completed source checks are memoized before later verification stages. Codex
executes inside its worker and may repeat if interrupted before that boundary
or worker completion. The built-in Verifier preserves structurally validated
completed checks when a stage fails. It publishes those checks with the error
in a failed native task outcome. Cancellation, invalid final publications, and
faults in opaque custom roles publish no partial checks. A new Verifier reuses
completed PASS checks and final source verdicts. Cleanup errors use Pi's nonfatal
reporting, preserving submitted results and the primary failure when a call fails.
Cancellation stops the Codex
process tree and may leave usage unknown. Implementation artifacts remain in
their workspace.

## Observation and experiments

Observe runs separately. Save a configuration file such as `observe.json` containing
`[{"id":"demo","database":".xean/demo/campaign.sqlite"}]`, with database paths
relative to that file, then run:

```sh
bun run observe observe.json
```

It listens on `127.0.0.1:8797` and serves `/api/runs` and `/api/runs/ID`, with `?view=status`
for compact reports. Run it on the campaign host and arrange remote access
yourself, for example with an SSH tunnel. Independent-review databases can be
listed as separate sources. The viewer shows note indexes, detailed summaries,
full notes, checks, dependencies, and usage.
Each refresh uses a fresh Pi Session on the live database, with no database copy.
Concurrent campaign updates can produce a temporarily inconsistent display.
CLI inspection and export retain consistent snapshots.

Usage reports count committed assistant responses and recorded Codex invocations.
They cannot establish every outbound request or provider retry. Direct ChatGPT
Web usage is unmeasured and excluded. Missing native usage remains unknown.
Process health, internal acceptance, and independent review are
separate observations.

`usagePrefix` supplies `XEAN_CODEX_USAGE_TAG` to Codex. A custom provider's native
configuration can forward it as an HTTP header for usage attribution.

[bounded-solve.ts](scripts/bounded-solve.ts) reads `task.json` and `settings.json`
from a run directory, with `--round-limit TOTAL`, `--resume`, and closed-book
`--offline` options. A round is a Coordinator decision that admits one worker,
including a Verifier. Empty waits and internal proof or comparison calls add
no rounds. The count derives from Pi's worker records and remains outside model
inputs. Response and usage counters remain observational.
[prompt-eval.ts](scripts/prompt-eval.ts) takes settings and a new output directory
to prepare frozen cases and commands without model calls.

## Checks and current limits

Install development dependencies to run checks and create a source archive:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run check:distribution
bun run pack
```

Start interface changes with focused contract tests and model behavior changes
with small standalone roles, using the CLI `role` command and frozen inputs.
Inspect their actual submissions before running a complete campaign smoke.
Use the golden problems after those checks pass.

`check` runs TypeScript, formatting, dependency integrity, and scripted tests.
`check:distribution` checks an unpacked source archive with production dependencies,
including the model-free workflow, CLI, local observation, browser assets, and licenses.
`pack` runs the same distribution check and writes the source archive under
`dist/`. The source-package smoke passed on Bun 1.4.2 for macOS ARM64 and Linux
ARM64 and x86-64 with only Bun on `PATH` and no provider credentials.

At revision `0e74fc7`, all six sequential golden campaigns reached internal
acceptance and independent PASS review, then reopened without credentials.
Standalone verification also reconstructed a dependency chain and rejected a
false claim. These runs used `gpt-6-astra` with `max` reasoning through codex-lb's
OpenAI `/v1` route and SSE. They qualify that gateway configuration, not public
OpenAI or Pi's subscription `openai-codex` transport. Source checking recorded
web activity without a directly observed source-open operation. Receipts and the
golden report are in `runs/golden-sequential-20261006-r04/`.

Release checks at `e40b85e` passed installed CLI use of a saved Pi OpenAI Codex
login, note reading, complete verification, and credential-free reopening with
`openai-codex/gpt-5.6-luna` at `max` reasoning. Gateway checks reconstructed a valid
proof chain, rejected invalid arguments, and left a claimless note INCONCLUSIVE.
Process tests covered live controls, writer exclusion, interrupted private work,
completed-result recovery, and dependency-complete export.

Public OpenAI, the new direct OpenAI subscription login, fresh login, OAuth
refresh, Anthropic, and Google remain unqualified live. Available credentials
covered only the gateway and existing OpenAI Codex login. The latest ChatGPT Web
test failed with `model_version_unavailable` before the service sent the message.
Xean made no second browser request and reopened the failed campaign unchanged.
Successful current-build ChatGPT Web generation and live cancellation remain
unqualified. Literature and implementation-worker qualification is pending.
Receipts are under `runs/release-3.0.0-qualification-20261008/`, outside the source
package.

Pi packages are built together from upstream commit
`f10993bc7f28145df1375f3ff39c7f5c4cfc05f0` using Pi's `pack:packages` command.
This commit follows the 1.0.4 release. The packages include frozen model data.
Artifact and patch hashes are recorded in [provenance](vendor/pi/provenance.json).
[Pi integration](docs/parity.md#pi-integration) records the adapter fixes and
the Pi Durable request hook used to select a profile's stream.
This is an [MIT-licensed](LICENSE) source package. Historical Yean and
Xean campaigns retain their original runtimes and readers.
