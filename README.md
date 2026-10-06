# Xean Pi prototype

A mathematical research workflow built on Pi Durable. Explorer develops
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

Use Fleet's locked Bun from the adjacent Fleet Infra checkout. The example
settings select `gpt-6-astra` with `max` reasoning and read `OPENAI_API_KEY` from
the environment. Keep credential values outside task and settings files.

```sh
cd ../fleet-infra
bin/fleet-nix run .#fleet-run -- install --cwd ../xean-pi-prototype --frozen-lockfile --ignore-scripts
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/apps/cli/index.ts doctor ../xean-pi-prototype/examples/settings.json
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/apps/cli/index.ts init ../xean-pi-prototype/examples/task.json ../xean-pi-prototype/.xean/demo/campaign.sqlite ../xean-pi-prototype/examples/settings.json
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/apps/cli/index.ts run ../xean-pi-prototype/.xean/demo/campaign.sqlite
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/apps/cli/index.ts status ../xean-pi-prototype/.xean/demo/campaign.sqlite
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

[Settings](src/config.ts) support per-role OpenAI, Codex, Anthropic, and Google
profiles. Literature is
disabled by default. Custom Responses gateways use `openai` with `baseUrl`.
`openai-codex` uses Pi's native subscription authentication and transport.
Codex source checking and review use native Codex
configuration. `settings.codex` enables implementation work in a retained
workspace. [Example inputs](examples/task.json) and [settings](examples/settings.json)
show the minimum solver configuration.

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

Blind reconstruction lets the prover choose how many pending notes to prove
together, in dependency order. The comparer can likewise submit a smaller group
of complete judgments. Further native conversations handle the remaining notes.
There are no separate planning calls or fixed note counts. Prompts ask the
models to allow for input, reasoning, complete written output, and structure.
Pi estimates context use and the provider guard reserves the model's full output
allowance. Inputs that leave insufficient space are rejected. Token-truncated
responses continue the same assignment within the
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
judgments demonstrate the workflow, not mathematical performance. From Fleet
Infra, give it a new database path:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/examples/model-free.ts ../xean-pi-prototype/.xean/scripted/campaign.sqlite
```

```ts
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defaultSettings, inspect, open, readReport } from "xean-pi-prototype";

const path = "campaign.sqlite";
const owner = await open(path, {
  create: {
    task: {
      problem: "For every real x >= 1, prove x squared >= x.",
      completionCriteria: "Give a self-contained elementary proof.",
    },
    settings: defaultSettings,
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

Observe runs separately through [apps/observe/server.ts](apps/observe/server.ts).
Its configuration is an array such as
`[{"id":"demo","database":"/absolute/path/to/campaign.sqlite"}]`. It listens on
`127.0.0.1:8797` and serves `/api/runs` and `/api/runs/ID`, with `?view=status`
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

`usagePrefix` supplies `XEAN_CODEX_USAGE_TAG` to Codex. Its native provider
configuration must forward that environment variable. For a provider named
`gateway` using codex-lb:

```toml
[model_providers.gateway.env_http_headers]
X-Codex-LB-Usage-Tag = "XEAN_CODEX_USAGE_TAG"

[model_providers.gateway.http_headers]
X-Codex-LB-Required-Capability = "usage_tag_v1"
```

[bounded-solve.ts](scripts/bounded-solve.ts) reads `task.json` and `settings.json`
from a run directory, with `--round-limit TOTAL`, `--resume`, and closed-book
`--offline` options. A round is a Coordinator decision that admits one worker,
including a Verifier. Empty waits and internal proof or comparison calls add
no rounds. The count derives from Pi's worker records and remains outside model
inputs. Response and usage counters remain observational.
[prompt-eval.ts](scripts/prompt-eval.ts) takes settings and a new output directory
to prepare frozen cases and commands without model calls.

## Checks and current limits

From Fleet Infra, run the socket-free checks and the source distribution check:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/scripts/dev.ts check
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/scripts/dev.ts distribution
```

Start interface changes with focused contract tests and model behavior changes
with small standalone roles, using the CLI `role` command and frozen inputs.
Inspect their actual submissions before running a complete campaign smoke.
Use the golden problems after those checks pass.

`check` runs TypeScript, formatting, dependency integrity, and scripted tests.
`distribution` checks an unpacked source archive with production dependencies,
including the model-free workflow, CLI, local observation, browser assets, and licenses.
A clean production installation passed on locked Bun 1.4.2, `darwin-arm64`.

Earlier local live smokes used `gpt-5.6-luna` with `max` reasoning. These receipts
predate the latest fixes. Pi Explorer committed
one response through codex-lb RelayAPI and reopened without credentials with an
identical report. Gateway tag and token counts matched. A separate native Codex
review returned PASS in one invocation with no external premises. Its provider
did not forward the usage tag, so that mapping remains unqualified. Local receipts are
`runs/live-2026-10-04T10-13-25-409Z/{live,review,gateway-usage}.json`, outside the
source package.

The later golden smoke completed a solve, source check, independent PASS review,
and credential-free reopening. Its source quotations and exact theorem were
checked separately. Native Codex events confirmed web activity but did not
identify a direct source-open operation. The receipt is
`runs/smoke-golden-20261004-r03/qualification.json`.

The Pi 1.0.4 smoke at revision `489d517` recorded internal acceptance, an
independent PASS review, and credential-free reopening. Its receipt is
`runs/golden-upgraded-20261006-r02/smoke-receipt.json`. The current sequential
outer loop was added after this smoke and remains unqualified live. The ChatGPT
Web, Anthropic, and Google paths also remain unqualified live.

Pi 1.0.4 uses the official compiled release packages, pinned together to
`7c10bd4337495ee613f2224843ecdf349b80d1df`. The packages include frozen model data.
Artifact and patch hashes are recorded in [provenance](vendor/pi/provenance.json).
[Pi integration](docs/parity.md#pi-integration) records the adapter fixes and
the Pi Durable request hook used to select a profile's stream.
This is a private [MIT-licensed](LICENSE) source package. Historical Yean and
Xean campaigns retain their original runtimes and readers.
