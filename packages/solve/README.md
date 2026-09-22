# xean-solve

`xean-solve` runs mathematical exploration from a JSON task and saves each role's work in a SQLite campaign. A person or another agent can start the run, inspect its progress, supply text notes or guidance, and resume after an interruption. [Agent usage](docs/agent-usage.md) gives complete command sequences, and the [workflow guide](docs/role-runner.md) is the authority on what each command does.

[Install the solver](docs/installation.md) to use `xean-solve` with an OpenAI API account or a Codex subscription.

## Task and settings

The task file has one schema. The completion criteria are the only statement of what an accepted note must do, so a task that would accept a counterexample says so there:

```json
{
  "problem": "Prove that the sum of two even integers is even.",
  "completionCriteria": "Give a standalone proof for arbitrary even integers."
}
```

Settings are frozen with the campaign, and the turn allowance lives outside them. Start with the [OpenAI API example](examples/settings-openai.json) or the [Codex subscription example](examples/settings-openai-codex.json), then adjust the profiles for your task. [Provider setup](docs/installation.md#choose-a-provider) explains credentials, the Codex CLI, and private model registries.

- `explorer`, `coordinator`, `correctness`, `requirements`, `reconstruction`: one Pi profile each, `{provider, model, reasoning}`, with optional `replayReasoning: false` to send the later responses of a call without the model's earlier reasoning items.
- `source`: the Codex profile `{model, reasoning}` for source verification and literature discovery, run with mandatory web search; `reasoning` is `minimal`, `low`, `medium`, `high`, or `xhigh`.
- `window`: the character cap on the note and support texts one verification reads, default 100000.
- `maxExplorerResponses`: the non-error model responses one Explorer call may use, default 4.
- `explorerContextBudgetTokens`: the Explorer call's preferred total context in tokens, default 400000, bounded by the model's context window.
- `coordinatorBehavior`: the frozen scheduling policy `{literature, verification, overlap?, instructions?}`, where `literature` is `optional`, `never`, or `required-if-not-started` and `verification` is `decide` or `always`. The default is `{"literature": "never", "verification": "decide", "overlap": false}`.

Set `coordinatorBehavior.overlap` to `true` to run Explorer alongside every verifier dispatch:

```json
{
  "coordinatorBehavior": {
    "literature": "never",
    "verification": "decide",
    "overlap": true
  }
}
```

With overlap enabled, every verifier dispatch includes one Explorer turn, under both `verification: "decide"` and `verification: "always"`. The coordinator selects the notes to verify and Explorer's guidance and support. Literature stays serial. Set `overlap` to `false`, or omit it, to run roles serially. This setting is frozen when the campaign starts, so changing it requires a new campaign.

A source verdict whose passages do not bind to the note's assigned premise IDs records INCONCLUSIVE for that note alone. The [verification section](docs/role-runner.md#verification) states every verifier's rules.

## Run

```sh
bun install --frozen-lockfile
bun packages/solve/solve.ts contract
bun packages/solve/solve.ts run task.json campaign.db settings.json
bun packages/solve/solve.ts inspect campaign.db
bun packages/solve/solve.ts inspect --include-requests campaign.db
bun packages/solve/solve.ts export campaign.db
```

`contract` prints the execution contract: the `run` command, its arguments and allowance options, and the report outcomes. `run` creates the campaign or resumes it, prints phase updates on standard error, and prints the execution report on standard output. A fresh campaign receives twenty turns, or `run --turns N`. After `turn-limit`, grant more turns and resume:

```sh
bun packages/solve/solve.ts run --turns 20 --id more-1 task.json campaign.db settings.json
```

`inspect` reports the phase, notes, calls, allowances, and spend, and `export` prints the accepted argument. The [coordinator loop](docs/role-runner.md#coordinator-loop) states the turn and allowance rules, and the [replay](docs/role-runner.md#replay-and-resume) and [inspection](docs/role-runner.md#inspection-and-export) sections state what these commands derive.

Each role can also run alone, from a typed input file into a campaign of its own:

```sh
bun packages/solve/solve.ts explorer input.json roles.db settings.json
bun packages/solve/solve.ts coordinator input.json roles.db settings.json
bun packages/solve/solve.ts literature input.json roles.db settings.json
bun packages/solve/solve.ts verifier input.json roles.db settings.json
```

## Supply notes

Create a campaign before its first model call, then submit mathematical text:

```sh
bun packages/solve/solve.ts init task.json campaign.db settings.json
bun packages/solve/solve.ts submit --id initial-work campaign.db notes.json
bun packages/solve/solve.ts inspect --include-submissions campaign.db
bun packages/solve/solve.ts run task.json campaign.db settings.json
```

`init` creates or matches the campaign without a model call and returns `application`, `campaignPath`, and `created`. `submit` reads a JSON file, or standard input when the filename is `-`:

```json
{
  "notes": [
    {
      "text": "A possible route is to write each even integer as twice an integer and add the two expressions.",
      "support": []
    }
  ]
}
```

Add `verification: {"source": "reviewer identity", "report": "what was checked and the evidence"}` to a note to supply an externally verified result. `submit` makes no model call and works while the runner holds its lock; `submit` and `guide` also carry selected work from an earlier campaign into a new one. The [inbox rules](docs/role-runner.md#submitted-notes) state validation, support references, delivery, numbering, and external verification, and the [agent guide](docs/agent-usage.md#supply-mathematical-notes) shows the receipts.

## Guide an active or paused campaign

```sh
bun packages/solve/solve.ts guide --id try-direct-proof campaign.db packages/solve/examples/guidance.txt
bun packages/solve/solve.ts inspect --include-guidance campaign.db
```

`guide` reads a UTF-8 file, or standard input when the filename is `-`, saves the text in the campaign, and returns a receipt. The [guidance rules](docs/role-runner.md#guidance) state delivery.

## Independent review

```sh
bun packages/solve/solve.ts review task.json argument.md review.db packages/solve/examples/profile-review.json
```

`review` runs a full Codex audit of the exact task and complete argument, without solver verdicts, and returns PASS, FAIL, or INCONCLUSIVE with its evidence in a separate review journal. The [review rules](docs/role-runner.md#independent-review) state its contract.

## External final review

After `accepted`, give an external reviewer the frozen task and the complete argument from `export`, including every supporting proof. Omit Xean's verdicts and verification flags from that review packet. The reviewer checks the supplied argument, hypotheses, citations, and completion criteria, including supporting lemmas, rather than rediscovering the solution. Record the external verdict and its evidence in the evaluation's artifacts, separately from Xean's internal acceptance. External review adds no verifier or support-challenge mechanism to the campaign.

## Development

```sh
bun run check
bun run e2e:roles
```

[`docs/role-runner.md`](docs/role-runner.md) defines solver behavior. [`docs/role-e2e.md`](docs/role-e2e.md) explains the hermetic role tests.

## License

The solver is available under the [MIT license](../../LICENSE).
