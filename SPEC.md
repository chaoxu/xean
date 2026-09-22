# xean core specification

This file is the normative contract for xean.

## Purpose and boundary

xean provides four guarantees:

1. one append-only SQLite campaign artifact containing exact candidate material;
2. an exact record of each call, its selected tool declarations, admitted tool inputs and results, and final call result, plus the JSON-semantic payload exposed before each Pi provider operation;
3. verdicts bound to fresh successful calls carrying the ID of the exact stored candidate; and
4. a derived, witnessed verification status requiring every declared verifier to pass and none to fail.

The kernel owns durable campaign facts, generic observation, and provider accounting. `xean-solve` owns the mathematical workflow. `xean-lab` owns experiments, execution provenance, and analysis. `xean-observe` owns HTTP serving, caching, and rendering. Applications own coordination, routes, context assembly, source search, computation, retries, budgets, filesystem policy, publication, and user interfaces.

## Runtime and dependencies

Runtime and dependency versions are pinned in `package.json` and `bun.lock`. xean uses Bun SQLite for persistence, Zod for input validation and JSON Schema generation, and Pi for the bundled model loop. xean exposes Pi's types directly instead of maintaining local copies. The implementation contains no custom SQL parser, JSON Schema validator, model loop, provider client, identifier generator, or native lock binding.

## Campaign artifact

A campaign is one SQLite database. The database uses SQLite's `journal_mode=DELETE` rollback journal, `synchronous=FULL`, a five-second busy timeout, strict tables, and append-only triggers. Each journal entry and each payload is one atomic row insertion. `createCampaign` creates a new artifact, `openCampaign` reopens an existing artifact for appends and performs any required rollback-journal recovery, and `openReader` opens an existing artifact without write access. WAL-format headers and `-wal` or `-shm` sidecars are outside the artifact contract and are rejected before SQLite opens the file. SQLite serializes writes. Applications remain responsible for ensuring that only one writer attempts a logical phase at a time.

xean campaigns use SQLite schema 2. The declaration records the schema and application identity, and a reader rejects an artifact whose schema is not the current one.

Creation uses an exclusive private file create and never overwrites an existing path. The schema and campaign identity commit together. A crash before that commit may leave an invalid file, which readers reject and an operator must remove before retry. The artifact is not tamper-resistant against an operator with raw filesystem or SQL access.

Copy a campaign only after its handles close. If a crash left a rollback journal, open and close the campaign with `openCampaign` before copying so SQLite completes recovery. A reader refuses an artifact that requires recovery rather than mutating it. Preserve an unexpected WAL artifact unchanged; checkpoint and convert only an operator-controlled copy with trusted SQLite before opening it as a xean campaign. Copying the file while a writer is active is not a supported live snapshot; that requires SQLite's backup facilities.

The positive `entries.seq` of a candidate, call, or tool call is its campaign-scoped identifier. It is not portable between campaign databases. Every submission creates a distinct candidate row, including submissions with identical bytes.

All database methods are synchronous because Bun SQLite is synchronous. External execution through `call` and `runPi` is asynchronous.

## Records

Every record has a positive `seq`, an informational nonnegative `atMs`, and one closed kind. Only `seq` determines order.

| kind | durable fact |
|---|---|
| `campaign` | application id and JSON configuration |
| `candidate` | exact material bytes and frozen nonempty verifier set |
| `call` | label, optional stable role, optional candidate sequence, exact JSON request, and selected tool declarations |
| `tool-call` | call sequence, optional provider source id, tool name, and validated JSON input |
| `call-result` | parent call sequence and either returned JSON or thrown error text |
| `tool-result` | parent tool-call sequence and either returned JSON or thrown error text |
| `verdict` | successful verifier-call sequence, verdict, and JSON evidence |

Rows and public values are validated with closed Zod schemas. The row primary key supplies identity. SQLite uniqueness constraints permit one campaign, one result per parent, and one verdict per call.

