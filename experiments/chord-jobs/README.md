# Chord jobs spike for `xean`

Chord manages Explorer and Verifier jobs. Pi Durable executes their model
conversations and tools. `xean` supplies research policy, prompts, note
publication, and verification. Pi has its own task scheduler, so using Chord jobs
is an application boundary rather than a prerequisite for concurrent agents.

`openJobs(directory, definition, models)` opens both runtimes over one Chord
store. Pi uses its native `StoreStorage` adapter. The caller starts work through
`jobs.start("explorer")` or `jobs.start("verifier")` and closes the owner with
`jobs.close()`. Each start freezes input from all current notes. Verifier inputs
also include current claim hints.
Set `maxWorkers: 1` for sequential execution, or a larger value for overlapping
Explorers and Verifiers. The optional report callback receives Chord and Pi
diagnostics and defaults to `console.error`.

## Native ownership

Chord enforces shared worker capacity and restores unsettled jobs on reopen. Each
Verifier stores its selected plan in native job state. A serialized state change
checks other running and finishing jobs before claiming the selected notes.
Chord removes that state when the job settles, together with its completion
history transaction. A blocked job prevents fresh claims because Chord hides its
state from the running view. The application retains completion history because
Chord deletes settled job records.

Pi stores frozen work inputs and model receipts. A native document maps each
work reference and stage key to a conversation. That reference, the conversation,
and its configuration are created in one Pi transaction. Reusing a stage checks
its arguments, then Pi's submission request ID handles replay and recovery.
There is no custom Pi task around each model stage. The existing task-based
workers share this role invocation code, including their explicit retry behavior.

The directory contains `execution.sqlite`, the existing `notes.sqlite`, and an
ownership lock. Closing seals Chord jobs and suspends Pi execution before closing
the shared store and releasing the lock. Mathematical notes remain immutable.

## Running the checks

Use Bun 1.4.2 from this worktree:

```sh
bun install --frozen-lockfile --ignore-scripts
bun node_modules/typescript/bin/tsc -p experiments/chord-jobs/tsconfig.json
bun test ./experiments/chord-jobs/jobs.test.ts
bun run check
```

Integration tests exercise sequential and concurrent execution, conflicting
claims, recovery during a proof call, replay after publication, invalidated
selection, and ownership cleanup. They use Chord and Pi SQLite storage with
simulated model responses and make no provider calls.

## Scope and comparison

| Runtime code                        | Initial spike | Revised spike |
| ----------------------------------- | ------------: | ------------: |
| Experimental job and Pi integration |           581 |           477 |
| Shared role caller                  |           455 |           496 |
| Total formatted lines               |         1,036 |           973 |

The net reduction is 63 runtime lines. The structural change removes custom
model-stage tasks, a separate claim registry, and a second execution database.
The automatic campaign controller remains unported. The experiment also omits
settled-job retries, deferred verification, caller intake and guidance, and
Codex source execution. Native terminal call failures remain failed on reopen.

The Pi freshness read and Chord claim are separate transactions even within the
shared store. A note can become invalid between them, allowing redundant local
verification. The latest projection determines verified and accepted status.
Claimed plans keep their frozen inputs during recovery.

Recovery tests cover clean close and reopen at held boundaries. Abrupt process
death, storage failures, Chord finish failures, and cancellation of an individual
job remain unqualified. These tests establish neither mathematical quality nor
model latency.

Use fresh databases. The shared role caller now requires native stage references,
so this branch does not migrate existing campaigns. Historical runs and the
Astra campaign retain their original runtimes. The experimental job API is not
wired into the CLI or included in the package.
