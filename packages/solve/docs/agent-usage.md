# Use Xean from another agent

An agent operates Xean through command-line calls and JSON output. It can read progress, supply mathematical notes, and append Explorer guidance while a run is active. Xean stores the submissions and their delivery boundaries in the campaign database.

The examples below run from the repository root with Bun. [Installation](installation.md) covers the current GitHub `main` checkout and provider credentials.

## Start and inspect

Create a task containing `problem` and `completionCriteria`, and select model profiles in a settings file. The example below uses the public Codex endpoint with Pi's **OpenAI Codex** login. [Provider setup](installation.md#choose-a-provider) also covers OpenAI API credentials and explicit private registries through `XEAN_MODELS_PATH`.

```sh
bun packages/solve/solve.ts run packages/solve/examples/task-even-sum.json campaign.db packages/solve/examples/settings-openai-codex.json
```

`run` prints phase updates on standard error and a JSON execution report on standard output when it returns. Supervise long-running commands with your application's existing process manager. Another process can read the campaign during execution:

```sh
bun packages/solve/solve.ts inspect campaign.db
bun packages/solve/solve.ts inspect --include-requests campaign.db
```

The report contains the task, phase, notes and verdicts, role calls and submissions, and accounting. Use the journal-derived `result` when it is present. `accepted` and `turn-limit` are terminal. `paused`, `call-failure`, and `interrupted` leave unfinished work resumable. Each inspected role call separates its kernel `state` from the provider `outcome` and saved `error`: a returned kernel call may contain a failed provider outcome. These diagnostics do not mark the mathematical task terminal. An inconclusive check ends that note's verification attempt. Explorer receives its full report on the next turn and can supply missing evidence or pursue another argument within the existing turn limit.

## Supply mathematical notes

Use `init` to create the campaign before any paid work, then submit the notes and start the usual runner:

```sh
bun packages/solve/solve.ts init task.json campaign.db settings.json
bun packages/solve/solve.ts submit --id initial-results campaign.db notes.json
bun packages/solve/solve.ts run task.json campaign.db settings.json
```

`init` matches the exact task and settings if the campaign already exists. It returns `{application, campaignPath, created}` and makes no provider setup or model call. `submit` requires an existing campaign and also makes no model call. It accepts this JSON shape:

```json
{
  "notes": [
    {
      "text": "A possible route is to express both even integers as multiples of two.",
      "support": []
    }
  ]
}
```

Each note has nonblank `text` and distinct `support` IDs. Its text is persisted exactly. Without `verification`, it enters as ordinary unchecked mathematical work. The coordinator writes its summary and selects any checks or later use through the usual note workflow.

The caller can explicitly mark a result as externally verified by adding `verification`:

```json
{
  "notes": [
    {
      "text": "For integers a and b, 2a + 2b = 2(a + b). Since a + b is an integer, the sum is even.",
      "support": [],
      "verification": {
        "source": "caller",
        "report": "Checked the algebraic identity and closure of the integers under addition."
      }
    }
  ]
}
```

Choose this field only when the caller intends to supply an established result. `verification.source` identifies the reviewer or caller, and `verification.report` records the basis of that verification. This is separate from the literature source verifier. The attestation makes the note usable as verified support only when its own support is verified and it is not dead. Ordinary source, correctness, or reconstruction failures still make it dead. A requirements failure still prevents acceptance. A supplied complete proof needs all four normal verifiers to pass, even with an attestation. It can then be accepted after one turn, its verifier dispatch, with no Explorer call.

String support IDs name existing notes in this campaign that are not dead. Obtain them from `inspect`. A positive integer names an earlier note in the same submission, counted from 1. For example, this submits a theorem and its application together without a model call:

```json
{
  "notes": [
    {
      "text": "The exact external theorem, with its hypotheses and source.",
      "support": []
    },
    {
      "text": "A proof applying that theorem with matching hypotheses.",
      "support": [1]
    }
  ]
}
```

The solver resolves local references to assigned note IDs at delivery, after any active Explorer output. Each submission has its own numbering. Self references, forward references, duplicate support, and missing existing IDs are rejected before appending. Raw receipt texts and references remain unchanged on replay.

