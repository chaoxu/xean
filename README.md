# Xean

Xean runs a mathematical research workflow on Pi Durable. Explorer develops
notes, Verifier checks their claims and dependencies, and Coordinator chooses
further work. Each campaign runs Coordinator, one worker, then Coordinator again.
A worker may parallelize its own internal work. Pi owns tasks, conversations,
checkpoints, cancellation, and storage.

Use fresh campaigns with this release. Keep existing campaigns with their frozen
runtimes. Pi document versioning rejects 3.0.0 databases. The qualification results
below identify the revisions and provider configurations tested.

The implementation includes staged verification, blind reconstruction, imported
notes, stable-ID edits, optional literature and Codex implementation work,
independent review, and a CLI. Exact-task acceptance requires the
candidate and its generated support to pass the required checks. Independent
review remains a separate result. The [capability inventory](docs/parity.md)
maps this behavior to implementation and tests.
See the [changelog](docs/changelog.md) for changes since 3.0.0.
Unimplemented proposals live in [design ideas](docs/design-ideas.md).

## Principles

Models choose mathematical strategy. Xean preserves the exact task, declared
dependencies, and evidence needed to check a result. Notes carry shared memory
through an index, detailed summaries, and full text, including failed approaches.
Pi supplies durable execution and storage. Xean keeps research policy in a small
layer over Pi's native APIs.

Xean assumes a trusted operator and trusted application, dependency, replacement,
and generated code. Isolation from malicious code or users is outside Xean's scope.
Validation addresses model mistakes, invalid outputs, stale revisions,
interrupted operations, and accidental concurrent ownership. Mathematical
claims still require verification.

The native Pi Explorer continues within the same conversation so later responses can develop
and revise earlier reasoning. Private partial notes preserve intermediate work
while exploration continues. A later worker starts a fresh conversation from the
published notebook, without automatically inheriting the earlier worker's private
conversation. Prompt caching can reduce the cost of reusing prior
context, but new reasoning and output still cost tokens, so continuation is
bounded. Worker simplifications should preserve this opportunity for further
exploration. A valid partial submission alone does not establish that the worker
has explored enough.

Acceptance requires checks across the complete generated dependency chain.
Blind reconstruction receives exact statements and approved premises without
the original proofs. INCONCLUSIVE remains unresolved. Model judgments can be
wrong, and independent review is recorded separately from internal acceptance.

Explorer repairs notes through `edits`, retaining their IDs. Each edit supplies
the expected `revision` and only changed fields. A worker publishes its creations
and edits atomically. Retiring a note hides it from routine discovery and preserves
historical reads. Existing consumers can still verify their retired dependencies.
Caller corrections preserve an existing import grant. Explorer edits to its
mathematical text or support revoke that grant. Mathematical edits clear affected
checks. Explorer and caller edits may mark presentation-only text changes with
`cosmetic: true`. Xean trusts that classification and preserves checks and import
trust. Support changes always invalidate affected checks. Unclassified text
changes are mathematical edits.
Verifier may correct summaries on PASS, while proof text and dependencies change
through edits.

Completed assessments of unchanged inputs stay closed. Coordinator chooses
mathematical repairs, relevant source retrieval, another approach, or idle.
New quotations matching a note's exact premises can reopen an eligible
INCONCLUSIVE source check. Changing receipt IDs, making cosmetic text edits, or
adding unrelated quotations does not reopen it.

## Run a campaign

