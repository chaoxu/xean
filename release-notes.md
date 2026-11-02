# `xean` 4.5.0

The revised Explorer and Coordinator prompts give Explorer control over
mathematical directions and which notes to read. Coordinator files missing
summaries and selects verification work. It no longer supplies exploration advice
or suggested reading IDs. Operator guidance through `guide` still reaches the
next fresh Explorer call.

Pi is pinned to upstream commit `b556cfe5b0300a91f39c7bc5369a65a25fb7fcd5`, an
unreleased snapshot after 1.4.0. The upgrade uses Pi's native provider request hook
and preserves the role prompts and verification policy. Progress has a zero
storage delay setting, while Pi still publishes partial progress asynchronously.
Runtime cleanup leaves verification and acceptance criteria unchanged.

Full-text note reads skip derived verification-state computation and return the
same text strings. The exported `sourceCall` helper now returns `CodexRequest`
directly instead of `{request, schema}`. Its unused `protocol` field is removed.

Source, correctness, requirements, and reconstruction checks retain their order.
Acceptance requires fresh reconstruction of selected candidates and reconstruction
of their generated dependencies, with reuse of previously reconstructed support
from the same campaign. Admitted verified source dependencies remain premise leaves.
Acceptance is an internal model judgment, separate from independent mathematical
review.

Start with fresh campaign databases. Historical campaigns keep their pinned
runtimes, without migration. Close all writers before backing up both
`campaign.sqlite` and `campaign.sqlite.notes.sqlite`, and restore both to their
original canonical paths. Notes, verification trust, and reconstructed proofs
stay within their campaign.

Contract tests cover recovery, accounting, and note access. Distribution checks
cover packaged installation and CLI behavior. A fresh campaign using the updated
prompts and Pi runtime is ongoing, with no completed outcome. Mathematical
improvement and nonregression for 4.5.0 remain unqualified.

The README includes a BibTeX entry for citing `xean`, with matching metadata in
the packaged `CITATION.cff`.