`Reader.records(query?)` returns exact entries in sequence order. Its optional `RecordQuery` intersects `kinds`, `labels`, `excludeLabels`, `call`, `parent`, `after`, and `through`. Labels select calls and their call-results. Excluded labels omit both. The `call` and `parent` filters match those top-level entry fields. `after` is exclusive and `through` is inclusive. An empty positive filter selects nothing, while an empty exclusion changes nothing. SQLite applies indexed kind, label, call, parent, and sequence filters before entry bodies are fetched and parsed. `record(seq)` retrieves one exact entry or `undefined`, and `lastSequence()` reads only the latest sequence. Capture that sequence and pass `through` when several reads must refer to one immutable journal prefix. Calling `records()` without a query retains its full-history behavior. `material(candidate)` on a campaign or reader returns the exact stored candidate bytes, and the exported `verdictSchema` is the Zod schema for `PASS`, `FAIL`, or `INCONCLUSIVE`.

`Campaign.storePayload(value)` returns the SHA-256 digest of the JSON-serialized payload. `Reader.payload(digest)` reconstructs those JSON serialization semantics, including property order. The `payloads` table stores each distinct serialization once under its digest, so identical payloads share one row. Literal reference-like keys are ordinary data. Reads verify the stored body against its digest. The table is append-only.

`Campaign.storePayloadJson(encoded)` accepts serialized JSON without an intermediate caller-side object copy. It parses the string and applies `JSON.stringify` before hashing and storage, normalizing whitespace, duplicate keys, and numbers under JavaScript JSON semantics. Malformed JSON is rejected before any write. Both payload methods use the same storage format and preserve literal `__proto__` keys.

Payload storage is explicit and does not rewrite or expand an `Entry`. An application may include a payload digest in its versioned request protocol, then retrieve that payload only for full inspection or replay. Saving a payload before its journal reference can leave an unreferenced immutable payload after a crash. A saved payload alone records no dispatched request or provider result.

## Calls and tools

```ts
interface CallOptions {
  readonly label: string;
  readonly role?: string;
  readonly candidate?: EntryId;
  readonly request: Json;
  readonly tools?: readonly Tool[];
  readonly signal?: AbortSignal;
}

interface CallContext {
  readonly call: EntryId;
  readonly request: Json;
  readonly tools: readonly AuditedTool[];
  readonly signal: AbortSignal;
}

campaign.call(options, runner): Promise<{ call: EntryId; output: Json }>
```

`call` validates and snapshots the optional role, optional candidate sequence, request, and each tool declaration, appends `call`, and then invokes `runner` with that recorded request. It appends one `call-result` if the runner settles. A crash may leave only the call row. Labels identify specific operations and retain their application semantics. Roles identify stable application actors so observers can group changing call labels without interpreting application vocabulary. Package projections recognize their own records through strict versioned request discriminators rather than a reserved namespace.

A tool is defined with `defineTool({ name, description, input, run })`, where `input` is a Zod schema. Every valid repetition of `run` after an interrupted phase must be harmless. Pure and read-only actions qualify; a write qualifies only when an application-stable semantic key or reconciliation rule survives phase restart. xean records `z.toJSONSchema(input)`. An audited wrapper parses each invocation with the same schema, appends `tool-call` before `run` executes, and passes `run` the containing call sequence, tool-call sequence, optional provider source ID, and abort signal. It appends one `tool-result` after settlement. Invalid arguments do not run `run`. Schema getters and refinements are allowed and must be pure. Transforms are unsupported because the frozen JSON Schema cannot represent them. The call stops accepting new tool invocations when its runner settles and waits for every admitted tool invocation before writing its result. `close()` refuses while a local call remains active.

A `tool-call` without a `tool-result` has an unknown outcome. xean does not retry it or invent a result. The application can combine its own campaign namespace with the campaign-scoped tool-call sequence to reconcile the original external record; a retried phase receives a new sequence. Non-idempotent external effects are outside the tool contract.

The runner receives only the tools listed in `CallOptions`. The kernel never adds tools. Applications must keep tools semantic and policy-checked; they must not wrap the whole `Campaign`, expose SQL or the database path, offer generic record append, or provide unrestricted candidate or filesystem access. Application-supplied runners and Pi registries are trusted not to add capabilities outside this set.

## Pi runner

