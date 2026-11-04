# `xean`

`xean` is a mathematical problem-solving tool for other agents. A controlling
agent chooses a concrete problem, prepares reference notes, selects models, and
uses the CLI or library to run and inspect a campaign. It handles literature
discovery, computational experiments, scheduling across problems, and independent
review of the result.

Inside `xean`, Explorer chooses mathematical directions and reads or appends
notes. Coordinator files missing summaries and selects verification work.
Verifier checks sources, correctness, task requirements, and blind
reconstruction. Pi Durable manages execution and recovery. The outer workflow is
sequential, and a valid Explorer submission ends its turn.

The design keeps research policy small and aims to reduce repeated reasoning
costs. Explorer works from prepared notes and the model's learned mathematical
knowledge, with no browsing or code-execution tools. The controlling agent should
check current literature, including whether the exact problem has already been
settled, before preparing the notes.

The [FAQ](docs/faq.md) explains the design philosophy, what notes contain, the
division of work between agents, and the limits of the system. The instructions
below describe the current CLI and library.

## Start a campaign

This checkout is `5.0.0-dev.1` and requires fresh campaign databases. Use Bun
1.4.2 or later on macOS or Linux. From an extracted archive or source checkout:

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
boundary. `xean` assigns note IDs then. Caller-supplied `support` can name only
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

This attestation grants source and correctness trust when the note serves as
support. A directly nominated candidate still requires its requested checks and
reconstruction. Admit results only at their exact scope, retain conjectures and
gaps as such, and check applications. `verified` is derived, not a submitted field.

Mathematical text is append-only. Corrections use new notes. For short, fallible
advice to the next fresh Explorer call, close the owner and use:

```sh
bun run xean guide .xean/demo.sqlite guidance.txt --id try-construction
```

Guidance preserves the frozen task and does not interrupt a running call.
Cross-process admission to an active owner is not implemented.

## Reading notes

Full `text` is authoritative. Optional `summary` and `detailedSummary` fields
state results, hypotheses, conventions, bounds, limitations, and explicit gaps
without reproducing the proof. Supplied summaries are the caller's responsibility.
The correctness verifier checks their fidelity against the full text.

Explorer starts with the summary index. It can apply a verified result from a
sufficient summary and must cite the note as support. `read_notes({ids, level})`
reads up to 20 IDs per call. `detailed` returns statements and verification state,
with `null` for a missing detailed summary. PASS and external-attestation report
prose is omitted, while FAIL and INCONCLUSIVE reports remain. Full evidence stays
available through `inspect`. `full` returns only text strings in requested order.
Coordinator receives full text only for notes lacking summaries and files each
missing summary once.

## Verification and models

Settings select provider, model, and reasoning level for `explorer`,
`coordinator`, `source`, `correctness`, `requirements`, and `reconstruction`.
Pi runs each role except the special Codex source profile below. OpenAI models
have been exercised. Other Pi providers remain unqualified.
`maxExplorerTurns` defaults to 10 completed Explorer submissions. The turn cap
does not stop Coordinator or eligible verification work. This is not a time or
cost limit. `window` defaults to 100,000 characters for verification batches, always
admitting at least the first entry.

By default, Coordinator can request checks of intermediate notes. To wait until
it nominates a claimed complete solution, initialize with:

```sh
bun run xean init task.json .xean/deferred.sqlite settings.json --verify-on-solution
```

The flag sets `verifyOnSolution: true`, also accepted in settings. All checks,
including source search, wait until nomination. Only nominated candidates and
their declared dependency closure are checked. Verification timing is frozen at
`init`. If no solution is accepted, exploration continues while turns remain.

Acceptance requires source, correctness, requirements, and reconstruction PASS
in one attempt. Joint reconstruction covers the candidate and generated dependency
closure. Selected candidates receive fresh reconstruction. Supporting notes may
reuse successful reconstruction from the same campaign, and admitted verified
source dependencies are premise leaves. Blind proof input contains extracted
statements, declared support IDs, and admitted or reused premises. Extraction and
comparison see the original texts, while blind proof excludes original target
proofs and verifier reports. `verified` establishes source and correctness
over verified support, rather than task completion.

