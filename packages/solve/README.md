# elenx-solve

`elenx-solve` runs mathematical exploration from a JSON task and saves each role's work in a SQLite campaign. A person or another agent can start the run, inspect its progress, supply text notes or guidance, and resume after an interruption. [Agent usage](docs/agent-usage.md) gives a complete command sequence.

[Install the released packages](docs/installation.md) to use `elenx-solve` from any project with an OpenAI API account or a Codex subscription.

```text
explorer(task, explorerGuidance, notes, support) -> notes with support
coordinator(task, notes) -> filings, explorerGuidance, support, verify
verifier(task, verify, notes, support)        -> verdicts
```

The explorer writes notes, each one self-contained text that names as support the notes whose results it uses without proving them. It says in the text when a note meets the completion criteria. The coordinator files every new note with a summary, its statement plus what the text says about its own status, gives advice for the next Explorer turn and selects the support notes it reads in full, and lists the notes to verify in priority order, each with the verifiers to run: a prefix of source, correctness, requirements, reconstruction. An unchecked note that later work will build on gets the first two and ends verified. A note whose text says it meets the completion criteria gets all four. One verification takes the longest prefix of that list whose note and support texts fit the `window` setting, always its first entry, and runs the verifiers in order on the notes that asked for them. A note stops at its first verdict that is not `PASS`, and a note whose support failed in the same verification is skipped. The workflow drains the requested list in fitting batches before another Explorer turn or the turn cap. Notes blocked by failed or inconclusive support are skipped while independent notes continue. Acceptance ends the search immediately.

The source verifier checks invoked external results and their hypotheses using available sources, mathematical knowledge, and supplied texts. Nonroutine imported theorems are separate support notes, which may precede their applications in the same Explorer submission. Their source notes may cite the literature directly. The source check catches an undeclared substantive dependency before downstream verification, while routine facts need no separate note. Its profile selects Codex with web search or Pi without it. A concrete mismatch fails a note, while a specific unresolved uncertainty leaves it inconclusive. The correctness verifier checks every inference and searches for counterexamples and missing cases. The requirements verifier alone decides whether a note meets the completion criteria. The reconstruction verifier states what the note establishes, has a fresh call write a proof of that statement from the support notes without seeing the note's text, and compares the two. Every verifier may return `INCONCLUSIVE`, which ends that note's verification attempt and sends the uncertainty to the next Explorer turn without marking the note defective. Support notes are handed to every verifier in full as established results not under review, so a verdict always names a note under verification.

A note is verified when source and correctness passed in one verification, or its caller supplied external verification, provided its support is verified and it is not dead. The coordinator lists a note only after every note in its support is verified or listed earlier with the correctness verifier, so an accepted note's closure is verified. The coordinator never has the explorer check, polish, or restate a verified note. A note is dead when correctness, source, or reconstruction failed it or a note in its support is dead. Every role still sees it with its verdicts, the explorer cannot name it as support, and the coordinator cannot list it again. External verification cannot override those failures. The workflow ends when all four normal verifiers pass one note on one verification.

Every role call is one logical model invocation, which may contain provider continuation requests, recorded in the Elenx journal with its request, transcript, and submission, and for Pi calls its telemetry. A verifier call that returns note verdicts records one kernel verdict whose evidence lists those verdicts. Reconstruction statement and proof calls, and judgments that only correct a statement, record their submissions without a mathematical verdict. Notes, verdicts, verified, dead, accepted, and the workflow phase are derived from those records. Repeating `run` rebuilds the phase and executes the first missing role call. Candidates, verdicts, telemetry, and spend remain append-only evidence.

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

The correctness, requirements, and reconstruction verifiers run through Pi on their own profiles, so a note that leans on an outside result costs one source call, a defective one adds one correctness call, and only sound notes reach the expensive calls. The source verifier runs the Codex CLI on its native credential, the only path that provides web search, when its provider is `codex`. Its `search` is true by default. Setting it to `false` keeps the call offline and assesses invoked results and their hypotheses from mathematical knowledge and supplied texts. Failed or inconclusive online lookup uses the same assessment. Known results can pass, concrete false statements or incorrect applications fail, and a specific uncertainty leaves the check `INCONCLUSIVE`. Only results confirmed in sources actually opened receive source entries. `ELENX_CODEX_COMMAND` names the binary, default `codex`. A source profile with any other provider runs the source verifier as one Pi call without web search, so a worker needs no Codex credential; that is the profile for a task that must not reach the internet. `window` is a character count over the note and support texts one verification reads, default 100000. A verification of one note normally makes one to six calls: the reconstruction verifier is three. Correcting a reconstruction statement adds a proof call and judgment, and preserves all successful checks. Spend covers the Pi calls; the source verifier's usage is on its submission.

