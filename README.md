# `xean`

`xean` 4.3.0 runs mathematical research on native Pi Durable. Explorer appends notes,
Coordinator selects work, and Verifier checks source, correctness, task
requirements, and blind reconstruction. Acceptance requires reconstruction of
both the candidate and its generated dependencies. Pi manages execution and
recovery. This experimental branch stores admitted notes in a separate SQLite
notebook and retains their snapshot reference in Pi.

Reconstruction reuses previously reconstructed supporting notes from
the same campaign. Selected candidates still receive fresh reconstruction.

The bundled `@chaoxu/notebook-store` package has no dependency on Pi or `xean`.
Installing `xean` installs it automatically. A campaign at `campaign.sqlite`
creates `campaign.sqlite.notes.sqlite` for its notes. Both databases are needed
for recovery. This branch requires fresh campaigns and retains their original
paths. Back up both databases after closing all writers.

Other programs can read the notebook and publish new revisions through its API.
Campaign reads stay pinned to admitted content. External edits do not replace
checked notes or change accepted exports. An external commit makes the campaign's
next fresh note publication fail with a version conflict. This branch does not rebase
or automatically admit external changes.

Version 4 is deliberately narrow. It focuses on reasoning over prepared notes and
checking the resulting arguments. In the [reported trials](#qualification), that
scope was sufficient for many tested problems, at recorded costs we found
manageable.

`xean` provides citation checking, but no literature-discovery or paper-preparation
workflow. To give Explorer a source packet, find relevant papers separately and
convert their texts into notes with provenance, exact hypotheses, and conventions.
The optional Codex source verifier can retrieve cited results while checking
notes. It does not automatically import papers into the notebook. See
[paper admission](#supply-papers-and-notes) and [source verification](#source-verification).

## Start a campaign

Use Bun 1.4.2 or later on macOS or Linux. From an extracted release archive or
source checkout:

```sh
bun install --frozen-lockfile --ignore-scripts
cp examples/task.json task.json
cp examples/settings.json settings.json
```

The example settings use `openai/gpt-6-astra` with `max` reasoning. Set
`OPENAI_API_KEY` before running. For a supported subscription, use `bun run pi`
and `/login`, then select the matching Pi provider and model in settings.
The CLI reads Pi credentials from `~/.pi/agent/auth.json`.
It also loads custom providers and model overrides from `~/.pi/agent/models.json`.
`PI_CODING_AGENT_DIR` selects another Pi configuration directory.

Edit `task.json` to state the exact problem and what counts as completion:

```json
{
  "problem": "For every real x >= 1, prove x squared >= x.",
  "completionCriteria": "Give a self-contained elementary proof."
}
```

Set the models and [verification timing](#when-verification-runs) before
initialization. `init` freezes the task and settings without model calls:

```sh
bun run xean init task.json .xean/demo.sqlite settings.json
```

If the task needs reference notes, [submit them](#supply-papers-and-notes) now,
before the first `run`. The elementary example needs none.

```sh
bun run xean run .xean/demo.sqlite
```

While it runs, another terminal can read progress without starting model calls:

```sh
bun run xean status .xean/demo.sqlite
bun run xean inspect .xean/demo.sqlite
```

Read the outcome: `accepted`, `turn-limit`, or `call-failure`. A successful process
exit alone does not establish acceptance. After `accepted`, save the argument:

```sh
bun run xean export .xean/demo.sqlite > accepted.md
```

Keep both databases as the record of the attempt. Acceptance is an internal model
judgment. [Independent review](#what-does-accepted-mean) remains separate.

## Supply papers and notes

`submit` accepts text notes, not PDFs or arbitrary files. Convert relevant paper
text into `notes.json`. Preserve definitions, hypotheses, conventions, and source
provenance. To admit an established result as an external premise:

```json
{
  "notes": [
    {
      "text": "Source excerpt, including hypotheses and conventions.",
      "support": [],
      "verification": {
        "source": "Paper title, version, and section",
        "report": "Caller admits the established results under their stated hypotheses."
      }
    }
  ]
}
```

After `init`, while the campaign owner is closed:

```sh
bun run xean submit .xean/demo.sqlite notes.json --id initial-notes
```

`--id` identifies the submission. `xean` assigns note IDs at intake. A note's
`support` may name only existing notes that are not dead, not new notes in the
same submission. Use `inspect` to read assigned IDs. Repeating the same submission
ID and content is idempotent. Reusing an ID with different content fails.
New submissions require the notebook head to match the campaign's pinned version.

The optional `verification` attestation grants source and correctness trust when
the note serves as support. A directly nominated candidate still receives its
requested checks and reconstruction. Admit only established results at their
exact scope. Conjectures retain their status, and applications require checking.
Omit `verification` for notes needing ordinary checks. `verified` is derived,
not a submitted field.

These commands queue input without starting models or reopening a terminal
result. To add input to an interrupted CLI campaign, close its owner, submit,
then run again. Cross-process admission to an active owner is not implemented.

## Reading notes

Every note has authoritative full `text` and may also carry a short `summary`
and a `detailedSummary`. A detailed summary states the results with the definitions, hypotheses,
conventions, bounds, and limitations needed to apply them without reading the
proof. Summaries preserve explicit gaps and conditional claims. Imported and
generated notes use these fields alike.

Explorer starts with the summary index and Coordinator's suggested note IDs.
It may apply a verified result from a sufficient summary and cite the note as
support. It uses `read_notes({ids, level})` for detailed statements or full texts
when it needs proofs, constructions, or missing details, batching up to 20 IDs
per call. A missing detailed summary is returned as `null`. Full reads return
only the complete text strings in a JSON array, in the requested ID order.
Pi continues the conversation after each read, and a valid `submit_notes`
submission ends the Explorer turn.

Summaries carry the note's verification state. They do not establish unverified
results. The correctness verifier checks summary fidelity against the full text,
and verification reads full texts. Reconstruction uses full texts for new targets
and previously checked statements for reused dependencies. Supplied summaries
are the caller's responsibility. Source titles and chunk offsets alone cannot
supply a theorem's statement or hypotheses.

Coordinator uses summaries to select work and nominate solutions for verification.
It receives full texts only for notes lacking summaries. Supplied summaries avoid
its initial filing pass. Include their preparation cost when comparing campaigns.

## Models and verification

[Settings](examples/settings.json) contain profiles for `explorer`, `coordinator`,
`source`, `correctness`, `requirements`, and `reconstruction`. Each selects a
provider, model, and reasoning level. Pi runs these roles except when `source`
selects the special Codex CLI profile below. OpenAI models have been exercised.
Other Pi providers are accepted by the schema but remain unqualified.

`maxExplorerTurns` defaults to 10. `window` defaults to 100,000 characters for
verification batches, always admitting at least the first entry.

### When verification runs

By default, Coordinator can request checks of intermediate notes. To defer all
verification until a claimed complete solution, initialize with:

```sh
bun run xean init task.json .xean/deferred.sqlite settings.json --verify-on-solution
```

The flag sets `verifyOnSolution: true`, also accepted in settings. All checks,
including source search, wait until Coordinator nominates a claimed solution for
all four verifiers. Only nominated candidates and their declared dependency
closure are verified. The order, acceptance criteria, joint reconstruction, and
Explorer turn allowance remain unchanged. If no solution is accepted, exploration
continues while turns remain. This mode defaults to off and is frozen at `init`.

### Source verification

The example source profile runs through Pi without web access. To let Codex look
up citations, replace `source` with:

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
This profile is for the source verifier, not Explorer.

Source checking assesses invoked results, declared dependencies, and applicability:

- PASS: the model finds the results and their applicability established, or finds
  no external result to check.
- FAIL: a concrete defect, such as a source mismatch, missing dependency, or
  incorrect application.
- INCONCLUSIVE: available evidence cannot settle the check.

With search enabled, the verifier is instructed to open authoritative sources
when available. Mathematical knowledge and supplied texts remain permitted, so
every PASS need not involve a fresh lookup. Search has no historical date cutoff.
The runtime does not match each reported URL and result against retrieved content.

The Codex adapter uses temporary configuration, ignores user configuration and
execpolicy rules, suppresses skill instructions, and disables plugins. Codex
writes a final JSON verdict that `xean` validates. Receipts retain that result and
raw stdout/stderr. Tool restrictions rely on Codex configuration, without an
independent event-log audit or host-added process isolation.

## FAQ

### What does accepted mean?

The candidate passed source, correctness, requirements, and reconstruction in one
attempt. Its generated dependencies passed reconstruction earlier in the same
campaign or in that batch. Reuse reads the checked statements from Pi's recorded
comparison and keeps the notes' declared dependencies. Pi's frozen worker input
retains the receipt references across recovery. Earlier generated proofs and
verifier reports stay out of the blind proof input. Failed dependencies remain
unusable.
An admitted source dependency is a premise leaf. `verified` is weaker:
it establishes source and correctness over verified support, not task completion.
Models can make mistakes. Independent review is external to this campaign, and
neither assessment is a formal proof certificate.

### Can I use partial results or ask for improvements?

Notes can retain partial results and failed approaches. Read them with `inspect`.
`export` writes only accepted note texts and their support as Markdown, excluding
summaries. It does not produce a finished research paper.
For a better bound or generalization, state the exact improvement in the task's
completion criteria. Acceptance ends the campaign. A further target needs a new
campaign.

### Should I use guidance or notes? Can I change them?

Use notes for mathematical claims and reference material. Use `guide` for short,
fallible advice to the next fresh Explorer call:

```sh
bun run xean guide .xean/demo.sqlite guidance.txt --id try-construction
```

Close the CLI owner before adding guidance, as for `submit`. Guidance preserves
the frozen task and does not interrupt a running call. Mathematical note text is
append-only, so corrections use new notes. Coordinator files summaries once.
Explorer sees the summary index and requests detailed summaries or full texts
through the notebook reader.

### Can Explorer browse or execute code?

Explorer has no web, shell, or code-execution tools. Citation lookup is confined
to the optional [source verifier](#source-verification). Paper discovery,
preparation, and computational experiments require an external workflow.

### What happens after a failed or inconclusive check?

A source, correctness, or reconstruction FAIL makes a note and its dependents
dead. A requirements FAIL can leave a useful partial result verified.
INCONCLUSIVE leaves the check unresolved. Neither supplies the missing acceptance
check. If no candidate is accepted, the workflow returns to exploration while
turns remain.

A reconstruction statement correction replaces the complete statement batch and
publishes no verdicts. The first fresh correction triggers another blind proof
automatically. A repeated fresh correction stops with `call-failure`. Explicit
`resume` continues from the latest corrected batch.

### How do I stop, recover, and read usage?

Ctrl-C closes the owner and preserves recorded progress. `run` recovers unfinished
native work. After `call-failure`, inspect the error and use `resume` to retry it.
A `turn-limit` result stays stopped. Task and settings remain frozen.

Pi handles output limits and retryable transport errors. Long responses can
disconnect near 15 minutes ([#24](https://github.com/chaoxu/xean/issues/24)). Retained
reasoning and failed-response usage remain incompletely measured. `inspect`
includes Pi's per-conversation usage ledgers, which omit some outbound attempts
and external Codex source usage. Recorded costs can therefore be lower bounds.

## Policy and implementation

The policy reference is `xean` 1.0.0 at `d4af872`, with transport repair `949a385`.
A valid Explorer submission ends its call. Joint reconstruction strengthens the
original acceptance policy. The 3.5 implementation is preserved separately as
`yean-3.5` at `c546de8`, a rename-only fork of `148bb128`.

### Version 4.2.0 compared with 3.5

The comparison describes released 4.2.0, before reconstruction reuse, and 3.5 at
`148bb12`, including its native Explorer.

| Area                            | 4.2.0 policy                                                                                                                                                                                                                                                                       | 3.5                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Note changes                    | Mathematical content is append-only. Corrections use new notes, and Coordinator files each summary once.                                                                                                                                                                           | Revision-checked edits preserve note IDs and invalidate affected checks. Explorer edits to mathematical content revoke external trust.                                                              |
| Context                         | Coordinator receives a compact note index, with full texts for notes lacking summaries. Explorer receives the index and suggested IDs, then requests detailed summaries or full texts as needed.                                                                                   | Coordinator and native Explorer receive note indexes and use `read_notes` for detailed summaries or full texts.                                                                                     |
| Explorer continuation           | A valid submission ends the call. The requested verification batches finish before the next Explorer turn.                                                                                                                                                                         | Native Explorer can publish multiple submissions within its response allowance. Coordinator chooses the next worker after the worker finishes.                                                      |
| Verification order              | Source, correctness, requirements, then reconstruction.                                                                                                                                                                                                                            | Correctness extracts checked statements and external premises before source checking, followed by requirements and reconstruction.                                                                  |
| Missing justification           | Correctness returns FAIL for unsupported inferences or unproved assertions, except omitted routine facts.                                                                                                                                                                          | Returns INCONCLUSIVE when missing justification is the only blocker. FAIL requires a concrete defect.                                                                                               |
| Source checks without retrieval | The source model assesses invoked results and applicability from supplied texts and mathematical knowledge.                                                                                                                                                                        | With retrieval disabled, unresolved extracted premises receive INCONCLUSIVE locally, without a model call for source checking.                                                                      |
| Batching                        | Drains Coordinator's ordered list in text-size batches, always including the first entry. Each reconstruction stage jointly handles eligible final roots and their generated dependency closure, deduplicated and sorted by note ID.                                               | Selects batches within each stage using model context and output estimates, including reconstruction batches.                                                                                       |
| Blind proof input               | Extracted statements and declared support IDs for every target, plus admitted source premise texts. Original target texts, summaries, verdict reports, and earlier proofs are withheld.                                                                                            | Checked statements and approved external premises across the dependency closure. Original proofs are withheld.                                                                                      |
| Trust and acceptance            | A final root needs all four PASS checks in one attempt, with generated ancestors' reconstruction PASS in that attempt. Earlier source/correctness checks may establish support. Admitted verified source dependencies are premise leaves. Selected roots are always reconstructed. | Caller trust grants correctness and source checks. Acceptance requires reconstruction throughout the dependency closure, including externally trusted notes, and the candidate's requirements PASS. |

Each eligible verification batch uses joint statement extraction, blind proof,
and comparison. Batch verdicts publish atomically. Supporting lemmas need not
satisfy the task's completion criteria.

Coordinator uses Pi's compatible prior input boundaries to append new notes and
changed fields. It excludes prior Coordinator reasoning and tool output, bounds
retained input plus updates to twice the current snapshot's character count, and
sends an exact snapshot when no boundary qualifies. Recovery retains the recorded
parent. Stable OpenAI routing headers and preserved prefixes can support caching,
subject to provider support and availability.

Pi 1.4.0 at `4a080252` owns tasks, conversations, checkpoints, storage, and recovery.
Retained patches are listed in [provenance](vendor/pi/provenance.json). Ordinary
verifier contracts and Codex source requests retain archived v1.0.0 fixtures.
Explorer and Coordinator acceptance instructions, joint reconstruction, native
recovery, and Coordinator history construction differ from that runtime.

Create fresh campaigns with 4.3.0. Existing campaigns require their pinned
runtime: Pi's earlier SQLite schema is rejected without migrating the campaign database.

## Qualification

### Version 4.3.0

This release adds reconstruction reuse and native Pi tool-argument validation,
and upgrades Pi to 1.4.0. The tests cover dependency invalidation, fresh
reconstruction of selected candidates, recovery with frozen receipt references,
provider-generated optional fields, and read-only rejection of older databases.
The mathematical prompts and settings match the tested reconstruction-reuse
baseline. The ongoing INCONCLUSIVE and recheck-policy experiments remain separate.

### Version 4.2.0

The note-access experiment at `96aa0d5` ran two campaigns per First Proof Batch 3
problem with prepared source packets and `gpt-6-astra`/max. At the release
checkpoint, 18 of 20 campaigns had passed fresh independent review. Both P08
campaigns were still running.

Among the 16 pairs with independent PASS results for both this experiment and
4.1.0 controls, recorded solver cost fell from $254.19 to $166.10. Coordinator
cost fell from $81.29 to $7.77. These are observed API-equivalent costs, excluding
packet preparation, independent review, and unreported failed responses. The
comparison combines note access with prepared summary metadata, so it does not
isolate either change. Seven pairs finished faster, and median paired elapsed
time increased by 4.5%.

The final summary-reading change at `ad4541a` passed two live `gpt-6-luna`/high
role checks: Explorer applied a verified result using only its detailed summary,
and the correctness verifier rejected a summary that omitted a necessary
hypothesis. These narrow checks do not establish full-campaign performance for
the final prompt change.

### Earlier qualification

A fresh strict-cut control produced a self-contained counterexample to an
already-disproved conjecture and passed independent `gpt-6-astra`/high review.
TSP and First Proof P05 campaigns on `ad1f082` exercised generated dependency
reconstruction and passed fresh independent `gpt-6-astra`/high review with complete
original source packets. These bounded model assessments do not qualify every
later runtime change. The specific P10 replay and broader
[qualification work](TODO.md) remain pending.

Paired Codex checks with `gpt-6-luna` demonstrated discovery and primary-paper
retrieval for [Forni's Lemma 3.5](https://arxiv.org/pdf/0706.3981v1), returning PASS
for the exact attribution and FAIL when conservativity was omitted. A separate
applicability check admitted that premise. It returned PASS for applying the lemma
to $X=\partial_\theta$ on $S^1$ with invariant volume $d\theta$, and FAIL for
applying it to $X=\sin\theta\,\partial_\theta$.
These checks cover that source and hypothesis distinction, not broad reliability.

The earlier First Proof Batch 3 run tested `b9ee726` with curated source notes
and source checking without web access, before joint reconstruction. All ten
candidates were internally accepted. Independent review after source adjudication
recorded nine PASS results and P08 INCONCLUSIVE. Recorded API-equivalent costs
were at least $134.48 for the solver and $39.80 for independent review, excluding
unreported usage. This run does not qualify open-ended retrieval or the stronger
acceptance policy.

## Library

```ts
import { open, inspect, readReport } from "xean";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

const task = await Bun.file("examples/task.json").json();
const settings = await Bun.file("examples/settings.json").json();
const owner = await open("campaign.sqlite", { create: { task, settings } });
try {
  await owner.root.waitForIdle(context);
} finally {
  await owner.close();
}
const report = await inspect("campaign.sqlite", readReport);
```

`open` accepts injected Pi `models` and a `source` executor. It returns the native `harness`, root conversation, `close`, and
`resume`. Library callers using saved Pi credentials supply authenticated
`models`. Note records live in the external notebook. Pi retains execution
documents, task records, and frozen call inputs and results. `readReport` reads
the campaign's admitted snapshot.

Pure graph and prompt helpers exported by `xean/policy` return synchronously.
Existing `await` calls still work. Replace `.then(...)` chains with direct use of
the returned value.

Use fresh databases. Earlier `xean` and Yean campaigns require their recorded
runtimes. This port provides no database migration.

## Check and package

```sh
bun run check
bun run pack
```

`check` runs TypeScript, formatting, and tests. Regressions cover joint
reconstruction, hidden proof inputs, atomic verdicts, corrections, acceptance,
workflow replay, provider-limit recovery, and persisted limits.
`pack` stages `package.json` and its `files` list, creates an archive with system
tar, and installs it with the frozen lockfile. It checks imports and the executable
CLI, runs the packaged tests, and writes `dist/xean-4.3.0.tgz`.
