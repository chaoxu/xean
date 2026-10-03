# Xean vocabulary

Use these terms in code, prompts, and documentation. Before introducing a new
domain term, define it here and explain the distinction it adds. Preserve native
Pi names when referring to Pi APIs. Historical artifacts keep their original names.

## Campaign execution

| Term                   | Meaning and code spelling                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Campaign               | Durable computation that survives pauses, `run()` calls, and process restarts. `Campaign` is its inspected state.                                                                                                                            |
| Task                   | Exact objective. The solver's `Task` contains `problem` and `completionCriteria`. A CLI `Declaration` freezes the task, settings, and invocation kind.                                                                                       |
| Role                   | Callable implementation. Kernel `Role` handles dispatched work. `Coordinator` handles signals and returns a `Decision`.                                                                                                                      |
| Work                   | One logical request, identified by `WorkRequest.id`, with a role and immutable input. `Work` adds its execution status and result. Use work rather than job.                                                                                 |
| Attempt                | One execution of work or one handling of a Coordinator signal. Recovery starts another attempt for the same work or signal. `Execution` supplies its ID and call recorder.                                                                   |
| Worker                 | Informal name for a role executing work. Use work for its logical identity and attempt for a particular execution.                                                                                                                           |
| Call                   | One operation admitted by `CallRecorder.begin()`. It may be a Pi model call or a Codex invocation with opaque internal requests. `recordRequest()` records its payload, and `settle()` records its outcome and usage.                        |
| Signal                 | Durable notification for Coordinator, consumed with its committed decision. `Signal` covers startup, work completion or failure, and external input.                                                                                         |
| Input and receipt      | Input is data supplied to a callback. External `input()` returns durable `{id, key, value}` receipts, typed `CampaignInput`. `Campaign.inputs` contains external input receipts. A private tool reply acknowledges only that tool operation. |
| Result and publication | A result is a role's returned value. Publication makes the complete result and its Coordinator signal visible together. Storage commits also record operations that publish no work result.                                                  |

`PiTask` is the internal Pi task record for work or a Coordinator signal.
Its native `checkpoint` field contains Xean's `AttemptState`: attempt count,
identity, error, and the Coordinator's frozen input reference.
Pi generation and tool checkpoints recover private execution. Conversation
documents retain accepted submissions and consumed reads. `recordRequest()`
only records a call payload.

Pi's `Session` owns campaign-document drafts, prepares changes with Chord, and
adopts them after the SQL commit succeeds. A draft is a private mutable view,
and a prepared change is an immutable candidate for that commit.

A Pi storage session groups campaign records. A durable conversation retains
the private transcript and model/tool progress. A provider transport session
holds invocation-local connection resources. These lifetimes are distinct from
the campaign's lifetime. Native history entries record operations, while
signals also carry an obligation for Coordinator to process them.

A round in a bounded solver experiment is one Coordinator planning invocation
and its dispatched work. Handling a signal without planning consumes no round.
Model-call counts are observational accounting and do not impose a campaign stop.

## Mathematical search

| Term                   | Meaning and code spelling                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Profile                | Model configuration for a named call site. `ProfileName` and `profileNames` enumerate the Pi settings slots, including checks inside Verifier. A profile need not be a separately scheduled role.                                                                                                                                                                                                            |
| Note and support       | A note draft becomes shared mathematical memory on publication. The projected `Note` adds its durable ID and verification state. Its `support` lists notes whose results it uses. Reading alone creates no dependency. `summary` is the index view, `detailedSummary` preserves claims, conditions, and gaps, and `text` is the authoritative full note.                                                     |
| Imported note          | A note supplied by a caller through `submit`. Its projected `imported` flag establishes correctness and sources by caller trust, with verified support still required. This distinguishes trusted input from generated mathematics without inventing verifier checks.                                                                                                                                        |
| Premises and evidence  | `premises` lists external claims requiring source checks. Explicit hypothetical antecedents remain in the conditional claim, not this list. `ResearchReport.passages` records the current bindings. Reusable `SourceEvidence` preserves a quotation and its original premise as `statement`.                                                                                                                 |
| Candidate              | A claimed solution awaiting verification. `candidate: true` marks the last note in an Explorer, Codex worker, or external submission batch. The flag grants no verification or acceptance.                                                                                                                                                                                                                   |
| Verdict and acceptance | A check returns PASS, FAIL, or INCONCLUSIVE. A note is verified when checks or caller import establish correctness and sources over verified support. Acceptance additionally requires requirements PASS for the candidate and reconstruction PASS for the candidate and every generated dependency. Trusted imported support remains an assumption. An accepted solution completes the mathematical search. |

`Settings` holds configuration. `PiRuntime` supplies resolved models and profiles.
The [Codex worker](solver.md#codex-worker) is the optional `codex` role for
implementation assignments. Its workspace retains files outside the campaign
database, while its published notes enter the ordinary verification process.
Reconstruction proves a set of exact statements independently in one batch. Statement extraction preserves claims and definitions while withholding proof methods. Each successful check retains its statement, permitted external premises, and proof for reuse. Export assembles the accepted
notes into an argument. Source checking evaluates external premises, while
independent review audits the whole argument separately.

Kernel completion records the application's accepted result. Standalone role
and review campaigns can complete execution with a mathematical FAIL or
INCONCLUSIVE verdict. Independent review and catalog closure remain separate
from solver acceptance.
