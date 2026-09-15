# Building an xean application

Install xean 1.1.1 from GitHub:

```sh
bun add github:chaoxu/xean#v1.1.1 zod@4.5.4
```

## Create and verify a candidate

Use `reader.record(seq)` for one entry and `reader.records({kinds: ["tool-call"], call})` for a call's tool submissions. Query filters run in SQLite before unrelated request bodies are parsed. `reader.lastSequence()` followed by queries with `through` captures a consistent immutable prefix. `records()` with no options still returns every exact entry. The complete `RecordQuery` contract is in [SPEC.md](../SPEC.md#campaign-artifact).

Large provider payloads can be saved explicitly with `campaign.storePayload(value)`. It returns a content digest, and `reader.payload(digest)` reconstructs the captured JSON, including property order. Repeated input items, ordered prefixes, and remaining fields such as instructions and tool declarations share storage. Put the digest in a versioned application request rather than inventing magic reference keys that ordinary entry reads must interpret. Saving a payload is local persistence and makes no provider request.

If you already have serialized JSON, use `campaign.storePayloadJson(encoded)` to avoid making an intermediate object copy. It parses and reserializes the JSON before hashing, preserving the resulting property order and rejecting malformed JSON before writing.

```ts
import {
  createCampaign,
  defineTool,
  deriveCandidateStatus,
  returnedToolSubmission,
  verdictSchema,
} from "xean";
import { builtinPi, runPi } from "xean/pi";
import { z } from "zod";

const verdictSubmission = z.strictObject({
  verdict: verdictSchema,
  evidence: z.json(),
});
const submitVerdict = defineTool({
  name: "submit_verdict",
  description: "Submit the final verdict and its evidence",
  input: verdictSubmission,
  replay: "safe",
  async run() {
    return null;
  },
});

const models = builtinPi();
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (model === undefined) throw new Error("model unavailable");

const campaign = createCampaign("campaign.db", "my-proof-app", {
  policy: "v1",
});
try {
  const verifier = "hostile-audit/v1";
  const material = new TextEncoder().encode(
    JSON.stringify({ statement, proof, sources, revision }),
  );
  const candidate = campaign.submitCandidate(material, [verifier]);
  const stored = new TextDecoder().decode(campaign.material(candidate));
  const audit = await runPi(campaign, {
    models,
    model,
    label: verifier,
    candidate,
    system:
      "Audit the candidate adversarially. Call submit_verdict exactly once with the reason in evidence, then stop.",
    prompt: stored,
    tools: [submitVerdict],
    stopAfterToolResult: true,
  });
  if (audit.state !== "succeeded") throw new Error(audit.error);
  const submitted = returnedToolSubmission(
    campaign.records(),
    audit.call,
    submitVerdict.name,
  );
  const report = verdictSubmission.parse(submitted.input);
  campaign.recordVerdict(audit.call, report.verdict, report.evidence);
  const status = deriveCandidateStatus(campaign.records(), candidate);
  if (!status.verified) throw new Error("not verified");
} finally {
  campaign.close();
}
```

`builtinPi()` uses Pi's normal environment and ambient provider authentication. An application that owns OAuth or API-key credentials can import `InMemoryCredentialStore` from `xean/pi` and pass it as `builtinPi({ credentials })`; xean re-exports both implementations and their types directly from Pi. Built-in adapters keep credentials outside the persisted payload. A custom adapter is trusted to do the same.

Configure gateway headers through Pi's provider settings. Pi `ModelRuntime` resolves provider-scoped `headers` in `models.json`. Applications that bypass `ModelRuntime` supply their own Pi headers or `transformHeaders` through the `models.streamSimple` adapter passed to `runPi`. The generic runner does not infer headers from `xean-lab` environment variables.

Put the current task, changing guidance, and correction requests in `prompt`, which Pi sends as a user message. Use `system` for stable role definitions and contracts. Within a live call, send new directions as fresh user messages after the relevant tool receipt. Tool receipts report results and validation errors; keep the next work assignment in its own user message. A submission gate delivers its `continuationPrompt` through this user-message path.

`returnedToolSubmission` requires one named tool call and its returned result. The application parses the durable input with the same submission schema and passes its verdict and evidence to `recordVerdict`; it supplies no second semantic value that could disagree with the model's submission. Tool output may differ from input, so the projection records both without equating them.

