# `xean`

`xean` is a mathematical problem-solving tool for other agents. A controlling
agent chooses a concrete problem, prepares reference notes, selects models, and
uses the CLI or library to run and inspect a campaign. It handles literature
discovery, computational experiments, scheduling across problems, and independent
review of the result.

Give this prompt to an agent with terminal and web access, replacing the bracketed
text:

```text
Use xean (https://github.com/chaoxu/xean) to work on this problem:

Problem: [state the exact problem, definitions, and assumptions]
Completion criteria: [what a successful result must establish]

Read the README and FAQ for the version you run. Handle installation and model
configuration using my available credentials. Ask me only for essential missing
problem details or authentication.

Check current literature, including whether the exact problem is already settled.
Prepare notes with exact statements, hypotheses, citations, and unresolved gaps.
Initialize a fresh campaign and submit these notes before running it.

Run the campaign, monitor its status, and use documented recovery when needed.
If it is accepted, export the argument and arrange an independent proof review.
Report the campaign outcome, useful results, remaining gaps, and artifact paths.
```

Inside `xean`, Explorers choose mathematical directions and append notes with
summaries. Verifiers select work and check sources, correctness, task requirements,
and blind reconstruction. Explorers and Verifiers can run together under a shared
worker limit. Each completion frees capacity for more work. Chord manages research
jobs, claims, and campaign state. Pi Durable supplies model conversations, tools,
receipts, and call recovery. A valid Explorer submission ends its turn.

The design keeps research policy small and aims to reduce repeated reasoning
costs. Explorer works from prepared notes and the model's learned mathematical
knowledge, with no browsing or code-execution tools. The controlling agent should
check current literature, including whether the exact problem has already been
settled, before preparing the notes.

The [FAQ](docs/faq.md) explains the design philosophy, what notes contain, the
division of work between agents, and the limits of the system. The instructions
below are CLI and library reference material for the controlling agent.

## Start a campaign

This checkout is the unreleased `5.0.0-dev.4` and requires fresh campaign
databases. Use Bun 1.4.2 or later on macOS or Linux. From an extracted archive or
source checkout:

```sh
bun install --frozen-lockfile --ignore-scripts
cp examples/task.json task.json
cp examples/settings.json settings.json
```

Edit `task.json` to state the exact problem and completion criteria:

```json
{
  "problem": "For every real x >= 1, prove x squared >= x.",
  "completionCriteria": "Give a self-contained elementary proof."
}
```

The [example settings](examples/settings.json) use `openai/gpt-6-astra` with
`max` reasoning. Set `OPENAI_API_KEY`. For a supported subscription, use
`bun run pi` and `/login`, then select the matching Pi provider and model.
The CLI reads credentials from `~/.pi/agent/auth.json` and custom providers and
model overrides from `~/.pi/agent/models.json`. `PI_CODING_AGENT_DIR` selects
another Pi configuration directory.

