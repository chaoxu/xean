# Editor experiment

Test whether editing produces a smaller, coherent mathematical reference while preserving useful results, complete arguments, methods, scoped limitations, and open gaps. All trials use one frozen three-note fixture. There is no compression target or requirement to preserve each old note. Full-corpus experiments remain stopped.

Two GPT-6 Luna editing responses followed by correctness and corpus checks reduced mathematical payload by **24.4% for $0.03265942 across four calls**. A fresh native trial produced a 14.4% smaller proposal for $0.03253662, but corpus review rejected an omitted failure explanation and the campaign remained limited. Independent adjudication found the omission minor. A manually curated reference achieved 32.8% with unpriced curation overhead. General reliability, large-input behavior, and downstream savings remain unestablished.

**Reconciled small-fixture gateway ledger: 51 requests, $2.05565878 known API-equivalent usage, plus unknown usage for one of those requests.** The original unpriced transport failure is counted once. Curation, interactive reviews, and the separately priced Opus design review are outside the gateway ledger. All jobs are terminal. No research corpus was activated.

## Materials and method

- [input.json](input.json) freezes the problem and original notes. [golden.md](golden.md) holds provenance, the capability/proof answer key, and known failures. The runner never reads the key.
- [reference.json](reference.json) is the curated replacement. Keep it out of generation and grading other candidates. It is one reviewed organization, not a required answer or size target. Its local IDs carry no copied verification history.
- Frozen prompts: [baseline](prompts/baseline.md), [reference](prompts/reference.md), [consolidation](prompts/consolidation.md), [reuse](prompts/reuse.md), and [shared proof](prompts/shared-proof.md).
- [settings.json](settings.json) defaults to **GPT-6 Luna/max**, one admitted call, and no literature access. A two-call refinement condition can be frozen in a separate source commit. Historical model settings remain in their artifacts.
- [run.ts](run.ts), [operate.ts](operate.ts), and [job.nomad.hcl](job.nomad.hcl) provide generation, operations, and the shared native-role job.

The original has 5,663 body tokens, 6,110 mathematical tokens, 6,196 full-note projection tokens, and 7,511 tokens in complete input JSON. Counts use `o200k_base`, not the provider billing tokenizer. Mathematical payload includes summaries and retained support closure but excludes verification records. `fullNote` includes status and feedback. Normalize IDs when comparing organization separately from ID length. The original detailed summaries duplicate its index summaries, so richer edited summaries can add useful information. Assess their utility alongside size.

Generation uses the existing Pi path, schema, and dependency validation. With one admitted call it returns one draft. With two, Pi retains the first submission in the transcript and requests a complete revision. Both response and provider-call allowances are fixed, and retries consume the same call allowance. Valid proposals are saved for inspection even if a later call fails. A returned first draft alone is not evidence of refinement, and private drafts do not turn a failed campaign into a success. There is no automatic verification.

Afterward, check the hidden key's useful capabilities, full arguments, scoped negatives, dependency closure, and repeated exposition. Equivalent proofs and different note organizations are welcome. Generation completion, native acceptance, and independent review are separate outcomes.

Change one factor at a time and commit before launch. Freeze inputs, prompts, settings, and reasoning. Keep the key outside generation and assessment inputs. For blinded comparisons, also withhold prior judgments of the tested claim, authorship, and expected outcomes. Independently establish a control's intended defect before spending a call on it. Record failed requests, invalid submissions, and stopping decisions. Single samples on this development fixture do not establish general reliability or causal effects.

## Current operating recommendation

Use GPT-6 Luna/max for an occasional edit of a supplied corpus that fits its context. Start with [settings.json](settings.json), retain its complete provider profile, and change these fields for the tested initial refinement path:

```json
{
  "maxEditorResponses": 2,
  "limits": { "concurrency": 1, "attempts": 1, "providerCalls": 4 }
}
```

Use those settings with native `edit`: draft, revise once, check correctness/sources, and review the whole replacement. Only the last returned draft reaches verification. Four successful calls cover this initial path. A frozen allowance of seven can also cover one complete targeted repair, verification, and corpus-review cycle if each stage takes one call. Retries, invalid submissions, and additional source obligations consume the same allowance. These are admission limits, not guarantees of acceptance or a number of calls to spend. Historical trials keep their original limits and verdicts.

