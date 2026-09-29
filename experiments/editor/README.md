# Editor experiment

Test whether editing produces a smaller, coherent mathematical reference while preserving useful results, proofs, methods, scoped limitations, and open gaps. All trials use one frozen three-note fixture. There is no compression target or requirement to preserve each old note. A short but defective replacement fails.

The best reviewed GPT-6 Luna draft reduced the complete mathematical payload by 13.6%. Fresh native workflows reduced it by 10.1% with Sol checking and 3.4% with Luna checking. These samples show inexpensive editing with modest compression and substantial latency. General reliability and downstream monetary savings remain unestablished. The latest summary controls returned unchanged PASS despite a preregistered expectation of correction. Independent audit confirmed that the wording exceeds the supplied proof, but did not establish that the stronger assertion is false.

**Current accounting: 33 requests, $1.61070294 known API-equivalent usage, plus unknown usage for one of those requests.** The unpriced request was an original transport failure and is counted once. Curation and interactive independent review are separate and unpriced. All recorded jobs are terminal, and no research corpus was activated. Further experiments remain restricted to this fixture. State a specific next question and independently establish any intended defect before another call.

## Materials and protocol

- [input.json](input.json): the problem and three original notes shown to the model.
- [golden.md](golden.md): provenance, capability/proof answer key, and known failure cases. The runner never reads it.
- [baseline.md](prompts/baseline.md), [reference.md](prompts/reference.md), [consolidation.md](prompts/consolidation.md), and [reuse.md](prompts/reuse.md): frozen prompt conditions.
- [settings.json](settings.json): current GPT-6 Luna/max generation settings, with one admitted call and no literature access.
- [run.ts](run.ts), [operate.ts](operate.ts), and [job.nomad.hcl](job.nomad.hcl): generation, operations, and the shared native-role job.

The input has 5,663 proof-body tokens, 6,110 mathematical tokens including summaries and support, and 7,511 tokens in its complete JSON. Counts use `o200k_base` as a common reference tokenizer. Mathematical counts include retained dependency closure and exclude historical verification records. The original `fullNote` projection, including status and feedback, has 6,196 tokens. Provider usage is measured separately and includes reasoning.

The historical fixture has identical index and detailed summaries. Edited detailed summaries may add useful hypotheses and bounds, so their growth is not necessarily waste. Assess that middle view's utility alongside complete-payload size.

Each generation uses the existing Pi request path, schema, and dependency validation for one call and one draft. It has no automatic repair or verification. Compare its output with the hidden key afterward: check usable capabilities and complete arguments, scoped negatives, dependency closure, and consolidation of repeated exposition. Equivalent valid proofs and different organizations are welcome. Generation completion, native acceptance, and independent review are separate outcomes.

Change one factor at a time and commit before launching. Prompt comparisons use separate frozen prompt files. Model comparisons hold prompt and reasoning fixed. Preserve failed requests and invalid submissions. Keep the dataset and answer key fixed, and treat success as evidence about this development fixture only.

## Run on Fleet

Run from the adjacent Fleet Infra checkout with its locked Bun:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-example-r01 consolidation
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts status editor-golden-example-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts collect editor-golden-example-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts cancel editor-golden-example-r01
```

Launch requires a clean, internally pushed commit and a fresh attempt ID. It reuses the pinned worker image on jupiter. The operator reads the gateway credential from OpenBao into memory, excluding it from committed files and saved jobs. Inspect the attempt after a submission error before creating another.

Collect into ignored `runs/<attempt-id>/`. Preserve frozen inputs/settings, hashes, source commit, complete request records, replacement, usage, elapsed time, and review evidence. Missing usage is unknown cost. Gateway and Pi usage overlap and must not be added. Costs below use frozen API-equivalent rates reconciled against gateway token buckets, not subscription bills. Request latency excludes queueing and operator work. Detailed reports and accounting remain in the evidence paths below, with earlier README narratives in Git.

The same operator runs native roles or the complete workflow:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-check-r01 verifier INPUT.json SETTINGS.json
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-review-r01 editionReview INPUT.json SETTINGS.json
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-repair-r01 editor INPUT.json SETTINGS.json
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-native-r01 edit ../xean-editor-science/experiments/editor/input.json SETTINGS.json
```

