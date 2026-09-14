# xean-solve

`xean-solve` runs mathematical exploration from a JSON task and saves each role's work in a SQLite campaign. A person or another agent can start the run, inspect its progress, supply text notes or guidance, and resume after an interruption. [Agent usage](docs/agent-usage.md) gives a complete command sequence.

[Install the solver](docs/installation.md) to use `xean-solve` with an OpenAI API account or a Codex subscription.

```text
explorer(task, explorerGuidance, notes, support) -> notes with support
coordinator(task, notes) -> filings, explorerGuidance, support, verify
verifier(task, verify, notes, support)        -> verdicts
```

The explorer writes notes, each one self-contained text that names as support the notes whose results it uses without proving them. It says in the text when a note meets the completion criteria. The coordinator files every new note with a summary, its statement plus what the text says about its own status, gives advice for the next Explorer turn and selects the support notes it reads in full, and lists the notes to verify in priority order, each with the verifiers to run: a prefix of source, correctness, requirements, reconstruction. An unchecked note that later work will build on gets the first two and ends verified. A note whose text says it meets the completion criteria gets all four. One verification takes the longest prefix of that list whose note and support texts fit the `window` setting, always its first entry, and runs the verifiers in order on the notes that asked for them. A note stops at its first verdict that is not `PASS`, and a note whose support failed in the same verification is skipped. The workflow drains the requested list in fitting batches before another Explorer turn or the turn cap. Notes blocked by failed or inconclusive support are skipped while independent notes continue. Acceptance ends the search immediately.

The source verifier opens primary sources to check every nonroutine imported theorem and its exact hypotheses. The Explorer states each imported theorem in a separate support note. The verifier lists the external results, records the relevant source passages and URLs, and checks that they justify the claims. A source mismatch fails the note when it exposes a mathematical defect or an unsupported required premise. Bibliographic and attribution errors are recorded as corrections without failing a mathematically verified argument, including when another primary source establishes the needed result. An inaccessible necessary statement leaves the check inconclusive. Immediate routine facts and self-contained proofs need no retrieval. The correctness verifier checks deductions, the requirements verifier checks completion, and reconstruction independently proves the statement from established support. These stages retain their existing order and dependency rules.

A note is verified when source and correctness passed in one verification, or its caller supplied external verification, provided its support is verified and it is not dead. The coordinator lists a note only after every note in its support is verified or listed earlier with the correctness verifier, so an accepted note's closure is verified. The coordinator never has the explorer check, polish, or restate a verified note. A note is dead when correctness, source, or reconstruction failed it or a note in its support is dead. Every role still sees it with its verdicts, the explorer cannot name it as support, and the coordinator cannot list it again. External verification cannot override those failures. The workflow ends when all four normal verifiers pass one note on one verification.

Every role call is one logical model invocation, which may contain provider continuation requests, recorded in the Xean journal with its request, transcript, and submission, and for Pi calls its telemetry. A verifier call that returns note verdicts records one kernel verdict whose evidence lists those verdicts. Reconstruction statement and proof calls, and judgments that only correct a statement, record their submissions without a mathematical verdict. Notes, verdicts, verified, dead, accepted, and the workflow phase are derived from those records. Repeating `run` rebuilds the phase and executes the first missing role call. Candidates, verdicts, telemetry, and spend remain append-only evidence.

Correctness judges the claims a note makes, including whether its declared support suffices. Submission validation checks the structured `support` array and does not infer dependencies from mathematical notation or mentions of note IDs. A sound partial result passes correctness even when the task remains unfinished. Requirements alone judges task completion. Every verifier receives the complete support closure of the notes it judges, including the earlier notes that supporting proofs rely on. Shared texts appear once and count once against the verification window. Established supporting results are available to resolve inherited definitions and cases, without being reverified. Explorer inputs list note metadata once and append selected supporting texts with their complete dependency closure. Model prompts omit historical PASS explanations while retaining each verdict, all FAIL and INCONCLUSIVE reports, and the original note statements. Inspection retains the complete reports. Changing Explorer guidance follows the stable mathematics in the prompt. The coordinator's guidance orients the next turn, while verification state comes from the note fields.

## Task and settings

The task file has one schema. The completion criteria are the only statement of what an accepted note must do, so a task that would accept a counterexample says so there:

