# Distribution

The `main` branch at `https://github.com/chaoxu/xean` is the current release. Install and update from that branch. Do not create new numbered releases or release tags. Preserve existing releases and tags as historical archives.

Use exact Git commits and the dependency lockfile for reproducible runs. Package version fields are packaging metadata.

Support only current schemas. Remove retired readers, aliases, adapters, and migration branches instead of maintaining backward compatibility. Reject unsupported formats without rewriting archived data. Schema versions identify persisted contracts. Change them when the stored format or the meaning of recorded evidence changes, including verifier policy changes. Prompt wording edits alone do not require a version bump.

Backward compatibility is not a project requirement. Do not spend implementation
time on legacy formats, compatibility shims, migration paths, or capability
parity with retired behavior; update the current contract and its callers
together instead. Tests are required only for essential current contracts and
failure boundaries. Prefer a small focused regression test, and remove tests
that merely mirror implementation details or preserve retired behavior.
