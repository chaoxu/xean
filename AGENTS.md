# Working on Xean

Read README.md and the pinned Pi implementation before changing the design.

- Start from Pi's Tasks, Conversations, Entries, Documents, outcomes, and commits.
  Before implementing behavior, check whether Pi supplies it or a small change
  in application behavior would let us use Pi directly.
- Keep this a small Pi extension. Do not add a separate kernel, Store, scheduling
  loop, task cache, lifecycle APIs, provider runtime, or compatibility code.
- Do not write custom parsers. Use native structured output and standard readers.
- Prefer application integration and native configuration to Pi patches. Patch
  Pi only when the required behavior belongs inside Pi, such as an adapter
  discarding provider errors or usage before application code can observe them.
- Keep mathematical content authoritative in one place and retain references
  where Pi already stores the value.
- Preserve the v1.0.0 research sequence: Explorer appends one completed submission,
  Coordinator selects verification work, and Verifier checks source, correctness,
  requirements, and reconstruction in that order. Explorer continuation is off.
  The authorized policy change is joint reconstruction of selected roots and
  their generated dependency closure. Admitted verified source dependencies are
  premise leaves, while selected roots always require reconstruction. Acceptance
  requires the root and its generated ancestors to pass reconstruction in the
  same attempt.
  Use Pi's native task waits and recovery. Keep the outer workflow sequential,
  with no separate scheduler, worker queue, or mutable mathematical note edits.
- Have a separate agent review each substantial design change specifically for
  native Pi alternatives and unnecessary application machinery. Resolve findings
  against Pi's implementation before declaring the change complete.
- Use Bun and the package commands. For a release, run `bun run check` and
  `bun run pack`, which includes the distribution checks. Use
  `bun run check:distribution` when no retained archive is needed. Internal Fleet
  validation may additionally use locked Fleet Bun and socket-free Nix checks.
  Keep tests focused on consequential workflow failures. Report runtime and test
  line counts.
- Reproduce interface failures with local contract tests. Screen model behavior
  with small standalone-role inputs before a full campaign smoke or golden run.
- Use `xean status` for routine monitoring and read transcripts on demand.
  Keep monitoring storage bounded instead of archiving cumulative snapshots.
- Preserve historical runs and their pinned runtimes. No compatibility,
  migrations, remote publication, or production cutover is implied.
- Apply the prose-writing skill to documentation and obtain separate verifier
  review. Keep documentation here short and describe only implemented behavior.