### Explorer continuation

Set `"explorerContinuation": true` in settings to keep Explorer working in the same context until it claims a complete solution or approaches its context limit. Omit the setting, or set it to `false`, for ordinary Explorer handoff. Coordinator, verification, search permissions, total-context budget, output reserve, and the Explorer-turn cap keep their existing behavior.

With the toggle on, Explorer can call `submit_notes` repeatedly, once per assistant response. Every valid submission saves new notes and its tool receipt carries the actual result `{noteIds}` only; later submissions may name those notes as support. Submit only new work, since earlier notes remain saved. The `solution` boolean permits early handoff when true, and the usual verifiers still judge the claim. While the context threshold has not been reached, every valid nonempty nonterminal submission is followed after its receipt by a fresh user message exactly `Keep trying, you can do it.`. The message asks Explorer to continue in the existing context; it is not a separate planning submission. Explorer chooses the route and should return new work; a plan or recap alone is insufficient. At the threshold, the call finalizes. The first empty submission ends the call immediately, and the coordinator receives all accumulated notes and the existing `emptySubmission: true` notice asking it to choose a different promising approach. This consumes one ordinary Explorer turn; the next Explorer starts fresh with the coordinator's guidance and selected notes. Explorer uses the generic kernel gate's `emptyArgument: "notes"` guard.

The preferred total-context budget is 400,000 tokens, bounded by the model's actual context capacity. Set `"explorerContextBudgetTokens": 400000` to make that default explicit, or supply another positive integer. The setting applies only with continuation enabled and is frozen with the campaign settings. Explorer reserves the model's maximum output tokens for final notes. For Astra with 128,000 maximum output tokens and Pi's current 4,096-token safety margin, the handoff threshold is `400,000 - 128,000 - 4,096 = 267,904` estimated context tokens. Model capacity and input-based pricing thresholds remain separate metadata.

Elenx uses Pi's context estimate, anchored to the latest applicable provider usage and estimated trailing messages. The accumulated conversation stays intact. Pi's native output-cap helper preserves the reserve before the threshold and releases it for finalization at the threshold. A budget that cannot fit the reserve and safety margin is rejected. Providers that ignore output caps may overshoot the requested allocation, and context overflow remains an operational failure. The estimate is not cumulative reasoning usage or an exact measurement of hidden provider state.

The enabled call uses context occupancy in place of the ordinary 32-request and eight-length-continuation limits. Transient-error recovery stays bounded, and interruption remains available. All these provider requests count as one Explorer turn. Use two fresh campaign databases with the same task and settings except for the toggle when comparing behavior. Compare cost and externally checked outcomes as well as turns.

## Run

```sh
bun install --frozen-lockfile
bun packages/solve/solve.ts contract
bun packages/solve/solve.ts run task.json campaign.db settings.json
bun packages/solve/solve.ts inspect campaign.db
bun packages/solve/solve.ts inspect --include-requests campaign.db
bun packages/solve/solve.ts export campaign.db
```

`run` creates a campaign or resumes the existing campaign after matching the exact task and settings against its declaration. Before a fresh campaign or unfinished resume makes a model call, it resolves every configured Pi role and its requested reasoning level, checks available provider credentials, and checks the native source CLI and its file-based login when that profile is selected. These checks make no paid model request and do not establish backend reachability or account entitlement. A completed campaign returns before provider initialization, so it needs no model registry or credentials. A second process cannot drive the same database. `contract` reports execution-contract schema 9 with application `elenx-solve`, protocol `workflow`, and arguments `task`, `campaign`, and `settings`.

`inspect` is the read authority. It derives the task, current phase, notes with their verdicts and flags, role calls with their submissions, and spend from the append-only journal. Its `accounting` field reports `measuredCostUsd` and `complete`, with `unmeasuredRequests`, `unaccountedCalls`, their saved `potentialRequests`, and `unpricedCalls`. A saved request checkpoint establishes that a request was prepared, not that inference completed. Missing usage or prices remain unknown, and the measured subtotal is null when no cost was measured. Native Codex source calls have token usage but no journaled price and therefore keep cost accounting incomplete. Terminal campaigns contain `result` with outcome `accepted` or `turn-limit`. Each reachable check runs once per candidate. An `INCONCLUSIVE` verdict preserves the uncertainty in the note's report and allows the next Explorer turn within `maxExplorerTurns`. A note still needs all required PASS verdicts to be accepted. `paused`, `call-failure`, and `interrupted` are run outcomes that leave unfinished work resumable. Repeating `run` resumes the next missing role call and preserves completed checks. A malformed reconstruction statement is corrected within verification instead of sending the proof back to the explorer. `export` emits the accepted note preceded by its closure, in id order.