For `verifier`, supply `{task, notes: replacement, targets}` with every target through `source`. Collection reads the native campaign without ownership or recovery and writes `snapshot.json`. Apply only completed published checks to a copy with `applyChecks`, preserving raw drafts and correction revisions. Supply `{task, notes: checkedReplacement, previous: originalNotes}` to `editionReview`. For a controlled repair, supply `{task, notes: originalNotes, previous: checkedReplacement, review: coverageVerdict}` to `editor`. Retained IDs keep checks, while rewritten notes need fresh verification. Freeze each stage, withhold the golden key and independent review, and include failed drafts and prior checks in actual-path costs. Standalone roles admit one call each.

`edit` runs the built-in workflow with a finite positive `limits.providerCalls` fixed before launch. The conservative reference configuration uses GPT-6 Luna/max by default and complete GPT-6 Sol/max `correctness` and `editorRepair` profiles. Native-r03 instead used Luna correctness, with Sol repair configured but unused. These are experimental settings, not changes to production defaults. Profiles replace whole profiles, so copy gateway and credential fields when overriding a model. `editorRepair` falls back to `editor`, then `default`. See [solver configuration](../../docs/solver.md) for editing-only runtime composition and check reuse across models.

Limits `{concurrency: 1, attempts: 1, providerCalls: 6}` allow an initial cycle and one repair cycle if every stage takes one call. Acceptance stops earlier. Retries, invalid submissions, or source obligations can consume the allowance first. Extensions are not automatic. A native completed editing result establishes that its gates passed. Measure size and independently inspect useful mathematics as separate judgments.

The former large-run drivers and templates remain in commit `23f19fa9188c119ca0fc2210019f032ae73b1614`, with historical artifacts under the original checkout's ignored `runs/`. The cancelled full-corpus continuation produced no replacement or coverage verdict and remains stopped.

## Outcomes

All model conditions below use max reasoning. Each table records request time unless marked as whole-task time.

The preregistered next pair, `runs/editor-golden-reuse-r01-protocol/`, compares consolidation with one added within-call editing pass: replace repeated derivations with precise applications of existing support, and keep proof tours out of summaries. It uses fresh one-call GPT-6 Luna arms at the same source commit. The input, settings, schema, and hidden key stay fixed. A shorter result must retain both usable proofs and useful detailed summaries before native follow-up. Results are pending.

### Generation comparisons

| Prompt        | Model        | Notes | Body tokens | Mathematical tokens |   Time |       Cost |
| ------------- | ------------ | ----: | ----------: | ------------------: | -----: | ---------: |
| Baseline      | GPT-6 Sol    |     4 |       5,249 |               6,838 | 6m 55s |  $0.213570 |
| Reference     | GPT-6 Sol    |     6 |       9,429 |              10,918 | 5m 52s |  $0.191292 |
| Consolidation | GPT-6 Sol    |     4 |       4,172 |               5,284 | 4m 51s |  $0.167792 |
| Consolidation | GPT-5.6 Luna |     4 |       5,433 |               6,679 | 8m 49s |  $0.036634 |
| Consolidation | GPT-6 Luna   |     4 |       4,312 |               5,276 | 5m 33s | $0.0096681 |

Baseline preserved the useful mathematics under blind review but grew the complete payload 11.9%. Reference retained all originals through dependencies and added notes, growing it 78.7%. Neither achieved useful net compression. Consolidation explicitly replaces repeated arguments and keeps summaries concise. Its Sol and GPT-6 Luna samples reduced mathematical payload by 13.5% and 13.6%, with no consequential defect or lost capability found independently. Minor clarifications concerned generic predicate-evaluation costs and learner-summary wording. GPT-5.6 Luna grew the payload 9.3% and stopped before a proof audit.

The first pair cost $0.404862, the first three calls $0.572654, and all five generations $0.618956 (rounded). Evidence: `runs/editor-golden-comparison-r01/`, `runs/editor-golden-baseline-r01/`, `runs/editor-golden-reference-r01/`, `runs/editor-golden-consolidation-r01/`, `runs/editor-golden-luna-r01/`, and `runs/editor-golden-luna6-r01/`.

