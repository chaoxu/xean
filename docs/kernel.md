# Xean kernel

Xean coordinates durable work over Pi's storage and execution APIs. The current
foundation pins matching packages from one tested Pi main commit and uses the
public `pi-durable` storage contract.
The [glossary](glossary.md) defines the shared terminology and code spellings.

## Responsibilities

| Component       | Responsibility                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `pi-ai`         | Models, providers, request conversion, streaming, authentication options, and transport retries                        |
| `pi-agent-core` | Agent and tool loops chosen by a role                                                                                  |
| Chord           | Native invocation context, cooperative cancellation, and prepared immutable campaign-state changes                     |
| `pi-durable`    | Native task, document, conversation, and entry records, IDs, atomic storage batches, and the SQLite schema             |
| `pi-telemetry`  | Optional native spans supplied through `XeanOptions.telemetry`                                                         |
| Xean            | Concurrent admission, sequential Coordinator decisions, whole-worker publication, campaign limits, and recovery policy |

Pi's public durable API supplies storage. Xean implements the campaign scheduler
against that API. The kernel introduces no workflow language or plugin sandbox.
Roles and Coordinator are trusted implementations.

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
`execution` supplies the attempt ID and call recorder. `context` is Chord's
native `Context`, with cancellation on `context.abortSignal`. Xean always
supplies that signal. Pi's public `getTelemetryContext(context)` helper from
`@earendil-works/pi-agent-core/harness/context` retrieves the attempt's telemetry
span. Pass these values directly to Pi's model and agent APIs.
Each role chooses its execution implementation, models, and tools. Pi-backed
roles use Pi's native loop, while research functions invoke Codex with its own
tools. The kernel has no campaign-wide model setting. A tool and a scheduled
role may call the same async function. Scheduling through the kernel supplies
the durable request and atomic publication boundary.

Coordinator implements `run(signal, view, execution, context)`, receiving a
committed campaign view and the same execution and Chord context types.
It returns its next JSON state, optional work requests, and an optional
completion candidate. Receiving a signal can be handled entirely in ordinary
code. Signals are `start`, `completed`, `failed`, user `input`, and `allowance`.
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

Worker attempts use their original immutable input. Coordinator attempts receive
a snapshot of committed state at the start of each attempt. The attempt-start
entry records enough information to recover that exact input before invocation.
Worker inputs and completed results remain in their Pi task records.
Coordinator entries freeze mutable view fields and reference those immutable
inputs and results. An input receipt cutoff selects the append-only input
history visible at that attempt's start.
`attemptInput(entryId)` reconstructs the historical worker input or
`{ signal, view }` for a Coordinator attempt. Its argument is the ID of a
`xean.attempt.started` entry from `records()`. Workers may finish while
Coordinator is considering an older snapshot. Their signals remain pending.

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
after the call cap is reached, or while the owner is closing.

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

A Coordinator decision commits its next state, consumes its pending signal,
and admits all new work together. A failed decision admits no partial work
batch. Coordinator attempts run sequentially while workers continue concurrently.

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
recovery also retries interrupted attempts. These retries repeat the whole
worker or Coordinator invocation within `limits.attempts`, which counts the
initial attempt too. Pi retains its transport retries inside each logical
provider call. Roles may also use its bounded assistant-call recovery through
`auditedStream`, retaining the current invocation while repeating one response.

An ordinary worker exception, or exhausted recovery allowance, ends that work
with a `failed` signal. Coordinator decides whether to dispatch new work.
An ordinary Coordinator exception or exhausted Coordinator allowance records
`blocked` and preserves its pending signal. No partial decision is committed.
`blocked` rejects new input. Explicit `resume()` renews the failed Coordinator
signal's attempt allowance and records its previous checkpoint, preserving the
signal ID, accepted input receipts, completed work, and immutable attempt history.
Call caps remain in force. If a concurrent worker reaches the call cap while
the campaign is blocked, add calls with `extendCalls()` before `resume()`.
During provider-call draining,
automatic retries stop. A worker failure becomes terminal, and a
Coordinator failure or exhausted allowance ends that signal so remaining work
and signals can drain.

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
pending worker results, external inputs, and grants reach fresh Coordinator
invocations. Accepted completion
preserves committed results and stops unfinished siblings. The mathematical
solver must implement the exact problem's verification requirements in this
acceptance policy.

