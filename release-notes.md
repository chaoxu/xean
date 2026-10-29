# `xean` 4.4.0

Admitted notes now live in a per-campaign SQLite notebook supplied by the bundled
`@chaoxu/notebook-store` package. Other programs can read snapshots and publish
revisions through its API independently of Pi. Pi continues to manage execution
and recovery, record checks, and pin the campaign's note snapshot.

Campaign isolation is deliberate. `xean` never transfers notes, verification
trust, or reconstructed proofs between campaigns. The mathematical workflow
continues to explore, check sources and correctness, assess task completion, and
reconstruct candidates and their generated dependencies. Acceptance remains an
internal model judgment, separate from independent mathematical review.

Start with fresh campaign databases. Historical campaigns keep their pinned
runtimes, without migration. Back up both `campaign.sqlite` and
`campaign.sqlite.notes.sqlite` after closing all writers, and restore both to
their original canonical paths.

External notebook commits leave admitted reads and accepted exports pinned. The
next fresh note publication fails with a version conflict. The campaign neither
rebases nor automatically admits those changes.

Full note reads return only the requested text strings, in request order. Library
callers use `readReport` to read admitted note bodies.