### Native assessment of the frozen GPT-6 Luna draft

| Stage                | Model      | Outcome                          |    Time |       Cost |
| -------------------- | ---------- | -------------------------------- | ------: | ---------: |
| Correctness/source   | GPT-6 Sol  | All four PASS, unchanged         |  2m 20s | $0.0766120 |
| Coverage, first call | GPT-6 Sol  | Prose only, no published verdict |  1m 29s | $0.0631580 |
| Coverage, retry      | GPT-6 Sol  | PASS                             | 12m 34s | $0.1956480 |
| Coverage comparison  | GPT-6 Luna | PASS                             |  4m 55s | $0.0066834 |

The retry required `submit_result` through Pi's Codex `tool_choice: "required"` when submission is the sole tool. The one-call cap had correctly prevented recovery of the initial missing verdict. Explicit tool choices and calls with other tools retain their behavior, as documented in [provider integration](../../docs/pi-alignment.md#provider-integration). The Luna coverage comparison used the same frozen input and submission policy as the successful Sol call.

Authentic standalone checks assembled offline satisfy the existing editing predicate. Luna draft + Sol check + Luna coverage cost $0.0929635. Using the successful Sol coverage costs $0.2819281, or $0.3450861 including its failed first submission. These are measured stage combinations, not a fresh native workflow. All generations and assessments reached $0.9610573. Reviews found only minor clarity issues concerning predicate costs, the dead-zone summary, boundary-search direction, and reuse of span finding. Evidence: `runs/editor-golden-luna6-verifier-r01/`, `runs/editor-golden-luna6-coverage-*/`, and `runs/editor-golden-assessment-r01/`.

### Coverage controls

| GPT-6 Luna input              | Verdict                        |   Time |       Cost |
| ----------------------------- | ------------------------------ | -----: | ---------: |
| Geometric obstruction omitted | FAIL, intended loss identified | 2m 29s | $0.0052904 |
| Intact, equally unverified    | PASS                           | 5m 03s | $0.0096164 |

Both inputs used fresh IDs and empty checks, with no mutation label or key. Only the counterexample and corresponding summaries differed. The failure report identified the `H=4, w_i=(5/2)^i` family and its limitation on the quantized-hull branch, without treating it as an impossibility result for the original problem. The pair cost $0.0149068, bringing 11 requests to $0.9759641. This tests one omission, not a general detection rate. Production still checks proofs before coverage. Evidence: `runs/editor-golden-coverage-controls-r01/` and native attempts `editor-golden-coverage-a-r01` / `editor-golden-coverage-b-r01`. The directory's `model-capacity.json` records advertised extended context, not a large-input trial.

### First native workflow and repairs

Native-r01 used GPT-6 Luna drafting/coverage and GPT-6 Sol correctness with three admitted calls. It ended limited and unaccepted: a WebSocket 1011 failure, a successful retry, and a proof check exhausted the allowance before coverage. The draft had 4,674 body and 5,626 mathematical tokens, a 7.9% payload reduction. Sol and a blind independent reviewer rejected a dropped integer-threshold hypothesis in the ray construction, each giving a fractional-threshold counterexample.

| Native-r01 request           |   Time |        Cost |
| ---------------------------- | -----: | ----------: |
| GPT-6 Luna transport failure | 7m 24s |     Unknown |
| GPT-6 Luna draft             | 3m 24s | $0.00496034 |
| GPT-6 Sol proof check        | 4m 14s |   $0.138612 |

Known cost was $0.14357234, bringing 14 requests to $1.11953644 plus the unpriced failure. Subsequent standalone trials preserved that capped campaign and froze the same checked draft and feedback. A preliminary GPT-6 Luna coverage review found the same defect without additional useful-content loss ($0.0048531, 2m 09s).

