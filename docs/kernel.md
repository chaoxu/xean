# Xean kernel

Xean coordinates durable work over Pi's storage and execution APIs. The current
foundation pins matching Pi 1.0.0 packages to one source commit and uses the
public `pi-durable` storage contract.
The [glossary](glossary.md) defines the shared terminology and code spellings.

## Responsibilities

| Component      | Responsibility                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`        | Models, providers, request conversion, streaming, authentication options, and transport retries                     |
| Chord          | Native invocation context, cooperative cancellation, and prepared immutable campaign-state changes                  |
| `pi-durable`   | Conversations, model and tool tasks, dispatch, cancellation, joining, recovery, records, atomic batches, and SQLite |
| `pi-telemetry` | Optional native spans supplied through `XeanOptions.telemetry`                                                      |
| Xean           | Concurrent admission, sequential Coordinator decisions, whole-worker publication, and recovery policy               |

Pi Harness executes tasks through the [local controls](pi-alignment.md#durable-integration)
that let Xean supply admission and publication policy. The kernel introduces no workflow language or plugin sandbox.
Roles and Coordinator are trusted implementations.
Their return shapes follow the TypeScript contract. Xean checks durable JSON,
work identity, registered roles, and acceptance when committing results.

Core exposes the kernel, solver, provider integration, and shared reports through
public library exports. The CLI and observer are optional applications with
separate entry points. Neither is a core dependency. `xean/report` projects
inspection data for both applications without starting a model or process.
The [repository package map](../README.md) defines their dependency directions.

## Opening and running

```ts
import { Xean, openXeanStorage } from "xean";