Keep the one-response library default and leave automatic editing disabled unless explicitly configured. The 200,000-token advice threshold is unqualified by these experiments. The pinned Luna profile has a 272,000-token window and 128,000-token output ceiling. Xean reserves that ceiling plus Pi's 4,096-token safety margin, leaving at most 139,904 estimated input tokens for the entire request. The original notes, retained draft, reasoning, and framing all count. A context override changes the local estimator, not the provider's capability. Do not infer large-input support from this fixture.

The evidence supports useful consolidation at low model cost. It does not establish a net monetary saving: some dependency packets and the index grow, editing changes the cache, and the reviewed path took about 17 minutes of request time. Prefer occasional editing when repeated full-proof use or improved organization justifies it. Preserve substantial negative results and complete retained arguments. Use existing targeted repair for concrete findings, without repeatedly regenerating to chase a smaller percentage.

The broader goal remains open on reliability, large-input capacity, downstream usefulness, and total cost. Stop paid development trials here. A further experiment should answer a named unresolved decision, with its input scope and stopping rule fixed before launch.

## Run and collect

From the adjacent Fleet Infra checkout, use locked Bun:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-example-r01 consolidation
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts status editor-golden-example-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts collect editor-golden-example-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts cancel editor-golden-example-r01
```

Launch requires a clean, internally pushed commit and a fresh attempt ID. It reuses the pinned worker image on jupiter and reads the OpenBao gateway credential into memory only. Inspect an attempt after a submission error before creating another. Collection reads campaigns without ownership or recovery. Keep frozen inputs, hashes, source commit, complete request records, raw results, revisions, measurements, reviews, and accounting in ignored `runs/<attempt-id>/`.

For native stages, replace the prompt argument with `verifier`, `editionReview`, `editor`, or `edit`, followed by `INPUT.json SETTINGS.json`:

| Mode            | Input and publication                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verifier`      | `{task, notes: replacement, targets}`, selecting every target through `source`. Apply only completed published checks to a copy with `applyChecks`, preserving the raw draft and revisions. |
| `editionReview` | `{task, notes: checkedReplacement, previous: originalNotes}`. Coverage PASS is separate from note correctness.                                                                              |
| `editor`        | `{task, notes: originalNotes, previous: checkedReplacement, review: coverageVerdict}` for repair. Retained IDs reuse checks. Rewritten notes need fresh verification.                       |
| `edit`          | The fixed `input.json`, through the built-in `xean edit` workflow. Only its completed result establishes native workflow acceptance.                                                        |

Standalone roles admit one call each. A native workflow fixes a finite positive `limits.providerCalls` before launch. The tested `{concurrency: 1, attempts: 1, providerCalls: 6}` allows an initial cycle and a repair cycle with one drafting response, only if every stage takes one call. With two initial drafting responses, those cycles require four and seven calls respectively. Acceptance stops earlier. Retries, invalid submissions, and source obligations can exhaust the allowance, with no automatic extension.

The tested mixed profile uses GPT-6 Luna/max by default with complete GPT-6 Sol/max `correctness` and `editorRepair` profiles. Native-r03 instead used Luna correctness. Profiles replace whole profiles, so preserve gateway and credential fields when overriding a model. Repair selection falls back `editorRepair` → `editor` → `default`. See [solver configuration](../../docs/solver.md) for editing-only composition and check reuse across models. These experiments do not change production defaults.

API-equivalent costs use frozen prices and matched gateway/Pi token buckets. Gateway and Pi reports describe the same requests and are never added. Missing usage stays unknown, and subscription charges remain unestablished. Request latency excludes queueing and operator work. Detailed reports below and Git retain the full history. Retired large-run drivers remain in commit `23f19fa9188c119ca0fc2210019f032ae73b1614`, with artifacts in the original checkout. The cancelled continuation produced no replacement or coverage verdict.

## Automatic drafts

All conditions use max reasoning. Times below are generation elapsed times, rounded where shown. Rows are single samples.