`runPi(campaign, options)` executes one fresh Pi interaction through the campaign's ordinary `call` method. Its initial loop and continuations share that durable call. Without a submission gate, they also share one aggregate turn cap. The strict outer request carries `protocol: "xean/pi-run/v3"`; strict request checkpoints carry `protocol: "xean/pi-request/v1"`, so projections recognize Pi state by protocol rather than application labels. The root request freezes the provider, model ID, API, base URL, system prompt, prompt, requested reasoning level, and a JSON model profile containing Pi's reasoning flag, thinking-level map, context window, output limit, sampling parameters, and compatibility settings. The application selects a real model from the registry returned by `builtinPi`, then supplies that registry, label, optional candidate ID, optional tools, and optional abort signal. Without a submission gate, a tool batch in which every tool result succeeds ends the call without another provider request, and an error result continues the loop. Applications remain responsible for stricter cardinality such as exactly one submission; gather other observations in earlier calls. A failed result stores the transient-error classification as `providerRetryable`: Pi's provider-error classifier plus codex-lb's transient gateway error text and the codex adapter's `provider_transport_failure` diagnostic; authentication, quota, invalid-request, and context-length error text is never retryable. Cancellation uses `state: "cancelled"`. Context overflow uses `state: "failed"`, `providerRetryable: false`, and the error `Pi exceeded its context window`. xean freezes the resulting classification and leaves restart policy to the application. `builtinPi({ credentials })` accepts Pi's re-exported in-memory credential store for OAuth or API-key use.

An optional `submissionGate: {completeArgument, emptyArgument?, contextBudgetTokens?, maxResponses?, continuationPrompt}` freezes a stopping rule for the call's sole submission tool. Each assistant response may call that tool once. Every valid submission executes and returns its tool result. Pi continues in the same context until the named boolean argument is true, the optional `emptyArgument` names an empty array in the validated submission, the optional response budget is reached, or the context estimate reaches the budget minus Pi's native safety margin and the reserve. `maxResponses` is a positive safe integer limiting non-error model responses, including the first, plain text, length-limited output, and rejected submissions. A value of 1 permits at most one such response. Provider errors use the separate recovery allowance. Internal provider retries share the response count, while a fresh call starts a fresh budget. A gate without `emptyArgument` treats an empty submission as nonterminal while response and context budgets remain. After every nonterminal submission, Pi appends the frozen `continuationPrompt` as a fresh user message before the next provider operation. The context budget caps total context at the smaller of `contextBudgetTokens` and the model's context window. Omitting it uses the model's window. The frozen model profile retains the actual model capacity, and the reserve is the model's maximum output tokens. At the threshold, finalization takes precedence over continuation feedback. Pi's native turn hooks continue unfinished text and length-truncated responses in the same context while response and context budgets remain. A recorded tool execution error ends the call. Schema validation rejected before the audited tool-call record returns feedback for correction in the same conversation while responses remain. Pi's native context estimator uses the latest applicable usage plus estimated trailing messages. Before the threshold, Pi's native output-cap helper preserves the reserve. At the threshold it releases that space for finalization. A budget that leaves no usable context after the safety margin and reserve is rejected. Providers must honor output caps for the allocation to hold. The gate replaces the ordinary aggregate-turn and length-continuation bounds, while transient-error recovery, cancellation, and overflow handling remain bounded as described below. At either limit, a valid submission ends the call. Exhaustion without a valid final submission is a failed call. Applications derive their saved submissions from the journal, including after failure. This gate controls handoff and grants no mathematical verification status.

A durable call whose result is a length-truncated failure is a dead end: the application preserves it and starts a fresh root call from explicit state.

xean supplies Pi only the audited wrappers selected for that run and asks supported providers to constrain each tool call to its JSON Schema, with ordinary tool calling as the fallback. Zod still validates every admitted input. Pi executes its own tool loop, provider calls, retries, and transcript construction. xean stores Pi's native transcript, including system messages carrying the prompt and tool declarations, Pi-native usage, and stop reasons, without inventing provider identity or cross-provider accounting. Without a submission gate, a final Pi `stop` or a tool batch in which every tool result succeeds is successful. Context overflow, token limits, deferred work, protocol errors, and cancellation are not successful, and a tool batch containing an error result never ends the call successfully.

`runPi` returns a full `PiResult` with `call`, `text`, `transcript`, and outcome. Its durable call-result stores a compact `piResultRecord`: outcome, call identity, per-assistant usage, and `textRef` and `transcriptRef` payload digests. `storePiResult(campaign, result)` writes these attachments and returns the compact record. `readPiResult(output, reader)` validates that record and resolves its attachments into the full result, rejecting missing or corrupt attachment data. Summaries and accounting validate compact metadata without reading attachment bytes. Full core inspection resolves and validates attachments.