const xean = await Xean.open(await openXeanStorage(path), options);
try {
  const campaign = await xean.run();
  console.log(campaign.status);
} finally {
  await xean.close();
}
```

`options` supplies roles, Coordinator, and the exact task for a new campaign.
The application can also supply limits, acceptance, and native Pi telemetry.
A role supplies a `name` and `run(input, execution, context)`, which returns JSON.
`execution` supplies the attempt ID, one-based `attempt` ordinal, and call recorder.
For Coordinator, `inputId` identifies its frozen input entry in Pi. Requests can
reference this entry without copying the corresponding view.
Roles can use the ordinal to reject unsafe whole-worker replay. `context` is Chord's
native `Context`, with cancellation on `context.abortSignal`. Xean always
supplies that signal. `execution.telemetry` supplies the native Pi attempt span.
Pass it as `telemetryContext` to Pi's model and agent APIs.
Each role chooses its execution implementation, models, and tools. Pi-backed
solver roles use Pi Durable conversations, while research and the solver's
[Codex worker](solver.md#codex-worker) invoke Codex with its own tools.
The kernel has no campaign-wide model setting. A tool and a scheduled
role may call the same async function. Scheduling through the kernel supplies
the durable request and atomic publication boundary.

`execution.durable` exposes the owning task ID, invocation-bound `commit`,
`conversation`, `snapshot`, `memo`, and `context` operations, and the host's native
Registry and Models collection. A role installs its extension and creates a
conversation owned by that task, selecting the extension in the creating
transaction. On recovery, native descendants wait until the owner is active
and every selected extension is installed. The role removes its extension when
the invocation ends. Pi retains the conversation and its checkpoints in storage.
The kernel's Harness disables automatic compaction and generation retries and
executes tool rounds sequentially. Roles select their own models and use the
call recorder for every provider request.

Coordinator implements `run(signal, view, execution, context)`, receiving a
committed campaign view and the same execution and Chord context types.
It returns its next JSON state, optional work requests, and an optional
completion candidate. Receiving a signal can be handled entirely in ordinary
code. Signals are `start`, `completed`, `failed`, and user `input`.
Worker signals identify the work and its Pi task record. The committed view
contains the result or failure details.
Work, signals, input receipts, and publication references use Pi's native
`TaskId` type; journal entries and `attemptInput()` use `EntryId`. These remain
numbers in JSON. The brands prevent mixing record kinds in TypeScript.

Only Coordinator constructs work requests. Each request has a stable `id`, a
registered role name, and JSON input. Repeating an identical request reuses the
same logical work, including its completed result. Reusing its ID with different
content rejects the whole decision. Repeating a failed work ID retains its
failure. Coordinator uses a new ID when it chooses to try that work again.

Worker attempts use their original immutable input. A new Coordinator invocation
receives a snapshot of committed state. Recovery that resumes its private
conversation retains the original snapshot. An explicit retry of a blocked
Coordinator starts with a fresh view. The attempt-start
entry records enough information to recover that exact input before invocation.
Worker inputs and completed results remain in their Pi task records.
Coordinator checkpoints retain their attempt-start entry ID. These entries freeze mutable view fields and reference those immutable
inputs and results. An input receipt cutoff selects the append-only input
history visible at that attempt's start.
`attemptInput(entryId)` reconstructs the historical worker input or
`{ signal, view }` for a Coordinator attempt. Its argument is the ID of a
`xean.attempt.started` entry from `records()`. Workers may finish while
Coordinator is considering an older snapshot. Their signals remain pending.
Solver worker inputs contain a `view` reference and role arguments. Their
referenced Coordinator input can also be read with `attemptInput(view)` and
projected through the solver's `project()` to inspect the original note corpus.

`run()` returns when there is no runnable work, the campaign is paused or
blocked, or a terminal status is reached. Waiting leaves the status `running`.
The application may append `input(value, key?)` and invoke `run()` again.
Calls made while a run is finishing request another scheduling pass before
the shared run promise resolves.

## External input receipts

`input(value, key?)` commits an input signal and returns a
`{ id, key, value }` receipt. `Campaign.inputs` and `CampaignView.inputs` expose
all committed receipts immediately, ordered by ID, including inputs whose
Coordinator signals are still pending. The immutable receipt stays available
after its signal is consumed. The optional `validateInput(value, view)` callback
runs synchronously against the latest committed view before admission.

A supplied key makes retries idempotent. The same key and value return the
original receipt. A different value with that key is rejected. Exact retries
are resolved before lifecycle checks, so a terminal campaign can still return
an existing receipt. New inputs are rejected after termination, while blocked,
or while the owner is closing.

The solver uses these inputs for external notes, guidance, and harmless
corrections. Running workers retain their immutable requests. New Coordinator
views see the latest receipts, and `attemptInput()` reconstructs older views
using their saved receipt IDs.

## Atomic publication

A successful worker commits its entire JSON result, completed task receipt,
and Coordinator completion signal in one Pi storage batch. Until that commit,
its result is unavailable to Coordinator. A terminal worker failure commits
the failure receipt and `failed` signal together. Failed and interrupted
attempts publish no result. Operational records, including provider requests,
responses, attempts, and usage, remain inspectable.
Completed work exposes its `publicationId`, which orders that commit against
external input receipts. The solver uses this order when projecting corrections.

Private conversations commit their transcripts, tool results, and documents as
they run. The kernel joins owned work before publishing the role's result.
These private commits leave the shared campaign result unchanged. On failure,
Pi aborts and joins descendants before Xean publishes the failure receipt.

A Coordinator decision commits its next state, consumes its pending signal,
and admits all new work together. A failed decision admits no partial work
batch. Coordinator signals run in creation order, including recovery and failure
cleanup, while workers continue concurrently.

Shared mathematical content can be carried in a committed result. A dedicated
note schema, dependency closure, correction rules, verification reuse, and
source checking belong to the solver. The kernel preserves
JSON results and request identity.

Atomic publication applies to Xean's stored state. A role must arrange its own
idempotency for external effects such as file writes or remote requests that
may be repeated after interruption.

## Results and execution failures

A role returns logical outcomes as JSON, including unsuccessful outcomes that
Coordinator should consider. Only an explicitly thrown `TransientError` opts
into automatic retry for a known temporary execution failure. Close or crash
recovery also reenters interrupted invocations within `limits.attempts`, which
counts the initial invocation too. A role using private conversations resumes
their committed progress, including completed tool results. Other roles repeat
their invocation. Pi retains its transport retries inside each logical
provider call. Roles may also use its bounded assistant-call recovery through
`auditedStream`, retaining the current invocation while repeating one response.

An ordinary worker exception, or exhausted recovery allowance, ends that work
with a `failed` signal. Coordinator decides whether to dispatch new work.
An ordinary Coordinator exception or exhausted Coordinator allowance records
`blocked` and preserves its pending signal. No partial decision is committed.
`blocked` rejects new input. Explicit `resume()` renews the failed Coordinator
signal's attempt allowance and records its previous checkpoint, preserving the
signal ID, accepted input receipts, completed work, and immutable attempt history.
The retry receives a fresh Coordinator view. Roles distinguish resuming private
work from starting another request after a terminal failure.

Pi reports provider failures through native response messages. `auditedStream`
preserves that behavior. The role is responsible for identifying a known
transient execution failure before throwing `TransientError`.

## Acceptance and lifecycle

An application must supply `accept(candidate, committedView)` to authorize a
completion. A Coordinator completion proposal succeeds only when that callback
returns true. This synchronous guard receives the view at commit time and runs
inside serialized publication, so it should be fast and side-effect free.
A missing or rejecting guard is a Coordinator error. Validation that needs
model calls or tools belongs in ordinary work before the completion proposal.
The completion decision cannot admit new work. If another Coordinator signal is
pending, the kernel consumes the current decision and defers completion until
pending worker results and external inputs reach fresh Coordinator
invocations. Accepted completion
preserves committed results and stops unfinished siblings. The mathematical
solver must implement the exact problem's verification requirements in this
acceptance policy.

| Operation or condition     | Behavior                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pause()`                  | Stops starting new attempts, lets active workers and Coordinator finish, then records `paused`                  |
| `resume()`                 | Resumes a paused campaign and runs queued work                                                                  |
| `cancel()`                 | Records `cancelled`, aborts active execution, and prevents late publication                                     |
| Terminal worker failure    | Records failed work and sends its `failed` signal to Coordinator                                                |
| Terminal Coordinator error | Records `blocked`                                                                                               |
| `close()`                  | Interrupts active execution, waits for it to settle, and closes storage without cancelling the logical campaign |

