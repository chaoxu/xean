# Xean

Xean coordinates durable mathematical work over Pi. The kernel handles campaign
scheduling, atomic publication, limits, and recovery. The solver adds notes,
exploration, verification, and exact-task acceptance. Pi supplies model and tool
execution, storage records, and atomic batches. Chord supplies invocation context
and prepared state changes.

The library lives in `packages/core`. The separate `xean-cli` package in
`packages/cli` exposes campaign operations through public library APIs.
The [observer](packages/observe/README.md) in `packages/observe` reads local
campaigns through the read-only API and displays exported remote snapshots.

- [Philosophy](docs/philosophy.md): mathematical autonomy, shared memory, trust, and evaluation.
- [Kernel contract](docs/kernel.md): execution, publication, limits, and storage.
- [Solver guide](docs/solver.md): roles, verification, CLI commands, and configuration.
- [Glossary](docs/glossary.md): canonical terminology.
- [Pi alignment](docs/pi-alignment.md): native APIs and deferred adoption.
- [Verification](docs/kernel-smoke.md): checks and provider smoke procedures.
- [Editor experiment](experiments/editor/README.md): fixed small dataset and controlled prompt and model comparisons.
- [Changelog](CHANGELOG.md): release changes and compatibility.
- [Contributor rules](AGENTS.md): design priorities and repository boundaries.

Matching Pi packages are pinned to one tested main commit in `package.json`.
The [artifact record](vendor/pi/provenance.json) records that source revision,
build, frozen model data, and hashes. Numbered releases are the stable
distribution. The `main` branch targets 3.0.0 and requires new campaigns for
its three-view note format. Version 2.0.0 remains the current stable release.

## Install and run

Use Bun 1.4.2 on Linux or macOS. Stable users should download and unpack a
source archive from [Releases](https://github.com/chaoxu/xean/releases), then run
`bun run setup` in that directory. The archive includes the library, CLI,
observer, pinned Pi packages, and patches. Individual workspace packages are
private and are not installed from npm.

For a development checkout:

```sh
git clone https://github.com/chaoxu/xean.git
cd xean
bun run setup
bun run xean --help
```

`setup` installs the frozen dependency lockfile without lifecycle scripts and
records the exact installation. Run it again after changing the checkout or Bun
runtime. `bun run xean --version` reports the distribution version.
Keep the release or source commit, lockfile, and runtime version with each
campaign. Historical campaigns require their original runtime, including 2.0.0
campaigns opened after the development note-format change.

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
configuration. Provider credentials stay outside task and settings files.

```sh
bun run xean init examples/tree-task.json tree examples/solver-settings.json
bun run xean run tree
bun run xean status tree
bun run xean export tree
```

Campaigns live under `.xean/` by default. Only `campaign.status: "completed"`
establishes an accepted argument. `export` requires that accepted result.
See the [solver guide](docs/solver.md#running) for live guidance, pause/resume,
cancellation, explicit database paths, and other model providers.

For supervised deployment, run `bun run xean run /data/campaign.sqlite` with a
persistent writable data directory and the provider's credentials. Use one
owner process per campaign. `SIGINT` and `SIGTERM` close the owner and retain
committed work for recovery. The command prints the campaign state when it
finishes, including paused, blocked, or waiting states. Inspect that state before
deciding whether a supervisor should restart it.

The [MIT license](LICENSE) covers Xean. Bundled dependencies retain their own
licenses.

## Releases

Stable releases use semantic versions and immutable `vMAJOR.MINOR.PATCH` tags.
Patch releases fix defects. Minor releases add compatible behavior. Breaking
public APIs, CLI contracts, or persisted campaign formats require a major release.
Run ongoing campaigns with their original release and frozen settings.

To prepare a release:

1. Set the root and workspace package versions, update `bun.lock` with a clean
   install, and describe changes and compatibility in [CHANGELOG.md](CHANGELOG.md).
2. Run the development check below. It checks types, formatting, tests, matching
   versions, bundled dependency hashes, and local documentation links.
3. Verify a clean source archive on Linux and macOS: run setup, check, CLI help
   and version, the deterministic example twice, and the README's initialization
   and status commands. Check the observer in a browser. Exercise affected model
   providers using the [smoke procedure](docs/kernel-smoke.md#live-provider-checks).
4. Commit the verified source, create the version tag, and publish its source
   archive, SHA-256 checksum, and release notes on GitHub. Record the tested Bun
   version, platforms, smoke results, and any provider limitations. Tagging and
   publication are separate from preparing the candidate.

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
```

`install` requires the existing lockfile, performs a clean frozen installation,
and skips lifecycle scripts. After an intentional dependency edit, use
`install --update-lockfile`. An installation receipt rejects changed dependency
inputs until a clean reinstall. `check` runs typechecking, formatting, distribution checks, and tests
inside a socket-free Nix build. `format` formats project sources and documentation.

Use the same locked runtime for local CLI work:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts --help
```

Closed-book experiments use the
[bounded runner](docs/solver.md#closed-book-experiments).

The [deterministic kernel example](examples/deterministic.ts) makes no model calls:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/examples/deterministic.ts
```

It runs two workers concurrently and accepts their sum of squares, writing
`runs/deterministic.sqlite`. Repeating it reopens the committed result.
Pass another database path to start fresh. `run()` can return while waiting for
input, so only `status: "completed"` establishes accepted completion.

## Live kernel smoke

On `saturn`, run from Fleet Infra:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/scripts/codex-lb-smoke.ts codex-lb/xean
```

The launcher verifies dependencies, reads the gateway key from OpenBao into
memory, and passes it over stdin with the provisioned lab CA. Two concurrent
Luna workers use max reasoning and Pi's cached WebSocket agent loop. The smoke
checks results, usage, connection reuse, delta requests, and unchanged reopening
in a second process without credentials.

Campaigns and records remain under ignored `runs/`. Successful execution prints
`completed` for both phases. JSON snapshots can also exist after assertion
failure, so their presence alone does not establish success.
See [kernel verification](docs/kernel-smoke.md) for observed results and
[solver verification](docs/solver.md#current-verification) for role checks.
