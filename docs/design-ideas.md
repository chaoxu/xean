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

## Simplifying accumulated proofs

Long campaigns can retain overlapping lemmas and unnecessary dependencies in
their final proof chain. In the P21 golden run, a strengthened orientation lemma
coexisted with its earlier version because a supporting note bundled a general
stability theorem with a consequence that used the earlier lemma. Later work
needed only the general theorem but inherited the whole note's dependencies.

Consider a model-led simplification pass that proposes replacement notes with
separate reusable claims and a smaller dependency chain. Preserve the original
notes and checks. Replacements require the usual verification before acceptance.
This pass is unimplemented. When to run it and whether it saves more work than
it costs remain open.