Pause preserves queued work and completion signals for resumption. An active
Coordinator can finish registering work that remains queued. Native descendants
of admitted work continue during pause. They occupy their
owner's concurrency slot. Cancellation marks the ownership tree and Pi aborts
it from the leaves upward. Roles and their tools must honor
those signals for prompt shutdown. Xean rejects a late result after cancellation
even if its role ignores the signal. `cancel()` and `close()` wait for active
execution to settle. A role that ignores cancellation can therefore keep them
waiting. Forceful process termination belongs to the supervising application.

An attempt remains active until its admitted provider calls finish settlement.
A failure cancels sibling calls and joins their accounting and private work
before releasing the attempt. Shutdown can interrupt the private-work join,
leaving unfinished native aborts for recovery. Admitted calls still settle before
shutdown finishes. Returning with a pending admission or unsettled
call fails the worker.
A settlement error also prevents success, even if the role handles that error.
`auditedStream` owns settlement on all response and error paths. Direct recorder
users must settle every successful admission, including after `recordRequest()`
failure or cancellation, so shutdown can finish.

Reopening restores committed work and pending signals. Previously running tasks
become pending with their consumed attempts retained. Calling `run()` retries
those tasks within the remaining allowance. A recovered `pausing` campaign
becomes `paused`. Explicit pauses and terminal states survive reopening.
Supplying a different task, Coordinator identity, or limits on reopen is rejected.

Completed work is never rerun for recovery. A failure confined to one worker
loses at most that worker's uncommitted contribution. A process crash can
interrupt several concurrent workers.

## Limits and call records

| Limit         | Meaning                                                                                                  | Default |
| ------------- | -------------------------------------------------------------------------------------------------------- | ------- |
| `concurrency` | Concurrent worker attempts, with Coordinator allowed alongside them                                      | `4`     |
| `attempts`    | Maximum invocations per logical worker or Coordinator signal, including initial and interrupted attempts | `3`     |

Omitted limits and explicitly undefined known fields use these defaults.
Unknown fields and invalid values are rejected.

The kernel imposes no wall-clock deadline on campaigns or roles. Elapsed time
does not stop kernel admission or publication. Settings reject the retired
`deadline` field. Experiment and smoke runners add no such cutoff. Existing
dependency timeouts remain provider behavior and are tuned from measured data.