| Repair                                      | Passing notes retained | Changed body tokens | Mathematical tokens |   Time |       Cost |
| ------------------------------------------- | ---------------------: | ------------------: | ------------------: | -----: | ---------: |
| GPT-6 Luna, appended repair guidance        |                      0 |    4,644 (all four) |               5,634 | 5m 23s | $0.0103194 |
| GPT-6 Luna, separate repair prompt          |                      3 |               2,723 |               6,565 | 8m 03s | $0.0103761 |
| GPT-6 Luna, preserve valid passages/support |                      3 |               2,378 |               6,213 | 4m 41s | $0.0072534 |
| GPT-6 Sol, same preservation prompt/input   |                      3 |               1,865 |               5,629 |    55s | $0.0569080 |
| GPT-6 Sol check of repaired note            |        3 checks reused |                   — |                   — | 3m 57s | $0.1157880 |
| GPT-6 Luna coverage of Sol repair           |                      — |                   — |                   — | 2m 24s | $0.0052492 |

All three Luna repairs stopped before verification under their preregistered criteria. The first discarded reusable checks. The other two expanded the changed proof from 1,862 tokens, growing the whole payload 7.4% and 1.7% above the fixture. The separate prompt preserved passing IDs, and passage guidance also preserved valid support. In the matched Sol repair, the proof changed only by adding “be an integer”, with consistent summary changes. The final assembled edition passed native checks and coverage: 4,677 body tokens, 5,629 mathematical tokens (7.9% smaller), and 5,745 full-note tokens (7.3% smaller). The only remaining review clarification concerned generic predicate costs.

Preliminary coverage plus the first two repairs cost $0.0255486. The successful Sol repair/check and Luna coverage cost $0.1779452. The actual path from native-r01, including rejected repairs, cost $0.35431954 known plus its transport failure. At this point 21 requests totaled $1.33028364 known plus that failure. Offline assembly satisfied `editingResult`, while native-r01 remained limited and no corpus was activated. Evidence: `runs/editor-golden-native-r01/`, `runs/editor-golden-native-r01-protocol/`, `runs/editor-golden-repair-r01-protocol/`, `runs/editor-golden-repair-r02-protocol/`, `runs/editor-golden-repair-r03-protocol/`, and `runs/editor-golden-repair-sol-r01-protocol/`, which reference their native attempt outputs.

### Fresh native workflows

| Run        | Draft / correctness / coverage models | Notes | Body tokens | Mathematical tokens | Full-note tokens | Whole task |       Cost |
| ---------- | ------------------------------------- | ----: | ----------: | ------------------: | ---------------: | ---------: | ---------: |
| Native-r02 | GPT-6 Luna / GPT-6 Sol / GPT-6 Luna   |     3 |       4,389 |               5,490 |            5,576 |  20m 28.6s | $0.2147969 |
| Native-r03 | GPT-6 Luna / GPT-6 Luna / GPT-6 Luna  |     4 |       4,855 |               5,901 |            6,017 |  14m 21.7s | $0.0248273 |

Both fresh runs completed the native gates in three calls within frozen six-call allowances. Sol repair was configured but unused. There were no retries or allowance extensions. Independent review found the useful capabilities and limitations preserved.

| Run/stage               | Request latency |       Cost |
| ----------------------- | --------------: | ---------: |
| Native-r02 draft        |       11m 53.3s | $0.0147701 |
| Native-r02 proof/source |        6m 40.8s | $0.1957540 |
| Native-r02 coverage     |        1m 53.7s | $0.0042728 |
| Native-r03 draft        |        315.136s | $0.0094561 |
| Native-r03 correctness  |        345.415s | $0.0102303 |
| Native-r03 coverage     |        200.208s | $0.0051409 |

Native-r02 reduced mathematical payload 10.1% and full-note tokens 10.0%. Sol corrected `H/(2B)` to `H/2` through the harmless-correction path, matching the independently found error. Final reviews noted minor summary scope issues, with correct conditions in the full proofs. Native-r03 reduced bodies 14.3%, mathematical payload 3.4%, and full-note tokens 2.9%, without changing the draft's mathematics. Independent review flagged its “integral vertex” summary wording, examined below. Raw runs remain unchanged.

Native-r02 brought 24 requests to $1.54508054 known. After the correctness controls below, native-r03 brought 31 requests to $1.60411534 known. Both totals exclude the same unpriced failure. Evidence: `runs/editor-golden-native-r02/`, `runs/editor-golden-native-r02-protocol/`, `runs/editor-golden-native-r03/`, and `runs/editor-golden-native-r03-protocol/`.