| Operation or condition     | Behavior                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pause()`                  | Stops starting new attempts, lets active workers and Coordinator finish, then records `paused`                  |
| `resume()`                 | Resumes a paused campaign and runs queued work                                                                  |
| `cancel()`                 | Records `cancelled`, aborts active execution, and prevents late publication                                     |
| Request beyond call cap    | Sets `callLimitReached`, stops new workers, and lets active work and Coordinator signals finish                 |
| Terminal worker failure    | Records failed work and sends its `failed` signal to Coordinator                                                |
| Terminal Coordinator error | Records `blocked`, except while draining                                                                        |
| `close()`                  | Interrupts active execution, waits for it to settle, and closes storage without cancelling the logical campaign |

Pause preserves queued work and completion signals for resumption. An active
Coordinator can finish registering work that remains queued. Cancellation
uses cooperative abort signals. Roles and their tools must honor
those signals for prompt shutdown. Xean rejects a late result after cancellation
even if its role ignores the signal. `cancel()` and `close()` wait for active
execution to settle. A role that ignores cancellation can therefore keep them
waiting. Forceful process termination belongs to the supervising application.

An attempt remains active until its admitted provider calls finish settlement.
A failure cancels sibling calls and joins their accounting before releasing the
attempt. Returning with a pending admission or unsettled call fails the worker.
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

| Limit           | Meaning                                                                                                  | Default           |
| --------------- | -------------------------------------------------------------------------------------------------------- | ----------------- |
| `concurrency`   | Concurrent worker attempts, with Coordinator allowed alongside them                                      | `4`               |
| `attempts`      | Maximum invocations per logical worker or Coordinator signal, including initial and interrupted attempts | `3`               |
| `providerCalls` | Initial logical-call allowance, retained unchanged when reopening                                        | `null`, unlimited |

The kernel imposes no wall-clock deadline on campaigns or roles. Elapsed time
does not stop kernel admission or publication. Settings reject the retired
`deadline` field. Experiment and smoke runners add no such cutoff. Existing
dependency timeouts remain provider behavior and are tuned from measured data.

Token and dollar budgets are outside the planned scope. Usage records support
observation and comparisons. Pi's internal HTTP or WebSocket retry
attempts count within their logical call. A fresh call through the recorder
consumes another admission. A rejected call cannot dispatch through the audited
stream. Roles must use that integration for the kernel to account for calls.

The first request beyond the call cap sets `callLimitReached`. Calls already admitted
can settle, and active workers can publish their complete results. Coordinator
continues processing signals and can accept a completed result without another
provider call. New worker attempts stay queued, including work registered by
Coordinator during draining. Once active work and runnable Coordinator signals
are exhausted, the campaign becomes `limited` and remaining queued work is
preserved for a possible allowance extension. An accepted completion can finish
the campaign before that point.

Call-cap draining is tracked separately from pause and Coordinator blocking.
A pause still stops new Coordinator attempts while admitted workers settle.
Resuming a paused campaign
with `callLimitReached` continues draining without admitting new workers. A
call denial also preserves an existing blocked Coordinator failure.

`extendCalls(additional, key)` grants additional calls to a finite allowance.
`additional` must be a positive safe integer and `key` must be nonempty. It
returns a durable `{ id, key, value: additional }` receipt and creates a
separate Coordinator signal. An exact keyed retry returns the receipt without
granting the calls again, including after termination. Reusing a grant key with
a different count is rejected. `Campaign.callAllowance` exposes the effective cap.
The original `limits.providerCalls` stays frozen, so the same startup options
remain valid on reopen.

A grant can return a campaign stopped by its call cap to `running`, clear the
admission block, and make preserved work runnable. It does not invoke `run()`.
A paused campaign stays paused. A blocked campaign can receive a grant while
preserving its Coordinator failure and pending signal. Explicit `resume()` is
still required. Cancelled and completed campaigns reject new grants.
The CLI's `extend` command
uses the active owner's control socket or acquires storage offline.

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

`openXeanStorage(path)` uses Pi's `NodeSqliteDatabase` over Bun's `node:sqlite`
implementation and returns Pi's `SqliteStorage`. Pi owns the database
schema and its migrations. Xean uses native task records for work and pending
signals, a session document for campaign state, and entries for operational
history.
Store uses Pi's native Session to serialize mutations, acquire the campaign
document, prepare changes, commit record/document writes, and adopt them after
storage succeeds. Drafts close at native callback settlement, before storage
commits. Callback failures roll back private changes. Uncertain storage or
post-storage adoption failures stop the open instance. Store retains its task
cache and observes storage commits for wakeup revisions and fatal failures.
Pi's `StorageRejected` guarantees that a rejected batch made no durable change.
That error reaches the caller after rollback and leaves the instance usable;
it does not automatically retry the operation. Other commit errors remain fatal.
Unchanged state requires no document write. The document's `checkpointWhen`
keeps full bases as the persistence format.
The internal `PiTask` type represents those task records. Their native
`checkpoint` field stores `AttemptState` for whole-attempt recovery. Private
execution checkpoints remain deferred.

Xean's campaign state and campaign document use format version 6. Earlier formats
are rejected without migration. This Pi revision changes its initial SQLite
schema while retaining upstream schema version 1; old campaign files remain
provenance and must not be opened with this build. Task records still use native
version 1. Solver declarations have an independent format version.

Pi configures WAL journaling; Xean selects `synchronous = FULL`. Readers hold
consistent SQLite snapshots while the owner continues committing work. A separate
SQLite connection holds an exclusive transaction on `<canonical-database-path>.lock`
before Pi storage opens, so another owner cannot allocate IDs or schedule work
concurrently. That file contains no campaign state. Keep it in place: closing the
owner or terminating its process releases the operating-system lock automatically.
Symlinks resolve to the same ownership lock; hard-linked databases are rejected.

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
Lifecycle and solver input commands use the running owner's local Unix socket;
without an owner, those commands acquire ownership. Opening an interrupted
campaign for execution or mutation can write recovery records; reading it cannot.
`:memory:` is supported for isolated runs and tests without a sidecar lock.
Live backups must include SQLite's committed WAL data; copying the main database
file alone is insufficient.

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
runs Pi's native provider parser and tool loop through file-backed storage,
interrupts a provider call, and verifies settlement and whole-worker recovery.
No paid campaign is required to validate the foundation.