Install [Bun](https://bun.sh/docs/installation) 1.4.2 or later on macOS or Linux.
Run these commands from the source root:

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

`init` freezes the task and settings without model calls. `doctor` checks local setup without testing a live provider or Codex login. `run` performs research.
Read the returned JSON status: a successful CLI exit can report `blocked` or
`idle`. Returning `work: null` leaves a campaign idle without claiming completion.
Add guidance or use `resume` to request another decision.
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
and authenticate the [Codex CLI](https://developers.openai.com/codex/cli).
Source checking and independent review use its native configuration. Literature is disabled by default, but `literature: false`
alone leaves source checking and review enabled. External premises remain
INCONCLUSIVE when research is disabled. `settings.codex` separately enables
implementation work in a retained workspace.

For a one-response ChatGPT Web Explorer, set
`chatgpt: {"baseUrl":"http://127.0.0.1:17841/v1","model":"chatgpt-web/gpt-6-pro"}`
in settings. Xean calls the external
[`codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) service's
non-streaming Responses API and validates its JSON answer. Run that service
separately in `browser-only` mode with its authenticated browser available.
The bridge must preserve the original JSON answer text and support ChatGPT's
current model picker. A `model_version_unavailable` error means the bridge
could not confirm the requested model and left the prompt unsent. Repair the
bridge before starting a fresh campaign. This Explorer receives the note index
and has no note reader or further browser attempt. It can create new notes. Edits
to existing notes require the native Pi Explorer or a caller correction.

## Library

[The public entry point](src/index.ts) exports `open`, `inspect`, `createResearch`,
mathematical types, note projections, and reports. Construct the built-in solver
through `open`, which returns the native Harness, root Conversation, workflow,
and `close`. Coordinator returns one `work` request, or `work: null` to become idle.
Replacement roles follow the same sequential outer loop. `open` accepts native Pi `models`, a `roles` callback that
receives the built-in functions, and a custom `Research` implementation through
`research`. Register custom tools and tasks through Pi's native `registry` option.
Call `open` for separate databases to run several campaigns in one process.
Pass the same Pi `models` instance to share its provider registry. Each campaign
keeps its own Harness and sequential workflow. The CLI runs one campaign per invocation.

Notes store `summary`, `detailedSummary`, and authoritative free-form `text`.
The text can record proofs, conjectures, observations, questions, or failed
approaches. Correctness records a separate nullable `statement` for later
verification. Notes with no mathematical claim remain context and cannot
become verified support or an accepted solution.
The note reader includes the existing checked statement. Explorer and Verifier
use it to distinguish granted support from additional facts that need a proof
or a separate supporting lemma.

Explorer continues its Pi conversation after partial submissions. A claimed
complete solution, an empty notes-and-edits submission, or reaching the response
allowance ends the invocation. Repeated private edits merge changed fields against
the same expected public revision. Pi retains this private progress until the
worker publishes its complete result.
If a provider failure ends the invocation and the submissions still validate
against the current notebook, the worker publishes those submissions atomically
with its failed status and error.

The native Pi Explorer defaults to eight model responses and up to four note-read
calls. An empty notebook disables reading. ChatGPT Web uses one response without
reads. Each read can request several notes. Reads and rejected submissions consume responses,
and reading is disabled on the final response. These are ceilings, not a minimum
amount of exploration. A model can still end early by claiming a complete solution
or submitting an empty batch.

Other native Pi role conversations allow up to sixteen responses. Coordinator
allows up to four note-read calls. Completed and token-truncated responses count
toward the limit, including responses with rejected submissions. Admitted reads
also count across recovery. Native Pi handles provider-error retries separately.

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
the current group's comparisons and returns its checks. Coordinator then chooses
a mathematical repair or other work. Further worker admissions use the existing
outer round allowance.

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
a second owner. A rewindable Pi catalog and per-note body Documents hold the
current notebook. Native submissions and outcomes retain execution receipts.
Workers read the notebook at their frozen Entry cutoff.
`inspect` reads a consistent backup without recovering live work. Acceptance
atomically checks the current dependency closure and pins its snapshot for export.
Closing suspends unfinished execution. Reopening reuses Pi's committed private
progress. A request interrupted before its answer commits may repeat, except
that an ambiguously sent ChatGPT Web request is rejected on recovery.
Completed source checks are memoized before later verification stages. Codex
executes inside its worker and may repeat if interrupted before that boundary
or worker completion. The built-in Explorer preserves validated native submissions
when a provider failure ends its invocation. Its failed outcome references the
existing Pi Entries. The built-in Verifier preserves structurally validated
completed checks when a stage fails. Both publish retained results with the error
in a failed native task outcome only if publication validation succeeds.
Cancellation, invalid final publications,
and faults in opaque custom roles publish no partial results. A new Verifier reuses
applicable completed checks. Cleanup errors use Pi's nonfatal
reporting, preserving submitted results and the primary failure when a call fails.
Cancellation stops the Codex process group and may leave usage unknown.
Detached descendants require external process containment. Implementation
artifacts remain in their workspace.

Codex output capture allows 16 Mi decoded characters on stdout and 1 Mi on stderr.
Exceeding either limit stops the process group and records a failed call with
truncated output. Usage received before the limit remains in the receipt.
Failed calls retain their raw logs and report the provider's error message when available.
Each Pi Session caches up to 128 document trackers and reloads evicted documents from storage.
This limits the number of cached documents, not their total size.
Completed roles release their provider session resources.

## Inspection and experiments

Agents inspect campaigns through the CLI on the campaign host:

```sh
bun run xean status .xean/demo/campaign.sqlite
bun run xean inspect .xean/demo/campaign.sqlite
bun run xean inspect .xean/demo/campaign.sqlite --records
bun run xean export .xean/demo/campaign.sqlite
```

Use `status` for compact JSON with progress, failures, and verification issues.
The `init`, `run`, `role`, `review`, `pause`, `resume`, and `cancel` commands also
return compact status. These responses skip transcript accounting and full
work-history details. Use `inspect` for usage, full notes, checks, dependencies,
and standalone results.
Request `--records` only when native tasks and transcripts are needed. `export`
returns the accepted argument and its dependency chain from the pinned snapshot
as Markdown. These reads
use consistent snapshots without recovering work or calling models. Inspect
historical campaigns with their matching frozen runtime.

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

For prompt checks, prepare a role input and run the ordinary standalone command:

```sh
bun run xean role verifier input.json campaign.sqlite settings.json
```

Use a fresh campaign path for each case and keep expected answers outside the input.
Pi stores the task, role input, and settings in the campaign.

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

During development, run a selected test file with
`bun scripts/dev.ts test ./tests/apps.test.ts`. Use
`bun run check ./tests/apps.test.ts` to include types and formatting. Keep the `./` prefix so Bun treats the argument as a file path.
Run the full check and distribution checks when the change is ready for review.

`check` runs TypeScript, formatting, and scripted tests.
`check:distribution` checks an unpacked source archive with production dependencies,
including the Pi and role contract tests, model-free workflow, CLI inspection
and export, and licenses.
`pack` runs the same distribution check and writes the source archive under
`dist/`. The 3.1 qualification passed 203 scripted tests on fresh production
installs on macOS ARM64, Linux ARM64, and Linux x86-64 with Bun 1.4.2 and no
provider credentials. The x86-64 suite used tmpfs. On Btrfs, 26 tests exceeded
the default five-second timeout. With longer allowances, all cases passed
across a full run and an isolated rerun.
Sixteen additional SQLite cases passed crash recovery, writer exclusion,
dependency invalidation, and unchanged-INCONCLUSIVE checks.

The 3.1 native-provider smoke passed note reading, an elementary campaign,
and credential-free reopening with a saved Pi OpenAI Codex login and
`openai-codex/gpt-5.6-luna` at `max` reasoning. At the release qualification
snapshot, two of six fresh `gpt-6-astra`/`max` golden campaigns through
codex-lb's OpenAI `/v1` route and SSE had passed internal acceptance,
independent review, and credential-free reopening.
The other four remained in progress. These are model-based assessments.
Qualification receipts remain under `runs/release-3.1.0-qualification-20261010/`
and `runs/release-3.1.0-golden-20261010-r01/`, outside the source package.

Explorer publication after provider failures and Codex error reporting have
contract-test coverage.
The live qualifications below used earlier revisions.

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
covered only the gateway and existing OpenAI Codex login for those native-provider
checks. A later ChatGPT Web check at `7e6e5fd` passed after repairing the external
bridge's model selectors. One standalone Explorer response produced a proof
note, which passed the native Verifier through reconstruction. The saved ChatGPT
conversation matched the complete prompt and answer and reported `gpt-6-pro`.
Both completed roles reopened without credentials or further HTTP requests.
This check covered standalone roles. Live browser cancellation remains
unqualified. Receipts are in `runs/chatgpt-web-fix-20261008/`.
Literature retrieval passed with independently checked quotations.
At `e40b85e`, the implementation worker passed on native macOS, including
independent artifact checks and credential-free reopening. The tested Linux
container could not create Codex's sandbox namespace, so implementation work
remains unavailable in that environment.
Receipts are under `runs/release-3.0.0-qualification-20261008/`, outside the source
package.

Pi packages are built together from upstream commit
`eba849739511223c51a62bbd7e3f1c00f99fb1d0` using Pi's `pack:packages` command.
This is an unreleased snapshot after the 1.1.0 release. The packages include frozen
model data.
Artifact and patch hashes are recorded in [provenance](vendor/pi/provenance.json).
[Pi integration](docs/parity.md#pi-integration) records the adapter fixes and
the Pi Durable request hook used to select a profile's stream.
This is an [MIT-licensed](LICENSE) source package. Bun and provider access suffice
for the core workflow. Fleet, Nix, and private Xean Lab are not required for installation.