Source, correctness, or reconstruction FAIL makes a note and its dependents dead.
Requirements FAIL can leave a useful partial result verified. INCONCLUSIVE leaves
the check unresolved without marking the note defective. Models can make mistakes.
Acceptance and independent model review are separate assessments, neither a formal
proof certificate.

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
resume skips that ambiguous result to make a fresh call. Reconstruction can correct its
statement batch and retry automatically once. A repeated fresh correction stops
with `call-failure`, and explicit `resume` uses the latest corrected batch.

The independent `@chaoxu/notebook-store` package is bundled and installs with
`xean`. A campaign at `campaign.sqlite` creates `campaign.sqlite.notes.sqlite`.
Both databases are required for recovery. Close all writers before backing up
both, and restore them to their original canonical paths. Use fresh databases
for this version. Historical campaigns keep their pinned runtimes without migration.

Campaigns never share notes, trust, or reconstructed proofs. Other programs may
read the notebook and publish through its API, but campaign reads remain pinned
to admitted content. External commits are not automatically admitted and cause
the next fresh publication to fail with a version conflict. Existing checked
notes and accepted exports remain unchanged. New submissions also require the
notebook head to match the campaign's admitted version.

Pi handles output limits and retryable transport errors. Long responses can
disconnect near 15 minutes ([#24](https://github.com/chaoxu/xean/issues/24)).
`inspect` includes Pi's usage ledgers, which omit some outbound attempts and
external Codex source usage. Retained reasoning and failed-response usage remain
incompletely measured, so recorded costs can be lower bounds.

## Qualification

The 4.5.0 release's fresh campaigns on Pi 1.5.0 passed independent model review
for destroying rigidity, matroid t-connectivity, and First Proof P10. The
[release notes](release-notes.md) distinguish these runs from the earlier 4.4.0
comparison. This bounded validation does not establish general mathematical
nonregression or formal certification. Independent workers have not received
live-model qualification.

## Library and development

Library entry points include `open`, `inspect`, and `readReport`. Callers using
saved Pi credentials supply authenticated `models` to `open`. Always close the
owner after use. Pi owns execution and recovery.

The library also exposes independently callable workers. Create a fresh root
with `open(path, {create, startCampaign: false, models})`, then create a worker
inside `owner.root.commit` with `owner.workers.create(tx, owner.root.id, request)`.
Requests select `explorer`, `coordinator`, or `verifier`. Explorer publishes its
notes, Coordinator publishes summaries and returns verification selections, and
Verifier records checks. Wait on the returned native task ID with
`owner.harness.waitForTask(id, context)`. Use `inspect(path, readNotes)` to read
the admitted notes. `createWorkers` exposes the extension for native Pi hosts.

[The worker example](examples/workers.ts) runs Explorer, Coordinator, and the
first selected verification batch:

```sh
bun examples/workers.ts task.json settings.json .xean/workers.sqlite
```

This interface uses the existing database owner and admits workers sequentially.
It does not add parallel writers or share notes between processes.
`startCampaign: false` only omits initial campaign creation. Reopening preserves
existing tasks. Waiting on the same task ID recovers unfinished work. For a
faulted or aborted worker, create `{kind: "retry", task: id}`. A retry preserves
the frozen input and requires the same admitted notebook version.

Pi stores worker inputs, checkpoints, and outcomes in the campaign SQLite
file. Other agents can read those records without starting work:

```ts
const page = await inspect(path, (tx, root) =>
  tx.scanTasks({ conversationId: root }, 128),
);
const worker = await inspect(path, (tx) => tx.task(id));
```

Pass `page.next` as the third argument to `scanTasks` for the next page.
Stored status reports the last committed state. A `running` record can remain
after its process dies. Mathematical note texts stay in the separate notebook
database.

Fresh Explorer and Coordinator workers admit notes queued through `submitNotes`.
Verifier workers and retries leave queued notes for a later intake. For manual
exploration, pass advice as `{kind: "explorer", guidance: "..."}`. The `guide`
queue is consumed by the automatic campaign controller.

Campaign `status`, `inspect`, `resume`, and `export` commands require the automatic
campaign task. The default CLI keeps the complete sequential research loop.

Released Pi 1.5.0 packages are pinned in `package.json` and `bun.lock`, with
retained patches recorded in [provenance](vendor/pi/provenance.json).

```sh
bun run check
bun run pack
```

`check` runs TypeScript, formatting, and tests. `pack` checks a clean installation
and writes `dist/xean-5.0.0-dev.1.tgz`. `bun run check:distribution` checks packaging
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
