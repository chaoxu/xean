# Xean

Xean coordinates durable mathematical work over Pi. The kernel handles campaign
admission, atomic publication, operational limits, and recovery policy. Model-call
counts and token or cost usage are retained as observations; they never stop a
campaign. An outer experiment runner may impose an explicit round limit. The
solver adds notes,
exploration, verification, and exact-task acceptance. Pi supplies model and tool
execution, private conversation recovery, task dispatch, storage records, and
atomic batches. Built-in model roles retain completed reads and submissions
across restarts, while shared notes publish only with a complete worker result. Chord supplies
invocation context and prepared state changes. Harness execution uses the
local controls documented in [Pi alignment](docs/pi-alignment.md#durable-integration).

The repository contains a core library and two optional applications:

| Package        | Location           | Responsibility                                                        |
| -------------- | ------------------ | --------------------------------------------------------------------- |
| `xean`         | `packages/core`    | Kernel, mathematical solver, providers, and shared inspection reports |
| `xean-cli`     | `packages/cli`     | Command parsing, terminal output, and live owner control              |
| `xean-observe` | `packages/observe` | Read-only dashboard, snapshot publisher, and bundled theme assets     |

Both applications depend on core's public APIs. Core depends on neither app,
and the apps do not depend on each other. Library callers can use `xean`,
`xean/solve`, `xean/pi`, and `xean/report` directly. Shared status projection
belongs to `xean/report`; command transport and presentation belong to the apps.
Repository checks enforce these dependency directions and public imports.

The CLI runs only when invoked. The [observer](packages/observe/README.md) runs
as a separate process and reads local campaigns or exported snapshots. Its
dashboard, publisher, HTML, CSS, and shared theme form one app. Solver execution
does not start or wait for it. The source archive and development setup include
all three packages, with one dependency lock and aligned package versions.

- [Philosophy](docs/philosophy.md): mathematical autonomy, shared memory, trust, and evaluation.
- [Kernel contract](docs/kernel.md): execution, publication, limits, and storage.
- [Solver guide](docs/solver.md): roles, verification, CLI commands, and configuration.
- [Glossary](docs/glossary.md): canonical terminology.
- [Pi alignment](docs/pi-alignment.md): native APIs and deferred adoption.
- [Verification](docs/kernel-smoke.md): checks and provider smoke procedures.
- [Changelog](CHANGELOG.md): changes and compatibility.
- [Contributor rules](AGENTS.md): design priorities and repository boundaries.

Matching Pi packages are pinned to one exact source commit in `package.json`.
The [artifact record](vendor/pi/provenance.json) records that source revision,
build, frozen model data, and hashes. The `main` branch contains the unreleased
3.0 candidate. New campaigns use campaign format 12 and solver declaration
version 14. Observer snapshots use `xean-observe/v4`. Historical campaigns require
their original source revision and runtime, and historical snapshots require
their matching observer. No migration is provided. Existing releases and tags
remain historical archives.

## Install and run

Use Bun 1.4.2 on Linux or macOS. Use the complete prepared source archive or clone
`main` and install its locked dependencies. The distribution includes the library,
CLI, observer, pinned Pi packages, patches, and dependency lockfile.
Individual workspace packages are private and are not installed from npm.

```sh
git clone --branch main https://github.com/chaoxu/xean.git
cd xean
bun run setup
bun run xean --help
```

`setup` installs the frozen dependency lockfile without lifecycle scripts and
records the installation's dependency inputs, Bun version, operating system,
and architecture. Run it again after changing those inputs or copying a checkout
to another platform. `bun run xean --version` reports the package version.
Keep the exact source commit, lockfile, and runtime version with each campaign.
Package versions alone do not identify a `main` revision.
After updating the checkout, start new campaigns with the new runtime. Continue
existing campaigns from their original checkout and settings.

Check the installation without credentials or model calls:

```sh
bun run check
bun examples/deterministic.ts
```

The deterministic example returns `{"status":"completed","result":25}`.
Repeating it reopens the same committed result.

The [example settings](examples/solver-settings.json) use the public OpenAI API
with `gpt-6-astra` at max reasoning. Supply `OPENAI_API_KEY` through your shell
or secret manager. Source checking and independent review use the separately
installed Codex CLI, authenticated with `codex login` or its native provider
configuration. [Claude settings](examples/claude-settings.json) use Pi's native
Anthropic provider with an operator-supplied subscription OAuth token in
`ANTHROPIC_OAUTH_TOKEN`. The [provider guide](docs/solver.md#configuration-and-functions)
also covers mixed providers and Anthropic API credentials. Provider credentials
stay outside task and settings files.

The optional [Codex worker](docs/solver.md#codex-worker) implements assignments
with native shell and file tools in a retained workspace. Enable it through
`settings.codex`. Its findings enter the ordinary note verification process.

ChatGPT Web uses a separately managed browser service. Supply its endpoint and
optional service credential through the [solver settings](docs/solver.md#configuration-and-functions).
Xean owns the Pi adapter and research workflow. The service operator owns browser
login, installation, patches, and process management.

```sh
bun run xean doctor examples/solver-settings.json
bun run xean init examples/tree-task.json tree examples/solver-settings.json
bun run xean run tree
bun run xean status tree
bun run xean export tree
```

`doctor` checks the local installation, settings, credential availability, and Codex
executables without making model calls. It returns `{ok,message}` as JSON and
stops at the first setup problem. It does not validate credentials with a provider
or check browser sessions and Codex login.

For your own problem, copy [the task file](examples/tree-task.json) and replace
its `problem` and `completionCriteria`. State the exact hypotheses, desired
conclusion, and permitted background. Copy the settings file to choose your
provider, model, and credential environment-variable names, then pass those
files to `init`. Initialization freezes both files without making model calls.
Editing them afterward does not change that campaign. `run` performs the model
work, `status` inspects it, and `export` prints an accepted argument with its
supporting proofs.

Campaigns live under `.xean/` by default. A solver campaign accepts an argument
only when its status is `completed`. `export` requires that accepted result.
See the [solver guide](docs/solver.md#running) for live guidance, pause/resume,
cancellation, explicit database paths, and other model providers.

To view this example in the optional observer, save `observe.json` beside the
repository's README with:

```json
[{ "id": "tree", "directory": ".xean/tree" }]
```

Run `bun packages/observe/src/server.ts observe.json` and open
<http://127.0.0.1:8797>. The dashboard reads the campaign without running models
or acquiring solver ownership. See [Observe's guide](packages/observe/README.md)
for remote runs and snapshot publishing.

For a status request, use the campaign's matching source checkout and runtime:

```sh
bun run xean status /absolute/run-directory/campaign.sqlite
```

This reads committed state without model calls or recovery. The compact report
omits proofs and transcripts. See [checking status](docs/solver.md#checking-status)
for frozen and remote runs, verification progress, and observation freshness.
Agents should start with `status`. Branch on its committed campaign state,
verification fields, and bounded work summaries; treat `nextAction` as advisory
text rather than a scheduler instruction. Use `pause`, `resume`, or `cancel` as
explicit lifecycle controls, then read `status` again to confirm the committed
state. Call and usage totals are observational and cannot block a new campaign or
continue one. Use `inspect` for notes, `inspect --records` for execution records,
and `export` for the accepted proof only when those details are needed. Commands emit JSON
except `export`, which emits Markdown, and help/version output. Xean Lab handles
discovery and submission across supervised experiments in its separate repository.

For supervised deployment, run `bun run xean run /data/campaign.sqlite` with a
persistent writable data directory and the provider's credentials. Use one
owner process per campaign. `SIGINT` and `SIGTERM` close the owner and retain
committed work for recovery. A normal return prints the campaign state, including
paused, blocked, or waiting states, as a compact receipt with `status`, `error`,
`providerCalls`, and `pendingSignals`. An interrupted command prints no final JSON.
Use `status` afterward to inspect committed state before deciding whether a
supervisor should restart it.

The [MIT license](LICENSE) covers Xean. Bundled dependencies retain their own
licenses.

## Distribution

The prepared 3.0.0 candidate uses aligned package versions. Its
[verification record](docs/kernel-smoke.md) identifies the tested platforms,
provider paths, and limitations. Retain the exact source commit, dependency
lockfile, and Bun version. Run ongoing campaigns with their original source
revision and frozen settings. Existing releases and tags remain historical archives.

Before distributing a source revision:

1. Describe changes and compatibility in [CHANGELOG.md](CHANGELOG.md). Keep root
   and workspace package versions aligned and install the frozen lockfile cleanly.
2. Run the development check below. It checks types, formatting, tests, matching
   versions, bundled dependency hashes, and local documentation links.
3. Verify a clean source archive on Linux and macOS: run setup, check, CLI help
   and version, the deterministic example twice, and the README's initialization
   and status commands. Check the observer in a browser. Exercise affected model
   providers using the [smoke procedure](docs/kernel-smoke.md#live-provider-checks).
4. Record the exact source commit, tested Bun version, platforms, smoke results,
   and any provider limitations. When sharing a source archive, include its
   SHA-256 checksum.

The [historical comparison](docs/xean-comparison.md) describes the implementation
replaced by 2.0.0. Earlier tags and campaign artifacts retain their original names
and formats.

## Development on Fleet

Run from the adjacent Fleet Infra checkout. Its `flake.lock` is the Bun runtime
authority, while Xean's `bun.lock` locks JavaScript dependencies.

```sh
cd ~/playground/fleet-infra
bin/fleet-nix run .#fleet-run -- ../xean/scripts/dev.ts install
bin/fleet-nix run .#fleet-run -- ../xean/scripts/dev.ts check
bin/fleet-nix run .#fleet-run -- ../xean/scripts/dev.ts test tests/observe.test.ts tests/report.test.ts
```

`install` requires the existing lockfile, performs a clean frozen installation,
and skips lifecycle scripts. After an intentional dependency edit, use
`install --update-lockfile`. An installation receipt rejects changed dependency
inputs until a clean reinstall. `check` runs typechecking, formatting, distribution checks, and tests
inside a socket-free Nix build. `format` formats project sources and documentation.
`test` runs only the named test files in that same sandbox. Pass existing files
under `tests/`. Set `XEAN_FLEET_INFRA` when Fleet Infra is elsewhere.

Use the same locked runtime for local CLI work:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts --help
```

Closed-book experiments use the
[bounded runner](docs/solver.md#closed-book-experiments).
Correctness-prompt changes can use the
[screen on frozen cases](docs/solver.md#current-verification), which prepares
inputs and commands for the existing Verifier CLI without making model calls.

The [deterministic kernel example](examples/deterministic.ts) makes no model calls:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/examples/deterministic.ts
```

It runs two workers concurrently and accepts their sum of squares, writing
`runs/deterministic.sqlite`. Repeating it reopens the committed result.
Pass another database path to start fresh. `run()` can return while waiting for
input, so only `status: "completed"` establishes accepted completion.
