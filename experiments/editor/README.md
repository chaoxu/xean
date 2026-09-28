# Editor experiment

Compare editing prompts and models on one frozen mathematical dataset before considering larger runs. The dataset contains three related research notes with complete proofs, overlapping arguments, and a counterexample limiting a promising approach. Its full bodies contain 5,663 reference tokens. The complete input contains 7,511 reference tokens.

The research question is whether a prompt produces a coherent, materially simpler reference while preserving usable mathematics. Size reduction, model cost, and elapsed time are measurements. A short but defective result fails.

## Fixed materials

- [input.json](input.json) contains the problem and notes shown to the model.
- [golden.md](golden.md) contains provenance, the mathematical answer key, and known failure cases. The runner never reads it.
- [baseline.md](prompts/baseline.md) freezes the existing Editor instructions.
- [reference.md](prompts/reference.md) describes the intended mathematical reference in self-contained terms.
- [consolidation.md](prompts/consolidation.md) tests explicit removal of repeated exposition without adding research that leaves the old proofs intact.
- [settings.json](settings.json) fixes the model and reasoning settings.

Each generation arm admits one model call and returns one draft. It uses the existing Pi request path, output schema, and dependency validation. There are no automatic repairs, verifiers, source searches, or subsequent editing calls. Failed requests and invalid submissions remain experimental outcomes. A completed generation is not mathematical acceptance. Native assessment and complete-workflow trials are recorded separately below.

Compare outputs against the answer key after generation. Record whether the useful capabilities and their proofs survive, whether negative conclusions retain their scope, whether dependencies close, and whether the output consolidates repeated arguments. Record each defect concretely. Equivalent valid proofs and different note organizations are welcome. There is no per-note preservation requirement or compression target.

Change one experimental factor at a time and commit it before the next run. Prompt comparisons use a new prompt filename with fixed settings. Model comparisons change settings while holding the prompt and reasoning fixed. Keep the dataset and answer key fixed. A success on this development fixture establishes only success on this fixture. Further runs remain limited to this dataset.

## Run on Fleet

Run from the adjacent Fleet Infra checkout using its locked Bun:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-example-r01 consolidation
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts status editor-golden-example-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts collect editor-golden-example-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts cancel editor-golden-example-r01
```

Launch requires a clean, internally pushed commit and a fresh attempt ID. It uses the existing pinned worker image on jupiter and the committed [Nomad specification](job.nomad.hcl). The operator reads only the Xean gateway credential from OpenBao and injects it in memory. Credentials never enter committed files or saved job specifications. After a submission error, inspect the attempt before creating another one.

Results are collected under ignored `runs/<attempt-id>/`. Keep the input, prompt, settings and model hashes, source commit, complete request records, generated replacement, reported usage, elapsed time, and a short `review.md` together. Missing usage is unknown cost. Report API-equivalent usage separately from subscription billing and independent review overhead.

To measure native assessment of a frozen candidate, use the same operator with the existing CLI roles:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-check-r01 verifier INPUT.json SETTINGS.json
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts collect editor-golden-check-r01
```

Verifier input contains `task`, the replacement `notes`, and `targets` selecting every note through `source`. Effective settings and inputs are frozen with hashes, with one admitted call per role. Collection writes the read-only native campaign and records to `snapshot.json`. Apply only a completed verifier result's published checks to a copy using `applyChecks`, preserving the raw candidate and any correction revisions. Then invoke `editionReview` with `{task, notes: checkedReplacement, previous: originalNotes}` and a fresh attempt ID. Keep the golden key and independent review outside both inputs. Unexpected premises, invalid responses, and failures remain outcomes. A completed role invocation alone does not establish mathematical PASS or activate a replacement.

For a controlled repair, invoke `editor` with `{task, notes: originalNotes, previous: checkedReplacement, review: coverageVerdict}`. This uses the built-in Editor's repair instructions. Retained IDs keep their existing checks; rewritten notes receive fresh IDs and need verification. Freeze each stage before calling it and report the combined cost, including the rejected draft and prior checks. The standalone stages measure repair behavior without extending a completed trial's allowance.