```json
{
  "problem": "Prove that the sum of two even integers is even.",
  "completionCriteria": "Give a standalone proof for arbitrary even integers."
}
```

Settings select one model profile for the explorer, one for the coordinator, one per verifier, the cap on explorer turns, and the window. Start with the [OpenAI API example](examples/settings-openai.json) or the [Codex subscription example](examples/settings-openai-codex.json), then adjust the role profiles for your task. [Provider setup](docs/installation.md#choose-a-provider) explains credentials.

The correctness, requirements, and reconstruction verifiers run through Pi. The source verifier always runs the Codex CLI with web search and its native credential. Set its provider to `codex`; `search` defaults to `true` and cannot be disabled. Other source providers are rejected. `XEAN_CODEX_COMMAND` names the binary, default `codex`. Each source verdict lists `externalResults` and `sources`, whose entries contain the checked result, paper and theorem location, URL, and quoted passage. A PASS missing a passage for a listed result is rejected. Claimed source evidence also requires recorded web-tool activity. The model remains responsible for identifying all imported results and judging whether the passages substantiate them. The CLI transcript does not reliably expose opened-page URLs, so URL and quotation accuracy are model judgments preserved for inspection. `window` remains a character limit over the notes and their support. Native Codex usage is recorded without a price.

### Explorer continuation

Explorer continuation is enabled by default. Explorer keeps working in the same context until it claims a complete solution, submits an empty notes array, reaches its response budget, or approaches its context limit. Set `"explorerContinuation": false` in settings for ordinary Explorer handoff.

Set `"maxExplorerResponses": 4` in settings to choose the response budget. The default is 4 responses per Explorer call, including the first, so it permits at most three continuation pushes. A value of 1 hands off after the first response; a large value such as 1000000000000000 leaves the context budget as the practical limit. This bounds responses, not reasoning tokens or cost. Plain text, length-limited output, and rejected submissions count. Provider errors do not count and use the separate recovery allowance. The setting applies only with continuation enabled and is frozen with the campaign settings. A fresh role call after failure or interruption starts a fresh budget; internal provider retries share the existing count.

With the toggle on, Explorer can call `submit_notes` repeatedly, once per assistant response. Every valid submission saves new notes and its tool receipt carries the actual result `{noteIds}` only; later submissions may name those notes as support. Submit only new work, since earlier notes remain saved. The `solution` boolean permits early handoff when true, and the usual verifiers still judge the claim. While both the response budget and context threshold permit continuation, every valid nonempty nonterminal submission is followed after its receipt by a fresh user message exactly `Keep trying, you can do it.`. The message asks Explorer to continue in the existing context; it is not a separate planning submission. Explorer chooses the route and should return new work; a plan or recap alone is insufficient. At either limit, a valid submission hands all saved notes to the coordinator. Reaching the response budget without a valid final submission fails the call and retains its saved notes. The first empty submission ends the call immediately, and the coordinator receives all accumulated notes and the existing `emptySubmission: true` notice asking it to choose a different promising approach. This consumes one ordinary Explorer turn; the next Explorer starts fresh with the coordinator's guidance and selected notes. Explorer uses the generic kernel gate's `emptyArgument: "notes"` guard.

The preferred total-context budget is 400,000 tokens, bounded by the model's actual context capacity. Set `"explorerContextBudgetTokens": 400000` to make that default explicit, or supply another positive integer. The setting applies only with continuation enabled and is frozen with the campaign settings. Explorer reserves the model's maximum output tokens for final notes. For Astra with 128,000 maximum output tokens and Pi's current 4,096-token safety margin, the handoff threshold is `400,000 - 128,000 - 4,096 = 267,904` estimated context tokens. Model capacity and input-based pricing thresholds remain separate metadata.

Xean uses Pi's context estimate, anchored to the latest applicable provider usage and estimated trailing messages. The accumulated conversation stays intact. Pi's native output-cap helper preserves the reserve before the threshold and releases it for finalization at the threshold. A budget that cannot fit the reserve and safety margin is rejected. Providers that ignore output caps may overshoot the requested allocation, and context overflow remains an operational failure. The estimate is not cumulative reasoning usage or an exact measurement of hidden provider state.

The enabled call uses its response budget and context occupancy in place of Pi's ordinary 32-turn and eight-length-continuation limits. Transient-error recovery has its own bound, and interruption remains available. All these provider requests count as one Explorer turn. Use two fresh campaign databases with the same task and settings except for the response budget when comparing behavior. Compare cost and externally checked outcomes as well as turns.

## Run

```sh
bun install --frozen-lockfile
bun packages/solve/solve.ts contract
bun packages/solve/solve.ts run task.json campaign.db settings.json
bun packages/solve/solve.ts inspect campaign.db
bun packages/solve/solve.ts inspect --include-requests campaign.db
bun packages/solve/solve.ts export campaign.db
```

`run` creates a campaign or resumes the existing campaign after matching the exact task and settings against its declaration. Before a fresh campaign or unfinished resume makes a model call, it resolves every configured Pi role and its requested reasoning level, checks available provider credentials, and checks the native source CLI and its file-based login. These checks make no paid model request and do not establish backend reachability or account entitlement. A completed campaign returns before provider initialization, so it needs no model registry or credentials. A second process cannot drive the same database. `contract` reports execution-contract schema 1 with application `xean-solve`, protocol `workflow`, and arguments `task`, `campaign`, and `settings`.

`inspect` is the read authority. It derives the task, current phase, notes with their verdicts and flags, role calls with their submissions, and spend from the append-only journal. Its `accounting` field reports `measuredCostUsd` and `complete`, with `unmeasuredRequests`, `unaccountedCalls`, their saved `potentialRequests`, and `unpricedCalls`. A saved request checkpoint establishes that a request was prepared, not that inference completed. Missing usage or prices remain unknown, and the measured subtotal is null when no cost was measured. Native Codex source calls have token usage but no journaled price and therefore keep cost accounting incomplete. Terminal campaigns contain `result` with outcome `accepted` or `turn-limit`. Each reachable check runs once per candidate. An `INCONCLUSIVE` verdict preserves the uncertainty in the note's report and allows the next Explorer turn within `maxExplorerTurns`. A note still needs all required PASS verdicts to be accepted. `paused`, `call-failure`, and `interrupted` are run outcomes that leave unfinished work resumable. Repeating `run` resumes the next missing role call and preserves completed checks. A malformed reconstruction statement is corrected within verification instead of sending the proof back to the explorer. `export` emits the accepted note preceded by its closure, in id order.

When a provider fails after making progress within a role call, the workflow derives its unfinished role from the journal and retries with a fresh provider session and rebuilt input. Saved notes, frozen guidance, and completed checks remain available; provider response IDs and conversation state are not carried into the new call. The workflow permits three such retries between completed phases, delayed by 1, 2, and 4 seconds. Cancellation, initial-request failures, and invalid tool submissions do not trigger these retries. This recovery uses the same provider-independent role and journal interfaces as an ordinary resume.

Each role can also run alone:

```sh
bun packages/solve/solve.ts explorer input.json roles.db settings.json
bun packages/solve/solve.ts coordinator input.json roles.db settings.json
bun packages/solve/solve.ts verifier input.json roles.db settings.json
```

Standalone role commands are boundary diagnostics. They use the same role schemas and journal machinery and are not a second workflow. An Explorer input carries one `explorerGuidance` string, empty when there is no advice. A coordinator result supplies that field for the next turn.

## Independent review

`review` runs a full Codex audit of the exact task and complete argument, including supporting proofs and citations. It receives no internal solver verdicts. The reviewer checks the primary sources and returns PASS, FAIL, or INCONCLUSIVE with its evidence. Citation corrections alone do not change the mathematical verdict and are included in the report.

```sh
bun packages/solve/solve.ts review task.json argument.md review.db packages/solve/examples/profile-review.json
```

The profile selects Codex with web search. The separate review journal freezes the task, argument, profile, instructions, and output schema, and records the Codex transcript and source passages. Repeating the same completed review returns its original receipt without another model call. Changed inputs or instructions require a new journal. The receipt is compatible with `xean-lab review record`. A failed or inconclusive independent review leaves the solver's historical acceptance record intact.

## Supply notes

Create a campaign before its first model call, then submit mathematical text:

```sh
bun packages/solve/solve.ts init task.json campaign.db settings.json
bun packages/solve/solve.ts submit --id initial-work campaign.db notes.json
bun packages/solve/solve.ts inspect --include-submissions campaign.db
bun packages/solve/solve.ts run task.json campaign.db settings.json
```

`init` creates or matches the exact task and settings declaration without provider setup. It returns `application`, `campaignPath`, and `created`. `submit` reads a JSON file, or standard input when the filename is `-`:

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

The text is stored exactly and enters the next coordinator input available for new notes. The coordinator files its summary, selects useful support, and requests the usual checks. A submitted note without `verification` starts as unchecked work. To supply an externally verified result, explicitly add `verification: {"source": "reviewer identity", "report": "what was checked and the evidence"}`. This attestation establishes the note over verified support while it is not dead. Its `source` identifies the reviewer or caller, separately from the source verifier's literature evidence. A complete proof still needs source, correctness, requirements, and reconstruction to pass before acceptance, which can occur at zero Explorer turns.

Every support ID must name an existing campaign note that is not dead. IDs of other notes in the same submission cannot be predicted or referenced. Use inspection's delivered `noteIds` for later submissions. The same `--id` and note content return the original receipt, while changed content with that id fails. Without an id, each submission is new.

Both commands make zero model calls. `submit` works alongside the runner. Notes received during an Explorer call are numbered after its returned notes and before the next coordinator input. A frozen coordinator or verifier input keeps its original content, so later submissions wait for another intake boundary. A terminal campaign keeps the submission pending without reopening. `inspect --include-submissions` exposes receipts, delivery boundaries, coordinator call IDs, assigned note IDs, and pending status. The [agent guide](docs/agent-usage.md#supply-mathematical-notes) covers these fields and external verification in detail.

The caller prepares the text, including PDF or CSV conversion, retrieval, dataset analysis, and selection of useful prior-run work. Xean places it in the existing note graph, support closure, and context formatting. File preparation adds no solver role.

## Guide an active or paused campaign

```sh
bun packages/solve/solve.ts guide --id try-direct-proof campaign.db packages/solve/examples/guidance.txt
bun packages/solve/solve.ts inspect --include-guidance campaign.db
```

`guide` reads a UTF-8 file, or standard input when the filename is `-`. It saves the text in the campaign and returns a JSON receipt containing its `id`, journal `call`, `atMs`, `text`, and guidance `schemaVersion`. Supplying the same `--id` and exact text again returns the original receipt. Reusing an id with different text fails. Omitting `--id` creates a new id for each submission.

The runner combines the coordinator's `explorerGuidance` with pending external advice, in journal order, into the Explorer's single `explorerGuidance` string. Advice applies to that turn only. Guidance received after a turn's input is frozen waits for the next turn. The current turn and its retries keep the same advice. A fresh Explorer call after interruption also receives all notes already saved by that turn in full, with their original IDs. The first turn works directly on the original task unless advice was submitted beforehand. There is no persistent guidance setting.

The coordinator and external advice can orient the Explorer without changing its task. The Explorer may reject a diagnosis, pursue a better approach, or finish a suggested step and continue useful mathematics. Submitting guidance makes no model call and works while the existing runner holds its campaign lock. A paused campaign still needs the usual `run` command to continue.

`inspect --include-guidance` adds the external receipts with `calls`, the Explorer call ids whose inputs included that guidance, and `pending`, true until an Explorer call includes it. Multiple calls can be retries of the same turn. Delivery records show what was sent to the model. The model's notes show how it used the advice. Advice recorded on a terminal campaign, or too late for another Explorer turn, remains pending. `guide` never reopens a terminal campaign or changes its result.

The [agent guide](docs/agent-usage.md) covers recovery and programmatic submission.

## External final review

After `accepted`, give an external reviewer the frozen task and the complete argument from `export`, including every supporting proof. Omit Xean's verdicts and verification flags from that review packet. The reviewer checks the supplied argument, hypotheses, citations, and completion criteria, including supporting lemmas, rather than rediscovering the solution. Record the external verdict and its evidence in the evaluation's artifacts, separately from Xean's internal acceptance. External review adds no verifier or support-challenge mechanism to the campaign.

## Development

```sh
bun run --cwd packages/solve check
bun run e2e:roles
```

[`docs/role-runner.md`](docs/role-runner.md) defines the role schemas, replay behavior, and inspection boundary. [`docs/role-e2e.md`](docs/role-e2e.md) explains the hermetic role tests.

## License

The solver is available under the [MIT license](LICENSE).