| Prompt / comparison            | Model        | Mathematical tokens | Change from original |     Time |       Cost | Assessment                                                          |
| ------------------------------ | ------------ | ------------------: | -------------------: | -------: | ---------: | ------------------------------------------------------------------- |
| Baseline                       | GPT-6 Sol    |               6,838 |         11.9% larger |   6m 55s |  $0.213570 | Useful mathematics preserved under blind review, no net compression |
| Reference                      | GPT-6 Sol    |              10,918 |         78.7% larger |   5m 52s |  $0.191292 | Retained originals and added notes, consolidation failed            |
| Consolidation                  | GPT-6 Sol    |               5,284 |        13.5% smaller |   4m 51s |  $0.167792 | No consequential defect or loss found independently                 |
| Consolidation                  | GPT-5.6 Luna |               6,679 |          9.3% larger |   8m 49s |  $0.036634 | Stopped before proof audit                                          |
| Consolidation                  | GPT-6 Luna   |               5,276 |        13.6% smaller |   5m 33s | $0.0096681 | Reviewed independently, later passed native stages                  |
| Fresh consolidation control    | GPT-6 Luna   |               5,650 |         7.5% smaller |   380.4s | $0.0095361 | Unverified draft                                                    |
| Added within-call editing pass | GPT-6 Luna   |               5,651 |         7.5% smaller |   352.1s | $0.0102082 | No size advantage, unverified, not adopted                          |
| Common-proof instruction       | GPT-6 Luna   |               5,522 |         9.6% smaller | 357.255s |  $0.010641 | Unverified, not adopted                                             |
| Same common-proof instruction  | GPT-6 Sol    |               5,629 |         7.9% smaller | 928.454s |  $0.316380 | Unverified, not adopted                                             |

The added editing pass saved 51 body tokens but expanded summaries, leaving complete size unchanged. Its matched requests differed only in instructions and their derived cache key. The common-proof instruction requested shared constructions, implementations, and complexity arguments with application-specific checks. Luna still repeated parts of its shared walk. Holding that prompt fixed and changing to Sol yielded 4,491 body tokens and a larger complete payload, at substantially higher cost. Recorded Luna/Sol requests differed only in model and the derived cache key. Neither improved on the earlier reviewed draft, so both stopped before native verification. Normalized mathematical sizes were 5,338 (Luna), 5,440 (Sol), and 5,060 (earlier reviewed draft).

Evidence: `runs/editor-golden-comparison-r01/`, `runs/editor-golden-consolidation-r01/`, `runs/editor-golden-luna-r01/`, `runs/editor-golden-luna6-r01/`, `runs/editor-golden-reuse-r01-protocol/`, `runs/editor-golden-shared-proof-r01-protocol/`, and `runs/editor-golden-shared-proof-sol-r01-protocol/`. These contain or reference raw outputs, frozen settings, measurements, request comparisons, and accounting.

## Draft refinement

One additional Luna response revised a complete first draft in Pi's existing transcript. The initial request exactly matched the earlier one-call shared-proof condition. Only after submission did a generic continuation request a complete revision. The key, curated reference, earlier trials, measurements, and external reviews were withheld.

| Measure                             | Original | First draft | Revised draft |
| ----------------------------------- | -------: | ----------: | ------------: |
| Notes                               |        3 |           4 |             4 |
| Proof bodies                        |    5,663 |       4,573 |         3,920 |
| Mathematical tokens                 |    6,110 |       5,460 |         4,619 |
| Mathematical tokens, normalized IDs |    6,094 |       5,300 |         4,459 |

The second pass saved 841 mathematical tokens from its own first draft (15.4%), including 653 body tokens. Both proofs and summaries became shorter. The pair cost $0.02106042 and took 638.159s. Its second request included 52,795 input tokens, of which 6,912 were cached, so retained conversation cost is included.

All four revised notes passed native correctness/source checks unchanged ($0.00574590), followed by corpus-review PASS ($0.00585310). The authentic standalone results satisfy `editingResult` when assembled locally. Independent review found no consequential defect or lost useful capability. Minor issues concern a misattributed proof implication and an omitted rounding tie rule. The shared span routine also leaves empty-set handling implicit, while all supplied applications contain zero. The frozen output remains unchanged.

