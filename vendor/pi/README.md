# Pi artifacts

Xean consumes the packages listed in [provenance.json](provenance.json)
from Pi commit `cd32f7725fdbddbaecdff5b1e68491563394e0ca`.
The tarballs contain upstream build output. The root
catalog selects them, and dependency overrides apply the same selections to
Pi's internal dependencies. Their upstream package version is `1.0.2`.
The commit and artifact hashes identify this build.

Normal installation uses Xean's existing locked Bun command, documented in the
[root README](../../README.md). Bun installs the artifacts selected by the
lockfile and applies the retained Pi AI and durable patches.
The install receipt also fingerprints
the local tarball bytes, workspace manifests, lockfile, and patch bytes.

## Rebuilding

Check out the exact upstream commit and use its `package-lock.json` with
`npm ci --ignore-scripts --no-audit --no-fund`. The upstream Node/npm build is
an explicit external-package exception to the Fleet Bun policy: Pi's official
workspace scripts, compiler, and npm lock define this build contract. Xean's
installation, orchestration, and tests continue to use Fleet's locked Bun.
The Node/npm versions used for these artifacts are recorded in the provenance.

Pi's model values are a second build input. They were hydrated once with the
upstream `npm run hydrate:model-data` command and are frozen in the AI tarball
under `package/dist/providers/data/`. This upgrade preserves the previous pin's
frozen catalog. To rebuild, extract that directory,
including `.manifest.json`, into the checkout's `packages/ai/src/providers/data/`.
Check the manifest SHA-256 against the provenance. Rehydrating queries live
catalogs and creates a new snapshot.

Run the upstream builds in this order from the Pi checkout:

```sh
npm --prefix packages/chord run build
npm --prefix packages/telemetry run build
npm --prefix packages/ai run build:offline
npm --prefix packages/durable run build
```

In each package directory, run
`npm pack --ignore-scripts --pack-destination <absolute-output-directory>`.
Compare the resulting SHA-256 values with `provenance.json`.
The recorded hashes matched across two builds, each starting with empty package
output directories and the same frozen model data.
The tarballs retain the upstream manifests, exports, documentation, and source
maps. The checkout, build dependencies, and expanded generated files stay outside
the committed artifact set.

## Patch maintenance

The tarballs contain unpatched upstream output. Xean's patches live
in `patches/` and are applied during Bun installation. Each key in
`patchedDependencies` uses the exact tarball resolution, without the `file:`
prefix. A version-only key does not match these local artifacts.

The AI patch retains measured usage on failed and zero-token
responses, custom Codex authentication and credential-specific connection
identity, deferred body serialization, session debug cleanup, and JSON repair
allocation reduction. Retry listener cleanup covers both the Codex transport
and `retryAssistantCall` backoffs. The assistant retry classifier also treats
authentication, invalid-request, and explicit context-limit errors as terminal
when their detail contains transient-looking text.
Codex, OpenAI Responses, Anthropic, and Google failures retain structured status, type, and code for the same native
retry classifier. This permits bounded recovery for new server-error codes and
activates the existing HTTP fallback after transient typed WebSocket failures.
Quota and billing exhaustion remain terminal, including HTTP 429 responses.
The Codex SSE parser accepts CRLF framing, including split network chunks.
The deferred request-body serialization and JSON repair allocation changes are
performance patches. The remaining AI changes preserve transport and accounting
behavior. None has an upstream replacement in this revision.
Related upstream reports are [#7444](https://github.com/earendil-works/pi/issues/7444)
for WebSocket recovery and [#9702](https://github.com/earendil-works/pi/issues/9702)
for preserving structured failure metadata.
When updating Pi or a patch, review each change and adjust hunks where needed.
Compare every installed patched file with a separately extracted tarball after
applying the patch with `git apply`.
A patch accepted by Bun alone does not verify correct placement.

The Pi durable patch adds `SqliteStorage.open(db, {readOnly: true})`. It checks
the existing schema instead of running migrations, and rejects `commit` and
`mintId`. All record decoding, document reconstruction, and scans remain native.
Xean supplies the read-only SQLite connection and its snapshot transaction.
The Harness extensions add transactional admission, recovery, and failure hooks,
plus pause and quiescence controls. Harness owns dispatch, invocation cancellation,
joining, and private conversation recovery. Xean uses the hooks for campaign policy and
atomic failure signals, and keeps Session accounting writable until interrupted
invocations settle. The patch also exposes native `Tx.setTask()` and preserves
explicit entry `byTaskId` outside a Harness invocation. Task creation uses the
registered executable definitions and the unmodified native API.
These are local extensions, not upstream guarantees. The
[alignment notes](../../docs/pi-alignment.md#durable-integration) record their
contracts and removal criteria. Unpatched artifacts remain reproducible;
the patch separately identifies the code executed by Xean.
