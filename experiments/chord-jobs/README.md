# Chord jobs spike for `xean`

Chord owns Explorer and Verifier jobs in this prototype. Pi owns individual
model calls, frozen inputs, and receipts. The existing note store, prompts,
verification sequence, and acceptance projection are reused.

Run these commands from this worktree with Bun 1.4.2:

```sh
bun install --frozen-lockfile --ignore-scripts
bun node_modules/typescript/bin/tsc -p experiments/chord-jobs/tsconfig.json
bun test ./experiments/chord-jobs/jobs.test.ts
bun experiments/chord-jobs/chord-probe.ts
```

The tests use real Chord and Pi SQLite storage with simulated model responses.
They make no provider calls. The files in this directory are excluded from the
package and leave the production CLI unchanged.

## Ownership

`pi.prepare(kind)` stores a frozen work input and returns its reference.
`jobs.start(ref)` starts or rejoins the corresponding unsettled Chord job.
A single job definition gives both roles a shared `maxWorkers` limit. The caller
chooses when to start another Explorer or Verifier.

Chord commits selected-note claims atomically and retains the selected plan for
recovery. Pi finds each model stage by its work reference and stage key, reuses
completed receipts, and resumes pending calls. Publication is idempotent under
the work reference. Chord releases claims and records completion in its finish
transaction.

The prototype uses separate Chord and Pi execution databases, the existing
notebook database, and a SQLite ownership lock covering both runtimes. Proof
text stays in the existing notebook and Pi input records. Chord retains claim
IDs, selected checks, and completion metadata. Successful native Chord jobs are
removed, so the application records the history needed after completion.

## Verified behavior

Six integration tests cover shared capacity and mixed roles, conflicting claims,
reopening during a proof call, publication before job settlement, invalidated
selection, and ownership cleanup. They pass with 55 assertions. The publication
and recovery tests confirm that completed model stages and note publications
are reused. A separate native Chord probe checks persisted job IDs, deduplication,
watches, and finish behavior.

These are execution-contract tests. They establish neither mathematical quality
nor model latency. The existing Astra campaign uses its original runtime and is
independent of this prototype.

## Scope and comparison

| Implementation                               | Formatted lines |
| -------------------------------------------- | --------------: |
| Chord worker lifecycle and claims, `jobs.ts` |             273 |
| Pi integration and host setup, `pi.ts`       |             308 |
| Total prototype implementation               |             581 |
| Existing `src/workers.ts`                    |             589 |
| Existing automatic controller, unported      |             299 |

The prototype retains the verification window for each invocation. It omits the
automatic controller, explicit retry after a job has settled as failed, deferred
verification, caller input and guidance handling, and Codex source execution.
Deferred verification, imported inputs, and Codex source profiles are rejected.
Settled work references cannot be started again.

A fresh selection checks current Pi note status before the Chord claim
transaction. These are separate transactions. Note invalidation can occur
between them, and the latest projection still determines verified and accepted status.
Already claimed plans retain their frozen inputs during recovery.

The tested interruption is a clean close at a deliberately held boundary.
Abrupt process death, storage failures, and Chord finish failures remain
unqualified.

Chord's capacity, start, finish, and watch APIs make the worker lifecycle clearer.
The integration between stores and retained completion history consume most of
the code saved. This prototype demonstrates feasibility, without establishing a
smaller replacement for the current worker implementation. Keep it on the spike
branch while deciding whether broader use of Chord would justify that integration.
