# Building an xean application

Install xean from the current `main` branch on GitHub:

```sh
bun add github:chaoxu/xean#main zod@4.5.4
```

Commit the generated lockfile to preserve the resolved revision. For an explicit revision, replace `main` with a full Git commit. Existing numbered releases are historical archives.

This page is guidance for application authors. [SPEC.md](../SPEC.md) is the normative kernel contract: its [campaign artifact](../SPEC.md#campaign-artifact) section defines records, `RecordQuery`, payload storage, and recovery; [calls and tools](../SPEC.md#calls-and-tools) defines tool recording and replay; the [Pi runner](../SPEC.md#pi-runner) defines the model loop, the submission gate, request checkpoints, result attachments, recovery, and accounting; and [candidates, verdicts, and verification](../SPEC.md#candidates-verdicts-and-verification) defines verdict admission and derived status.

## Create and verify a candidate

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

For an LLM verifier, parse the durable submission with the same submission schema and pass its verdict and evidence to `recordVerdict`, supplying no second semantic value that could disagree with the model's submission. An application-owned deterministic verifier adapter instead runs through `campaign.call`, validates its typed receipt, and applies one fixed mapping from that receipt to the verdict passed to `recordVerdict`. xean preserves the mapping's input and output; it does not establish that the verifier is sound. Never translate free-form model text into an application-selected verdict.

A successful tool batch ends the call, so keep the verdict-submission tool as the call's only tool. Gather source inspections or other observations in earlier calls so finalization has one unambiguous submission. With `submissionGate`, the gate decides which valid submission ends the call.

The candidate envelope is application-owned. Include every fact that must be audited together: statement revision, answer or proof, cited sources, imported assumptions, and dependency versions. `deriveCandidateStatus(records, candidate).verified` is derived from the supplied log snapshot; xean stores no promotion event. Publishing or adopting a verified candidate belongs to the application.

Large provider payloads can be saved explicitly with `campaign.storePayload(value)` or `campaign.storePayloadJson(encoded)` and read back with `reader.payload(digest)`. Put the digest in a versioned application request rather than inventing reference keys that ordinary entry reads must interpret.

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
});
```

Give a tool's `input` a Zod schema with pure refinements and no transforms. Make every valid repetition of `run` harmless: a write needs an application-stable semantic key or reconciliation rule, and the application reconciles a recorded tool call without a result from its own namespace and the tool-call sequence.

Tools should express one bounded application action. Suitable proof-search tools read a named attached source, inspect a bounded frontier view, launch one application-approved computation, or submit one structured observation. Do not expose SQL, the campaign path, a database client, arbitrary record append, unrestricted candidate access, the whole `Campaign`, or a general filesystem shell.

The campaign artifact stores candidate bytes, requests, prompts, transcripts, tool inputs and results, verdict evidence, and pre-send payloads as plaintext. Treat it as sensitive application data. Built-in Pi adapters exclude authentication credentials; a custom adapter must preserve that boundary and invoke the payload hook exactly once before dispatch.

## Account for provider work

`derivePiSpend(records)` and `inspectCoreCallSummaries(records)` from `xean/observe` read one record snapshot and write nothing. `inspectCoreCampaign` separates `spend.requests.first` from `spend.requests.continuation`, with `cachedInputShare` when measured input is available, and `spend.recoveredRequestErrors` counts provider errors inside Pi calls that ultimately succeeded; full call observations include `pi.accounting.recoveredErrors` with the one-based request position, stop reason, and available error message. A healthy final call can contain recovered errors, and missing request usage remains unknown in both partitions. Use `inspectCoreCampaignRecords(reader, records)` for full content and attachment integrity checks. These generic facts support `xean-solve`'s mathematical workflow, `xean-lab`'s experiments and provenance, and `xean-observe`'s HTTP, caching, and rendering.

## Resume and read safely

Use `openCampaign(path)` only after the prior writer has terminated or closed, then derive the next application action from `campaign.records()`. Close every handle in `finally`; copying an open database is unsupported. Calls and tool calls without matching results require external reconciliation and are not automatically replayable. Use `openReader(path)` for read-only inspection.

A `runPi` result that is still length-truncated after its bounded in-call recoveries is a dead end. Preserve it and start a fresh `runPi` call from explicit application state; a fresh model, profile, prompt, or context policy likewise starts another root call.

Set `maxRecoveries` to allow bounded retries of transient provider failures and `maxLengthContinuations` to bound ordinary response-length continuations. For the OpenAI Responses and Codex Responses adapters, recovery replays completed encrypted reasoning within the live call, so treat encrypted reasoning and request checkpoints as sensitive campaign data. Use `piRequestAttempts(records, call, reader)` to inspect the IDs and content supplied on each retry, and treat missing usage on failed attempts as unknown spend. The [Pi runner](../SPEC.md#pi-runner) section states the allowance defaults, the authentication and routing requirement across attempts, the restart rule, and `replayReasoning`.

`runPi` writes through the supplied `Campaign.call` interface. A decorator around that interface is trusted application code and may observe or alter execution; the kernel does not claim an intra-process security boundary against its caller.

## Keep orchestration outside the kernel

An application can maintain routes, task queues, source bundles, blind-review views, stopping policy, and human-readable reports in ordinary files or its own database. Use xean at the points where evidence becomes durable:

1. package exact output and sources into candidate bytes;
2. submit the candidate with versioned verifier names;
3. run each verifier through `runPi` or `campaign.call` with only its selected tools;
4. for an LLM verifier, finalize exactly one returned structured submission; for an application-owned deterministic adapter, validate its receipt and apply its fixed verdict mapping; and
5. publish or adopt the candidate in application code only when `deriveCandidateStatus(records, candidate).verified` is true.

[`../examples/scripted-verifier.ts`](../examples/scripted-verifier.ts) shows the deterministic adapter path. [`../examples/pi-smoke.ts`](../examples/pi-smoke.ts) independently exercises the LLM-verdict path with a real Pi model.
