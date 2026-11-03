# `xean` 4.5.0

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