Token and dollar budgets are outside the planned scope. Usage records support
observation and comparisons but never stop admission or publication. Pi's
internal HTTP or WebSocket retry attempts count within their logical call. Each
fresh call through the recorder records another admission, and roles must use
that integration for the kernel to account for calls.

`auditedStream` from `xean/pi` wraps Pi's native `streamSimple` function. At Pi's
`onPayload` hook, it calls `recordRequest()` with a JSON snapshot after applying
the caller's hook and before returning control to Pi. This captures the hook
payload, whose serialization or later transformation by a provider can differ from the final
wire request. It awaits durable response settlement before emitting terminal
success. Pi retains its provider behavior, tool loop, cancellation options, and
retries. The role owns Pi session cleanup.
An optional third argument supplies Pi's `RetryPolicy` to `retryAssistantCall`.
Each recovered response attempt requires fresh admission and durable request
and settlement records. Failed responses settle before recovery begins, and
their tools never reach execution. Admission, request-recording, and settlement
failures are terminal. Cancellation also stops backoff. With no policy, the
wrapper returns the first attempt. Adapter-internal HTTP or WebSocket retries
remain inside that attempt's record.
For OpenAI Responses and Codex Responses, recovery snapshots completed encrypted
reasoning at Pi's `thinking_end` events. It validates usable signatures and
model identity, deduplicates item IDs, and replays only those completed items.
Pi still serializes them and executes the next request. The retry must leave
room for the model's maximum answer according to Pi's capacity estimator.
The model-facing successful message retains recovered reasoning for later
turns. Recorded responses and usage remain the originals from each attempt.
The narrow package patch retains reported failure usage and supports opaque
credentials on explicitly configured custom Codex endpoints.

The recorder also accepts non-Pi calls. Codex research records one admission
per subprocess invocation and preserves its native result
and usage. That admission does not limit the subprocess's internal model calls.

`records()` returns native Pi entries containing attempt starts, completions,
failures, interruptions, and provider call admission, request, and settlement.
Usage `null` means no measurement was identified. The patched Responses and
Anthropic adapters distinguish explicitly reported zero usage from absent,
empty, or invalid counts. Other adapters without a usage marker conservatively
record all-zero counts as unknown. Failure usage can be partial and does not establish the
provider's final bill. Reasoning tokens are included in output tokens.
After a process crash, a started call may have no settlement record.

## SQLite ownership and durability

`openXeanStorage(path)` uses Pi's SQLite adapter over Bun's native database
connection and returns Pi's `SqliteStorage`. Pi owns the database
schema and its migrations. Xean uses native task records for work and pending
signals, a session document for campaign state, and entries for operational
history.
Store uses Harness for owners and Session for inspection. Native Session
serializes mutations, acquires the campaign document, prepares changes, commits
record/document writes, and adopts them after storage succeeds. Drafts close at
native callback settlement, before storage
commits. Callback failures roll back private changes. Uncertain storage or
post-storage adoption failures stop the open instance. Store updates its task
projection through Pi's public post-adoption commit
subscription. After a failed operation, an empty Session commit detects native
poisoning without a Storage write.
Pi's `StorageRejected` guarantees that a rejected batch made no durable change.
That error reaches the caller after rollback and leaves the instance usable;
it does not automatically retry the operation. Other commit errors remain fatal.
Unchanged state requires no document write. The document's `checkpointWhen`
keeps full bases as the persistence format.
The internal `PiTask` type represents Xean worker and Coordinator records.
Their native `checkpoint` field stores `AttemptState`. Pi's generation and tool
tasks retain their own checkpoints and stay outside the campaign's work and
signal projection. Private transcripts and documents remain available through
Pi's conversation APIs.