To test the complete built-in workflow on the same fixture, select `edit`:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-native-r01 edit ../xean-editor-science/experiments/editor/input.json SETTINGS.json
```

This uses the existing `xean edit` CLI, with three admitted calls for the whole campaign. Settings use Luna/max as the default, a complete Sol/max `correctness` profile, and limits `{concurrency: 1, attempts: 1, providerCalls: 3}`. Copy the default profile when overriding the model so gateway and credential settings survive. The expected stages are drafting, proof verification, and corpus coverage; an invalid submission or unexpected source obligation can exhaust the allowance earlier. No extension is automatic. Only the native completed result establishes that the verification gates passed. Measure size and compare useful capabilities separately.

The former large-run drivers and job templates are retired from this branch. Their source remains in commit `23f19fa9188c119ca0fc2210019f032ae73b1614`, and historical run artifacts remain under the original checkout's ignored `runs/`. The cancelled full-corpus continuation produced no replacement or coverage verdict. No large run is part of this experiment.

## First comparison

The first pair used source commit `cfdd4e9445ed1dd7fe9aaf5badaab000983a2b6a`, the same input, and Sol/max. Each arm used one call with no correction or repair. The input had 3 notes, 5,663 body tokens, and 6,110 tokens of mathematical content including summaries and dependencies.

| Prompt    | Notes | Body tokens | All mathematical tokens |   Time | Reported API-equivalent cost |
| --------- | ----: | ----------: | ----------------------: | -----: | ---------------------------: |
| Baseline  |     4 |       5,249 |                   6,838 | 6m 55s |                    $0.213570 |
| Reference |     6 |       9,429 |                  10,918 | 5m 52s |                    $0.191292 |

Counts use `o200k_base` as a common reference tokenizer. They exclude historical verification records. Provider usage includes reasoning and is recorded separately. The two gateway requests have complete reported usage matching Pi. Their price fields are NULL, so the amounts above use the frozen model's API-equivalent rates. The pair totals $0.404862. Interactive curation and review are separate and unpriced.

Blind review of the baseline found no substantive proof defect or lost required capability, with minor scope clarifications about integer budgets and predicate evaluation. It shared repeated DP and boundary-search arguments, but expanded summaries made the whole mathematical payload 11.9% larger. The reference prompt retained all three source notes through dependencies and added three new notes, making the payload 78.7% larger. That arm fails consolidation without needing a complete audit of its added mathematics.

Neither arm demonstrates useful net compression. The proposed reference prompt is not adopted. This one pair supports testing more explicit removal of repeated exposition and avoiding additions that leave the old proofs intact. It does not establish that prompting alone explains the earlier full-corpus failures. Both raw outputs and the comparison records remain in ignored `runs/editor-golden-*-r01/`, including the separate `editor-golden-comparison-r01` review and accounting records.

## Consolidation trial

The next prompt explicitly asks shared arguments to replace repeated exposition, counts retained dependency closures, and keeps summaries concise. It permits new formulations that simplify the supplied mathematics while excluding additions merely extending it. Input, model, settings, runner, and answer key are unchanged. The prompt receives neither prior outputs nor review findings. Source commit: `208ca7160804675cc5c144abe7f0857fc5d69ae5`.

One call produced 4 notes with **4,172 body tokens and 5,284 total mathematical tokens**, reductions of **26.3%** and **13.5%** from the input. It took **4m 51s** and reported **$0.167792** in API-equivalent usage, matching gateway token buckets. All three generation attempts together total **$0.572654**, excluding interactive curation and review.

Independent review found no consequential defect or lost required capability. The shared DP, span, and boundary-search arguments preserve the scaled learner, exact-zero restoration, guarded conformal ray, horizontal application, scoped geometric obstruction, and unresolved operation-count gap. One minor clarification remains: the general state-predicate wording should charge predicate evaluation or restrict it to efficient predicates. Every actual application uses constant-cost thresholds.

This is a useful edit on the fixed small fixture, with genuine consolidation and a smaller complete payload. It is one sample, not evidence of full-corpus reliability or a complete production cost measurement. No native verification or automatic repair was run. The output remains unchanged, with the review recorded separately under `runs/editor-golden-consolidation-r01/`. Further experiments remain restricted to this fixture.

## GPT-5.6 Luna comparison

One `gpt-5.6-luna` call used the same consolidation prompt, input, max reasoning, and one-call allowance. Source commit `d7d40bce24024681336582a45e407d9e1c1119ca` changes only the configured model and removes the runner's duplicate Sol-only assertion. The generator received no prior output, answer key, or review findings.

| Model        | Notes | Body tokens | All mathematical tokens |   Time | Reported API-equivalent cost |
| ------------ | ----: | ----------: | ----------------------: | -----: | ---------------------------: |
| GPT-6 Sol    |     4 |       4,172 |                   5,284 | 4m 51s |                    $0.167792 |
| GPT-5.6 Luna |     4 |       5,433 |                   6,679 | 8m 49s |                    $0.036634 |

Luna generation was 78.2% cheaper, but took 81.5% longer. Its proof bodies shrank only 4.1%, and the complete mathematical payload grew 9.3% over the input. It factored shared machinery and rewrote all notes, but did not produce a smaller reference by the token measure. This fails the editing objective without requiring another proof audit. The candidate remains mathematically unverified.

The four golden generations total **$0.609288** in reported API-equivalent usage. Dataset curation and interactive reviews remain separate and unpriced. Native assessment is measured separately below. These single samples establish neither general model superiority nor full-corpus cost effectiveness. Raw evidence and measurements are under `runs/editor-golden-luna-r01/`.

## GPT-6 Luna comparison

One `gpt-6-luna` call used the same consolidation prompt, input, max reasoning, one-call allowance, and evaluation. Source commit: `8a148328ba77305f8325741791e5c0c89a877115`. It is a separate model condition from GPT-5.6 Luna.

The result has 4 notes, **4,312 body tokens and 5,276 total mathematical tokens**, reductions of **23.9%** and **13.6%**. It took **5m 33s** and reported **$0.0096681** in API-equivalent usage. Compared with the Sol sample, generation cost fell 94.2% and elapsed time rose 14.3%, with nearly identical total mathematical size. Gateway and Pi token buckets match. Gateway price is NULL, so the estimate uses the frozen model rates.

Independent review, blinded to model and cost, found no consequential mathematical defect or lost required capability. The proofs preserve the scaled learner, exact-zero compression, guarded conformal ray, horizontal application, scoped geometric obstruction, and unresolved operation-count gap. Two minor clarifications remain: charge arbitrary state-set membership costs in the generic DP statement, and describe the learner statistic as encoding labels in its short summary. The full proof already distinguishes the statistic from an exact sign representative. The generated output remains unchanged.

This sample supports GPT-6 Luna for further development on the fixture: one call achieved a reviewed reduction comparable to Sol at much lower generation cost. Subsequent native assessment is recorded below. One sample cannot establish reliability or full-corpus economics.

The five golden generations total **$0.618956**, excluding curation and interactive reviews. Raw artifacts, reference-token measurements, and accounting are under `runs/editor-golden-luna6-r01/`.

## Native assessment costs

The unchanged GPT-6 Luna draft then received correctness and source PASS for all four notes from one native Sol/max Verifier call. No correction or external source-model call was needed. Published checks were applied to a copy with `applyChecks` before corpus review. Both Sol/max and Luna/max subsequently returned native coverage PASS against the original corpus. The same candidate satisfies the existing editing acceptance predicate when these authentic results are assembled offline. The research campaign itself remains unchanged.

| Stage                  | Model      | Outcome                          | Request time | API-equivalent cost |
| ---------------------- | ---------- | -------------------------------- | -----------: | ------------------: |
| Draft                  | GPT-6 Luna | 13.6% smaller complete payload   |       5m 33s |          $0.0096681 |
| Correctness and source | GPT-6 Sol  | All 4 notes PASS, no corrections |       2m 20s |          $0.0766120 |
| Coverage, first call   | GPT-6 Sol  | Prose only, no published verdict |       1m 29s |          $0.0631580 |
| Coverage, retry        | GPT-6 Sol  | PASS                             |      12m 34s |          $0.1956480 |
| Coverage comparison    | GPT-6 Luna | PASS                             |       4m 55s |          $0.0066834 |

The first coverage response omitted `submit_result`, and its one-call cap correctly prevented a recovery call from publishing a verdict. The retry changed only tool selection, using Pi's Codex support for `tool_choice: "required"` when submission is the sole tool and no valid result exists. The [provider contract](../../docs/pi-alignment.md#provider-integration) records this small adapter integration. Explicit caller choices and calls with other tools retain their behavior. No prose-to-verdict parser was added. The Luna comparison used the same coverage input, prompt, schema, reasoning, and required submission policy as the Sol retry.

Drafting with Luna, verifying with Sol, and reviewing coverage with Luna totals **$0.0929635** across the three measured stages. Using the successful Sol coverage call instead totals **$0.2819281**. The actual path to the Sol-checked result cost **$0.3450861**, including the unsuccessful first coverage call. All five draft generations and four native assessment calls total **$0.9610573**. These are model-usage estimates from frozen prices, reconciled against gateway token buckets. Interactive curation and independent reviews are separate and unpriced. Stage times exclude operator work and queueing between stages.

The candidate needed no mathematical revision. The independent and native reviews recorded minor clarity suggestions about state-set membership costs, the dead-zone summary, the one-sided boundary-search interval, and reuse of the algebraic span-finding subroutine. They found no consequential loss or defect. The raw candidate stays unchanged, with feedback retained separately.

This establishes a cheap successful combination on one valid fixture. The matched controls below test one known defect, with the golden key still withheld from the model. Larger runs remain outside this experiment. Native campaigns and receipts are under `runs/editor-golden-luna6-verifier-r01/`, `runs/editor-golden-luna6-coverage-*/`, and `runs/editor-golden-assessment-r01/`.

## Coverage controls

Two further Luna/max calls compared an intact copy of the same draft with a copy lacking the useful geometric obstruction. Both replacements had fresh IDs and empty verification histories. This removes verification status as a cue. The defective copy retained the conditional ray method, its proofs, and its horizontal application. Only the counterexample paragraph and corresponding summary claims were removed. The model received the ordinary original/replacement input, with no mutation label, golden key, or expected verdict.

| Replacement                   | Native coverage verdict        | Request time | API-equivalent cost |
| ----------------------------- | ------------------------------ | -----------: | ------------------: |
| Geometric obstruction omitted | FAIL, intended loss identified |       2m 29s |          $0.0052904 |
| Intact, equally unverified    | PASS                           |       5m 03s |          $0.0096164 |

The failure report identified the exact H=4, w_i=(5/2)^i family and reconstructed why polynomially bounded B cannot make this quantized-hull branch universal. It explained why this is a branch limitation rather than an obstruction to the original compression problem. The intact control preserved those capabilities and passed, while correctly treating its absent per-note checks as a separate verification requirement.

The pair cost **$0.0149068**, bringing all eleven golden-data model calls to **$0.9759641**. Gateway identities and token buckets match Pi. This is one positive/negative pair testing omission of an informative obstruction. It establishes neither a general defect-detection rate nor full-corpus reliability.

These results support testing coverage as a cheap screen before stronger proof verification. Final acceptance still needs both checks. The production editing loop currently checks proofs first. Inputs, preregistration, removed text, and accounting are retained in `runs/editor-golden-coverage-controls-r01/`; the native campaigns are `editor-golden-coverage-a-r01` and `editor-golden-coverage-b-r01`, frozen at source commit `5d3e98dc97836200d319236a25051937eeb4cd97`.

A read-only gateway metadata check also advertises an extended context of 872,000 tokens for both GPT-6 Luna and Sol, above their 272,000-token defaults. This is capability metadata, not a large-input experiment. The fixed small-fixture settings remain unchanged, and Xean's output reserve and capacity checks still apply. The receipt is `runs/editor-golden-coverage-controls-r01/model-capacity.json`.

## Native workflow trial

Source commit `257134aaf6cb384d4a94a41803b8c3d83bb5f77b` adopts the exact consolidation prompt in the built-in Editor, with repair guidance added only on repair invocations. A fresh `xean edit` trial used the same fixture, Luna/max drafting and coverage, Sol/max correctness, and three total admitted calls. The golden key and previous results remained outside the model inputs.

The campaign ended **limited, without an accepted replacement**. Its first Luna request failed with a WebSocket 1011 transport error after about seven minutes. Pi's retry produced four notes with 4,674 body tokens and 5,626 total mathematical tokens: reductions of **17.5%** and **7.9%**. The third call checked proofs. The allowance then prevented coverage from calling a model; there was no extension or repair run.

Sol passed three notes and rejected the ray construction for dropping the hypothesis that threshold `L` is an integer. An independent reviewer, without seeing the native verdict, found the same defect. Both supplied concrete fractional-threshold counterexamples where the success tests pass but the claimed finite boundary search fails. On the source's integer domain, the independent review found the useful capabilities and scoped obstruction preserved, with no other consequential defect. The raw draft remains unchanged; a local repair is still required.

The three gateway requests took 7m 24s, 3m 24s, and 4m 14s respectively. Successful drafting cost **$0.00496034** and proof verification **$0.138612**, totaling **$0.14357234 known API-equivalent cost**, plus the failed request whose token usage and cost are unknown. All admitted calls match gateway records, and the successful token buckets match Pi. Across all fourteen small-fixture requests, known cost is **$1.11953644**, plus that unpriced failure. Curation and interactive reviews remain separate and unpriced.

This trial measures a failed complete-workflow attempt and a successful detection of a mathematical editing error. The earlier checked candidate remains evidence that a one-draft result is possible; this fresh sample shows that it is not guaranteed. It does not establish a needed number of repair rounds or full-corpus economics. Artifacts, frozen settings, measurements, independent review, and accounting are under `runs/editor-golden-native-r01/`, with preregistration in `runs/editor-golden-native-r01-protocol/`. No historical research corpus was activated or modified.

The integration adds 3 production lines and 21 experiment/operator lines, with no new tests or runner. Types, formatting, documentation checks, and all 103 tests passed. The existing acceptance, combined-feedback repair, and atomic-activation checks remain in place.

## Repair prompt comparison

A standalone Luna/max corpus review of the checked native draft identified the same integer-threshold defect and no additional useful-content loss. Two one-call Editor trials then received exactly the same original notes, checked proposal, and native review. The answer key and independent review stayed outside both inputs. These are staged follow-ups; they do not extend or complete the capped native campaign.

| Repair instructions                                | Passing notes retained | Notes rewritten | Body tokens | All mathematical tokens | Request time | API-equivalent cost |
| -------------------------------------------------- | ---------------------: | --------------: | ----------: | ----------------------: | -----------: | ------------------: |
| Consolidation prompt with appended repair guidance |                      0 |               4 |       4,644 |                   5,634 |       5m 23s |          $0.0103194 |
| Separate repair prompt                             |                      3 |               1 |       5,535 |                   6,565 |       8m 03s |          $0.0103761 |

The first trial fixed the reported hypothesis but discarded all three reusable checks by rewriting their notes, with almost no change in total size. It stopped before verification because it failed the targeted-repair objective. Source commit: `aad77f66fdcc425206455ae8f1b9c29aae977d57`.

The second changed only the repair prompt, leaving the initial consolidation prompt byte-identical. It retained the three passing notes by exact ID. However, the changed note grew from 1,862 to 2,723 body tokens and no longer used the existing exact-compression note as support, repeating more machinery. The complete payload became 7.4% larger than the original fixture, so it also stopped before verification, as preregistered. This establishes note retention on this sample, not an adequate repaired corpus. Source commit: `2f6c859114e5eabe02c8f14db65a3d938e688bf8`. The change removes one production line; no schema, runtime, or test was added.

The shared preliminary review cost $0.0048531 and took 2m 09s. These three calls cost **$0.0255486** in total. All seventeen small-fixture requests now have **$1.14508504 known API-equivalent cost**, plus the earlier unpriced transport failure. Gateway and Pi usage agree for all three follow-up calls. Interactive curation and reviews remain separate and unpriced. Both repair drafts remain mathematically unverified and unaccepted; the planned stronger verification and final coverage calls were not run. All three follow-up jobs are terminal.

The remaining observed problem is expansion within the changed note. Any next comparison should test passage-level preservation and continued use of valid support, while retaining the successful whole-note reuse behavior. Inputs, preregistrations, stopping decisions, and accounting are under `runs/editor-golden-repair-r01-protocol/` and `runs/editor-golden-repair-r02-protocol/`; native outputs are under the corresponding `editor-golden-repair-*` attempt directories.
