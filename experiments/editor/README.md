# Editor prompt experiment

Test editing prompts on one frozen mathematical dataset before considering larger runs. The dataset contains three related research notes with complete proofs, overlapping arguments, and a counterexample limiting a promising approach. Its full bodies contain 5,663 reference tokens. The complete input contains 7,511 reference tokens.

The research question is whether a prompt produces a coherent, materially simpler reference while preserving usable mathematics. Size reduction, model cost, and elapsed time are measurements. A short but defective result fails.

## Fixed materials

- [input.json](input.json) contains the problem and notes shown to the model.
- [golden.md](golden.md) contains provenance, the mathematical answer key, and known failure cases. The runner never reads it.
- [baseline.md](prompts/baseline.md) freezes the existing Editor instructions.
- [reference.md](prompts/reference.md) describes the intended mathematical reference in self-contained terms.
- [settings.json](settings.json) fixes the model and reasoning settings.

Each arm admits one model call and returns one draft. It uses the existing Pi request path, output schema, and dependency validation. There are no automatic repairs, verifiers, source searches, or subsequent editing calls. Failed requests and invalid submissions remain experimental outcomes. A completed generation is not mathematical acceptance.

Compare outputs against the answer key after generation. Record whether the useful capabilities and their proofs survive, whether negative conclusions retain their scope, whether dependencies close, and whether the output consolidates repeated arguments. Record each defect concretely. Equivalent valid proofs and different note organizations are welcome. There is no per-note preservation requirement or compression target.

Change one prompt at a time, use a new prompt filename, and commit it before the next run. Keep the dataset and answer key fixed. A success on this development fixture establishes only success on this fixture. Further runs remain limited to this dataset.

## Run on Fleet

Run from the adjacent Fleet Infra checkout using its locked Bun:

```sh
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts launch editor-golden-baseline-r01 baseline
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts status editor-golden-baseline-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts collect editor-golden-baseline-r01
bin/fleet-nix run .#fleet-run -- ../xean-editor-science/experiments/editor/operate.ts cancel editor-golden-baseline-r01
```

Launch requires a clean, internally pushed commit and a fresh attempt ID. It uses the existing pinned worker image on jupiter and the committed [Nomad specification](job.nomad.hcl). The operator reads only the Xean gateway credential from OpenBao and injects it in memory. Credentials never enter committed files or saved job specifications. After a submission error, inspect the attempt before creating another one.

Results are collected under ignored `runs/<attempt-id>/`. Keep the input, prompt, settings and model hashes, source commit, complete request records, generated replacement, reported usage, elapsed time, and a short `review.md` together. Missing usage is unknown cost. Report API-equivalent usage separately from subscription billing and independent review overhead.

The former large-run drivers and job templates are retired from this branch. Their source remains in commit `23f19fa9188c119ca0fc2210019f032ae73b1614`, and historical run artifacts remain under the original checkout's ignored `runs/`. The cancelled full-corpus continuation produced no replacement or coverage verdict. No large run is part of this experiment.
