# Use Xean from another agent

An agent operates Xean through command-line calls and JSON output. It can read progress, supply mathematical notes, and append Explorer guidance while a run is active. This page gives the command sequences and JSON shapes; the [workflow guide](role-runner.md) is the authority on what each command does.

The examples below run from the repository root with Bun. [Installation](installation.md) covers the checkout and provider credentials.

## Start and inspect

Create a task containing `problem` and `completionCriteria`, select model profiles in a settings file, and run. The example uses the public Codex endpoint with Pi's **OpenAI Codex** login; [provider setup](installation.md#choose-a-provider) also covers OpenAI API credentials and private registries through `XEAN_MODELS_PATH`.

```sh
bun packages/solve/solve.ts run packages/solve/examples/task-even-sum.json campaign.db packages/solve/examples/settings-openai-codex.json
```

`run` prints phase updates on standard error and a JSON execution report on standard output when it returns; its exit code is 130 after an interruption and 1 after a call failure. Supervise long-running commands with your application's existing process manager. Another process can read the campaign during execution:

```sh
bun packages/solve/solve.ts inspect campaign.db
bun packages/solve/solve.ts inspect --include-requests campaign.db
```

Use the journal-derived `result` when it is present: `accepted` and `turn-limit` are terminal, and `paused`, `call-failure`, and `interrupted` leave unfinished work resumable. Each inspected role call separates its kernel `state` from the provider `outcome` and saved `error`. The [inspection section](role-runner.md#inspection-and-export) lists every field.

## Supply mathematical notes

Use `init` to create the campaign before any paid work, then submit the notes and start the usual runner:

```sh
bun packages/solve/solve.ts init task.json campaign.db settings.json
bun packages/solve/solve.ts submit --id initial-results campaign.db notes.json
bun packages/solve/solve.ts run task.json campaign.db settings.json
```

`init` returns `{application, campaignPath, created}`. `submit` accepts this JSON shape:

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

Each note has nonblank `text` and distinct `support` IDs. Mark an externally verified result with `verification`:

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

String support IDs name existing notes in this campaign; obtain them from `inspect`. A positive integer names an earlier note in the same submission, counted from 1, so a theorem and its application enter together:

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

When transferring work, submit each theorem and proof separately in dependency order and convert the selected graph's edges to local positions. The [inbox rules](role-runner.md#submitted-notes) state validation, external verification, delivery, and numbering.

Use `-` for standard input, or call the exported function from TypeScript:

```sh
bun packages/solve/solve.ts submit --id initial-results campaign.db - < notes.json
```

```ts
import { submitNotes } from "./packages/solve/solve.ts";

const receipt = await submitNotes(
  "campaign.db",
  { notes: [{ text: "Try the integer parametrization a = 2m.", support: [] }] },
  "integer-parametrization",
);
```

The receipt contains `call`, `atMs`, `schemaVersion`, `id`, and `notes`. Keep a stable id when retrying after an interrupted command; omitting the id creates a new submission on every call.

```sh
bun packages/solve/solve.ts inspect --include-submissions campaign.db
```

The opt-in `submissions` array adds `pending`, `boundary`, `coordinatorCall`, and, once assigned, `noteIds` to each receipt. Read the note's verdicts and the campaign result for verification and acceptance.

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

In TypeScript, the solver exports the same operation:

```ts
import { guideCampaign } from "./packages/solve/solve.ts";

const receipt = await guideCampaign(
  "campaign.db",
  "Try a direct proof from the definitions.",
  "strategy-2",
);
```

```sh
bun packages/solve/solve.ts inspect --include-guidance campaign.db
```

The added `guidance` array contains each external receipt, `calls` listing the Explorer calls that included it, and `pending`. Check the resulting notes to see how the model used the advice. The [guidance rules](role-runner.md#guidance) state when advice takes effect.

## Pause and resume

Send one `SIGINT` or `SIGTERM` to pause after the active role call settles. A second signal interrupts the active call. Resume with the same task, campaign, and settings:

```sh
bun packages/solve/solve.ts run task.json campaign.db settings.json
```

After `turn-limit`, grant twenty more turns and continue:

```sh
bun packages/solve/solve.ts run --turns 20 --id more-1 task.json campaign.db settings.json
```

Reuse the same id and count for retries. The [coordinator loop](role-runner.md#coordinator-loop) states the allowance rules, and the [replay section](role-runner.md#replay-and-resume) states what a resumed `run` reuses.

All notes, guidance, and delivery boundaries live in `campaign.db`. The `.runner.lock` and `.inbox.lock` files only coordinate processes and hold no campaign state. Copy a campaign after its handles close, or use SQLite's backup facilities for a live snapshot; the kernel [durability contract](../../../SPEC.md#campaign-artifact) states the recovery and copy rules.

## Export and review

```sh
bun packages/solve/solve.ts export campaign.db
```

Export contains the accepted note and every supporting proof it relies on. Give this text and the frozen task to an external reviewer, following the [review procedure](../README.md#external-final-review).
