# Working on Xean

Read [README.md](README.md) for setup and the documentation map, and
[the philosophy](docs/philosophy.md) for the research principles. Before changing
architecture, read the relevant [kernel](docs/kernel.md) or
[solver](docs/solver.md) contract. [Pi alignment](docs/pi-alignment.md) separates
available APIs from deferred designs. Use [the glossary](docs/glossary.md) for
canonical terminology. Reuse an existing term before defining and justifying a new one.

For campaign-status requests, start with the [compact status workflow](docs/solver.md#checking-status)
and the campaign's frozen reader. Read full inspection or proofs only when needed.

## Core priorities

- Simplicity and correctness take precedence over feature count and speculative
  extensibility. Use the smallest clear implementation for the current contract.
- Keep one authoritative definition for each contract, policy, and default.
  Derive validation, types, and projections from it. Preserve immutable history
  and frozen inputs as records of past state.
- Keep documentation in its existing home: setup in README, contributor rules
  here, behavior in the kernel and solver guides, future Pi adoption in the
  alignment notes. Link those sources instead of adding parallel handoffs or
  repeating implementation details. Git and run artifacts retain checkpoint history.
- Treat code growth as a design cost. Report runtime and test line deltas for
  substantial changes. Remove redundant representations and bookkeeping while
  preserving readable formatting and essential correctness checks.
- Use runtime-native APIs, Pi, and maintained libraries for standard behavior. Before adding runtime
  machinery, inspect the pinned Pi/Chord implementation and record any missing
  guarantee in the alignment notes. Check ownership, publication, cleanup, and
  whether consumers retain histories despite native paging. Trace each datum
  from creation through persistence, reads, caching, and retirement. Reassess
  the requirement behind each workaround as well as upstream support. Distinguish
  missing native guarantees from defaults or consumers we have misconfigured.
- Express application semantics through native documents and tasks. Do not
  rebuild Pi's lifecycle, ownership, recovery, or storage behavior.
- Pin matching Pi packages to one tested commit with verified artifact hashes
  and frozen model data. Never use floating dependencies. Every patch needs a
  concrete reason and reassessment when upgrading.
- Xean is experimental software. Choose the simplest correct design as if
  writing it from scratch, even when APIs, schemas, or persisted formats break.
  Previous runs need not open in new code. Keep their artifacts as provenance,
  without legacy readers, aliases, migrations, or compatibility scaffolding
  unless the user explicitly requests them.
- Use TypeScript on Fleet's locked Bun runtime. Follow
  `~/.config/fleet/agent-reference.md` for runtime and fleet operations.
- Prepare the 3.0 release from a reviewed source revision. Publish a release or
  create its tag only when requested and after the distribution checks pass.
  Preserve existing releases and tags as historical archives.
  Preserve active campaigns and their source-frozen runtimes.
  Historical artifacts retain the original Yean and Xean names and formats.

## Tests

- Keep the suite small. Add a test only for a distinct, consequential failure or
  required contract. Prefer a focused regression or compact integration check.
- Avoid tests that mirror implementation, trivial library behavior, duplicate
  coverage, or retired contracts. Keep fixtures simple and consolidate overlap.
- Run proportionate checks. Repeat or broaden them only after relevant changes,
  failures, or unresolved concerns.
- Distinguish prompt-contract tests from evidence of mathematical performance.
  Screen one prompt change at a time on small frozen cases before larger runs,
  keeping held-out tasks and independent judgments separate from tuning.
- Before a long model-backed run, smoke-test every required path in its deployed
  image with its runtime, model, credentials, and native configuration. Include
  Codex source checking when used. Inspect results and recorded failures, not
  just process health or version output.

## Architecture boundaries

- The kernel treats a role as an opaque async function. Input goes in and one
  result or failure comes back. Codex, shell execution, authentication, and tools
  belong inside roles. Reuse maintained libraries without a command-specific runtime.
- Roles are trusted code. Avoid plugin sandboxes, permission frameworks,
  workflow languages, extra storage layers, or registries without a concrete need.
- Preserve atomic publication of each complete worker result and its Coordinator
  signal. Terminal failures also produce durable signals. Operational records
  remain visible after failure. External effects need role-owned idempotency.
- Coordinator owns scheduling, work requests, and logical retries. Workers
  return results, never proposed work requests. Processing a completion signal
  need not call a model. Pi owns transient provider retries.
- Pi owns private conversation recovery. Reuse completed generations, tool
  results, submissions, and frozen allowances without publishing partial notes.
  Opaque non-Pi roles still recover the whole worker. External effects remain
  role-owned and must be idempotent when replay is allowed.
- Do not impose arbitrary wall-clock deadlines on campaigns, roles, experiments,
  or smoke runs. Keep existing dependency timeouts and tune them from measured
  run and provider data, distinguishing total duration from inactivity.
  Model-call counters and usage are observational only; they never stop
  admission. Cancellation prevents late publication. Token and dollar budgets
  are out of scope.
- Permit independent read-only inspection while retaining one campaign owner.
  Inspection must not acquire ownership or perform recovery. Keep SQL as the backend direction.
- Core is a library. CLI and observer are optional sibling applications using
  its public exports. Core depends on neither app, and the apps do not depend
  on each other. Shared inspection reports belong in core. The observer owns
  its dashboard, theme, and snapshot-publisher lifecycle outside solver execution.
  Keep operation semantics in the library and model runtime construction lazy.
  CLI live mutations use the active owner, following the lifecycle contract.

## Mathematical roles

- Explorer owns mathematical strategy and selects its own note reads from the
  automatically supplied index and feedback. Coordinator supplies guidance and
  prioritizes pivotal or repeatedly reused claims for verification, without
  prescribing proof steps or imposing a verification quota.
- The built-in Coordinator admits at most one Explorer per group, with other
  roles allowed alongside it. This is replaceable Coordinator policy.
- Experiment round allowances belong only to the outer runner. No role receives
  remaining rounds, approaching-limit warnings, or an end-of-run strategy.
- Notes and summaries must suffice as shared mathematical memory, including
  failed approaches. Read existing notes for context instead of a separate
  digest or mathematical information held only in guidance. Rejected notes may
  be read for diagnosis but cannot supply mathematical dependencies.
- Preserve exact statements, hypotheses, and completion criteria. Keep private
  requester/catalog metadata outside solver tasks. Acceptance of the exact task,
  independent review, and catalog closure remain distinct.
- Pi runs Coordinator, Explorer, and mathematical checks. Codex owns literature,
  source verification, independent review, and optional implementation work,
  using its native tools. The solver guide defines the
  [Codex worker](docs/solver.md#codex-worker) and its artifact boundary.
  Use it sparingly for concrete implementation requirements with specified
  inputs, outputs, constraints, and checks. Self-contained source checks skip Codex.
  Model-visible capabilities and dispatch validation must agree. Reject unavailable
  requests instead of silently dropping them. Intentional waiting uses the existing lifecycle.
- Closed-book correctness may establish task-permitted background after checking
  exact statements and hypotheses. Forbidden black boxes fail. Uncertain premises
  remain unresolved under the task's proof rules.
- Reuse completed PASS checks, batch per-note judgments, validate every requested
  result ID, and establish dependencies before verification or acceptance.
  Blind reconstruction proves a set of exact statements together. Final acceptance
  requires reconstruction throughout the generated dependency chain. Imported
  supporting theorems remain assumptions, with their dependencies still checked.
- Caller-imported notes are trusted for correctness and sources over verified
  support. Keep their origin explicit. Exact-task acceptance still requires
  requirements and reconstruction checks.
- Source reuse shares immutable quotations and original bindings. Each new
  application requires judgment. Independent review obtains its own evidence.
- Trust harmless corrections to preserve meaning, dependencies, and checks.
  Supply every note view a role is permitted to replace.
  Mathematical changes require new notes. Preserve revision checks, frozen inputs,
  and atomic publication as specified in the solver guide.
- Each invocation must finish with room for its structured result. Use Pi's
  capacity estimator, preserve valid Explorer submissions at handoff, and never
  silently truncate mathematics. Conversation compaction is outside Xean's design.
- Use `gpt-6-astra` for new flagship work unless another model is selected.
  Every new role and smoke run uses `max` reasoning unless the user requests
  otherwise. Preserve completed runs' settings and model names as provenance.
