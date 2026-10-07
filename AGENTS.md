# Working on Xean

Read README.md and the pinned Pi implementation before changing the design.

- Start from Pi's Tasks, Conversations, Entries, Documents, outcomes, and commits.
  Before implementing behavior, check whether Pi supplies it or a small change
  in application behavior would let us use Pi directly.
- Keep this a small extension. Do not copy Xean's kernel, Store, scheduling loop,
  task cache, lifecycle APIs, provider runtime, or compatibility code.
- Prefer application integration and native configuration to Pi patches. Patch
  Pi only when the required behavior belongs inside Pi, such as an adapter
  discarding provider errors or usage before application code can observe them.
- Keep mathematical content authoritative in one place and retain references
  where Pi already stores the value.
- The outer loop is strictly sequential: Coordinator chooses one worker, that
  worker commits its complete result or failure, then Coordinator chooses again.
  This applies to replacement roles too. A worker may parallelize its own work.
  Use Pi's native task waits. Keep no outer concurrency setting or worker queue.
  Interrupted decisions and workers recover private progress. Preserve atomic
  publication and durable event delivery.
- Have a separate agent review each substantial design change specifically for
  native Pi alternatives and unnecessary application machinery. Resolve findings
  against Pi's implementation before declaring the change complete.
- Use Bun and the package commands `bun run check`, `bun run check:distribution`,
  and `bun run pack`. Internal Fleet validation may additionally use locked
  Fleet Bun and socket-free Nix checks. Keep tests focused on consequential
  workflow failures. Report runtime and test line counts.
- Reproduce interface failures with local contract tests. Screen model behavior
  with small standalone-role inputs before a full campaign smoke or golden run.
- Preserve the Yean and Xean checkouts and historical runs. No compatibility,
  migrations, remote publication, or production cutover is implied.
- Apply the prose-writing skill to documentation and obtain separate verifier
  review. Keep documentation here short and describe only implemented behavior.