`piResultRecord` validates the compact journal output. `piStoredResult` validates the expanded result body without its `call` field, including text and transcript. Both reject unknown top-level fields. The current package validates the current xean campaign and report contracts.

`runPi` records one request checkpoint for every logical provider operation, including continuations after tool results. `maxLengthContinuations` bounds ordinary response-length continuations; `maxRecoveries` bounds consecutive retryable provider failures. Each allowance defaults to zero when omitted. A successful provider response resets that failure count, including a response that saves a partial submission. Every retryable provider failure, including `incomplete.max_messages` with new completed reasoning, consumes the error-recovery allowance. Completed reasoning remains available on an admitted retry. Gated recovery receives fresh user feedback and also requires remaining context headroom. Successful empty submissions are not provider errors and do not consume this allowance. Raw incomplete outcomes and their usage remain in the transcript and request completions. A length continuation carries the full transcript. Ordinary calls use a fixed continuation prompt, and gated calls use their context-threshold feedback. An error recovery retains the failed assistant message in the transcript and derives its next model input as described below. A request with `replayReasoning: false` removes thinking blocks from every model input after the first response, including continuations and recoveries, while the transcript retains them; the default replays them. Overflow-shaped length stops, non-retryable errors, and aborts always terminate. Each recovery is an ordinary logical provider operation with its own request checkpoint. Provider adapters may retry an operation without exposing each wire attempt. Each `runPi` call generates one random transport session ID shared by its initial loop and recoveries, which adapters use for provider-side prompt caching, session affinity, and transport-failure fallback. The optional `transport` option pins the adapter transport (for example `"sse"`) for every operation in the call. Both are transport configuration outside the durable contract. xean releases Pi's session resources in `finally` after the logical call settles, including failure and cancellation. Pi owns WebSocket caching, incremental input, and transport fallback. Explicit custom proxies may opt into Pi's `compat.codexProxyAuth` for opaque API keys; that setting is rejected on the direct ChatGPT endpoint. Without a submission gate, the initial loop and continuations share a thirty-two-turn limit for non-error, non-aborted responses. Pi's turn hook ends a cancelled call before scheduling another request. Message-limit recoveries are bounded by the error allowance and remaining context headroom.

For `openai-responses` and `openai-codex-responses`, xean observes Pi's `thinking_end` events and snapshots validated reasoning signatures containing an item ID and encrypted content. Pi emits these after `response.output_item.done`, including when the enclosing response later fails. Within that live `runPi` call, the model-input projection replays these completed reasoning items in order through Pi's existing serializer, preserving their IDs and encrypted bytes. Repeated item IDs in failed attempts are omitted. The failed response must match the requested provider, API, and model, including the served model when Pi reports it. The projection contains no text or tool calls from failed attempts. Previously successful messages and tool results remain available, and tools from failed attempts are never executed. Pi's original error stop reason remains in the durable transcript and request completion.

This recovery requires an endpoint that accepts completed encrypted reasoning without a following completed answer. Provider rejection remains a failed call. Credential identity and proxy account routing are outside xean's model contract, so applications must retain compatible authentication and routing across attempts. The recovery state is local to a running call. A process restart or a fresh `runPi` call does not resume an interrupted provider stream from the journal. Completed request checkpoints show the replayed input, while missing provider usage remains unknown spend.

