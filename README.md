# Xean

Xean 4.1.0 runs a mathematical research workflow on native Pi Durable. Explorer
appends notes, Coordinator selects verification work, and Verifier checks source,
correctness, task requirements, and blind reconstruction in that order. Joint
reconstruction of generated dependencies strengthens the v1.0.0 acceptance policy.
Pi owns conversations, tasks, checkpoints, and SQLite storage.

The runtime uses Pi 1.2.0 at `b45e0eb`, with retained patches listed in
[provenance](vendor/pi/provenance.json). Pi handles responses interrupted by
`max_output_tokens` or `max_messages` limits, transport retries, and
interrupted-response context. Xean configures role limits and the
output-continuation prompt through Pi settings.
Pi retains truncated tool calls as text for resubmission. Ordinary verifier
contracts and Codex source requests retain their archived v1.0.0 fixtures. Explorer
and Coordinator acceptance instructions and reconstruction contracts reflect the
stronger policy. Native recovery and Coordinator history construction also differ
from that runtime. Correctness instructions clarify that declared support may
appear in the same verification batch.

Long responses can disconnect near 15 minutes and trigger recovery
([#24](https://github.com/chaoxu/xean/issues/24)). Retained progress and usage
from failed responses remain incompletely measured.

Coordinator treats supplied sources and generated notes uniformly. It forks Pi's
history at the newest compatible input boundary from a successful Coordinator call
and appends new notes and changed fields by note ID. First summaries, added
verdicts, and newly dead notes are ordinary updates, including any resulting loss
of verification. Previous Coordinator reasoning and tool output stay outside that
history.

Coordinator tries earlier native parent boundaries when corrections or accumulated
updates prevent reuse of the latest boundary. It appends the cumulative changes
from the chosen boundary, keeping retained input text plus the update within twice
the current snapshot's character count. If no boundary qualifies, it sends an exact
current snapshot. Recovery retains the call's recorded parent. Current failure
evidence remains available. Coordinator's OpenAI Responses calls use stable routing
headers within a campaign. Cache reuse depends on provider support, input length,
retention, and availability. These changes preserve the current notebook data,
while their effect on mathematical decisions requires evaluation.

The policy reference is Xean 1.0.0 at `d4af872`, with the transport repair at
`949a385`. This port requires Explorer continuation to be off. A valid note submission ends
that Explorer call. Mathematical note content is append-only, and corrections
use new notes. Coordinator files each note's summary once.
Internal acceptance remains a model judgment requiring independent mathematical
review. The 3.5 implementation is preserved in the separate `yean-3.5` repository
at `c546de8`, a rename-only fork of `148bb128`.

## Default mathematical policy compared with 3.5

This comparison uses the 3.5 implementation at `148bb12`, including its native
Explorer.

| Area                            | Current policy                                                                                                                                                                                                                                                                     | 3.5                                                                                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Note changes                    | Mathematical content is append-only. Corrections use new notes, and Coordinator files each summary once.                                                                                                                                                                           | Revision-checked edits preserve note IDs and invalidate affected checks. Explorer edits to mathematical content revoke external trust.                                                              |
| Context                         | Coordinator receives full note texts through snapshots or compatible deltas. Explorer receives all note summaries and Coordinator-selected support texts.                                                                                                                          | Coordinator and native Explorer receive note indexes and use `read_notes` for detailed summaries or full texts.                                                                                     |
| Explorer continuation           | A valid submission ends the call. The requested verification batches finish before the next Explorer turn.                                                                                                                                                                         | Native Explorer can publish multiple submissions within its response allowance. Coordinator chooses the next worker after the worker finishes.                                                      |
| Verification order              | Source, correctness, requirements, then reconstruction.                                                                                                                                                                                                                            | Correctness extracts checked statements and external premises before source checking, followed by requirements and reconstruction.                                                                  |
| Missing justification           | Correctness returns FAIL for unsupported inferences or unproved assertions, except omitted routine facts.                                                                                                                                                                          | Returns INCONCLUSIVE when missing justification is the only blocker. FAIL requires a concrete defect.                                                                                               |
| Source checks without retrieval | The source model assesses invoked results and applicability from supplied texts and mathematical knowledge.                                                                                                                                                                        | With retrieval disabled, unresolved extracted premises receive INCONCLUSIVE locally, without a model call for source checking.                                                                      |
| Batching                        | Drains Coordinator's ordered list in text-size batches, always including the first entry. Each reconstruction stage jointly handles eligible final roots and their generated dependency closure, deduplicated and sorted by note ID.                                               | Selects batches within each stage using model context and output estimates, including reconstruction batches.                                                                                       |
| Blind proof input               | Extracted statements and declared support IDs for every target, plus admitted source premise texts. Original target texts, summaries, verdict reports, and earlier proofs are withheld.                                                                                            | Checked statements and approved external premises across the dependency closure. Original proofs are withheld.                                                                                      |
| Trust and acceptance            | A final root needs all four PASS checks in one attempt, with generated ancestors' reconstruction PASS in that attempt. Earlier source/correctness checks may establish support. Admitted verified source dependencies are premise leaves. Selected roots are always reconstructed. | Caller trust grants correctness and source checks. Acceptance requires reconstruction throughout the dependency closure, including externally trusted notes, and the candidate's requirements PASS. |

Each eligible verification batch uses a joint statement extraction, blind proof,
and comparison. Reconstruction publishes the whole batch's verdicts atomically. A statement
correction replaces the complete statement batch, publishes no verdicts, and
triggers a new blind proof before comparison. Supporting lemmas need not satisfy
the task's completion criteria. Scripted regressions cover joint reconstruction
and interruption recovery. A fresh strict-cut campaign produced a self-contained
counterexample to an already-disproved conjecture and passed independent
`gpt-6-astra`/high review. It had no supporting notes. The separate Forni check
below exercised an admitted source premise. Neither tests live reconstruction of
generated dependencies. The P10 replay is prepared but has not run. Further
[qualification work](TODO.md) remains.

The earlier First Proof Batch 3 run tested `b9ee726` with curated source notes
and source checking without web access, before joint reconstruction of generated
dependencies. All ten candidates were internally accepted.
Independent review after source adjudication recorded nine PASS results and
P08 INCONCLUSIVE. Recorded API-equivalent costs were at least $134.48 for the
solver and $39.80 for independent review, excluding unreported usage. Those
results do not qualify open-ended retrieval or this version's stronger
acceptance policy.

## Run a fresh campaign

Use Bun 1.4.2 or later on macOS or Linux:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run xean init examples/task.json .xean/demo.sqlite examples/settings.json
bun run xean run .xean/demo.sqlite
bun run xean status .xean/demo.sqlite
bun run xean inspect .xean/demo.sqlite
bun run xean export .xean/demo.sqlite
```

The example settings use public OpenAI with `gpt-6-astra` and `max` reasoning.
Set `OPENAI_API_KEY` in the environment. The CLI also uses Pi's saved credentials
in `~/.pi/agent/auth.json`. Use `bun run pi` and `/login` to configure a supported
subscription. Set the matching provider and model in each role profile.
`PI_CODING_AGENT_DIR` selects another Pi credential directory.
The tested configuration uses OpenAI. Other Pi providers are accepted by the
configuration schema but remain unqualified.

`init` freezes the task and settings without model calls. `run` starts or recovers
the current native task. Closing the process suspends unfinished work. `resume`
explicitly retries failed work from its recorded progress. A turn-limit result
remains stopped. Inspect the returned outcome: `accepted`, `turn-limit`, or `call-failure`.
A successful process exit alone does not establish acceptance.

By default, Coordinator can request verification of intermediate notes during
exploration. To defer verification until a claimed complete solution, initialize
a fresh campaign with:

```sh
bun run xean init examples/task.json .xean/deferred.sqlite examples/settings.json --verify-on-solution
```

The flag sets `verifyOnSolution: true`, which can also be supplied in settings.
All verification, including source checking, waits until Coordinator nominates
a claimed solution for all four checks. Only nominated candidates and their
declared dependency closure are verified. The verification order, acceptance
criteria, and joint reconstruction stay unchanged. If no solution is accepted
after these checks, exploration continues while turns remain. The mode defaults
to off, keeps the Explorer turn allowance unchanged, and is frozen at `init`.

`status` reads compact progress. `inspect` includes notes, verification
evidence, and Pi's native per-conversation usage ledgers. These ledgers do not
count every outbound request or include external Codex source usage. Both read a consistent SQLite snapshot without starting model calls.
`export` writes accepted note texts and their support as Markdown, excluding
navigation summaries. Keep the
campaign database as the record of the attempt.

Supply caller notes or guidance while the campaign owner is closed:

```sh
bun run xean submit .xean/demo.sqlite notes.json --id initial-notes
bun run xean guide .xean/demo.sqlite guidance.txt --id try-construction
```

`notes.json` contains `{ "notes": [{ "text": "...", "support": [] }] }`.
Convert papers to text in `notes[].text` before submission. To admit a supplied
excerpt as an external premise, include its provenance and the caller's attestation:

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

This attestation grants source and correctness trust when the note serves as
support. A directly nominated candidate still receives its requested checks and
reconstruction. Include exact hypotheses and conventions, and admit only
established results. Conjectures and questions retain their status, and new
applications require verification. `verified` is derived, not an input attribute.
Omit `verification` for a note that needs source and correctness checks.
A stable `--id` makes an exact retry idempotent. Reusing it with different input
fails. These commands queue input without starting models or reopening a terminal
result. An active library owner can call `submitNotes` or `guide` through
`owner.root.commit`. Cross-process admission to a running CLI owner is not
implemented.

The six role profiles in [settings](examples/settings.json) select the models.
`maxExplorerTurns` defaults to 10. `window` defaults to 100,000 characters for
verification batches. Explorer works from the notebook without web access or
external tools. The example source profile runs through Pi without web access.
To enable Codex citation lookup, replace the `source` profile with:

```json
{
  "provider": "codex",
  "model": "gpt-6-astra",
  "reasoning": "high",
  "search": true
}
```

Install the Codex CLI and authenticate with
`codex -c 'cli_auth_credentials_store="file"' login`. The adapter reads
`$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`.
`search: false` disables search. Set `XEAN_CODEX_COMMAND` for another Codex executable. The source
adapter uses a temporary configuration and the native Codex credential. It ignores
user configuration and execpolicy rules, suppresses skill instructions, and
disables plugins. Search has no historical date cutoff. Codex writes its final
JSON result directly, and Xean validates that verdict object. Receipts retain the
result and raw stdout/stderr. Tool restrictions rely on Codex configuration.
Xean does not interpret the event log or independently audit tool activity.
Retrieved papers are not automatically imported as notebook notes.
Explorer has no literature-gathering tool. The host adds no process isolation.

Source verification checks invoked results, declared dependencies, and whether
the results' hypotheses apply. PASS means the model finds these established, or
finds no external result to check. FAIL identifies a concrete defect, such as a
source mismatch, missing dependency, or incorrect application. INCONCLUSIVE
identifies what the available evidence cannot settle. With search enabled, the
verifier is instructed to open authoritative sources when available. It may also
use mathematical knowledge and supplied texts, so a fresh lookup is not required
for every PASS. The runtime does not match each reported URL and result against
retrieved content. These verdicts remain model judgments.

Paired live checks with Codex 0.163.0 locally and 0.162.1 under Nomad, using
`gpt-6-luna`, demonstrated discovery and primary-paper retrieval for
[Forni's Lemma 3.5](https://arxiv.org/pdf/0706.3981v1). They returned PASS for the
exact attribution and FAIL when conservativity was omitted. This covers that
source and hypothesis distinction.

A separate applicability check admitted the exact Forni premise. It returned
PASS for applying it to $X=\partial_\theta$ on $S^1$ with invariant volume
$d\theta$, and FAIL for $X=\sin\theta\,\partial_\theta$, because smoothness alone
does not supply a positive smooth invariant volume. This checks only that
hypothesis distinction. Broad mathematical reliability remains unqualified.

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
`models`. Application data lives in Pi documents and task records.

Pure graph and prompt helpers exported by `xean/policy` return synchronously.
Existing `await` calls still work. Replace `.then(...)` chains with direct use of
the returned value.

Use fresh databases. Earlier Xean and Yean campaigns require their recorded
runtimes. This port provides no database migration.

## Check and package

```sh
bun run check
bun run pack
```

`check` runs TypeScript, formatting, and tests. Historical fixtures compare
ordinary verifier contracts and Codex source requests with the archived v1.0.0
runtime. Regression tests cover joint reconstruction, hidden proof inputs, atomic
verdicts, corrections, and acceptance within the same attempt. Native Pi tests
cover workflow replay, provider-limit recovery, and persisted limits.
`pack` copies `package.json` and the paths in its `files` list into staging,
creates an archive with system tar, and installs it with the frozen lockfile.
It checks imports and the executable CLI, runs the packaged tests, and writes
`dist/xean-4.1.0.tgz`. These checks exercise scripted behavior. Live mathematical
performance requires separate experiments under the stronger acceptance policy.
The pinned Pi artifacts and patches are recorded in
[vendor/pi/provenance.json](vendor/pi/provenance.json).