Use that structured path for an LLM verifier. An application-owned deterministic verifier adapter instead runs through `campaign.call`, validates its typed receipt, and applies one fixed mapping from that receipt to the verdict passed to `recordVerdict`. xean preserves the mapping's input and output; it does not establish that the verifier is sound. Never translate free-form model text into an application-selected verdict.

Use `stopAfterToolResult` when the verdict-submission tool is the call's only tool. Gather source inspections or other observations in earlier calls so finalization has one unambiguous submission.

The candidate envelope is application-owned. Include every fact that must be audited together: statement revision, answer or proof, cited sources, imported assumptions, and dependency versions. `deriveCandidateStatus(records, candidate).verified` is derived from the supplied log snapshot; xean stores no promotion event. Publishing or adopting a verified candidate belongs to the application.

## Give a model one narrow tool

When a verifier needs one read-only source tool, run source inspection as a preliminary call and pass its recorded result into the verdict prompt. Keep the final verdict as the same verdict-only structured call shown above.

```ts
import { defineTool, returnedToolSubmission } from "xean";
import { z } from "zod";

const inspectedSource = z.strictObject({
  source: z.enum(allowedSourceNames),
  text: z.string(),
});
const inspectSource = defineTool({
  name: "inspect_source",
  description: "Read one source already attached to this candidate",
  input: z.strictObject({
    source: z.enum(allowedSourceNames),
  }),
  replay: "safe",
  async run({ source }, { signal }) {
    signal.throwIfAborted();
    return { source, text: await sourceStore.read(source) };
  },
});

const inspection = await runPi(campaign, {
  models,
  model,
  label: `${verifier}/source-inspection`,
  candidate,
  system:
    "Inspect one attached source. Call inspect_source exactly once, then stop.",
  prompt: stored,
  tools: [inspectSource],
  stopAfterToolResult: true,
});
if (inspection.state !== "succeeded") throw new Error(inspection.error);
const sourceInspection = inspectedSource.parse(
  returnedToolSubmission(
    campaign.records(),
    inspection.call,
    inspectSource.name,
  ).output,
);

const audit = await runPi(campaign, {
  models,
  model,
  label: verifier,
  candidate,
  system:
    "Audit the candidate and source-inspection result. Call submit_verdict exactly once, then stop.",
  prompt: JSON.stringify({ stored, sourceInspection }),
  tools: [submitVerdict],
  stopAfterToolResult: true,
});
```

