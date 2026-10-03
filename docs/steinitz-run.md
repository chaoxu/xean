# Euclidean Steinitz experiment

The task is the catalog export `steinitz-conjecture-l2`: for every zero-sum
sequence of Euclidean unit vectors in dimension m, determine whether some
permutation keeps every partial sum within C sqrt(m), for a universal C.
The task export includes its full completion criteria and excludes catalog
metadata. Its SHA-256 is
`ebf74fa06c9fb22b1ea17610b9c73a0cedc2c9893b749bc43ea4560b6656c9a1`.

`scripts/bounded-solve.ts RUN_DIRECTORY` runs the standard solver with the directory's
`task.json` and `settings.json`. The default allowance is 20 Coordinator
planning invocations, counting interrupted invocations. Each reserves a numbered
file before planning. Work dispatched in round 20 may finish and pass acceptance.
Otherwise the campaign pauses, preserving notes and recording `round_limit`.
Deterministic signal handling and acceptance consume no additional rounds.
The allowance and remaining count are visible only to the runner and operators.
No role, including Coordinator, receives them or a warning that the cap is near.

To grant a paused 20-round campaign another 20 rounds, run the same script with
`--round-limit 40 --resume`, retaining `--offline` for a closed-book campaign.
The limit is the total number of planning invocations, so repeating the same
command cannot grant another block. Existing round reservations remain intact.
Explicit `--resume` resumes a paused campaign. Record the authorized total and
source revision with the supervised submission, and preserve the prior result
and verification artifacts before continuing.

Use this script for this experiment, including any restart. The general CLI
does not enforce the experiment's round allowance. Retain the round files beside
the database. The script writes a compact execution receipt to `result.json`.
Pi retains notes and the journal in `campaign.sqlite`. Use CLI `inspect` or
`inspect --records` for explicit exports, and the separate
[snapshot publisher](../packages/observe/README.md#snapshot-publishing) for remote
observation. Reopen verification belongs to the
[test and smoke procedure](kernel-smoke.md).
The runner uses the public solver and kernel APIs without introducing a kernel
round limit.

The committed `nomad/bounded-solve.nomad.hcl` takes `run_id`, `source_commit`,
and `installation`. It runs on jupiter using an existing immutable Lab image
and one qualified installation at `/srv/xean-lab/runs/_runtime/INSTALLATION`.
The installation retains the complete `source/` tree with locked dependencies
and `runtime/bun` with `runtime/bun-runtime.toml`. New campaigns reuse it by
identity. Their inputs and results live separately under `_xean/RUN_ID`.
Record the source, dependency and runtime hashes with the submission.

The optional `codex_configs` map supplies native TOML files without credentials:
`config.toml` and, for each configured named profile, `NAME.config.toml`.
Nomad writes those files into the allocation's Codex home. Codex
plugin caches and Bun scratch stay in the allocation instead of the archive.
Credentials still arrive through the job environment. Lab and deployment tools
own these installations and their retention. Ordinary Lab campaigns already
share the worker image. Historical campaigns retain their original job specs,
source paths and runtimes.

## September 23 run

This historical run used `gpt-6-astra` with high reasoning, two concurrent
workers, and at most four Explorer responses per invocation. Literature search
was disabled. Source verification used Codex for external premises.
Credentials reached the job only through its environment. The recorded usage prefix
is `yean/steinitz-2026-09-23`.

The offline cap probe verified draining, acceptance after round 20, preserved
reservations after interruption, and unchanged reopen with no provider calls.
Its local evidence is `runs/cap-probe-verified.json`.

The allocation `fe3fdcef-84df-51c7-f10c-705650342dec` started on jupiter
at 2026-09-23 20:23:48 UTC from source commit
`e71ec7dfd6fa1193be3e6da4a61278732dd909a6`. It drained and paused after
20 rounds without an accepted solution. The local run audit, `runs/run-review-2026-09-24/report.md`,
records its mathematical findings, costs, and operational concerns. Its durable
artifacts are under `jupiter:/srv/xean-lab/runs/_yean/steinitz-2026-09-23/`.
Local task, settings, source hashes, submission receipts, and the
nonsecret Nomad specification are under `runs/steinitz-2026-09-23/`.

An earlier allocation failed before starting Yean because the reused image's
entrypoint executable was missing. The final spec starts the staged Bun directly.
That failed allocation consumed no round or model call.

At the end of round 6, the 32 admitted calls comprised 11 Coordinator model
requests, 15 Explorer model requests, three verifier model requests, and three
source invocations that failed at Codex startup. Role timing and per-attempt
gateway tags establish this accounting. The source invocations used a legacy
`[profiles.yean]` table rejected by the deployed Codex. A credential-free probe
reproduced that configuration error. Process health and empty stderr had not
exposed these worker failures.

At 2026-09-23 21:20:45 UTC, both benchmark configurations were corrected to use
`yean.config.toml`, preserving the old files and recording the change beside each
database. Current workers and round counts were preserved. A separate deployed
source smoke then passed using the same image, locked Bun, Codex executable,
Astra model, and gateway settings. It used one recorded Codex call, observed a
web operation, returned a DLMF passage with source PASS, and reopened unchanged.
Evidence: `runs/source-smoke-2026-09-23/verified.json` and each run's
`codex-profile-fix.json`. The smoke supplied a correctness PASS fixture to isolate
source execution. It did not verify either benchmark's mathematics.
