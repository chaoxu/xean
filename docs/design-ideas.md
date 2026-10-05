# Design ideas

## Verified exploration

Consider exposing exploration and verification as one operation to Coordinator.
The operation would return exploration together with verification results,
potentially simplifying scheduling. It may cost more if it verifies more notes
than Coordinator would otherwise select.

Which notes it verifies, how verification overlaps exploration, and what it
returns when checks fail remain open. This is an unimplemented idea.