The complete four-call path cost **$0.03265942**, with **16m 57.3s summed request latency**, excluding manual handoffs. The checked full-note projection shrank 23.6%, from 6,196 to 4,734 tokens. This is a promising development result for draft refinement before verification. It required no verifier repair loop, but one sample does not establish reliable four-call completion. No further calls are part of this trial.

The normal Editor now exposes the same initial prompt and continuation through optional `maxEditorResponses: 2`. Its default is one, and targeted repair behavior is unchanged. The [solver guide](../../docs/solver.md#corpus-editing) defines response limits, fallback, and publication. The fresh native smoke below exercised this integration but did not obtain acceptance.

Smaller notes do not by themselves establish monetary savings. In this result, entry proofs all shrink, but complete support grows for the learner and restoration while rays shrink from 4,795 to 2,710 tokens. The separately supplied index grows from 239 to 465. Whole-corpus input-only cost recovery, including that index, would require about 14 uncached or 133 cached Sol exposures, versus 265 or 2,643 Luna exposures at frozen rates. Actual reading patterns, cache invalidation, and research effects remain unmeasured. See `read-economics.md` and its reproducible measurements in the refinement protocol directory.

Evidence: `runs/editor-golden-refinement-r01-protocol/`, `runs/editor-golden-refinement-verifier-r01-protocol/`, and `runs/editor-golden-refinement-coverage-r01-protocol/`. The experiment initially added 30 net code lines using the existing Pi loop. Subsequent native integration added 17 production and 76 test lines, removing one experiment line. Tests cover private refinement, final-only verification, unchanged repair behavior, invalid submissions, and denied call admission. The locked check passed 105 tests and 1,481 assertions, plus types, formatting, and distribution checks.

### Native refinement smoke

`editor-golden-native-refinement-r01` used the built-in `xean edit` workflow at source `f13736d`, with GPT-6 Luna/max, two drafting responses, and a frozen four-call allowance. Its first effective model request exactly matched the earlier reviewed trial. The native workflow then scheduled correctness/source checking and corpus review without manual stage assembly.

| Measure             | Original | First draft | Revised proposal |
| ------------------- | -------: | ----------: | ---------------: |
| Notes               |        3 |           4 |                4 |
| Proof bodies        |    5,663 |       4,870 |            4,274 |
| Mathematical tokens |    6,110 |       6,012 |            5,228 |

Revision saved 784 mathematical tokens from its first draft (13.0%). The proposal is 14.4% smaller than the original. All four notes passed correctness/source checks unchanged. Corpus review returned **FAIL** because the revised text says denominator clearing is unused but omits why it fails for general real inputs and can violate the required output-height bound for rational inputs. The repair worker was denied admission at the call cap. The campaign is **limited**, its accepted result is null, and no fifth model request or corpus activation occurred.

The four requests cost **$0.03253662 API-equivalent**. The whole native task took **21m 5.2s**, including orchestration. Independent review found no consequential mathematical loss. Follow-up adjudication classified the warning as useful but recoverable exposition: the replacement retains the real-input setting, explicitly avoids the shortcut, and proves the bounded-integer alternative. The corpus review also overstated the issue as a workspace limitation, whereas rational workspace may depend polynomially on input length.

The earlier accepted draft and curated reference also omit the explicit warning. This disagreement motivated the materiality calibration below. That later check does not change any recorded verdict or establish reliable acceptance. The failed campaign remains terminal.

Evidence: `runs/editor-golden-native-refinement-r01-protocol/REPORT.md`, `metrics.json`, `accounting.json`, `independent-review.md`, and `adjudication.md`. `metrics.json` is the size authority and keeps the accepted result null. Accounting references those measurements and separately records native campaign status.

## Verification, repair, and native workflows

| Result                                        | Mathematical tokens | Full-note tokens |                              Measured model cost | Qualification                                                  |
| --------------------------------------------- | ------------------: | ---------------: | -----------------------------------------------: | -------------------------------------------------------------- |
| Frozen Luna draft + Sol check + Luna coverage |               5,276 |    See artifacts |                                       $0.0929635 | Authentic standalone stages assembled offline, unchanged draft |
| Repaired native-r01 draft                     |               5,629 |            5,745 | $0.1779452 successful repair/check/review stages | Assembled offline, original native campaign stayed limited     |
| Fresh native-r02, Luna / Sol / Luna           |               5,490 |            5,576 |                                       $0.2147969 | Native completion in three calls, whole task 20m 28.6s         |
| Fresh native-r03, all Luna                    |               5,901 |            6,017 |                                       $0.0248273 | Native completion in three calls, whole task 14m 21.7s         |

The frozen Luna draft received correctness/source PASS for all four notes and coverage PASS. A first Sol coverage call returned prose without submission ($0.0631580), so it published no verdict. Requiring the sole submission tool through Pi's Codex adapter fixed that integration. Successful Sol coverage cost $0.1956480, versus $0.0066834 for Luna on the same input. The actual draft/Sol-check/Sol-coverage path cost $0.3450861 including the failed submission. See [provider integration](../../docs/pi-alignment.md#provider-integration) and `runs/editor-golden-assessment-r01/`.

Native-r01 exhausted three admitted calls on a WebSocket 1011 failure, a retry draft, and Sol verification, leaving coverage uncalled. Its known cost was $0.14357234 plus the unpriced failure. Sol and a blind independent reviewer found a dropped integer-threshold hypothesis. Three subsequent Luna repairs stopped before verification: one discarded reusable checks, and two enlarged the changed proof. A matched Sol repair added “be an integer”, updated summaries, and retained three passing notes and both dependencies. The actual path, including rejected repairs, cost $0.35431954 known plus the same failure. Evidence: `runs/editor-golden-native-r01-protocol/`, `runs/editor-golden-repair-r01-protocol/`, `runs/editor-golden-repair-r02-protocol/`, `runs/editor-golden-repair-r03-protocol/`, and `runs/editor-golden-repair-sol-r01-protocol/`.

Native-r02 and r03 used frozen six-call allowances and needed no Editor repair, retry, or extension. Sol corrected a local `H/(2B)` versus `H/2` error in r02. Independent review found useful capabilities preserved in both, with summary issues retained in the raw evidence. Native-r03's bodies shrank 14.3%, but richer summaries and references left only 3.4% mathematical and 2.9% full-note reduction. Evidence: `runs/editor-golden-native-r02-protocol/` and `runs/editor-golden-native-r03-protocol/`.

## Curated reference and cost effectiveness

The primary assistant, using the hidden key and earlier results, proved shared optimization, span, boundary, rank-growth, and encoding arguments once. Applications retain their own feasibility and cofactor reasoning. The learner, exact restoration, failure certificate, horizontal case, geometric obstruction, and computational gap remain explicit. This was supervised curation with unpriced overhead, not measured automatic drafting.

| Measure                             | Original | Curated reference |
| ----------------------------------- | -------: | ----------------: |
| Body tokens                         |    5,663 |             3,387 |
| Mathematical tokens                 |    6,110 |             4,105 |
| Mathematical tokens, normalized IDs |    6,094 |             4,095 |
| Checked full-note projection        |    6,196 |             4,190 |

The mathematical reduction is **32.8%**, including after ID normalization. GPT-6 Luna/max proof/source and coverage calls passed unchanged, with key, authorship, size, and expected verdict withheld. They cost $0.0073584 and $0.0050296, with request latencies 291.117s and 175.741s. Their assembled results satisfy the editing predicate. An earlier invocation used the wrong target field and failed before any model call. That failure is preserved. Summaries were clarified before verification to promise polynomial encoding lengths rather than total memory. Evidence: `runs/editor-golden-reference-study/`, `runs/editor-golden-reference-r02-protocol/`, and `runs/editor-golden-reference-coverage-r01-protocol/`.

Smaller total size does not guarantee cheaper retrieval. The curated learner entry shrank from 1,404 to 1,341 tokens, but reading its full support costs 2,589. Guarded rays with support shrank from 4,795 to 2,852. These are possible read packets, not measured behavior or automatically fetched support. Workload weights are unknown. Native-r02's illustrative input-only cost recovery requires about 174 uncached or 1,733 cached full-corpus Sol reads, while r03 requires about 70 uncached reads. These calculations exclude cache invalidation, output/reasoning changes, and research utility. Evidence: reference-r02's `read-sizes.json` and native-r02's `reuse-economics.json`.

A separate Opus 5.5/max design review recommended testing a stronger drafter before adding a workflow. Its packet omitted earlier Sol evidence, so its claims that drafting capability and Sol repair were untested were rejected. Its numerical compression threshold was not adopted. The review cost $0.8591462 API-equivalent usage outside the gateway ledger. The later Sol comparison above supplies the requested additional sample. Evidence: `runs/editor-golden-opus-design-r01/`.

## Controls and remaining uncertainty

Controls use fresh neutral IDs and empty target checks, withholding mutation labels, witnesses, prior verdicts, and expected outcomes. Each arm admits one GPT-6 Luna/max call. Their outcomes test specific cases, not general reliability.

| Control                                                  | Outcome                                                                           |            Cost | Evidence under `runs/`                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------: | ---------------------------------------------------------------------------------------- |
| Coverage, obstruction omitted / intact                   | Intended loss FAIL / intact PASS                                                  | $0.0149068 pair | `editor-golden-coverage-controls-r01/`                                                   |
| Correctness, real / integer threshold                    | Defect FAIL / sound arm limited by a Hadamard source premise, no published checks | $0.0177267 pair | `editor-golden-proof-controls-r01-protocol/`                                             |
| Same inputs, routine-background clarification            | Defect FAIL / sound correctness/source PASS, unchanged                            | $0.0164808 pair | `editor-golden-proof-controls-r02-protocol/`                                             |
| Summary fidelity / explicit faithful-summary requirement | Both unchanged correctness/source PASS                                            | $0.0065876 pair | `editor-golden-summary-check-r01-protocol/`, `editor-golden-summary-check-r02-protocol/` |
| Cofactor sum / single-cofactor bound                     | Sound unchanged PASS / defect FAIL with correct counterexample                    | $0.0059963 pair | `editor-golden-cofactor-controls-r01-protocol/`                                          |
| Materiality, intact / substantial obstruction omitted    | Intact PASS / omission FAIL identifying the lost geometric obstruction            | $0.0146102 pair | `editor-golden-materiality-r01-protocol/`                                                |

Routine-background clarification kept uncertain/nonroutine premises and substantive proof obligations intact. Recorded payloads confirmed only instructions changed, and the rerun correctly distinguished the sound and defective threshold claims. The summary controls missed a requested wording correction: the supplied proof reaches a rational vertex and then scales, while its summary says “integral vertex”. Independent audit confirmed that the wording exceeds the proof, but found no admissible fractional-vertex witness. These are missed wording corrections, not certified mathematical false positives, and no further paid retry on that oracle is warranted. See summary-r02's `oracle-audit.md`.

The cofactor pair tests a separately established defect: a binary right-hand side requires a sum of cofactors, while a single-cofactor bound needs a stronger restriction. The frozen inputs differ only by the factor `d` in one added sentence. The verifier passed the sound arm unchanged and rejected the defective arm with a valid two-dimensional counterexample. Both completed in one call, without correction or escalation. Whole-task times were 78.438s and 192.712s. This pair met its detection criterion and supports another small drafting experiment, without establishing general verifier reliability.

The materiality pair uses the native refinement proposal with identical neutral target IDs and empty target checks. The second arm removes only the substantial geometric obstruction and its summary claims. A generic clarification permits omitted motivation or routine details when the retained arguments suffice for correct reuse and recovering the explanation requires no substantive new argument. Complete-proof and useful-negative-result requirements remain. The recorded requests differ only in the intended input content.

The intact arm passed without requiring the elementary denominator-clearing explanation. The omission arm failed, identifying the missing fixed-H family, polynomial-quantization obstruction, and its scope as failure of the branch rather than impossibility of the target theorem. Both standalone reviews completed in one Luna/max call, costing $0.0074097 and $0.0072005, with request latencies 229.692s and 215.918s. No repair or further tuning followed. The failed arm also requested an explicit overall open-gap statement, showing that ancillary feedback still varies.

This pair met its preregistered criterion and supports keeping the clarification. It uses the same development fixture repeatedly, and the historical native review had different target IDs and statuses. It therefore neither isolates the prompt's causal effect nor establishes general reliability. The earlier native campaign remains limited, and these standalone coverage verdicts activate no corpus. The source change adds no runtime mechanism or tests, and the full locked check still passes 105 tests and 1,481 assertions.
