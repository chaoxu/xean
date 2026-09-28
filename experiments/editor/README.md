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

Each arm admits one model call and returns one draft. It uses the existing Pi request path, output schema, and dependency validation. There are no automatic repairs, verifiers, source searches, or subsequent editing calls. Failed requests and invalid submissions remain experimental outcomes. A completed generation is not mathematical acceptance.

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

This establishes a cheap successful combination on one valid fixture. It does not yet establish the cheaper reviewer's ability to catch a broken replacement. The next useful check is a known defective variant of these same notes, with the golden key still withheld from the model. Larger runs remain outside this experiment. Native campaigns and receipts are under `runs/editor-golden-luna6-verifier-r01/`, `runs/editor-golden-luna6-coverage-*/`, and `runs/editor-golden-assessment-r01/`.
