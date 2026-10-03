# Aligning Xean with Pi

Pi supplies model execution, durable transactions, and task execution. Xean supplies campaign
policy and the mathematical workflow. The [kernel contract](kernel.md) defines
publication and recovery, and the [solver guide](solver.md) defines mathematical
acceptance. This document records native API ownership and the gaps that still
prevent further delegation.

## Sources and availability

The Pi/Chord packages are pinned to
[`a276dabe5791`](https://github.com/earendil-works/pi/tree/a276dabe57911253350bffb93cb7d7aff6a73261),
the main revision checked on 2026-10-02 after the Pi `1.0.0` release. It adds
Anthropic inline tool definitions that preserve the initial cache prefix,
retry classification for model-capacity errors, and provider fixes, including
Bedrock Claude thinking replay after system or tool changes. Its Kitty image
conversion changes affect Pi's TUI and coding agent. Xean uses neither those
packages nor Bedrock profiles. Pi Durable,
Chord, and telemetry source are unchanged from the previous pin. Pi Durable
remains experimental. The
[artifact record](../vendor/pi/provenance.json) identifies the source, frozen
model catalog, reproducible builds, and retained patches.

This refresh preserves the frozen model catalog and Xean's model/reasoning
settings. The upstream changes replace none of the retained local patches.
Both patches are byte-identical to the preceding `9fba660cf1ca` build and apply
to the new artifacts. Native tool-change handling remains Pi's
responsibility. Xean's frozen read allowances and complete-result publication
remain application policy.

The [public durable types][types] and [Session implementation][session] supply
transactions, documents, records, typed IDs, snapshots, conversation forks, and
public commit subscriptions. Pi implements a [durable task scheduler][scheduler],
Harness, persistent model/tool turns, task ownership, structured concurrency,
conversation views, and compaction. Their contracts are in the [Pico5 specification][spec].
Xean adopts Harness with local admission, pause, recovery, and failure-settlement
extensions described below. These extensions are not upstream APIs.

Xean registers its worker and Coordinator tasks in one named Pi extension.
Pi resolves models, tools, prompt sections, hooks, and environments per
conversation through `pi.agent`. Built-in model roles use native private
conversations; other roles remain opaque functions. Campaign format is 11. Start fresh campaigns and
retain old runtimes for existing runs.

Xean is an application of Pi Durable: work and signals are native tasks,
private model interactions are conversations, and state changes use native
documents and transactions. Role functions define the mathematical procedures.
Xean also defines which work may start, when results become shared, and what
constitutes an accepted solution. These policies run on Pi's execution engine.

## API ownership

| Responsibility             | Current implementation and reason                                                                                                                                                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models and transport       | Pi catalogs, provider factories, auth helpers, conversion, and streaming. Xean profiles select models and endpoints.                                                                                  |
| Role execution             | Pi Durable owns private conversations, generation and tool tasks, argument validation, and replay. Xean hooks enforce submission and invocation limits.                                               |
| Turn state                 | Native transcripts determine response counts and continuation. A conversation document retains the accepted result and admitted read IDs.                                                             |
| Context capacity           | Pi's estimator runs before each request. Xean reserves answer space and hands off prior valid submissions. Automatic compaction is disabled.                                                          |
| Provider recovery          | Pi `retryAssistantCall` owns classification, backoff, and bounds. Xean records each admitted call and selectively retains completed reasoning.                                                        |
| Transactions               | Native Session owns serialization, document caching, draft preparation, rollback, atomic storage, and adoption.                                                                                       |
| Record identities          | Native `TaskId`, `EntryId`, `DocumentId`, and `Seq` identify tasks, entries, documents, and commits. Task creation returns the native ID.                                                             |
| Storage                    | Pi's SQLite adapter supplies statements, transactions, and records over Bun's native connection. Xean configures persistent WAL, ownership, and read snapshots.                                       |
| Cancellation and telemetry | Harness owns invocation cancellation and joining; Chord contexts carry the signal. `Execution.telemetry` carries the native Pi attempt span.                                                          |
| Scheduling and publication | Harness dispatches admitted tasks and recovers interrupted work. Xean admission policy enforces concurrency, Coordinator serialization, and limits. Xean publishes each whole result with its signal. |
| Mathematical state         | Xean owns dependency closure, verification stages, corrections, evidence binding, and exact acceptance. Notes derive from immutable results and input receipts.                                       |
| CLI and observation        | Optional sibling apps use public core APIs, including `xean/report`. Core depends on neither app. Read-only inspection uses Pi scans. Live mutations reach the active owner through a local socket.   |

A kernel role needs only its name and `run(input, execution, context)`. Tool
descriptions belong to Pi's tools. Solver and standalone execution call the same
functions, with lazy runtime construction. Research and the optional
[Codex worker](solver.md#codex-worker) invoke Codex through Execa,
whose argv, stdin, process cancellation, and separate-output contract remains
necessary. Pi's shell surface does not supply that contract.

## Durable integration

Store opens Harness for the campaign owner and `createSession` for inspection.
It validates campaign format, task, limits, Coordinator identity, and required
roles before Harness recovery can write. A new campaign uses `Harness.root()`
with an initializer to create the root, native conversation documents, and
campaign document atomically. Pi assembles the initialization storage batch.
Its typed campaign document uses full bases
through `checkpointWhen`. Native transactions validate task conversation
membership and ownership. Xean detaches values at external boundaries because
native records and drafts can be Session-owned. Coordinator copies its callable
input once and derives its prompt and note reader from that frozen copy.

Store uses `Session.subscribeCommits()` to update its task projection after
document adoption. Startup subscribes before refreshing recovered tasks and
preserves newer commits observed during those reads. Pi owns commit observation
and poisoning. After a rejected
operation, an empty Session commit checks whether the instance remains usable
without a Storage write.
Migration-only commits notify observers. Pi also rejects `now()` and
`report()` on ended invocations and cleans up failed Harness opening independently
of caller cancellation.
The task projection avoids repeated full scans. Completed Coordinator payloads
stay durable but leave the resident cache.
`StorageRejected` guarantees a failed batch made no durable change and leaves
the instance usable. Unknown commit outcomes and post-storage adoption failures
stop the instance.

The durable patch adds the following generic Harness controls. The unpatched
revision reserves every eligible task, has no domain failure hook, and seals
Session writes before joining on close.

- `admitTasks` selects a batch and its checkpoints on the Session transaction
  line. Xean uses it for concurrency, sequential Coordinator invocations, pause,
  call-cap draining, and attempt-start records. A pause during an unfinished
  admission rolls back the batch and its records.
  Native candidate order is not signal order. Xean admits only its oldest
  unfinished Coordinator when that task is eligible, including after recovery.
- `onTaskFailure` can replace a runtime-generated `faulted` or `orphaned` outcome
  and stage domain records in the same transaction. Xean publishes a worker's
  failure signal or blocks a failed Coordinator without losing its signal.
- `pause({interrupt: true})` cancels invocations and rejects their late runtime
  commits while keeping Session writes open. `waitForQuiescence()` joins admitted
  invocations and their final transactions, including when admission holds queued
  work. Xean waits for call settlements before closing the Session.
- `onTaskRecovery` writes outer-attempt interruption history in the transaction
  that resets running tasks to pending. Native descendants retain their own
  checkpoints and recover through Pi.
- Generation's `beforeRequest` accepts a task-scoped stream and request options.
  Xean supplies `auditedStream` with the owning execution and frozen profile.
  Generation hooks propagate failures, and `afterTools` can terminate or append
  a continuation at the native atomic boundary. These narrow extensions retain
  accounting, capacity guards, and structured handoff without a second loop.

Harness owns the invocation map, dispatch, cancellation, joining, and recovery.
Its pause state also gates execution between explicit Xean `run()` calls.
Invocations return terminal outcomes through native `runtime.commit()`, alongside
the result and Coordinator signal. Pi owns transition validation and retirement.
Xean uses conversation-owned tasks because workers are opaque functions and
Coordinator schedules their work independently.
Its scheduler yields between passes so synchronous work cannot starve external
cancellation. A pending checkpoint yields a logical retry back to admission.
Xean registers executable task definitions and uses native task creation.
Native descendants run within their admitted owner's slot, including during
draining. They wait until the resumed owner has reinstalled its conversation's
extensions. Xean projects only its outer tasks into campaign work and signals.
Pi owns child checkpoints and waits for owned work before terminal settlement;
Xean joins it before publishing a shared result. The patch retains an outer
checkpoint while it is completing so domain failure settlement can identify
the attempt after owned work has been cancelled.
The patch exposes existing `Tx.setTask()` for external campaign transitions,
such as cancellation, blocked-signal resumption, and admission failure. It
preserves explicit entry attribution outside an invocation. Native validation,
transaction assembly, retirement, and publication own these operations.
Reassess these local extensions when equivalent upstream controls become available.

The separate owner lock protects Pi's ID allocator and Harness execution while
allowing independent readers. Xean selects FULL synchronization. Read-only
transactions give inspection coherent snapshots. The upstream opener always
runs migrations, so the read-only patch skips writes, validates the schema, and
rejects mutation and ID allocation. Reader cleanup avoids a writer checkpoint.
SQL remains the backend direction.

Pi owns asynchronous SQL execution, operation ordering, statement caching,
transaction handles, rollback, read draining, and close. The adapter patch
accepts Bun's structural connection and normalizes missing-row `null` to Pi's
`undefined`. Read-only document loading uses the already pinned snapshot,
avoiding a nested write transaction, and reader close skips the writer checkpoint.
Bun's public `fileControl` enables
`SQLITE_FCNTL_PERSIST_WAL` on writers. Without retained WAL sidecars, the locked
runtime can fail read-only reopening with `SQLITE_CANTOPEN` after writer close.
The Node connection API does not expose this setting. Native `close(true)`
finalizes prepared statements before ownership is released. Reassess this patch
when Pi supports Bun connections or upstream provides the required WAL control.

Native paging bounds each read, but consumers must also bound retained data.
Status projects call metadata per page. Exports reverse Pi's newest-first scans
to retain chronological order. Native scans lack entry-kind and field projection.
Historical worker inputs/results stay in immutable task records. Coordinator
attempt entries freeze mutable view fields and reference those records. Session
documents are current-only, and `task(id)` returns current state, so native
snapshots cannot reconstruct a past Coordinator view. Task documents retire at
completion and cannot hold permanent notes. Coalescing Chord watches cannot
replace durable signals, receipts, or history.

Xean's JSON boundary keeps Chord's strict-value check followed by serialization.
Native `copyJson` preserves negative zero and null prototypes, whereas SQLite's
encoded representation normalizes them. The boundary keeps live, reopened, and
idempotency-comparison values consistent.

## Provider integration

Role profiles keep their selected model objects and credentials. Registering
models with the host preserves models already supplied by other roles, including
custom IDs absent from a provider's catalog. Generation resolves that native
catalog before Xean's stream hook supplies the selected profile's request.

`auditedStream` uses Pi's awaited `onPayload` hook to record the effective request
before dispatch, then settles accounting before terminal delivery. Cancellation
during settlement preserves the recorded provider outcome and usage while
returning an aborted stream. Admission and
accounting failures remain terminal. `onResponse` runs at HTTP headers and does
not cover Codex WebSockets. Telemetry cannot replace durable admission or
settlement. Context capacity belongs in the fail-closed generation request hook.

The Pi AI patch preserves failed-response usage, typed provider errors, explicit
zero counts, retry-listener cleanup, cache-session isolation, and the existing
JSON/serialization allocation fixes. Authentication, invalid requests, context
limits, and quota failures remain terminal even when their details resemble
transport errors. Retryable typed WebSocket failures use Pi's HTTP fallback.
Anthropic and Google catches retain `normalizeProviderError` output so native
retry classification sees HTTP status rather than only error-message wording.
Remove those hunks when both adapters preserve `providerError` upstream.
The retry pattern matches `terminated` as a word so JSON `Unterminated string`
errors do not trigger transport retries. Remove that change when upstream narrows
the pattern or uses an equivalent classification.
Patch hashes and build qualification remain in the artifact provenance.
The upstream changes leave all retained patch guarantees unresolved. Deferred
request-body serialization and JSON repair allocation are performance patches,
separate from transport correctness, authentication, and accounting.
The Codex SSE patch normalizes CRLF framing after joining incoming chunks.
Remove it when the native parser handles CRLF, including split line endings.

Pi drops failed messages from normal input. Xean retains only completed
encrypted reasoning items, checks identity and capacity, and preserves original
call records. Failed text, unfinished reasoning, and tool calls remain excluded.
Pi also derives OpenAI's prompt cache key from its transport session ID. Xean
replaces only that generated default with a model/system/tools hash, preserving
caller keys and disabled caching. Native selective replay and an independent
cache-key option would remove these integrations.

Explorer supplies the task and each index entry as separate user messages,
followed by mutable note states, feedback, guidance, and allowances. Pi preserves
those message boundaries during Responses conversion. Xean keeps tool definitions
stable when the read allowance is exhausted. Native schema validation precedes
tool execution; the reader then reserves its task ID in the private conversation
document. Sequential execution bounds several calls in one response, and replay
of an interrupted safe tool cannot charge twice. Unknown IDs consume an admitted
read; schema-invalid arguments do not. Pi owns the transcript and tool results,
while Xean owns the allowance and final-response restriction.

For public OpenAI Responses models that advertise explicit cache support, the
payload hook marks stable prefix messages as cache boundaries. It preserves
`cacheRetention: "none"` and caller-supplied explicit cache policy. When reading
ends, `allowed_tools` restricts calls to the remaining tools without changing
their definitions. These controls are covered through Pi's native request
conversion with a local transport fixture. They have not been live-qualified on
the public API. Codex Responses currently uses local read enforcement without
these payload additions. Pi's native `configure({ tools })` changes tool
availability. Anthropic can represent removals inline while preserving initial
definitions, but OpenAI Responses replaces the request-level tool list, changing
the cache prefix. A provider-neutral restriction that preserves tool declarations
and per-message cache controls would remove the corresponding payload hooks.
Read admission would remain necessary to bound multiple calls in one response.
Removing a reader before its admitted task finishes also prevents Pi from
resolving that tool for safe replay after interruption.

Role conversations begin with a native system entry declaring their complete tool
catalog and executable tools in their selected extension. This keeps the provider request's
top-level `tools` array present when a structured submission is required,
including after Pi retries a rejected submission; a later-only declaration can
leave Codex with `tool_choice: required` but no tools and is rejected by the
provider.

ChatGPT Web's [service boundary and role policy](solver.md#configuration-and-functions)
live in the solver guide. The adapter uses Pi's `createProvider`, `lazyStream`, `contentText`,
Responses transport, and transcript conversion. The tested wire contract is:

- `POST {baseUrl}/responses` accepts the complete Responses input, including
  native function-call/result items, the model and reasoning setting, and
  `stream: true`. When tools are declared, `text.format` with `type: "json_schema"`
  carries the strict schema for the `text` and `calls` envelope. Native tool declarations
  are omitted.
  Error results include failure text because Responses has no error flag.
- The adapter supplies thread/turn identity in
  `client_metadata["x-codex-turn-metadata"]` and the matching current-user
  `internal_chat_message_metadata_passthrough.turn_id`. These are transport
  fields, not a requirement for Xean to manage browser sessions.
- Responses SSE's terminal `response.completed` must contain exactly one
  assistant message with `phase: "final_answer"` and the original `output_text`.
  Commentary, incomplete output, and ambiguous final answers cannot become
  submissions. Token-by-token streaming is unnecessary.

The provider's custom API identity excludes browser answers from OpenAI reasoning
replay. Transport retries, solver response retries, and recovered browser-worker
sends remain disabled. Client cancellation prevents late publication but does not
establish that remote generation stopped. `/healthz`, `/v1/models`, and setup or
browser-control APIs are outside Xean's required interface. The old `chatgpt-cli`
Chat Completions path is retired, with no fallback.

The [live qualification](kernel-smoke.md#chatgpt-web) records the tested external
runtime, its answer-preservation patch, and the exercised paths. That deployment
is evidence for the contract, not a required installation layout.

The official [Workspace Agents API](https://developers.openai.com/workspace-agents/trigger-runs)
can trigger a workspace agent and report its status, but cannot currently retrieve its
answer. It therefore cannot supply Pi model responses. Its workspace-scoped
authentication does not establish personal Pro availability.

Claude uses Pi's native `anthropicProvider`, backed by `@anthropic-ai/sdk`.
Pi owns API-key and Pro/Max OAuth authentication, message conversion, tool calls,
streaming, and usage. Xean uses the same profile and call recorder as other models.
The CLI accepts an operator-supplied token through `apiKeyEnv`; library callers
can supply Pi's credential store for OAuth refresh. Native OAuth qualification
is recorded in [verification](kernel-smoke.md#native-anthropic).
The separate Claude Code provider, subprocess bridge, and provider patch are removed.

## Private conversation recovery

Each built-in Pi stage owns a native conversation under its outer task. Native
submission request IDs deduplicate startup; completed stages return their stored
result without another call. Pi resumes unfinished generation and tool phases.
Xean retains validated submissions and admitted read IDs in a conversation
document, derives response counts from the transcript, and reuses the frozen
Coordinator snapshot after interruption. Logical retries of terminal failures
start a new conversation. Shared notes still publish only when the worker succeeds.

A verifier stores validated source batches in native task memos keyed by their
exact input. Recovery reuses the original source-report IDs, keeping later Pi
stage inputs stable. The memo is private to the worker and requires no additional
storage or publication mechanism.

The task document maps each stage's input identity to its conversation in the
same transaction that creates it. Pi's first-writer-wins memos cannot replace
this mapping after a terminal failure or atomically create the conversation.
The conversation document holds Xean's accepted submissions and read allowance.
These are application documents managed by Pi.

Pi persists validated tool arguments and replay intent before execution, then
commits the result and terminal state together. Reads and submissions are safe
to replay: reads use frozen input and admission IDs; a submission's state change
and receipt are keyed by its native tool task ID. Other tools keep their declared
replay policy. Native ownership joins or aborts child tasks before settlement.

Automatic compaction is disabled and mathematical tools have explicit output
limits that preserve full text. The stream wrapper retains call admission,
effective-request recording, and settlement even when cancellation bypasses
generation hooks. Native generation retries are disabled because the audited
stream already uses Pi's response retry policy. ChatGPT Web cannot replay an
interrupted browser send. An unfinished Codex subprocess restarts as a whole call.
Deferred model requests are rejected because native polling does not yet pass
through the call-admission and settlement wrapper.

## Next adoption opportunities

Revisit these when compatible upstream APIs reduce the overall implementation
or an observed failure justifies a change. The linked closed issues record why
publication waiting, catalog merging, and capacity handoff remain as implemented.

- **Durable execution:** replace the local Harness extensions with upstream
  admission, domain settlement, and pause controls when available. Preserve
  atomic whole-worker publication and durable failure delivery. Native ownership
  delays a task's terminal state, but writes made in its callback commit
  immediately. A [success-settlement callback](https://github.com/chaoxu/xean/issues/15) could replace the success-path
  wait. Failure handling would still need to join owned work.
- **Role configuration:** [conversation-scoped model resolution](https://github.com/chaoxu/xean/issues/16) would remove
  shared catalog merging. A [stop decision in `beforeRequest`](https://github.com/chaoxu/xean/issues/17) would let a role
  hand off an accepted submission at capacity without recognizing a persisted
  capacity-error message. The pinned APIs provide neither operation.
- **Session health:** replace the empty-commit check when Session exposes fatal
  state directly. Public commit observation is already adopted. Document watches
  alone do not replace the scheduling projection or durable signals.
- **Live activity:** `taskGraph()` and `watchTaskGraph()` expose committed live
  tasks, ownership, and owned conversations. They omit terminal tasks and their
  inputs, checkpoints, results, and errors, so they cannot replace the campaign
  projection. Watches may coalesce frames and belong to an open Harness whose
  startup performs recovery. Independent inspection continues to use Session.
- **Accounting and patches:** adopt native awaited admission and settlement
  when late accounting survives cancellation. Remove the read-only opener and
  provider patches as equivalent upstream guarantees become available.
- **Forks:** native `Tx.forkConversation()` copies conversation documents using
  their `asOf`, `current`, or `initial` policy. A whole-campaign branch also needs
  session state and a concrete publication/ownership contract for the experiment.
- **Continuation:** `incomplete.max_messages` and length-truncated output are
  separate from transient retries. Add either for a demonstrated workload need.

Changing role implementations during a run, alternate storage, and a second task
framework remain deferred. Invocation-specific extensions are registered today
to bind frozen inputs, tools, and call accounting. Current validation is recorded in
[kernel verification](kernel-smoke.md).

[types]: https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/durable/src/types.ts
[session]: https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/durable/src/session/session.ts
[scheduler]: https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/durable/src/harness/scheduler.ts
[spec]: https://github.com/earendil-works/pi/blob/a276dabe57911253350bffb93cb7d7aff6a73261/packages/durable/docs/spec.md