Xean's campaign state and campaign document use format version 12. Earlier formats
are rejected without migration. This Pi revision changes its initial SQLite
schema while retaining upstream schema version 1; old campaign files remain
provenance and must not be opened with this build. Task records still use native
version 1. Solver declarations independently use version 13. The durable patch
adds Harness policy hooks, pause, and quiescence, exposes native task-record
mutation for atomic domain transitions, and retains entry attribution. The
[alignment notes](pi-alignment.md#durable-integration) describe these local extensions.

Xean configures WAL journaling, `synchronous = FULL`, and persistent WAL sidecars
so read-only inspection works after the writer closes. Pi queues asynchronous SQL
operations, caches statements, owns transaction handles and rollback, drains reads,
and performs writer checkpoints. Native close finalizes prepared statements
before releasing the connection. Readers hold
consistent SQLite snapshots while the owner continues committing work. A separate
SQLite connection holds an exclusive transaction on `<canonical-database-path>.lock`
before Pi storage opens, so another owner cannot allocate IDs or schedule work
concurrently. That file contains no campaign state. Keep it in place: closing the
owner or terminating its process releases the operating-system lock automatically.
Symlinks resolve to the same ownership lock. A database symlink must point to an
existing target. Hard-linked databases are rejected.

`await inspectCampaign(path, records = true)` opens a read-only connection and returns
`{campaign, records}` from one SQLite read transaction. It uses the same campaign
projection as owner inspection, without opening the kernel, running recovery, or
making model calls. Pass `false` to skip the journal, or a `RecordProjection` to
select records. It reuses Pi's document loading and paginated scans through the
existing Store. `openXeanStorage(path, {readOnly: true})` opens a read-only SQLite
connection and pins one read transaction. A small Pi patch adds a read-only
storage opener that checks its schema, skips migrations, and rejects writes and
ID allocation. The unpatched opener always performs writes during initialization.
Reader close skips Pi's writer checkpoint. Owner close releases the campaign lock
after closing storage; its zero busy timeout lets existing readers retain their
snapshots without delaying shutdown for a WAL checkpoint.

Inside the owner, `inspectWithRecords()` returns `{campaign, records}` from one
serialized point, so a worker publication cannot fall between its two reads.
An optional `RecordProjection` callback selects or reduces each detached record
as Pi pages are read. Returning `undefined` omits that record. Status retains only
call identity and usage through this callback. Full inspection remains the default.
Separate calls to `inspect()` and `records()` do not provide that guarantee.
The CLI's `inspect`, `status`, and `export` use independent read-only connections.
`inspect --allow-uninitialized` returns `{ "campaign": null }` when SQLite is
empty or Pi storage exists before campaign initialization commits. The library
reports this state with `UninitializedCampaignError`. Missing files, foreign
sessions, corruption, and incompatible versions remain errors.
Lifecycle and solver input commands use the running owner's local Unix socket;
without an owner, those commands acquire ownership. Before sending a command,
the client checks that the socket and its private directory belong to the current
user. Runners can assign
`--owner-id ID` when starting execution and use `--expected-owner-id ID` on
live commands. The serving owner checks the ID before mutation. Conditional
commands fail if that owner has ended or been replaced, with no offline fallback.
Opening an interrupted campaign for execution or mutation can write recovery
records. Reading it cannot.
`:memory:` is supported for isolated runs and tests without a sidecar lock.
Keep the database and retained `-wal` and `-shm` files together for read-only
inspection. Live backups must include SQLite's committed WAL data. Copying the
main database file alone is insufficient.

Pi retains complete Coordinator decisions. Xean drops their result payloads from
its resident task map after commit and on reopen, keeping signal inputs, worker
inputs/results, and historical reconstruction intact. Terminal tasks cannot be
rewritten through the mutation interface.

Tests cover concurrent snapshot readers, writes during reads, independent CLI
inspection, second-owner rejection, SIGKILL recovery, retained committed records,
and normal close/reopen. An injected SQLite failure after
partial task and document writes verifies transaction rollback. FULL sync is
configured. Power-loss behavior has not been tested.

The local checks also exercise concurrent workers, both reactive and
group-waiting Coordinators, failed decisions, pause, cancellation, limits,
acceptance, and provider accounting with offline fixtures. An end-to-end test
runs Pi Durable conversations through file-backed storage and interrupts a
provider call after a completed tool. It checks settlement before close and
private recovery without repeating that tool.
Native-child fixtures cover checkpoint recovery, frozen Coordinator inputs,
exhausted attempt allowances, cancellation, pause, and provider accounting.
No paid campaign is required to validate the foundation.