When transferring work, submit each theorem and proof separately in dependency order and convert the selected graph's edges to local positions. Include shared support once. Keep source-note references in the text unambiguous, and preserve provenance separately from verification. If a prior migration already bundled notes into archival prose, recover the original graph from its source journal and recorded lineage first. An archival paragraph naming a theorem does not create a support edge. Submission grants no verification by default.

Use `-` for standard input, or call the exported function from TypeScript:

```sh
bun packages/solve/solve.ts submit --id initial-results campaign.db - < notes.json
```

```ts
import { submitNotes } from "xean-solve";

const receipt = await submitNotes(
  "campaign.db",
  { notes: [{ text: "Try the integer parametrization a = 2m.", support: [] }] },
  "integer-parametrization",
);
```

The receipt contains `call`, `atMs`, `schemaVersion`, `id`, and `notes`. Repeating the same id with the same note texts, support, and verification returns the original receipt. A changed submission with that id fails. Omitting the id creates a new submission on every call. Keep a stable id when retrying after an interrupted command.

The caller prepares text from PDFs, CSVs, retrieved sources, datasets, or prior runs and includes enough statements, evidence, and limitations for its intended use. Xean accepts text notes. Conversion, retrieval, and data analysis remain with the caller and add no model role to the solver.

## When notes take effect

Notes enter the next coordinator intake whose input has not been frozen. Before the first Explorer call, `init` followed by `submit` lets the coordinator file and consider them first. During an Explorer call, the runner preserves that Explorer's assigned IDs, appends the supplied notes after its output, and passes both to the next coordinator. A coordinator or verifier that has already started retains its original input. Later notes wait until another intake boundary. The same boundary and IDs survive retries and reopening.

`submit` can run while the runner holds its lock. It stores work without starting or resuming execution. A paused campaign still needs `run`. A terminal campaign retains later submissions as pending and keeps its terminal result.

```sh
bun packages/solve/solve.ts inspect --include-submissions campaign.db
```

The opt-in `submissions` array adds `pending`, `boundary`, `coordinatorCall`, and, once assigned, `noteIds` to each receipt. `boundary` is the journal call that froze intake. `coordinatorCall` identifies the first coordinator request receiving it. `pending: false` confirms that request has started, not that a model verified the text. Read the note's verdicts and the campaign result for verification and acceptance. Submitted notes use the existing support selection, transitive closure, and deduplicated proof formatting.

## Submit advice

Write the advice to a UTF-8 file and submit it with a stable id:

```sh
bun packages/solve/solve.ts guide --id strategy-1 campaign.db guidance.txt
```

Example file content:

```text
Test the smallest nontrivial cases before extending the construction.
If a construction fails, record the precise obstruction in a note.
```

Standard input is also supported:

```sh
printf '%s\n' 'Try a direct proof from the definitions.' | bun packages/solve/solve.ts guide --id strategy-2 campaign.db -
```

The command returns a receipt like this:

```json
{
  "call": 42,
  "atMs": 1788912000000,
  "schemaVersion": 1,
  "id": "strategy-1",
  "text": "Test the smallest nontrivial cases before extending the construction.\n"
}
```

The receipt acknowledges durable storage. Repeating the same id and exact text returns that receipt, including after the campaign finishes. Different text with the same id is an error. Use a fresh id for new advice. The command requires write access to an existing workflow campaign and makes no provider request.

In TypeScript, the installed solver also exports the same operation:

```ts
import { guideCampaign } from "xean-solve";

const receipt = await guideCampaign(
  "campaign.db",
  "Try a direct proof from the definitions.",
  "strategy-2",
);
```

## When advice takes effect

The coordinator supplies `explorerGuidance` for the next turn. The runner combines that text with pending external messages in the Explorer's single `explorerGuidance` field. Both are fallible advice. The Explorer can reject a diagnosis, choose another approach, or finish a suggested step and continue toward the original task.

Before a turn starts, the runner freezes the available messages. They appear after the coordinator's text, in journal order. External advice applies to one turn only. The next turn receives a new coordinator recommendation and any newly submitted advice. Settings contain no persistent guidance.