Pi's awaited `onPayload` hook exposes the effective full request before transport encoding. xean saves its JSON serialization semantics through `storePayloadJson` and appends an internal `xean/pi-request` call containing its `payloadRef` before the hook returns. After the provider operation terminates, that call returns an `xean/pi-request-completion/v2` record with operation identity, reported usage or null, stop reason, and available response/error details. Its optional `httpStatus` is the last status delivered by the adapter’s `onResponse` hook for that logical operation, including internal HTTP retries; it is absent when no HTTP response was observed, including transports without this hook. Status is reset for each logical request and response headers are never stored. This completion commits before the terminal stream event reaches Pi's agent loop or another continuation begins. Nonterminal stream events forward immediately. A process death may leave a dispatched request unsettled. `piRequestAttempts(records, parent?, reader?)` reports each checkpoint's state without loading payloads; supplying a reader explicitly reconstructs its payload. A completed attempt records the adapter's terminal result and does not guarantee provider success or measured usage. Pi's cached WebSocket adapter may encode the full hook payload as `previous_response_id` plus incremental input and may fall back to full input. The journal records the effective full request, not every transport encoding or retry. The runtime rejects a successful logical provider operation unless exactly one checkpoint was created; an adapter may fail or be cancelled before constructing a payload. Built-in Pi adapters supply the ordering. A custom adapter is trusted to invoke the hook exactly once before dispatch and to keep credentials and tokens outside its payload. The checkpoint records the effective request base URL when the dispatching model carries one, so the durable log names the endpoint a payload was prepared for. Provider authentication, headers, other transport configuration, and SDK-internal retries are not persisted.

Provider headers come from the supplied Pi runtime or adapter configuration. `runPi` does not interpret `XEAN_LAB_*` environment variables or inject gateway headers.

`derivePiSpend(records)` reads durable request completions, including those whose enclosing Pi call never settled. Each completed request checkpoint is one operation, counted once, without adding duplicate transcript usage. Only checkpointed requests are counted: an adapter that fails before constructing a payload leaves no checkpoint, so that failure surfaces only through the parent call's failure or, when a recovery succeeds, only as the failed assistant message in the stored transcript. It returns JSON-safe operation identity, per-call and aggregate provider-reported usage, unaccounted Pi call IDs, and redacted unsettled request checkpoints that may represent unknown spend. A call may remain unaccounted overall while its completed requests contribute measured usage. The six core usage fields are atomic; a partial bundle is invalid, while no bundle yields `usage: null`. Pi's input, cache-read, and cache-write fields are disjoint buckets; reasoning tokens are a subset of output and are not added again. Provider accounting is diagnostic and never affects candidate verification.

`inspectCoreCallSummaries(records)` derives call timing, settlement, tool identities, Pi outcomes, checkpoints, and accounting from one captured entry array. It validates metadata without reading response or transcript attachments or candidate material, and omits `pi.responseText`. Full `inspectCoreCampaignRecords(reader, records)` retains response text, candidate material, and attachment integrity checks.

The parent call contains the optional candidate sequence, provider, model ID, API ID, base URL, model profile, prompt, optional system prompt, optional requested reasoning level, and selected tool declarations. The child checkpoints contain the provider, model ID, API ID, effective request base URL, and JSON-semantic pre-send hook payload. The durable contract identifies the requested runtime configuration; provider credentials, headers, backend revision, adapter implementation, unrecorded registry metadata, authenticated transport details, and the provider's interpretation of a model ID remain outside it.

## Candidates, verdicts, and verification

`submitCandidate(material, requiredVerifiers)` copies the exact bytes, freezes a sorted, unique, nonempty verifier set, appends the candidate row, and returns its sequence. A later submission always creates another candidate.

`recordVerdict(call, verdict, evidence)` accepts `PASS`, `FAIL`, or `INCONCLUSIVE` only when:

- the call names an existing earlier candidate;
- the call label is required by that candidate;
- the call starts after candidate submission;
- the call returned JSON whose `state` is `"succeeded"`; and
- SQLite admits the first verdict citing that call.

`returnedToolSubmission(records, call, tool)` requires exactly one matching tool call and exactly one returned tool result, then projects their record IDs, admitted input, and output. It does not require output to equal input. An application parses the input with its own submission schema and passes the derived verdict and evidence to `recordVerdict`; the application supplies no second semantic value that could disagree with the durable submission.

A candidate is verified when each required verifier has at least one PASS and no required verifier has any FAIL. INCONCLUSIVE neither passes nor fails. A later PASS does not erase a FAIL for that candidate ID. Failures are submission-scoped: submitting even identical bytes again creates an independent candidate, and applications decide whether to permit that retry.

`deriveCandidateStatus(records, candidate)` derives `verified`, missing verifier names, failed verifier names, and the first PASS verdict sequence for each satisfied verifier from one explicit record snapshot. It stores no status row. Publishing, adopting, or otherwise promoting a verified candidate is an application action.
