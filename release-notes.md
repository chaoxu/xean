# Release notes

## `5.0.0-dev.4` (unreleased)

`xean` uses Chord for research jobs, claims, and campaign control, and Pi Durable
for model calls and recovery. A single database owner runs Explorers and Verifiers
under `maxWorkers`, which defaults to `1`. Higher limits allow concurrent workers
through the same controller. Manual workers use native Chord runs through
`owner.start` and `owner.startGroup`.

Full note texts remain authoritative in immutable notebook publications. Verifiers
check selected notes conditionally on their declared dependency statements.
Acceptance requires verified dependencies and all four checks in one attempt.
The controller cancels unrelated campaign work after provisional acceptance,
joins cleanup, and rechecks acceptance. The [README](README.md) describes the
admission, verification, and recovery conditions.

The bundled Chord and Pi CI builds include upstream scheduler wake-up and provider
shutdown fixes. [Provenance](vendor/pi/provenance.json) pins the archives, metadata
adjustments, and retained patches. Use fresh campaign databases and keep historical
campaigns with their original runtimes.

### Qualification

Five matched `gpt-6-astra`/`max` tests of statement extraction and comparison at
released `411f08a` and v5 `10114cd` found no case where 4.5 passed and v5 failed.
Both versions' comparison roles failed to reject a supplied statement containing
the original prime-proof recipe. This shared weakness remains unresolved.

At `10114cd`, six fresh Astra/max campaigns covered tree edge counts, Bernoulli's
inequality, and infinitude of primes, each with one or three workers. All reached
`accepted`. Independent Astra/max review found all six arguments sound and noted
minor wording defects. Separate review found no proof-method leakage in their
accepted reconstruction inputs. These cases used no declared dependencies, so
they do not qualify conditional dependency handling. Observed worker counts stayed
within their configured caps, with no duplicate claims observed. Explorers
repeated approaches, including across all three parallel cases.

These records belong to `5.0-astra-qualification-20261109-r01` and its matched
4.5 packet. They concern the frozen tested revisions, not every later dependency
update. They establish neither general mathematical nonregression nor formal
certification.

### P01 resource comparison

The `4.5-v5-resource-p01-20261111-r01` packet compared released `411f08a` with v5
`621e04e` on identical First Proof Batch 3 P01 inputs, using Astra/max and one
worker. Both campaigns reached internal `accepted` outcomes. Neither fresh
argument has received independent mathematical review.

| Recorded measurement                         |    4.5 |     v5 |
| -------------------------------------------- | -----: | -----: |
| Elapsed minutes                              | 167.80 | 122.32 |
| Observed process high-water RSS (MiB)        | 224.83 | 231.31 |
| Final database size including sidecars (MiB) |  19.41 |  20.59 |

Process high-water RSS was observed once per minute and is a lower bound on the
final process peak, which was not retained. Sampling began after initialization
and note submission, excluding final report and export subprocesses.
The runs produced different proofs and amounts of work. This single pair supports
no general speedup or efficiency claim.

## `xean` 4.5.0

Explorer controls mathematical directions and note reading. Coordinator files
missing summaries and selects verification work without supplying exploration
advice. Operator guidance still reaches the next fresh Explorer call.

Pi 1.5.0 replaces bundled development packages with exact released dependencies
and retained [patches](vendor/pi/provenance.json). The independent notebook package
remains bundled. Multiple valid role submissions still fail the call, but resume
now skips the ambiguous result and makes a fresh call.

Detailed note reads omit PASS and external-attestation report prose while retaining
FAIL and INCONCLUSIVE reports. Full reads return text strings only. Stored evidence
remains available through `inspect`. The exported `sourceCall` helper now returns
`CodexRequest` directly, without its former wrapper or unused `protocol` field.

Start with fresh databases. Historical campaigns retain their pinned runtimes.
Follow the [backup and recovery instructions](README.md#recovery-storage-and-usage)
for both campaign and notebook databases. Notes and verification trust remain
isolated by campaign.

The frozen comparison `v450-v440-comparison-20261101-r01` tested 4.4.0 at
`4092dede` against the earlier 4.5.0 candidate `34740e5`: two runs per version on
destroying rigidity, matroid t-connectivity, and First Proof P03 and P10, using
`gpt-6-astra`/max with `verifyOnSolution: true`. Post-hoc independent review admitted
established literature and returned PASS for all eight final proofs per version.
Recorded API-equivalent solver costs were $171.77 and $151.15 respectively, about
12% lower, excluding unknown usage, independent review, and source preparation.
Original closed-packet verdicts, solver inputs, and proofs remain unchanged.

That comparison predates subsequent runtime and reader changes. Fresh campaigns
in `v450-release-validation-20261102-r01` tested the final Pi 1.5.0 runtime on
destroying rigidity, matroid t-connectivity, and First Proof P10 with
`gpt-6-astra`/max and `verifyOnSolution: true`. All three final proofs passed
independent model review. These runs validate those cases on the final runtime
separately from the earlier comparison. Contract and distribution checks cover
implementation behavior. Neither assessment establishes general mathematical
nonregression or formal certification.