An active request keeps the prompt it was sent. New advice waits for the next Explorer turn, and retries of the current turn keep its original guidance. A crash after the input boundary is recorded also preserves that boundary on resume. Earlier notes, verdicts, and requests remain unchanged.

```sh
bun packages/solve/solve.ts inspect --include-guidance campaign.db
```

The added `guidance` array contains each external receipt, `calls` listing the Explorer calls that included it, and `pending`. Several calls can be retries of the same turn. `pending: false` confirms delivery to at least one started Explorer call, including a call that later failed. Check the resulting notes to see how the model used the advice.

The original task and completion criteria remain the authority for acceptance. Guidance cannot establish a lemma, change a verifier's verdict, or increase the turn cap. `guide` records advice without starting or resuming execution. Advice recorded after completion, or too late for another Explorer turn, remains pending. The terminal result stays unchanged.

## Pause and resume

Send one `SIGINT` or `SIGTERM` to pause after the active role call settles. A second signal interrupts the active call. Resume with the same task, campaign, and settings:

```sh
bun packages/solve/solve.ts run task.json campaign.db settings.json
```

Guidance and submitted notes are already in the campaign. Leave the original settings file unchanged. The command resumes the first missing role call and preserves completed work. A fresh campaign receives twenty turns by default; a turn is one coordinator dispatch and the role it runs. `run --turns N` or `init --turns N` sets its initial allowance outside the settings.

After `turn-limit`, use `run --turns 20 --id more-1 task.json campaign.db settings.json` to grant twenty additional turns and continue. Reuse the same ID and count for retries. A different count with the same ID is rejected. New allowances require an exhausted campaign, and accepted campaigns stay accepted. Plain `run` never grants additional turns. Inspection exposes `maxTurns` and the journaled `allowances`. Historical entries and completed verification remain unchanged.

The workflow drains requested verification batches before control returns to the coordinator. Every Explorer call uses the submission gate. Each valid `submit_notes` call submits `{notes, solution}`, saves new notes, and returns their `{noteIds}`. A submission rejected by schema validation can be corrected while responses remain. Every nonempty nonterminal submission receives a fresh user message exactly `Keep trying, you can do it.` after its receipt. Explorer continues until it claims a complete solution, submits an empty notes array, reaches `maxExplorerResponses` (default 4), or reaches its estimated context threshold. Set `maxExplorerResponses` to 1 to allow at most one non-error response, which must contain a valid submission to hand off. Plain text, length-limited output, and rejected submissions count. Provider errors use their separate recovery allowance. At the response limit, a valid submission hands all saved notes to the coordinator. Exhaustion without one fails the call. The first empty submission hands all saved notes to the coordinator with `emptySubmission: true`, asking for a different promising approach. Use the current example settings for new campaigns.

Inspection includes saved notes before handoff and after interruption. A fresh role call receives their full texts with stable IDs and the same guidance, with a fresh response budget. Internal provider retries share the existing response count. Every retryable provider error, including `incomplete.max_messages`, consumes the `maxRecoveries` allowance while preserving completed reasoning. Empty submissions are successful handoffs and do not consume error recoveries. See [Explorer continuation](../README.md#explorer-continuation) for context headroom. Coordinator advice uses `explorerGuidance`, and inconclusive verification returns its report to Explorer. Resuming requires the task, settings, and request contracts recorded in the campaign.

Workflow declarations are versioned independently of the execution contract, which uses schema 2. Execution reports use schema 1. Notes may carry external `verification`, and a submitted proof can produce an accepted result after one turn, its verifier dispatch, once all normal checks pass. `--include-guidance` and `--include-submissions` expose the corresponding inspection fields.

All notes, guidance, and delivery boundaries live in `campaign.db`. The `.runner.lock` and `.inbox.lock` files only coordinate processes and hold no campaign state. Copy a campaign after its handles close, or use SQLite's backup facilities for a live snapshot. See the kernel [durability contract](https://github.com/chaoxu/xean/blob/main/SPEC.md) for recovery and copy rules.

## Export and review

```sh
bun packages/solve/solve.ts export campaign.db
```

Export contains the accepted note and every supporting proof it relies on. Give this text and the frozen task to an external reviewer, following the [review procedure](../README.md#external-final-review). An internal `accepted` result reports that Xean's declared checks passed.
