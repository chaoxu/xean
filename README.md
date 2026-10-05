# Xean Pi prototype

A mathematical research workflow built on Pi Durable. Explorer develops
notes, Verifier checks their claims and dependencies, and Coordinator chooses
further work. Each input or worker outcome starts a fresh Coordinator decision
while independent workers continue. Pi owns tasks, conversations, checkpoints,
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
and `close`. Its options accept native Pi `models`, a `roles` callback that
receives the built-in functions, and a custom `Research` implementation through
`research`. Register custom tools and tasks through Pi's native `registry` option.

Notes store an authoritative `statement` and `argument` alongside the index and
detailed summaries. `renderNote` combines the statement and argument for full
reads, Observe, and export. The index, detailed summary, and full note remain
separate reading levels.

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
or worker completion. A model or Codex execution failure can publish fully
completed verification checks with the failure in the same native task outcome.
A new Verifier reuses completed PASS checks and final source verdicts. Faults
and cancellation do not publish partial checks. Cancellation stops the Codex
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
`--offline` options. A round is a Coordinator decision that commits new workers,
including verification. Empty waits consume no rounds. The count derives from
Pi's worker records and remains outside model inputs.
[prompt-eval.ts](scripts/prompt-eval.ts) takes settings and a new output directory
to prepare frozen cases and commands without model calls.

## Checks and current limits

From Fleet Infra, run the socket-free checks and the source distribution check:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/scripts/dev.ts check
bin/fleet-nix run .#fleet-run -- ../xean-pi-prototype/scripts/dev.ts distribution
```

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
`runs/smoke-golden-20261004-r03/qualification.json`. This predates the Observe
and direct ChatGPT simplification, the current note format, and the verification
changes. ChatGPT Web, Anthropic, and Google remain unqualified live. The prototype
has not been deployed.

Matching Pi packages are pinned to `b2b5c42f6138b73ec4b2f49ec0ca468800f88586`
with artifact and patch hashes in [provenance](vendor/pi/provenance.json).
[Pi integration](docs/parity.md#pi-integration) records the adapter fixes and
the Pi Durable request hook used to select a profile's stream.
This is a private [MIT-licensed](LICENSE) source package. Historical Yean and
Xean campaigns retain their original runtimes and readers.
