# Xean

Xean runs a mathematical research workflow on Pi Durable. Explorer develops
notes, Verifier checks their claims and dependencies, and Coordinator chooses
further work. Each campaign runs Coordinator, one worker, then Coordinator again.
A worker may parallelize its own internal work. Pi owns tasks, conversations,
checkpoints, cancellation, and storage.

This checkout develops 3.5.0 and requires fresh campaign databases. The campaign
definition format and external role interface have changed. Keep existing campaigns with
their pinned runtimes. No database migration is provided. The
[qualification results](#checks-and-current-limits) identify the revisions and
configurations tested.

The implementation includes staged verification, blind reconstruction, external
trust grants, stable-ID edits, optional role backends for implementation, verification,
and research, independent review, and a CLI with a shared campaign host. The
[capability inventory](docs/parity.md) maps this behavior to implementation and tests.
See the [changelog](docs/changelog.md) for changes since 3.0.0.
The [FAQ](docs/faq.md) covers computation, broader research goals, and current
limits. The proposed [milestones](docs/milestones.md) cover 4.0 research and
computation, then 5.0 knowledge maintenance and paper writing. Further
[design ideas](docs/design-ideas.md) describe future work.

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

The native Pi Explorer continues within the same conversation so later responses
can develop and revise earlier reasoning. Each successful submission publishes
its notes and edits immediately. Explorer can read and edit those notes while it
continues working. Coordinator waits for the worker to finish before choosing the
next worker. A later worker starts a fresh conversation from the published
notebook. Prompt caching can reduce repeated-context costs, while new reasoning
and output still cost tokens. A valid partial submission alone does not end
Explorer's invocation.

Acceptance requires checks across the complete dependency chain.
All notes share the same content and verification rules. External trust is
recorded in `checks.external` with a reference to the caller's Pi input entry.
It grants correctness and sources. A note becomes verified only when its
declared dependencies are verified.
Before blind reconstruction, Verifier must produce a faithful exact statement
with PASS for each note. For externally trusted notes, this checks statement
fidelity without rechecking the granted truth. Preparation follows the ordinary
retry and reassessment rules.
Blind reconstruction receives exact statements and approved premises without
the original proofs. INCONCLUSIVE remains unresolved. Model judgments can be
wrong, and independent review is recorded separately from internal acceptance.

Explorer repairs notes through `edits`, retaining their IDs. Each edit supplies
the expected `revision` and only changed fields. Retiring a note hides it from
routine discovery and preserves historical reads. Existing consumers can still
verify their retired dependencies.
Workers create notes with permanent IDs prefixed by their Pi task ID, such as
`27/square-bound`. They use those exact IDs
in text, dependencies, reads, and edits. Names are never rewritten at publication.
New notes require unused names. Changes to existing notes use edits.
Caller edits preserve an existing external grant unless they explicitly change
`trusted`. Explorer edits to mathematical fields revoke that grant. Changes to
mathematical fields, support, or trust clear affected checks. Candidate and
retirement flags only advance the revision.
Verifier may correct summaries on PASS, while proof text and dependencies change
through edits.
Explorer publication receipts also identify dependent notes whose checks were
cleared. A dependent revision can be reused when Explorer had observed its prior
revision. The receipt requires a read when intervening changes remain unseen.
Operator `recheck` inputs withdraw assessments for the named note revisions and
their transitive consumers. They also withdraw external grants on the named
notes. Note content and prior evidence remain in Pi's journal. Reassessment uses
the ordinary verification stages.
Coordinator receives the target IDs and withdrawal reason as guidance.

Coordinator can assign an external Verifier to reassess an INCONCLUSIVE correctness,
requirements, or reconstruction check when computation or artifact access can
settle the unfinished obligation. This can follow either verifier backend, and
Coordinator decides whether another attempt is useful. Xean does not retry
these checks automatically. PASS and FAIL assessments of unchanged inputs stay
closed. Coordinator can also choose mathematical repairs, relevant source
retrieval, another approach, or idle.
New quotations matching a note's exact premises can reopen an eligible
INCONCLUSIVE source check. Changing receipt IDs or adding unrelated quotations
does not reopen it.
Both verifier backends use the registered research backend for source checking.
Source backend failures identify that stage and preserve completed checks. Switching
verifier backend leaves the source provider unchanged.

## Run a campaign

Install [Bun](https://bun.sh/docs/installation) 1.4.2 or later on macOS or Linux.
Run these commands from the source root:

```sh
bun install --production --frozen-lockfile --ignore-scripts
```

Set `OPENAI_API_KEY` in your environment, or use a saved Pi login as described
below. The [example settings](examples/settings.json)
use public OpenAI with `gpt-6-astra` and `max` reasoning. The default is closed-book: Explorer
and Verifier use the configured Pi models, and external source retrieval and
independent online review require an explicitly registered backend. Keep credential
values outside task and settings files.

```sh
bun run xean doctor examples/settings.json
bun run xean init examples/task.json .xean/demo/campaign.sqlite examples/settings.json
bun run xean run .xean/demo/campaign.sqlite
bun run xean status .xean/demo/campaign.sqlite
```

`init` freezes the task and settings without model calls. `doctor` checks local Pi setup without testing live providers or optional backends. `run` performs research.
Read the returned JSON status: a successful CLI exit can report `blocked` or
`idle`. Returning `work: null` leaves a campaign idle without claiming completion.
Add guidance or use `resume` to request another decision.
Pausing retains inputs and worker outcomes. Resume makes a fresh decision over
that accumulated state and explicitly replaces any failed decision.
Campaign arguments accept explicit paths or names under `--campaign-dir`, which
defaults to `.xean` relative to the calling directory.

The same CLI provides `pause`, `resume`, `cancel`, `inspect [--records]`, and
accepted-only Markdown `export`. `submit` takes a JSON file containing `notes`
and optional `edits`. Explorer uses the same submission structure. Set
`candidate: true` on a note or its edit when it claims a complete solution.
`guide` takes a text file. `recheck` takes note IDs, current revisions, and a reason
for withdrawing their assessments. These commands require a stable `--id` for
exact retries.
With `submit --id lemmas`, new note IDs have the form `input/lemmas/square-bound`.
Use the full ID in the JSON and in references between notes in the same batch.
Use `guide` for short steering instructions and `submit` for initial notes or
reference material. New caller notes default to external trust. Set a note or
edit's `trusted` field to `false`, or pass `submit --untrusted` for the batch, to
require ordinary verification. See [guidance versus notes](docs/faq.md#should-i-use-guidance-or-notes-for-background-material).
Live mutations reach the active owner.
`role NAME INPUT CAMPAIGN SETTINGS` runs a standalone procedure. Use `role review`
with a JSON input containing `task` and `argument` for independent review. The
[FAQ](docs/faq.md#can-i-supply-my-own-results) includes edit and review examples. Use
`--help` for arguments and owner, credential, and usage-attribution options.

[Settings](src/roles/config.ts) use native Pi profiles for OpenAI, `openai-codex`,
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

## Optional role backends

Register external tools with a module exporting an `open({ roles })` callback.
For example, save this as `roles.ts` in a project that depends on Xean:

```ts
import { codex } from "xean/plugins/codex";

const worker = {
  model: "gpt-6-astra",
  reasoning: "max" as const,
  workspace: "/absolute/path/to/workspaces",
};
export default codex({
  implementation: worker,
  verifier: worker,
  research: { model: "gpt-6-astra", reasoning: "max" },
});
```

Install and authenticate the selected CLI separately, then pass the module when
opening or resuming work:

```sh
bun run xean --roles ./roles.ts run .xean/demo/campaign.sqlite
```

Only explicitly supplied roles are enabled. Core installation and ordinary Pi
roles need no external CLI. Codex provides implementation, verification,
Explorer, and research adapters. The `claude` factory from `xean/plugins/claude`
provides implementation, verification, and Explorer adapters through the same
registration pattern. External Explorers receive the note index and return a single batch of
new notes per invocation. They cannot edit existing full texts through that interface.
The native Pi Explorer retains its reading, editing, and continued-submission behavior.
Claude uses its native restricted mode and requires its native shell sandbox.
Codex retains workspace-write mode for workers and read-only mode for research.

The caller's role module can instead export `chatgpt({baseUrl, model})` from
`xean/plugins/chatgpt` to use ChatGPT Pro through the external browser service.
Run [`codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) separately
in `browser-only` mode with an authenticated browser. Codex, Claude, and ChatGPT
all register through `external.explorer`. Other services can implement the same
[`ExternalCall`](src/roles/backend.ts) contract. Xean validates their returned notes.
The browser adapter reuses completed Pi memos and refuses ambiguous replay of
an interrupted request. Each new Explorer invocation can make a new request.
Browser usage is unmeasured and excluded from usage reports.

Source retrieval and independent review require `research`. Literature additionally
requires `literature: true` in settings. The Codex research adapter uses native
web search with shell execution disabled. To disable Codex plugins for these
calls, use [xean-research.config.toml](examples/xean-research.config.toml) in
`CODEX_HOME` and set `research.profile: "xean-research"` in the factory options.
Codex worker profiles are configured independently on `implementation`, `verifier`,
and `explorer`.

Keep the module and configuration stable across recovery. A native Pi memo rejects
changes to enabled backend registrations while recovering an interrupted worker.
Packaged adapters separately pin the provider and configuration of admitted calls.
Custom replacement code remains responsible for its own replay behavior.

## Shared campaign host

Run named campaigns under one foreground process:

```sh
bun run xean --campaign-dir .xean host
```

At startup, the host opens every `.xean/NAME/campaign.sqlite` it can own and resumes
its saved Pi execution. This includes initialized campaigns that have not run yet.
Paused, idle, accepted, and cancelled campaigns retain their stored state. Keep only
campaigns using this runtime under that directory. An unavailable or incompatible
database is reported without stopping other campaigns.

From another terminal, attach a newly initialized campaign or detach an owned one:

```sh
bun run xean init examples/task.json second examples/settings.json
bun run xean attach second
bun run xean detach second
```

Each campaign retains its Pi Harness, database, and sequential workflow. The host
shares Pi's `Models` instance and uses the existing campaign control sockets.
`pause`, `resume`, `cancel`, and submissions work as before. Detach suspends unfinished
work and closes its control socket and Pi Harness. Attach recovers its committed progress.
Host restart scans the directory again, including detached campaigns. Pause a campaign
before detaching when it should remain paused on restart. SIGINT and SIGTERM close
all owned campaigns. Ordinary OS supervision can restart the foreground host.

Supply `--roles`, credentials, and usage overrides on `host`, which applies them
to every attached campaign. External CLI child processes still have their own
memory costs.

A Linux x86-64 measurement at `bd1c668` with Bun 1.4.2 compared one shared
host with one host process per campaign. Total proportional resident memory
(PSS, which apportions shared pages) was:

| Campaigns | Active shared / separate | Idle shared / separate |
| --------- | ------------------------ | ---------------------- |
| 1         | 56.5 / 56.9 MiB          | 58.8 / 58.8 MiB        |
| 10        | 70.5 / 399.5 MiB         | 76.4 / 416.7 MiB       |
| 50        | 118.1 / 1,793.1 MiB      | 140.1 / 1,855.9 MiB    |
| 100       | 156.2 / 3,541.0 MiB      | 195.4 / 3,677.4 MiB    |

These synthetic campaigns each retained a 64 KiB seed note, ran a worker waiting
on a barrier, then committed a second note. They made no provider calls or CLI
subprocesses. Provider buffers, larger notebooks, and external processes add to
these costs. Every campaign completed its worker, and ten subsequent reopen/close
cycles completed. Diagnostics remain outside the source package under
`runs/issues-20-21/memory/`, with results in `summary-r3.json`.

Every close returned to the nine-descriptor process baseline without explicit
garbage collection. In the 100-campaign shared process, memory was 135.7 MiB after
the initial close. The reopen/close series began after an explicit collection,
peaked at 139.7 MiB in its closed-state measurements, and reached 85.4 MiB after
a final explicit collection. Xean leaves collection to Bun. The native
Bun SQLite connection finalizes statements on close, while Pi retains ownership
of SQL transactions and durable state. An earlier `node:sqlite` comparison
retained database handles until collection. The thin driver facade fixes that
cleanup behavior without another Pi patch.

## Library

[The public entry point](src/index.ts), `xean`, supplies the default setup through
`open`, which returns the native Harness, root Conversation, workflow, and `close`.
For custom roles, import `xean/core` and call `createResearch(roles)` when assembling
your own native Pi Harness, registry, models, and storage. Core contains the
sequential workflow, note publication, dependency and verification rules, and role
contracts. It records role settings as JSON and runs without the bundled roles,
CLI, or adapters.

`xean/roles` exports `createRoles` for the bundled prompts, conversations, and
verification strategy, plus `selectBatch` for capacity-based grouping with caller-supplied
inputs and output estimates. `xean/report` supplies status and reports. The ordinary
`open` setup validates settings for the bundled roles and accepts native Pi `models`
and a `roles` callback that receives the built-in functions. Coordinator returns
one `work` request, or `work: null` to become idle. Replacement roles follow the
same sequential outer loop. Register custom `Research`
through that callback's `external.research` field. Register custom tools and tasks
through Pi's native `registry` option.
Coordinator supplies an `assignment` to Explorer, Literature, and implementation. Caller
guidance remains campaign input for Coordinator.
Explorer assignments identify relevant note IDs and the remaining gap in the
complete task, so later workers can continue from published work.

With a verifier backend registered, Coordinator can request
`{kind: "verifier", backend: "external", notes: [noteId], through: "correctness"}`.
The same selection supports source, requirements, and reconstruction stages.
Omitting `backend` selects the native Verifier. External Verifiers judge PASS, FAIL, or
INCONCLUSIVE under the same dependency, stage, and acceptance rules. The packaged
Codex and Claude backends run checks and independent proofs in fresh retained
workspaces and record execution receipts and artifact paths. Source checks still use the research backend.
External blind reconstruction receives only the task, exact statements, and approved
support and premises. Instructions forbid reading original proofs, campaign transcripts,
or other workspaces. This boundary relies on instruction compliance, not hostile
code isolation.

Call `open` for separate databases to run several campaigns in one process.
Pass the same Pi `models` instance to share its provider registry. Each campaign
keeps its own Harness and sequential workflow. The CLI exposes this through `host`, `attach`, and `detach`.

Notes store `summary`, `detailedSummary`, and authoritative free-form `text`.
The text can record proofs, conjectures, observations, questions, or failed
approaches. Correctness records a separate nullable `statement` for later
verification. Without external trust, notes with no mathematical claim remain
unverified context. The note reader includes the existing checked statement.
Explorer and Verifier
use it to distinguish granted support from additional facts that need a proof
or a separate supporting lemma.

Explorer continues its Pi conversation after partial submissions. A claimed
complete solution, an empty notes-and-edits submission, or reaching the response
allowance ends the invocation. Submission returns published note IDs and current
revisions for subsequent reads and edits. Explorer reads the current notebook.
Stale edits and dependencies changed since Explorer observed them are rejected.
Each publication and its replay receipt commit together in Pi. Recovery returns
the saved receipt without publishing twice. Previously committed batches remain
published after a later failure or cancellation. Worker completion records
publication references without submitting the notes again.

Standalone Explorer uses the same notebook tools. Supplied notes retain their
IDs, external grants, and recorded checks, with new revisions assigned by Pi.
Their checks refer to immutable input evidence. External Explorers
and replacement roles returning a batch retain publication on completion.

The native Pi Explorer defaults to eight completed responses and up to four
note-read calls, including reads of its own published notes when the notebook
starts empty. Each read can request several notes. Reads and rejected submissions
consume responses, and reading is disabled on the final response. These are ceilings, not a minimum amount of
exploration.

Other native Pi role conversations allow up to sixteen completed responses.
Coordinator allows up to four note-read calls. Responses with reads or rejected
submissions count toward the limit. Incomplete responses do not. Admitted reads
also count across recovery.

Output limits (`max_messages` or `max_output_tokens`) and retryable provider
failures with reusable text, reasoning, or tool arguments continue the same
submission automatically. Continuations have no fixed count. Pi retains the raw
response and schedules its continuation atomically. Unfinished tool arguments
become unexecuted draft text. Incomplete tools never execute. Empty limit responses
fail explicitly. Retryable failures without reusable output use Pi's bounded
retry policy and backoff. Authentication, quota, invalid-request failures, context
overflow, and cancellation retain their existing handling. Context and
completed-response limits still apply, with operational handoffs to Coordinator.

Native correctness and requirements checks also use `selectBatch`, with each group
receiving its declared support and relevant source records. Earlier judgments
update later groups, and refuted dependencies skip their later consumers.
Blind reconstruction assigns batches in dependency order. External verification reconstructs
one note per call. Native verification greedily packs notes using original text
lengths, Pi's token estimator, and the configured model's context and output
capacities. It reserves space for complete writing,
reasoning, structured results, and headroom. Comparisons use the actual returned
proof lengths and may need smaller batches. Each call must submit every assigned
note. These estimates guide grouping and do not cap responses or guarantee that
a proof fits. An oversized note is assigned alone, subject to Pi's input guard.
Pi checks context use and the provider guard reserves the full output allowance.

Native roles use Pi's model catalog for context and output limits. The packaged
catalog corrects OpenAI entries that used a pricing threshold as context
capacity. For example,
[`openai/gpt-6.1-sol`](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
has a 1,050,000-token context window and a 128,000-token output limit. Pi's
4,096-token safety margin leaves 917,904 estimated input tokens with the full
output allowance. Higher pricing above 272,000 input tokens remains in effect.
Caller-supplied `Models` retain their own capacity metadata.

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

The host uses Pi's SQLite storage and transaction queue with Bun's native SQLite
driver, FULL synchronization, and exclusive ownership. A small adapter normalizes
the driver interface. Bun tracks prepared statements and finalizes them on close,
so releasing database handles does not depend on garbage collection. This uses
Pi's existing adapter without another Pi patch.
A rewindable Pi catalog and per-note body Documents hold the
current notebook. Native submissions and outcomes retain execution receipts.
Workers receive a notebook snapshot at their admission cutoff. Explorer reads
its current notebook after each durable submission.
`inspect` uses a read-only Pi Session and holds a SQLite read transaction.
Pi rejects writes from inspection callbacks. Acceptance atomically checks the
current dependency closure and pins its snapshot for export.
Closing suspends unfinished execution. Reopening reuses Pi's committed private
progress. A request interrupted before its answer commits may repeat.
Codex and Claude adapters share Execa process handling and Pi request receipts. Pi memoizes each completed request within its worker. Interrupted calls
restart in a fresh workspace. Source checks also retain results from custom
research implementations before later stages. The browser adapter refuses to
resend an ambiguously admitted request. The built-in Verifier preserves
structurally validated completed checks when a stage fails. Invalid submissions and faults in
opaque custom roles publish no partial results. A new Verifier reuses
applicable completed checks. Cleanup errors use Pi's nonfatal
reporting, preserving submitted results and the primary failure when a call fails.
Cancellation stops the external CLI process group and may leave usage unknown.
Detached descendants require external process containment. Implementation
artifacts remain in their workspace.

External CLI output capture allows 16 Mi decoded characters on stdout and 1 Mi on stderr.
Exceeding either limit stops the process group and records a failed call with
truncated output. Usage received before the limit remains in the receipt.
Failed calls retain their raw logs and report the provider's error message when available.
Failures also identify the operation, request and completion records, exit status
when recorded, and workspace. Coordinator receives these references in the
failure message. A missing completion record leaves execution unknown.
Xean sets Pi's `documentRetentionMs` to zero, releasing unobserved document
trackers after use. Watched documents remain cached until their observers detach
or the document retires. Later reads reload evicted documents from storage.
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
The `init`, `run`, `role`, `pause`, `resume`, and `cancel` commands also
return compact status. These responses skip transcript accounting and full
work-history details. Use `inspect` for usage, full notes, checks, dependencies,
and standalone results.
Request `--records` only when native tasks and transcripts are needed. `export`
returns the accepted argument and its dependency chain from the pinned snapshot
as Markdown. `status`, `inspect`, and `export` read the campaign database directly
through a read-only Pi Session. Each call holds a consistent SQLite read
transaction without recovering work or calling models. Inspect historical
campaigns with their matching frozen runtime.

Retain the campaign database as the transcript record. For routine monitoring,
keep only the latest compact status. Run `inspect --records` on demand for
diagnostics instead of retaining repeated transcript copies.

Usage reports count committed assistant responses and recorded external CLI invocations.
They cannot establish every outbound request or provider retry. Missing native
usage remains unknown.
Process health, internal acceptance, and independent review are
separate observations.

The Codex factory's `usagePrefix` supplies `XEAN_CODEX_USAGE_TAG` to Codex. A custom provider's native
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
Pi stores the task, role input, and settings in the campaign. Standalone
`verifier` and `reconstruct` inputs also accept `backend: "external"` with
a verifier backend registered through `--roles`.

## Checks and current limits

Install development dependencies to run checks and create a source archive:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run pack
```

Start interface changes with focused contract tests and model behavior changes
with small standalone roles, using the CLI `role` command and frozen inputs.
Inspect their actual submissions before running a complete campaign smoke.
Use the golden problems after those checks pass.

During development, run a selected test file with
`bun scripts/dev.ts test ./tests/apps.test.ts`. Use
`bun run check ./tests/apps.test.ts` to include types and formatting. Keep the `./` prefix so Bun treats the argument as a file path.
Run the full check and `pack` when the change is ready for release.

`check` runs TypeScript, formatting, and scripted tests.
`check:distribution` checks an unpacked source archive with production dependencies,
including the Pi and role contract tests, model-free workflow, CLI inspection
and export, and licenses.
`pack` runs the same distribution check and writes the source archive under
`dist/`. Use `check:distribution` when you need that check without retaining an
archive. Running both commands on unchanged code repeats the packaged checks.

Tests cover mathematical validation, notebook publication, role protocols,
workflow recovery, provider adapters, and CLI processes. Pure validation uses
direct calls. Role tests use Pi's in-memory storage unless they need persistence.
Reopening and crash tests use durable storage, and process tests retain actual
subprocesses. Scripted model replies exercise protocol behavior. Research quality
requires separate model experiments.

Keep each test tied to a failure it can detect. Assert observable results and
preserved data instead of exact prompt sentences. Share repeated setup while
keeping scenario actions and expectations in the test. Preserve distinct
publication, cancellation, and recovery boundaries when consolidating cases.

The current checks qualify fresh databases only. Historical campaigns remain
pinned to their recorded runtimes. Transfer of an in-flight model generation
remains unqualified.

The 3.4.0 local checks passed 259 tests and 2,533 assertions. The unpacked
source archive passed 97 tests and 1,257 assertions under Bun 1.4.2. A Linux
ARM64 package smoke also passed the focused protocol tests and a model-free
campaign. These checks use scripted providers. Live campaign qualification
remains pending.

The 3.2.0 qualification passed 213 scripted tests and 2,044 assertions on each
tested platform: macOS ARM64 with Bun 1.4.3, and Linux ARM64 and x86-64 with
Bun 1.4.2. Source-distribution checks also passed 66 Pi and role tests.
A live Codex CLI implementation screen with `gpt-5.6-luna` at `low` reasoning
passed strict-schema handling and independent execution of the generated artifact.
The completed role reopened without credentials or new calls. This live check
covered one standalone implementation role. Full-campaign qualifications below
retain their original revisions.

The 3.1.0 qualification passed 203 scripted tests on fresh production
installs on macOS ARM64, Linux ARM64, and Linux x86-64 with Bun 1.4.2 and no
provider credentials. The x86-64 suite used tmpfs. On Btrfs, 26 tests exceeded
the default five-second timeout. With longer allowances, all cases passed
across a full run and an isolated rerun.
Sixteen additional SQLite cases passed crash recovery, writer exclusion,
dependency invalidation, and unchanged-INCONCLUSIVE checks.

The 3.1.0 native-provider smoke passed note reading, an elementary campaign,
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
checks.
Literature retrieval passed with independently checked quotations.
At `e40b85e`, the implementation worker passed on native macOS, including
independent artifact checks and credential-free reopening. At that revision, the
tested Linux container could not create Codex's sandbox namespace. Container
execution depends on the host's sandbox configuration.
Receipts are under `runs/release-3.0.0-qualification-20261008/`, outside the source
package.

Pi packages are built from unreleased upstream commit
`301617df7b88951c328f8a7b6a732e590713df07`, after the 1.2.0 release.
They retain the existing frozen model catalog, including the OpenAI/Azure
context-capacity correction, and all existing Xean patches.
Artifact and patch hashes are recorded in [provenance](vendor/pi/provenance.json).
[Pi integration](docs/parity.md#pi-integration) records each retained patch,
including the adapter fixes, the request hook used to select a profile's stream,
and read-only SQLite inspection.
This is an [MIT-licensed](LICENSE) source package. Bun and provider access suffice
for the core workflow. Fleet, Nix, and private Xean Lab are not required for installation.