Zod validates the model's input before `run` executes and generates the JSON Schema Pi receives. Pure refinements are supported; transforms are unsupported because JSON Schema cannot represent them. `replay: "safe"` is the application's assertion that every valid repetition is harmless; a write needs an application-stable semantic key or reconciliation rule. A recorded tool call without a result has an unknown outcome and is never retried by the kernel. Use the campaign namespace and tool-call sequence to reconcile the original external record. The exact recording and replay contract is in [`../SPEC.md`](../SPEC.md#calls-and-tools).

Tools should express one bounded application action. Suitable proof-search tools read a named attached source, inspect a bounded frontier view, launch one application-approved computation, or submit one structured observation. Do not expose SQL, the campaign path, a database client, arbitrary record append, unrestricted candidate access, the whole `Campaign`, or a general filesystem shell.

`piRequestAttempts(campaign.records(), call)` returns compact request identities and completion states. Pass the campaign or a reader as the third argument to expand the JSON-semantic full request payloads, which may contain complete prompts and attached sources. Pi may send a cached WebSocket continuation as a response ID plus new items. Each completed checkpoint has a durable terminal measurement even when the outer call never settled; missing provider usage remains unknown. Built-in adapters omit credentials and HTTP headers; custom adapters must do the same and invoke the hook exactly once before dispatch. See [`../SPEC.md`](../SPEC.md#pi-runner) for the checkpoint contract.

`runPi` returns the full result with text and transcript. Its journal output is a compact `piResultRecord` with `textRef` and `transcriptRef` payload digests, outcome, telemetry, and assistant usage. Use `readPiResult(output, reader)` to reconstruct and validate the full saved result. Applications can use `storePiResult(campaign, result)` to create the same compact representation. Summaries and accounting validate metadata without loading attachment bytes. Full result reads and full core inspection reject missing or corrupt attachments.

The campaign artifact stores candidate bytes, requests, prompts, transcripts, tool inputs and results, verdict evidence, and pre-send payloads as plaintext. Treat it as sensitive application data. Built-in Pi adapters exclude authentication credentials; a custom adapter must preserve that boundary.

## Account for provider work

`derivePiSpend(records)` returns settled provider operations, per-call and campaign totals, unaccounted Pi calls, and redacted unsettled request checkpoints that may represent unknown spend. Completed request measurements remain available after a later interruption or failure of their outer call. Provider-reported token buckets and estimated cost remain separate; missing usage is `null`, not zero. It reads one record snapshot and writes nothing.

`inspectCoreCampaign` separates `spend.requests.first` from `spend.requests.continuation`, with `cachedInputShare` when measured input is available. `spend.recoveredRequestErrors` counts provider errors inside Pi calls that ultimately succeeded. Full call observations include `pi.accounting.recoveredErrors`, with the one-based request position and available saved error name and message. A healthy final call can contain recovered errors. Missing request usage remains unknown in both partitions.

For per-call analysis, use `inspectCoreCallSummaries(records)` from `xean/observe`. It returns timing, settlement, tool identities, Pi outcomes, checkpoints, and accounting from the same captured entry array, without loading response or transcript attachments or candidate material. Use `inspectCoreCampaignRecords(reader, records)` for full content and attachment integrity checks. These generic facts support `xean-solve`'s mathematical workflow, `xean-lab`'s experiments and provenance, and `xean-observe`'s HTTP, caching, and rendering.

## Resume and read safely

Use `openCampaign(path)` only after the prior writer has terminated or closed, then derive the next application action from `campaign.records()`. Close every handle in `finally`; copying an open database is unsupported. Calls and tool calls without matching results require external reconciliation and are not automatically replayable. Use `openReader(path)` for read-only inspection. Recovery, copying, rollback-journal, and rejected WAL-state rules are defined in [`../SPEC.md`](../SPEC.md#campaign-artifact).

A `runPi` result that is still length-truncated after its bounded in-call recoveries is a dead end. Preserve it and start a fresh `runPi` call from explicit application state; a fresh model, profile, prompt, or context policy likewise starts another root call.

Set `maxRecoveries` to allow bounded retries of transient provider failures. `maxLengthContinuations` separately bounds ordinary response-length continuations. Each allowance defaults to zero when omitted. The failure count resets after a successful response. Every retryable provider failure, including `incomplete.max_messages` with new completed reasoning, consumes the error allowance. Valid completed reasoning is preserved for an admitted retry; remaining context is also required. Successful empty submissions are not provider errors. For the OpenAI Responses and Codex Responses adapters, xean carries completed encrypted reasoning items into the retry through Pi's serializer. Completion means Pi emitted `thinking_end` for a validated signed reasoning item, not merely a text delta or a finished summary. Failed attempts remain errors in the transcript and telemetry. Their text and tool calls stay out of model input and tool execution. Check `piRequestAttempts(records, call, reader)` to inspect the IDs and encrypted content supplied on each retry. This works within one live call, with compatible authentication, routing, and an endpoint that accepts reasoning-only replay. It does not recover unfinished items or survive a process restart. Treat encrypted reasoning and request checkpoints as sensitive campaign data, and treat missing usage on failed attempts as unknown spend. The [Pi runner contract](../SPEC.md#pi-runner) defines recovery admission and retry limits.

`runPi` writes through the supplied `Campaign.call` interface. A decorator around that interface is trusted application code and may observe or alter execution; the kernel does not claim an intra-process security boundary against its caller.

## Keep orchestration outside the kernel

An application can maintain routes, task queues, source bundles, blind-review views, stopping policy, and human-readable reports in ordinary files or its own database. Use xean at the points where evidence becomes durable:

1. package exact output and sources into candidate bytes;
2. submit the candidate with versioned verifier names;
3. run each verifier through `runPi` or `campaign.call` with only its selected tools;
4. for an LLM verifier, finalize exactly one returned structured submission; for an application-owned deterministic adapter, validate its receipt and apply its fixed verdict mapping; and
5. publish or adopt the candidate in application code only when `deriveCandidateStatus(records, candidate).verified` is true.

[`../examples/scripted-verifier.ts`](../examples/scripted-verifier.ts) shows the deterministic adapter path. [`../examples/pi-smoke.ts`](../examples/pi-smoke.ts) independently exercises the LLM-verdict path with a real Pi model.
