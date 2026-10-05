# Working on the Pi prototype

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
- Coordinator decisions are short-lived. Fresh events get fresh conversations,
  interrupted decisions recover private progress, and workers have independent
  ownership. Preserve atomic publication and durable event delivery.
- Have a separate agent review each substantial design change specifically for
  native Pi alternatives and unnecessary application machinery. Resolve findings
  against Pi's implementation before declaring the change complete.
- Use locked Fleet Bun and socket-free Nix checks. Keep tests focused on
  consequential workflow failures. Report runtime and test line counts.
- Preserve the Yean and Xean checkouts and historical runs. No compatibility,
  migrations, remote publication, or production cutover is implied.
- Apply the prose-writing skill to documentation and obtain separate verifier
  review. Keep documentation here short and describe only implemented behavior.
