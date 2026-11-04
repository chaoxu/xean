# Frequently asked questions

## Who is `xean` for?

`xean` is a tool for an agent managing mathematical research. The controlling
agent turns a problem into an exact statement and completion criteria, prepares
relevant references, selects models, starts a campaign, and inspects its results.
It decides what to do with those results and arranges independent review.

The CLI and library are the control interfaces. A human can use them too, but the
intended workflow lets another agent handle preparation and follow-up. See the
[README](../README.md#start-a-campaign) for commands and configuration.

## What kind of problem should the controlling agent supply?

Supply a concrete mathematical target with explicit definitions, assumptions,
and completion criteria. A proof, counterexample, improved bound, or construction
can be a target if the required conclusion is precise. For a collection of open
problems, the caller selects and prepares each problem and runs separate campaigns.

Broader decisions, such as which topic to investigate or whether a new result
deserves a paper, stay with the controlling agent. The
[qualification record](../README.md#qualification) describes the tested cases.
It does not establish performance across arbitrary open problems.

## Why keep the system small?

Models choose mathematical directions and judge arguments. `xean` supplies a
consistent workflow, explicit dependencies, and recorded verification evidence.
Pi supplies execution and recovery. Keeping literature discovery, computation,
and cross-problem scheduling with the caller limits the operational machinery
inside the solver.

The design aims to make repeated attempts economical. It uses note summaries,
selective full-text reads, and reuse of established support to reduce repeated
work. Cost still depends on the problem, model, source preparation, and review.

## What is a note?

A note is mathematical working memory: a result and its proof, a source statement,
a partial argument with explicit gaps, or a failed approach and its diagnosis.
Its full `text` is authoritative. `support` names other notes whose results the
argument uses. Optional summaries help agents find and apply relevant material.

Keep exact hypotheses, conventions, conclusions, and limitations in the note.
Put citations and URLs in its text. A paper title or link alone does not supply
the mathematical content. Generated arguments declare their dependencies so
verification can check the supporting chain.

## Should literature search happen before a run?

Yes. The controlling agent should check current literature, including whether the
exact target has already been settled, and prepare relevant source notes. This
can supply results absent from the model's learned knowledge. Preserve source
versions, precise statements, and uncertainties about applicability.

After initialization, submit the packet before the first run:

```sh
bun run xean init task.json campaign.sqlite settings.json
bun run xean submit campaign.sqlite notes.json --id literature-v1
bun run xean run campaign.sqlite
```

Use the [note format](../README.md#supply-papers-and-notes). Submission queues the
notes without starting models. Execution assigns IDs and admits them at its next
intake boundary. Self-contained initial source notes can use `support: []`.
Caller submissions cannot refer to future IDs in the same packet.

## Why does literature discovery belong to the outside agent?

The controlling agent can use its existing search, paper-reading, and computation
tools to prepare the input. Explorer then receives the selected mathematical
material through notes. The outside agent's browsing conversation stays outside
Explorer's context.

Current `xean` has no literature-discovery role. Its optional Codex source verifier
can look up cited results while checking an argument. That is a separate operation
from discovering relevant literature and preparing new notes. The ordinary Pi
source profile has no web access. See [source verification](../README.md#source-verification).

## Can Explorer read the notes prepared by another agent?

Yes. Explorer receives the admitted note index and chooses detailed summaries or
full text through `read_notes`. Verification uses the supplied mathematical
content. The controlling agent can read admitted notes, queued submissions, and
checks through `inspect`.

Use the campaign's `submit` interface for admission. Direct external notebook
commits are not automatically admitted and can cause a version conflict.
See [reading notes](../README.md#reading-notes) and
[storage](../README.md#recovery-storage-and-usage).

## Are supplied papers and notes automatically trusted?

Ordinary submitted notes receive normal checks when selected for verification.
The caller can explicitly admit an established result through the optional
`verification` attestation. That grants source and correctness trust when the
note serves as support. It is a deliberate premise grant, not a flag indicating
that a citation is present. Preserve conjectures, gaps, and uncertain source
matches as unresolved.

A directly nominated candidate still receives its requested checks and
reconstruction. [The README](../README.md#supply-papers-and-notes) specifies the
attestation and dependency rules.

## Can a run produce useful work without solving the problem?

Yes. Notes may record lemmas, partial results, counterexamples to attempted
approaches, and unresolved steps. Use `inspect` to recover that work. A verified
supporting lemma may be useful while failing the original task's completion
criteria. The `export` command is reserved for an accepted argument and its
support.

## What does an accepted result mean?

The candidate passed source, correctness, requirements, and reconstruction in
the same verification attempt. Generated dependencies
also require reconstruction, with reuse of successful supporting reconstructions
from the same campaign. Admitted verified source dependencies are premise leaves.

Acceptance is an internal model assessment. The controlling agent should arrange
independent review before treating a result as established. Model review also
remains distinct from a formal proof certificate. See the complete
[verification rules](../README.md#verification-and-models).

## Is there a fixed time or cost budget?

`maxExplorerTurns` limits completed Explorer submissions. The turn cap does not
stop Coordinator or eligible verification work. It does not impose a wall-clock
or monetary limit. The controlling agent manages its overall budget and scheduling.

`inspect` reports Pi's recorded usage. Some failed or external calls have
incomplete accounting. Include source preparation and independent review when
comparing total research costs.

## Can I use other models or run code?

Settings select a provider, model, and reasoning level for each role. Pi runs the
roles except the optional Codex source profile. The CLI uses Pi's credentials and
custom model configuration. OpenAI models have been
exercised, while other providers remain unqualified for this workflow. See
[models](../README.md#verification-and-models).

Explorer has no code-execution tools. The controlling agent can perform
computations externally and supply the findings and reproducible evidence as
notes. Claims based on computation still need evidence supporting their exact
scope. Manuscript preparation also belongs to the outside agent.

## How does the controlling agent steer or recover a run?

Use `status` for the outcome and error, and `inspect` for notes, checks, and usage.
Ctrl-C closes the CLI owner while preserving recorded progress. `run` recovers
unfinished native work. After `call-failure`, inspect the error and use `resume`.
Accepted and turn-limit campaigns remain terminal.

With the CLI owner closed, `guide` queues advice for the next fresh Explorer call,
and `submit` queues additional notes. Neither changes an already frozen call.
Mathematical corrections use new notes. Cross-process admission to an active
owner is unsupported. [Recovery instructions](../README.md#recovery-storage-and-usage)
cover the campaign and notebook databases.

## Can campaigns share knowledge or run together?

The controlling agent can manage separate campaigns, each with its own execution
and notebook databases. Their admitted notes, verification trust, and reconstructed
proofs remain isolated. To reuse material, the caller prepares an explicit input
packet for a fresh campaign and decides which premises it is admitting.

Inside a campaign, the outer workflow remains sequential. The caller owns
scheduling across problems. Keep historical campaigns with their pinned runtimes
and preserve both databases when backing up a campaign.

## Can another agent call the workers directly?

The library can create a root with `startCampaign: false` and invoke Explorer,
Coordinator, and Verifier separately. Each worker publishes its own notes,
summaries, or checks before completing. The caller chooses the sequence and waits
on Pi's native task IDs. Unfinished tasks recover under the same ID. Faulted or
aborted workers need a `{kind: "retry", task: id}` request, which preserves their
frozen input and requires the same admitted notebook version.
[The worker example](../examples/workers.ts) shows a pass through the roles and
the first selected verification batch. [The library instructions](../README.md#library-and-development)
explain queued-note intake and manual Explorer guidance.

This interface retains a single database owner and sequential worker admission.
The ordinary CLI still runs the full research loop. Independent workers do not
enable concurrent notebook writers or transfer knowledge between campaigns.

## Where can an agent inspect current work?

Pi stores worker inputs, checkpoints, and outcomes in the campaign SQLite file.
Use the library's `inspect` with Pi's `tx.scanTasks` or `tx.task` to read those
records without starting models. Stored status is the last committed state,
which can outlast the process that wrote it. Note texts remain in the separate
notebook database. See the [library examples](../README.md#library-and-development).
