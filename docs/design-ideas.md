# Design ideas

## Concurrent outer workers

Outer concurrency is deferred. The current contract is Coordinator, one worker,
then Coordinator again after that worker's complete result or failure commits.
A worker may parallelize its internal work. Reconsider overlapping outer workers
only after the sequential workflow is stable, with evidence that the benefit
justifies the additional scheduling and consistency rules.

## Verified exploration

Consider exposing exploration and verification as one operation to Coordinator.
The operation would return exploration together with verification results,
potentially simplifying scheduling. It may cost more if it verifies more notes
than Coordinator would otherwise select.

Which notes it verifies, how verification overlaps exploration, and what it
returns when checks fail remain open. This is an unimplemented idea.