`init` freezes the task and settings without model calls. Submit any
[reference notes](#supply-papers-and-notes) before the first `run`:

```sh
bun run xean init task.json .xean/demo.sqlite settings.json
bun run xean run .xean/demo.sqlite
```

Another terminal can inspect progress without starting models:

```sh
bun run xean status .xean/demo.sqlite
bun run xean inspect .xean/demo.sqlite
```

Read the outcome: `accepted`, `turn-limit`, or `call-failure`. Process exit alone
does not establish acceptance. After `accepted`, export the note texts and their
support as Markdown:

```sh
bun run xean export .xean/demo.sqlite > accepted.md
```

Acceptance ends the campaign. A different target requires a new campaign.

## Supply papers and notes

`submit` accepts JSON text notes. Save relevant paper passages as `notes.json`
in this format, preserving definitions, hypotheses, conventions, limitations,
and source versions. Citations and URLs belong in `text`:

```json
{
  "notes": [
    {
      "summary": "Result and its exact scope, or the unresolved question.",
      "detailedSummary": "Definitions, hypotheses, conclusion, and limitations.",
      "text": "Full statement or excerpt, with paper title, version, section, URL, and any uncertainty about applicability.",
      "support": []
    }
  ]
}
```

After `init`, while the campaign owner is closed:

```sh
bun run xean submit .xean/demo.sqlite notes.json --id initial-notes
bun run xean inspect .xean/demo.sqlite
bun run xean run .xean/demo.sqlite
```

`inspect` shows queued `inputs` until execution admits them at its next intake
boundary. `xean` assigns short note IDs such as `i1.1` and `w2.1`, which remain
stable through recovery. Treat them as opaque references. Caller-supplied
`support` can name only
existing notes that are not dead, excluding new notes in the same submission.
Repeating an ID and identical content is idempotent. Reusing the ID with different
content fails. Submission does not start models or reopen a terminal result.

Ordinary notes omit `verification` and receive normal checks when selected.
State each nonroutine external theorem as a separate note with its exact
hypotheses, conclusion, and citation. Applications name that note in `support`.
Routine facts need no separate note. To admit an established result explicitly
as a premise, the caller may add:

```json
{
  "verification": {
    "source": "Paper title, version, and section",
    "report": "Caller admits the established result under its stated hypotheses."
  }
}
```

This attestation grants only the scope stated in `report` and supplies local trust
for `checked`, unless the note has an invalidating FAIL. Its dependencies must
still verify before it becomes
`verified`. A candidate still requires all four checks in one attempt. Admit
results only at their exact scope, retain conjectures and gaps as such, and check
applications. `checked` and `verified` are derived, not submitted fields.

Mathematical text is append-only. Corrections use new notes. For short, fallible
advice to the next fresh Explorer call, close the owner and use:

```sh
bun run xean guide .xean/demo.sqlite guidance.txt --id try-construction
```

Guidance preserves the frozen task and does not interrupt a running call.
Cross-process admission to an active owner is not implemented.

## Reading notes

Full `text` is authoritative. Explorer supplies a `summary` for each generated
note. Imported notes may omit summaries. A `summary` or optional `detailedSummary`
states results, hypotheses, conventions, bounds, limitations, and explicit gaps
without reproducing the proof. Supplied summaries are the caller's responsibility.
The correctness verifier checks their fidelity against the full text.

Explorer starts with the summary index. It can apply a verified result from a
sufficient summary and must cite the note as support. `read_notes({ids, level})`
reads up to 20 IDs per call. `detailed` returns statements and verification state,
with `null` for a missing detailed summary. External attestation reports remain
visible to preserve their scope. Internal PASS explanations are omitted, while
FAIL and INCONCLUSIVE reports remain. Full evidence stays
available through `inspect`. `full` returns only text strings in requested order.
Notes without sufficient summaries remain available through full reads.

Explorer and Verifier selection can read any admitted note in the shared notebook,
including notes outside their initial index. Their frozen assignments still
determine permitted support IDs and verification selections. Verification checks,
including blind reconstruction, have no notebook reader.

## Verification and models

Settings select provider, model, and reasoning level for `explorer`, `source`,
`correctness`, `requirements`, and `reconstruction`. Verifier selection uses the
`correctness` profile. Pi runs each role except the special Codex source profile
below. OpenAI models have been exercised. Other Pi providers remain unqualified.

`maxWorkers` is a positive integer, defaulting to `1`. Set `"maxWorkers": 2`
before `init` to allow two Explorer or Verifier invocations in total, including
Verifiers still selecting work. A Verifier's selection and checks share that slot.
The limit applies to automatic campaigns and manual worker calls. A limit of `1`
uses the same job and controller path.

After any worker completes, the campaign fills available slots with eligible,
unclaimed verification work first, then new Explorer turns. `maxExplorerTurns`
defaults to 10. Admission counts completed and in-flight Explorers against that
cap. After exploration stops, remaining eligible verification batches can finish.
The campaign reaches `turn-limit` when admitted work has settled and no eligible
offer remains. These limits impose no wall-clock or monetary bound.

`window` defaults to 100,000 characters per verification batch, always admitting
its first entry. Automatic admission consumes only the batch's selected note IDs
for the current publication. A `no-work` selection is reoffered when a new
publication or new solution nomination changes its eligibility. The campaign
keeps `busy` work eligible after competing claims settle.

By default, Verifiers can select intermediate notes for checks. To defer checks
until a Verifier selects a claimed complete solution, initialize with:

```sh
bun run xean init task.json .xean/deferred.sqlite settings.json --verify-on-solution
```

The flag sets `verifyOnSolution: true`, also accepted in settings. A solution must
first be nominated with all four checks. Selection may explicitly include that
solution's dependencies for source, correctness, and reconstruction.
Later batches may select still-eligible dependencies without selecting the
solution again. Checks are limited to
explicitly selected solutions and their eligible ancestors. Dependencies are never
added to the batch implicitly. Verification timing is frozen at `init`. If no
solution is accepted, exploration continues while turns remain.

Verification checks selected notes conditionally on their exact frozen dependency
statements. Those statements are assumptions even when their proofs are unresolved.
Selected notes are claimed together. Dependencies are checked and claimed only
when separately selected. A useful lemma needs source, correctness, and
reconstruction PASS in one attempt. Requirements checking is optional for lemmas.
A candidate needs all four checks in one attempt.

`checked` records successful local proof checks or a caller attestation, provided
the note itself has no invalidating FAIL. `verified` additionally requires every
declared dependency to be verified and the note not to be dead. Acceptance
requires `verified` and all four PASS results in one attempt.

Statement extraction handles selected notes and their direct dependencies together.
Blind reconstruction receives only scoped statements, without original candidate
or dependency proof texts or verifier reports. The proof model is asked to
establish each selected conclusion from that note's declared premises. Extraction
and comparison see the original texts, and extracted statements can still disclose
proof methods.

Source, correctness, or reconstruction FAIL makes a note and its dependents dead.
A dependency failure preserves the dependent note's local `checked` evidence, and
an in-flight conditional check may finish. Requirements FAIL does not invalidate
a local proof. INCONCLUSIVE leaves the check unresolved. Changing a premise
statement requires new notes and new dependent checks, without reviving old
notes. Acceptance and independent model review remain separate assessments,
neither a formal proof certificate.

### Source verification

The example source profile runs through Pi without web access. For citation
lookup through Codex, replace `source` with:

```json
{
  "provider": "codex",
  "model": "gpt-6-astra",
  "reasoning": "high",
  "search": true
}
```

Install Codex and authenticate with
`codex -c 'cli_auth_credentials_store="file"' login`. The adapter reads
`$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`.
`search: false` disables search. `XEAN_CODEX_COMMAND` selects another executable.
This source-only profile checks cited results and their applicability. It does
not discover literature or automatically import retrieved papers.

The verifier may use supplied texts and mathematical knowledge, so PASS need not
involve a fresh lookup. Search has no historical cutoff. Reported URLs and claims
are not individually matched against retrieved content by the runtime.
Codex runs with temporary configuration, user configuration and execpolicy rules
ignored, skill instructions suppressed, and plugins disabled. Tool restrictions
rely on that configuration, without an independent event-log audit or host-added
process isolation. Receipts retain the validated JSON result and raw stdout/stderr.

## Recovery, storage, and usage

Ctrl-C closes the owner and preserves recorded progress. `run` recovers unfinished
native work. After `call-failure`, inspect the error and retry with:

```sh
bun run xean resume .xean/demo.sqlite
```

`turn-limit` stays stopped. Multiple valid role submissions fail the call, and
resume skips that ambiguous result to make a fresh call. Reconstruction re-proves
the whole statement batch after each correction, continuing until comparison
returns verdicts, a call fails, or the run is cancelled.
The campaign pauses new admission while a candidate is provisionally accepted
or a worker has failed. Verification claims and pending selections involving the
candidate or its support chain must settle, as must manually started workers.
Once the latest checks establish a candidate whose note and support chain have
no unresolved failed verification claim, the campaign cancels unrelated campaign
work through Chord and Pi. It waits for cleanup and rechecks acceptance before
reporting `accepted`. Controller errors or the absence of such a candidate after
worker failure produce `call-failure` until explicitly resumed. If later checks
invalidate provisional acceptance and no worker has failed, normal admission can
resume before other workers settle. Resume preserves frozen inputs and recorded
receipts.

Native jobs blocked by incompatible versions or repeated finish failures require
repair before model-call recovery or `resume`.

The independent `@chaoxu/notebook-store` package is bundled and installs with
`xean`. A campaign at `campaign.sqlite` creates `campaign.sqlite.notes.sqlite`.
Both databases are required for recovery. Close all writers before backing up
both, and restore them to their original canonical paths. Use fresh databases
for this version. Historical campaigns keep their pinned runtimes without migration.

Campaigns never share notes, trust, or reconstructed proofs. Each admitted
publication is pinned to its exact notebook revision. Unrelated appends do not
change frozen worker inputs or prevent their recovery. Other programs may read
and publish through the notebook API, but external material still needs explicit
admission. Mathematical note texts remain immutable within a campaign.

Pi handles output limits and retryable transport errors. Long responses can
disconnect near 15 minutes ([#24](https://github.com/chaoxu/xean/issues/24)).
`inspect` includes Pi's usage ledgers, which omit some outbound attempts and
external Codex source usage. Retained reasoning and failed-response usage remain
incompletely measured, so recorded costs can be lower bounds.

## Architecture and sources of truth

`xean` implements research policy using Chord jobs and Pi model execution.
Each kind of state has an authoritative record:

| State                                            | Authority                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Task and settings                                | The campaign definition, frozen at initialization. Workers read it without storing settings in each job. |
| Worker activity, claims, and campaign control    | Chord jobs and research state in the campaign database.                                                  |
| Pi assignments, conversations, and call receipts | Pi Durable in the campaign database.                                                                     |
| External Codex source receipts                   | Research state in the campaign database, including the request and raw output.                           |
| Admitted mathematical content                    | Immutable notebook publications, referenced by revision and note IDs.                                    |
| Note verification status                         | Derived from recorded checks, caller attestations, and declared support.                                 |

Eligibility uses the admitted publication count. Each worker saves that count
at admission as its `epoch` and retains it across retries. The controller compares
it with the current publication count to decide whether earlier work remains
consumed. Campaign state carries no separate publication counter.

Frozen worker inputs and Pi assignments preserve the assigned inputs during
recovery. These snapshots intentionally contain copied content. Terminal worker
receipts stay in application history because Chord retires settled job records.
Role calls await Pi's `waitForIdle` after submission settlement because Pi can
still have tasks to finish.

Shared policy helpers also prevent drift. `directSupport` in
[support.ts](src/policy/support.ts) constructs direct dependencies outside the
selected roots for verification and reconstruction. The verifier lists in
[contracts.ts](src/policy/contracts.ts) define check order and prerequisites.
Prefer these authorities and native Chord and Pi APIs when simplifying code.

## Qualification

Six elementary Astra/max campaigns at `10114cd` reached `accepted` and passed
independent mathematical review, with minor wording defects noted. Separate
role tests exposed a proof-method leakage case shared with released 4.5, and
Explorers repeated approaches. The [release notes](release-notes.md) record
these tests, the later P01 resource comparison, and historical 4.5 results with
their distinct scopes. These samples establish neither general nonregression
nor formal certification.

## Library and development

Library entry points include `open`, `inspect`, and `readReport`. `open` is passive
by default (`execute: false`). It can initialize or change state without starting
research jobs or recovering model calls. Supply `execute: true` to run work and
authenticated `models` when using saved Pi credentials. Use
`await using owner = await open(...)` for automatic cleanup, or call
`await owner.close()` explicitly. `owner.state` returns a detached state snapshot.
For automatic campaigns, `await owner.wait()` returns the campaign result.
`await owner.resume()` retries a `call-failure` before waiting again.

For manual workers, create a fresh owner with
`open(path, {create, execute: true, startCampaign: false, models})`.
Call `await owner.start(request)` or `await owner.startGroup(requests)`.
They return a native Chord `Run` or an array of runs, respectively, with string IDs. Wait for
settlement with `await run.outcome(context)` and check the outcome's `kind`.
Requests select `explorer` or `verifier`. Explorer publishes its notes and
summaries. A Verifier selects work for checks. Pass `verify` in a Verifier
request to supply an explicit selection. Each invocation processes at most one
batch within `window`. A default Verifier may instead complete with result
`{status: "no-work"}` when no selected work remains, or
`{status: "busy"}` when its selection conflicts with competing work.
These results add no checks. Use `inspect(path, readNotes)` to read admitted notes.

Default Verifiers created together receive separate subsets of target notes,
frozen at admission. With `verifyOnSolution`, selection views may also include
eligible declared ancestors for explicit dependency checks. Checking supplies all
of each target's direct dependency statements. An empty selection view returns
`no-work` without a model call. Only selected targets can cause `busy`. Shared
dependencies are assumptions, and equivalent mathematics can still appear under
different note IDs.

[The worker example](examples/workers.ts) runs an Explorer followed by a default
Verifier:

```sh
bun examples/workers.ts task.json settings.json .xean/workers.sqlite
```

This interface uses the existing database owner. Manual Explorers and Verifiers
may overlap within `maxWorkers`. An automatic campaign owns admission while it
runs or awaits recovery. `startCampaign: false` only omits initial campaign creation.
Reopening with `execute: true` recovers unfinished jobs under their original IDs.
For a failed manual worker, call `owner.start({kind: "retry", job: id})`.
A retry preserves frozen inputs, publication references, and recorded receipts.
Running roles keep their note IDs and texts frozen. New roles see later
publications, while reads can update verification status for already-known notes.

`owner.running` is Chord's native `Watchable` of unsettled jobs. Read its current
value through `owner.running.value` or subscribe through its watch interface.
`owner.history` contains terminal job receipts. Chord state and Pi conversations
share the campaign SQLite file. Read persisted state without starting work:

```ts
const history = await inspect(path, (data) => data.history);
const notes = await inspect(path, readNotes);
```

The `inspect` callback receives `(data, session)`: Chord research state and a Pi
session for reading conversations and receipts. Stored status reports the last
committed state, not process liveness. Mathematical note texts stay in the
separate notebook database.

Fresh Explorer workers admit notes queued through `submitNotes`. A Verifier
without an explicit selection admits queued notes when no worker is active.
Explicit Verifier batches and retries leave queued notes for a later intake.
For manual exploration, pass advice as `{kind: "explorer", guidance: "..."}`.
The `guide` queue is consumed by the automatic campaign controller.

Campaign `status`, `inspect`, `resume`, and `export` commands require the automatic
campaign state. The default CLI runs the complete research loop with mixed workers.
Independent processes writing a shared notebook remain outside this interface.

Chord and Pi use vendored CI builds from [upstream commit
`9642f39a`](https://github.com/earendil-works/pi/commit/9642f39a80407a3bd0b778184400117a861cb8c2).
This pin includes Pi Durable's fixes for lost task wake-ups and provider resource
cleanup when a harness closes.
[Provenance](vendor/pi/provenance.json) records their hashes, package metadata
adjustments, and retained patches.

```sh
bun run check
bun run pack
```

`check` runs TypeScript, formatting, and tests. `pack` checks a clean installation
and writes `dist/xean-5.0.0-dev.4.tgz`. `bun run check:distribution` checks packaging
without retaining an archive.

## Citing `xean`

```bibtex
@misc{xean,
  author       = {Xu, Chao},
  title        = {{Xean}},
  howpublished = {\url{https://github.com/chaoxu/xean}}
}
```

Record the version or commit and model settings used in experiments.
Citation metadata is also available in [CITATION.cff](CITATION.cff).