Native-r02 saved 620 full-note reference tokens. At its frozen small-context Sol input rates, editing cost recovery through input savings alone would require about 174 uncached or 1,733 cached whole-corpus reads (about 3,465 uncached Luna reads). Native-r03 saved 179 tokens, requiring about 70 uncached Sol reads. These are illustrative calculations, not measured savings. They exclude cache invalidation, output/reasoning changes, and research utility. Native-r02's `reuse-economics.json` records the calculation.

### Correctness controls

Matched native-r02 copies had fresh IDs, empty checks, and equally corrected summary wording. Only the ray note's integer-versus-real threshold hypothesis differed. Inputs excluded prior verdicts, the key, and expected counterexamples. Each GPT-6 Luna arm had one admitted call through `source`.

| Instructions                     | Input             | Native outcome                         | Whole task |       Cost |
| -------------------------------- | ----------------- | -------------------------------------- | ---------: | ---------: |
| Original                         | Real threshold    | Ray note FAIL, other notes PASS        |   5m 33.2s | $0.0097688 |
| Original                         | Integer threshold | Limited, no published checks           |   4m 27.4s | $0.0079579 |
| Routine-background clarification | Real threshold    | Ray note FAIL, other notes PASS        |   4m 43.2s | $0.0084091 |
| Routine-background clarification | Integer threshold | All correctness/source PASS, unchanged |   5m 37.4s | $0.0080717 |

The original sound arm escalated Hadamard's inequality as a premise and exhausted its allowance before source checking. Its recorded correctness response was diagnostic only, with no partial publication. The defective arm rejected the integer-gap error and inconsistent band definitions with a concrete counterexample. The prompt then clarified that routine steps should be checked directly under the task's proof rules, while uncertain/nonroutine premises, forbidden black boxes, and substantive missing proofs retain their obligations. Repeated input/settings bytes and recorded payloads confirmed only stage instructions changed. Both clarified arms met the preregistered criteria in one call, without correction or source calls.

The pairs cost $0.0177267 and $0.0164808. Their cumulative totals were 26 requests/$1.56280724 and 28 requests/$1.57928804 known, plus the earlier failure. One stochastic pair supports further study, not general correctness reliability or a causal estimate. Production defaults remain unchanged. Evidence: `runs/editor-golden-proof-controls-r01-protocol/` and `runs/editor-golden-proof-controls-r02-protocol/`.

### Summary controls

Native-r03's n3 summary describes reaching an integral vertex, while its proof reaches a rational vertex and scales it. The initial independent review labeled this inaccurate. Native correctness had received no summaries, and coverage passed it. Correctness input now includes target summaries after the shared full-text packet. Extraction and blind reconstruction inputs are unchanged.

Two GPT-6 Luna calls reused the affected note under a fresh target ID with empty checks and authentic verified support. Both were blinded to the suspected defect and the expected outcome. The second used identical mathematical input and changed only `user.instructions` to require faithful summaries for PASS and correction of harmless inaccuracies.

| Control                                    | Outcome                            | Request latency |       Cost |
| ------------------------------------------ | ---------------------------------- | --------------: | ---------: |
| Summary fidelity instruction               | Correctness/source PASS, unchanged |        146.472s | $0.0038019 |
| Explicit faithful-summary PASS requirement | Correctness/source PASS, unchanged |        162.525s | $0.0027857 |

Both failed the preregistered expectation of detecting and correcting the alleged inaccuracy. The second explicitly called both summaries faithful. Independent audit found that the supplied argument proves integrality after scaling, so the faithful description is “reaches a vertex, then scales it to obtain an integer representative.” Bounded exact checks found no admissible fractional vertex. These outcomes therefore establish missed wording corrections, not certified mathematical false positives. The audit supports no further paid retry on this oracle. Evidence: `runs/editor-golden-summary-check-r01-protocol/`, `runs/editor-golden-summary-check-r02-protocol/` (including `oracle-audit.md`), and corresponding native snapshots in `runs/editor-golden-summary-check-r01/` and `runs/editor-golden-summary-check-r02/`. The controls bring the cumulative total to the 33 requests and known $1.61070294 reported above.