Each role can also run alone:

```sh
bun packages/solve/solve.ts explorer input.json roles.db settings.json
bun packages/solve/solve.ts coordinator input.json roles.db settings.json
bun packages/solve/solve.ts verifier input.json roles.db settings.json
```

Standalone role commands are boundary diagnostics. They use the same role schemas and journal machinery and are not a second workflow. An Explorer input carries one `explorerGuidance` string, empty when there is no advice. A coordinator result supplies that field for the next turn.

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

The caller prepares the text, including PDF or CSV conversion, retrieval, dataset analysis, and selection of useful prior-run work. Elenx places it in the existing note graph, support closure, and context formatting. File preparation adds no solver role.

## Guide an active or paused campaign

```sh
bun packages/solve/solve.ts guide --id try-direct-proof campaign.db packages/solve/examples/guidance.txt
bun packages/solve/solve.ts inspect --include-guidance campaign.db
```

`guide` reads a UTF-8 file, or standard input when the filename is `-`. It saves the text in the campaign and returns a JSON receipt containing its `id`, journal `call`, `atMs`, `text`, and guidance `schemaVersion`. Supplying the same `--id` and exact text again returns the original receipt. Reusing an id with different text fails. Omitting `--id` creates a new id for each submission.

The runner combines the coordinator's `explorerGuidance` with pending external advice, in journal order, into the Explorer's single `explorerGuidance` string. Advice applies to that turn only. Guidance received after a turn's input is frozen waits for the next turn. The current turn and its retries keep the same advice. A fresh Explorer call after interruption also receives all notes already saved by that turn in full, with their original IDs. The first turn works directly on the original task unless advice was submitted beforehand. There is no persistent guidance setting.

The coordinator and external advice can orient the Explorer without changing its task. The Explorer may reject a diagnosis, pursue a better approach, or finish a suggested step and continue useful mathematics. Submitting guidance makes no model call and works while the existing runner holds its campaign lock. A paused campaign still needs the usual `run` command to continue.

`inspect --include-guidance` adds the external receipts with `calls`, the Explorer call ids whose inputs included that guidance, and `pending`, true until an Explorer call includes it. Multiple calls can be retries of the same turn. Delivery records show what was sent to the model. The model's notes show how it used the advice. Advice recorded on a terminal campaign, or too late for another Explorer turn, remains pending. `guide` never reopens a terminal campaign or changes its result.

Workflow schema 37 continues after nonempty nonterminal Explorer submissions with a fresh user message. The first empty submission hands off immediately to stop empty loops. It validates dependencies through structured support, with completeness checked by mathematical verification. It saves repeated Explorer submissions, preserves them after interrupted calls, and delivers them together at handoff. The Explorer context budget, output reserve, verification order, and Explorer-turn cap retain their existing behavior. Execution-contract schema 9 permits optional external `verification` on notes and zero Explorer turns in an accepted result. The `run` arguments remain `task`, `campaign`, and `settings`. The role field remains `explorerGuidance`, with no persistent guidance setting. Preserve older campaigns with their matching implementation. The [agent guide](docs/agent-usage.md) covers recovery and programmatic submission.

## External final review

After `accepted`, give an external reviewer the frozen task and the complete argument from `export`, including every supporting proof. Omit Elenx's verdicts and verification flags from that review packet. The reviewer checks the supplied argument, hypotheses, citations, and completion criteria, including supporting lemmas, rather than rediscovering the solution. Record the external verdict and its evidence in the evaluation's artifacts, separately from Elenx's internal acceptance. External review adds no verifier or support-challenge mechanism to the campaign.

## Development

```sh
bun run --cwd packages/solve check
bun run e2e:roles
```

[`docs/role-runner.md`](docs/role-runner.md) defines the role schemas, replay behavior, and inspection boundary. [`docs/role-e2e.md`](docs/role-e2e.md) explains the hermetic role tests.

## License

The solver is available under the [MIT license](LICENSE).
