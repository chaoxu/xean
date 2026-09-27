# Mathematical solver

Xean's solver runs Explorer, Coordinator, literature, and verification over the
existing kernel. The task contains only `problem` and `completionCriteria`.
Settings and the exact task are frozen in the CLI campaign declaration.
Private requester and catalog metadata stay outside the solver payload.
The [philosophy](philosophy.md) states the research principles and trust model.
The [glossary](glossary.md) defines the shared terminology and code spellings.

## Roles and acceptance

- Explorer automatically receives the exact task, every note's ID and index
  summary, current verification state and feedback, and Coordinator guidance.
  It owns mathematical strategy and chooses detailed summaries or full notes
  through `read_notes`, within its configured read allowance. It has no external
  search tools. Its submissions stay private until the whole worker
  returns. A `candidate` claim, an empty submission, prose after a valid
  submission, or `maxExplorerResponses` ends the worker. Every completed response
  counts toward that limit, and each follow-up states how many remain.
- Coordinator chooses work and supplies guidance to Explorer. It may dispatch
  several independent workers, with at most one Explorer in the built-in
  implementation. It waits for that group before choosing more work.
  Failed workers reach Coordinator, which schedules logical retries or
  further work. Schema and note-reference errors are returned through Pi tool replies.
  Verification requests from one decision share a batch, so common support is
  checked once while Explorer may run alongside it.
  It prioritizes pivotal or repeatedly reused unchecked claims without prescribing
  Explorer's proof steps or imposing a verification quota. Workers return results,
  not proposed work requests.
  Its first prompt contains every note's ID, index summary, and feedback.
  `read_notes` retrieves detailed summaries or full texts from the same frozen
  input. Dead notes may be read for diagnosis, but cannot supply mathematical
  support or change the verification requirements.
- Editor optionally rewrites the whole corpus between worker groups. Coordinator
  selects it using corpus-size statistics and the configured advisory threshold.
  Its verification and repair loop runs before ordinary planning resumes.
  See [corpus editing](#corpus-editing).
- Verifier requests select a stopping stage: `correctness`, `source`,
  `requirements`, or `reconstruction`. Each stage checks multiple notes in one
  model request and returns a verdict per note. Dependencies must pass correctness
  and source before a target becomes verified. Caller-imported notes establish
  those stages by trust. Completed PASS checks and imported trust are reused.
  A request may establish outstanding dependencies even when the target's own
  requested stages are already satisfied.
- Literature is optional and disabled by default. It can complete once per
  campaign and returns ordinary unverified theorem notes. Coordinator may retry
  failed literature workers. When enabled, it requests a specific external theorem
  or source gap, rather than a general survey. Task-granted assumptions and
  self-contained arguments need no survey. The startup setting remains the
  authority for availability. This search limit belongs to the built-in Coordinator.

A supporting note becomes verified when its correctness and sources are
established over verified support, through checks or caller import. A later
solution request reuses those stages, then checks requirements and reconstruction.
Full-solution acceptance requires those
additional PASS results and reconstruction of every generated claim in its
transitive support. Trusted imported support is assumed, with its dependencies
still checked. Acceptance is reconstructed from committed notes and
checks, independently of Coordinator's claims.
Worker completion, a rejected proof, or an inconclusive check does not complete
the mathematical search. It continues until exact-task acceptance or an
authorized stop, with operational failures reported separately.

Coordinator plans use requests such as
`{"kind":"verifier","notes":["w3-1/n1"],"through":"source"}`. `correctness`
checks the note's argument, `source` establishes its external premises,
`requirements` checks the exact task, and `reconstruction` includes an independent
proof and comparison. Dependencies are established through `source` even when
the requested target stops earlier. Requests from one decision share a verifier
batch at the highest requested stage for each target. Standalone Verifier input
uses `targets: [{id, through}]` alongside the exact task and selected notes.
Correctness judges supporting and partial claims on their own terms. A cited
theorem note can pass conditionally on source verification without reproducing
its external proof. Requirements alone checks the original completion criteria.
Correctness checks the hypotheses of established support at each application
without asking source verification to establish the same supporting result again.
Its `premises` array names any nonroutine external claims that still require
source checking. Source verification and independent review use the same field
name.

Correctness checks dependent reasoning conditionally on declared support, even
when that support is checked in the same batch. A failed dependency invalidates
its dependents; an inconclusive dependency blocks their verification and acceptance.
Source checking combines notes with external premises into one Codex invocation;
notes without external premises pass that stage without a call. Requirements
checks only verified notes. Missing, duplicate, or unexpected result IDs reject
the entire submitted batch. Pi lets the model correct an invalid submission.

For an explicit conditional claim `P implies Q`, correctness checks the derivation
of Q assuming P. The antecedent stays in the claim and is omitted from external
`premises`. Source checks external results used to prove the implication.
An unstated assumption in an unconditional claim remains a defect. Requirements
alone decides whether the conditional result meets the original completion
criteria. Proving an implication does not establish its antecedent. Blind
extraction preserves the antecedent in the statement, and reconstruction checks
that the exact conditional claim was proved.

A note ID receives at most one committed source verdict. This includes
INCONCLUSIVE, which permanently leaves that note unresolved and blocks its
dependents from verification and acceptance. Harmless corrections and new
evidence do not reopen source checking. Further evidence requires a new note.
Coordinator has no override, and code rejects verification plans with no pending
checks. Execution failures without a committed result remain eligible for
recovery. Independent review still obtains its own source evidence.

Blind reconstruction accepts a set of notes. Final verification supplies its
requirements-passing targets and expands their transitive dependencies. One
statement-extraction call preserves exact claims, hypotheses, and definitions
while removing proofs and methods. One blind proof call then proves all pending
generated claims together, with a proof per note. Trusted imported support and
previously reconstructed claims supply statement-only assumptions. Source-checked
external premises also remain assumptions. Imported notes explicitly selected
as targets must themselves be reconstructed.

The blind prover receives the task, extracted statements, permitted premises,
and dependency links. Original proofs, index and detailed summaries, and verifier reports are
withheld. Each proof may use only its declared transitive support and permitted
background. Shared dependencies appear once. Previously checked descendants
are excluded when retrying an unresolved ancestor.

One comparison call checks statement fidelity and both arguments for each
pending note, including the assumptions used. Supporting lemmas need only prove
their own claims. Requirements alone checks the original completion criteria.
An incomplete or incorrect independent proof, or an unfaithful extraction, gives
INCONCLUSIVE unless the original argument has a concrete defect. Successful
checks retain the statement, premises, and proof for reuse. A conditional PASS
may survive an inconclusive dependency, but acceptance waits for the whole chain.
The existing Pi capacity check applies to each batch without truncation or
automatic splitting.

A full self-contained batch normally needs five model requests: correctness,
requirements, statement extraction, independent proof, and comparison. External premises add one Codex
invocation, whose internal searches and model requests remain Codex's responsibility.
Completed checks and earlier stopping stages reduce calls; invalid model outputs
can require additional requests. Each stage retains its configured model profile.

Notes and their summaries are the shared mathematical memory and must suffice to
continue the task. Every ordinary note contains `summary` for the index,
`detailedSummary` for its actual claims or findings, decisive conditions, bounds,
and unresolved gaps, and authoritative full `text` with arguments and evidence.
Both summaries preserve conditionality, negative conclusions, and limitations.
Detailed summaries may explain proof methods. Roles produce all three in their
normal submission, without a separate summarization call or fixed length ratio.
Verification receives full notes and dependencies. Summary views change neither
verification status nor dependency obligations.

Coordinator and Explorer begin with every note's ID, index summary,
status, and feedback. They select IDs directly from that complete index.
Their only retrieval tool, `read_notes`, takes up to 20 unique `ids`
and a `level` of `detailed` or `full`. Reads include verification state, support
IDs, and failure feedback. Independent IDs should be batched. Full text is never
truncated, and support IDs can be read in further calls. Read the full note when
a summary omits material detail.

An Explorer work request contains only `kind: "explorer"` and `guidance`.
The library builds its frozen `ExplorerInput` from the exact task, the full
committed `notes` snapshot, and that guidance. Full notes stay behind the reader
until Explorer requests them. Notes committed after dispatch remain invisible,
including on a worker retry. Internal reads work with literature and source
retrieval disabled.

`maxExplorerReads` limits reads per invocation. Each admitted `read_notes` call
consumes one read, including a batch of IDs or a call that fails because an
ID is unknown. Pi rejects schema-invalid arguments before admission, so those
requests consume no reads. Several calls in one response each consume a read.
The local guard enforces the allowance before executing a call, including when
the model requests several calls at once. The allowance must be at least one,
so Explorer can obtain details absent from the summaries. Coordinator's own
reader has no per-invocation read allowance.

`maxExplorerResponses` bounds completed responses, including read requests,
rejected submissions, and responses without a submission. Reading is disabled when its allowance is
exhausted and on the final response, leaving that response available for
`submit_result`. Read results and follow-ups report the remaining allowance.
Providers that support the reader retain its tool definition in the
conversation, and attempts after it is disabled receive a blocked result.
The submission tool remains available.

Failed approaches belong in notes, and guidance supplies scheduling direction.
Dead notes remain readable for diagnosis but cannot be mathematical dependencies.
Notes have stable IDs derived from their producing work or external command and
local note ID.
Support names actual mathematical dependencies. Missing, cyclic, forward, and
dead dependencies are rejected. Correctness, source, or reconstruction FAIL
invalidates the note and its dependents. Requirements FAIL leaves useful partial
results available. Reconstruction FAIL requires a defect in the candidate;
failure of the independent proof alone is INCONCLUSIVE.

Notes can receive harmless corrections through the command interface below.
The editor is trusted to preserve mathematical meaning. Corrections retain
checks and verification status, increment the revision, and leave dependencies
unchanged. A change to a claim, assumptions, argument, or dependencies requires
a new note. Original worker results and command receipts remain immutable.

A verdict may include `correction: {summary, detailedSummary, text}` containing
the complete note and consistent summaries with harmless edits. Only the stage's final PASS applies it, including after any
source-evidence or reconstruction checks that can downgrade a verdict. Later
stages use the corrected text privately. The complete verifier result publishes
`Check.correction: {revision, summary, detailedSummary, text}` atomically with its checks. Projection merges
worker publications and input receipts in commit order using `Work.publicationId`
and input IDs. A matching revision applies all three views and increments the revision.
A stale automatic proposal leaves newer content intact and retains the completed
checks. This differs from a stale manual `correct` command, which is rejected.
Projected note checks omit `Check.correction` and verdict `correction`
payloads, so later role inputs contain the current note text without old edit
proposals. Immutable worker results and call records retain the original payloads.

## Research

Pi roles use role-specific system instructions, JSON user messages, and a typed
`submit_result` tool. Explorer continuation stays in the same Pi conversation;
each verification check starts its own conversation. Prompts preserve Xean's
exact-task, dependency, and independent-proof principles in shorter form.
If a response ends without a tool call, Xean requests the missing submission
once in the same conversation and session. A second omission fails the invocation.
After a valid submission, a response without a tool call hands off the submitted
result instead. A rejected submission receives its validation error, not the
role's continuation prompt.
The follow-up remains subject to response, context, and call limits and
cancellation. Only validated `submit_result` arguments count as results.

Verifier requests put the shared task, support, and note text before the stage
instructions under a common system prompt. Stages keep their required result
schemas, so different tools, models, or changed notes can limit cache reuse.
Explorer places the task and each note's ID and summary in separate messages
before mutable state, feedback, guidance, and allowances. This preserves earlier
message boundaries when new notes are appended. Its system prompt and tool
definitions stay the same across read allowances and after reading is disabled
on providers that support the reader.
OpenAI's default prompt cache key is stable for the same model, system, and
tools while transport sessions remain separate. Caller-supplied keys and
disabled caching are preserved. Cache reuse depends on the provider and eligible
prefix boundaries. Measure reported cached tokens rather than inferring a hit
from a shared key. [Pi alignment](pi-alignment.md#provider-integration) records
the provider-specific controls. Blind proof inputs remain statement-only.

Pi roles other than ChatGPT Web recover transient response failures through Pi's `retryAssistantCall`,
with at most eight retries per response and exponential backoff starting at one
second, capped by Pi at one minute. Recovery retains the same session, successful
messages, tool results, and private submissions. Each retry consumes another
provider-call admission and records any reported usage. Failed responses do not
consume the completed-response allowance. Completed encrypted reasoning from
OpenAI Responses and Codex Responses survives an interrupted response. Failed
text, unfinished reasoning, and tool calls are omitted from the retry input.
Exhaustion, insufficient context, or refused admission fails the
invocation and publishes no partial mathematical result. This recovery is local
to a live invocation. Reopening after process death still restarts the worker.

Codex research uses developer instructions, JSON stdin, and an output schema.
Its source/review schema requires `correction`, with `null` meaning no edit;
the adapter omits that null in local verdicts. This follows OpenAI's
[strict structured-output contract](https://developers.openai.com/api/docs/guides/structured-outputs#all-fields-must-be-required).

Role invocations are intended to finish with room for a structured result.
Coordinator chooses subsequent work from committed notes and results, with
fresh context for each new invocation. Xean does not compact conversations;
Codex owns its internal execution as an opaque subprocess.

Before every Pi request, including requests following tool results, the pinned
Pi capacity estimator reserves the model's maximum output plus Pi's safety
margin. Oversized initial input fails before call admission. If Explorer has
already made valid submissions, approaching capacity ends that worker and
publishes its accumulated notes atomically. A truncated response fails the worker
without another automatic request. Pi blocks tools from that response.
An invocation with no valid result reports failure, so incomplete output cannot
become a published result merely because context is running short.
This also applies when a Coordinator note read leaves insufficient room for its
next request: the invocation fails, and a Coordinator failure blocks the campaign.
The estimate is conservative, and Codex Responses does not enforce an output
token cap on the wire. An oversized task and complete note index require a
larger-context model. No mathematical text is silently truncated,
and this adds neither a spending budget nor private checkpoint recovery.

Codex implements literature, source verification, and independent full-proof
review. It owns the search and reading tools used inside those functions. Pi
runs Coordinator, Explorer, correctness, requirements, statement extraction,
proof, and reconstruction.
When correctness explicitly lists no external premise, the source check records
PASS without invoking Codex. Correctness checks the scope and application of
task-granted assumptions and omits them from external premises. Source checks
also receive the exact task, so any remaining task-granted premise can be
established from that input.

The optional `research` object configures Codex. Omission uses `gpt-6-astra`
with `max` reasoning.
Codex starts only when a research function needs it. Literature remains an
optional scheduling choice, disabled by default.
Literature answers its supplied query and stops when the relevant evidence is
established. It returns only useful new theorem notes, or an empty list when
there is no useful new result. It records citations in ordinary note text without
a mandatory bibliographic schema or a Xean web-action cap. Citation typos alone do not fail
otherwise checked mathematics.

The Codex role calls `codex exec` through Execa with `web_search="live"`, a read-only
sandbox, structured output, and a temporary working directory. Research disables
the native shell with `features.shell_tool=false`. The selected Codex runtime,
model, and provider must expose native web search. Qualify the exact command and
profile with a source check that opens a primary source. Successful startup alone
does not establish retrieval. See the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Custom providers that implement Codex's standalone search endpoint need
`supports_standalone_web_search=true` in their native provider configuration
for Responses Lite models.
Codex reads its own configuration and login. Xean does not parse configuration, copy credentials,
or manage Codex sessions. An optional `profile` selects a native Codex profile.
The invoking environment and Codex configuration are trusted role inputs. Use a
dedicated `CODEX_HOME` or profile when the role needs different tools or settings.
Project-document loading is disabled for this research invocation. Cancellation
uses Execa to kill the owned process group, and temporary request files are
removed after execution. The kernel sees only the role's eventual result or failure.

Codex source and review results are labeled `kind: "codex-report"`, with an
operation ID, report time, and exact `premises`, using the `ResearchReport` type.
Fresh passages retain their reported URLs and quotations, an ID derived from
the original operation, and the original premise as `statement`. Codex's JSONL records web activity but
does not reliably expose page contents or opened URLs. Fresh external passages
require completed native `web_search` items in that invocation. Arbitrary tool
calls do not establish web activity. A task-granted premise instead uses
`url: "urn:xean:task"` with an exact quotation from the supplied problem or
completion criteria, checked against the current task even when reused. Codex
must distinguish granted assumptions from requested conclusions or assertions
made only in notes. Every premise needs valid passage coverage.

Verifier input may include `evidence` projected from source PASS results on
established live notes. This freezes available quotations with the worker's
other inputs. Earlier completed checks within that worker also provide evidence.
For each new source assessment, Codex must check the exact hypotheses, conclusion,
variant, and application. It can return `{premise, passageId}` to reuse a supplied
quotation or `{premise, url, quote}` for a fresh retrieval. Binding resolves IDs
only against that invocation's evidence and preserves the original quotation and
statement. Unknown references or missing coverage downgrade PASS to INCONCLUSIVE.
Other valid passages are retained even when one reference is invalid.
Codex assesses supplied evidence first. When it establishes every premise, the
source call returns without web activity. Retrieval addresses only missing
evidence, and stops once that gap is settled. Every application still needs a
new applicability verdict. Previous corrections are excluded from evidence.
Independent review receives no solver evidence and its schema requires fresh
passages for external premises. Quotation accuracy remains a model judgment,
and reuse retains `codex-report` provenance rather than host-retrieved page text.

The shared call recorder preserves the Codex request, selected profile, usage
tag, raw stdout/stderr, and native usage fields, including after an invalid answer or
cancellation. A Codex invocation consumes one logical call admission. Its internal
model requests and web actions are opaque to that limit. The role-owned `askCodex`
function handles admission, execution, output validation, and settlement. The process
receipt stores `exitCode`, `failed`, and `isCanceled` alongside stdout/stderr.
Native token fields
remain distinct from Pi's usage structure, and no price is invented.

The [verification procedure](kernel-smoke.md) separates execution and accounting
checks from evidence about difficult mathematical judgments.

### Closed-book experiments

The [bounded runner](../scripts/bounded-solve.ts) accepts
`RUN_DIRECTORY --offline` with literature disabled (the default). This
disables literature, online review, and source retrieval. Correctness checks may
establish standard background permitted by the task after assessing its exact
statement, hypotheses, and application. Forbidden black boxes remain defects.
Uncertain or otherwise unresolved external premises stay INCONCLUSIVE until
proved in notes. This uses the existing correctness batch and adds no model call.
Mathematical roles have no browsing, shell, or filesystem tools. Model inference
still uses the configured endpoint.

These campaigns use `xean.solve.offline` and require the same runner and flag
when reopening. The ordinary CLI rejects that declaration. The
[experiment protocol](steinitz-run.md) keeps round allowances private to the
runner and operators, with no remaining-round information in role inputs.
The bounded runner publishes observation snapshots and serves the CLI's live
owner control. Guidance, note submissions, and lifecycle commands reach the
active owner. Round allowances remain an outer-runner setting.

## Running

Commander 15.0.0 supplies argument validation and help. Use `xean --help` or
`xean <command> --help` for the command's arguments and options.

After [installation](../README.md#install-and-run), use `bun run xean` from the
source checkout. For example:

```sh
bun run xean init TASK.json tree SETTINGS.json
bun run xean run tree
bun run xean guide tree GUIDANCE.txt --id next-route
bun run xean status tree
bun run xean export tree
```

On Fleet, run from the adjacent Fleet Infra checkout with its locked Bun:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts init TASK.json tree SETTINGS.json
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts run tree
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts status tree
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts pause tree
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts resume tree
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts cancel tree
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts inspect tree
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts inspect tree --records
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts export tree
```

Every campaign argument accepts either a name or an explicit SQLite path. Names
contain only ASCII letters, digits, underscores, or hyphens; `tree` selects
`./.xean/tree/campaign.sqlite`. Put `--campaign-dir DIR` before the subcommand to
change the campaign root. An absolute path, a path containing a separator, or a
name ending in `.sqlite` or `.db` selects a database directly. Paths are relative
to the calling directory, including the default `.xean` root.

`init TASK CAMPAIGN SETTINGS` creates the frozen campaign declaration and initial
state without model calls. `run CAMPAIGN` opens that campaign, uses its stored
task and settings, and prints its state and notes as JSON. Only
`campaign.status: "completed"` means an accepted argument. `export` prints the
accepted argument with all its supporting proofs. Initialization, inspection,
export, offline input commands, and reopening completed work do not construct
the Pi model runtime. `inspect`, `status`, and `export` use independent read-only
database connections, including while a campaign is running. `inspect --records`
returns campaign state and journal records from the same SQLite snapshot.
`status` uses the same coherent snapshot for a shorter JSON report: campaign
state, work counts, pending signals, note progress, call allowance, and usage by
provider/model/API. Native numeric usage fields retain their names; overlapping
fields are not combined into a new token total. Settled calls without counts and
unsettled calls are counted separately. Price estimates and complete provider-bill
reconciliation are outside this report.

`pause` stops new admission and waits for admitted work to finish. `run` leaves a
paused campaign paused; use `resume` to continue it. `cancel` interrupts active
work and prevents late publication. All three lifecycle commands accept
`--records`. Offline `resume` owns execution and accepts `--key-stdin`; live
`resume` waits for the active owner's execution and uses its credentials. An
accepted resume keeps the owner socket available for lifecycle and input commands.
Responses lost after submission are not automatically replayed. Terminal campaigns
cannot be resumed; `run` reopens completed results without executing work.

Opening an interrupted campaign for execution or mutation performs the kernel's
normal attempt recovery and can write recovery records. Read-only inspection
preserves the interrupted state. The active owner holds a separate ownership lock
that permits database readers. `export` requires an accepted argument.

Supply credentials through the provider's normal environment variables, a
profile's `apiKeyEnv`, or `--key-stdin`. Credential values are never settings.
When the fleet CA is installed, the CLI launches the same locked Bun with that
CA so the direct command can reach the lab services.
The codex-lb smoke launcher reads its key from OpenBao and supplies the fleet CA
to the child runtime:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/scripts/solver-smoke.ts codex-lb/xean
```

It initializes without model calls, then runs the tree edge-count task with
Luna at max reasoning and forty logical calls. It saves
the campaign and accepted argument under ignored `runs/`, then reopens without
a credential and checks that no work or records change. The failed-attempt
artifacts are also retained.

## External notes, guidance, and corrections

The same commands work while `run` owns a campaign and while it is offline:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts submit CAMPAIGN.sqlite NOTES.json --id supplied-lemma
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts guide CAMPAIGN.sqlite GUIDANCE.txt --id focus
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts correct CAMPAIGN.sqlite CORRECTION.json --id fix-wording
```

`--id` is required and contains 1–128 ASCII letters, digits, underscores, or
hyphens. Each command prints its committed `{id, key, value}` receipt. Retrying
the same command ID with identical content returns the original receipt, even
after the campaign ends. Reusing an ID with different content is rejected.
New commands are rejected for terminal or blocked campaigns, after the call
cap is reached. Exact keyed retries
still return their existing receipts. Only solver campaigns accept these commands.

`NOTES.json` contains note drafts and a candidate flag:

```json
{
  "notes": [
    {
      "id": "n1",
      "summary": "Base case",
      "detailedSummary": "A one-vertex tree has zero edges, establishing the base case.",
      "text": "A tree with one vertex has no edges.",
      "support": []
    }
  ],
  "candidate": false
}
```

The batch must contain at least one note. Local IDs use `n1`, `n2`, and so on.
Support may name existing nondead notes or earlier notes in the same batch.
Duplicate, missing, dead, and forward dependencies are rejected. The example
creates `input/supplied-lemma/n1`, verified at revision zero. All notes supplied
through `submit` are trusted for correctness and sources. Their declared support
must also be verified before they become verified, and recorded failures still
invalidate them and their dependents. Explorer and literature results receive
their normal checks.

Projection records `imported: true` from the accepted input receipt. The note's
`passed` summary includes correctness and source, so verification skips those
stages. Its `checks` retain only actual verifier results. No model PASS or source
quotation is invented, and exported check records identify imported notes.
`candidate: true` claims that the final note solves the exact task. Requirements
and reconstruction must pass before an imported candidate can complete the
campaign. Harmless corrections preserve the note's imported status.

`GUIDANCE.txt` contains nonblank text for Coordinator. Guidance is retained in
receipt order, and later instructions can revise earlier ones. Coordinator sees
that history when choosing work. The default Coordinator waits for active and
queued work before planning another group, so guidance does not interrupt
workers already running.

`CORRECTION.json` names a note and its current revision:

```json
{
  "note": "input/supplied-lemma/n1",
  "revision": 0,
  "summary": "Base case",
  "detailedSummary": "A one-vertex tree has zero edges, establishing the base case.",
  "text": "A tree on one vertex has no edges."
}
```

All three content fields are required so displayed summaries stay consistent with
the full text. The accepted correction increments the revision and preserves all checks. A stale revision is rejected. This
operation trusts the editor to make only typography, formatting, or unambiguous
notation corrections that need no verifier. It cannot change `support`.
Substantive mathematical edits must be submitted as new notes.

Commands are validated and committed by the active owner through its local Unix
socket. With no active owner, the CLI takes database ownership, records the
command, and exits without running workers or making model calls. An owner
rejection is returned to the caller. The CLI does not fall back to opening an
already-owned database after a rejection.
Socket paths use a private per-user directory under `/tmp`, independent of
`TMPDIR`. SIGINT and SIGTERM abort incomplete request bodies, drain admitted
command handlers, and interrupt worker execution. An interrupted run closes
without printing final JSON. Use `inspect CAMPAIGN` afterward to report the
committed state; inspection does not resume or recover execution.

All accepted commands are visible immediately in campaign views and inspection,
even while their Coordinator signals are pending. Historical views retain input
receipt IDs, and running workers retain their frozen requests. Later workers
see corrected text and new notes. Completion is deferred while another
Coordinator signal is pending, including worker results, accepted inputs, and
call grants. Receipt acceptance records the command, not a promise that
Coordinator will follow guidance or verify a submitted note next.

Library callers use `readCommand`, `submitCommand`, and the solver's
`validateInput` callback. These share the CLI's validation and projection rules.
`submitCommand` validates values strictly without type conversion. Direct
`engine.input()` calls must also pass normalized JSON.

To add calls to an existing finite allowance:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts extend CAMPAIGN.sqlite 20 --id extra-round
```

The command uses the active owner's control socket or records the grant
offline. It returns a keyed receipt, so an exact retry grants nothing twice.
The added count must be a positive safe integer, and an already unlimited
campaign needs no grant.
`Campaign.callAllowance` reports the effective cap while the original settings
stay frozen. A call-limited campaign returns to `running` with its queued work
preserved. The grant gives Coordinator a fresh signal but does not itself call
`run()`. Offline campaigns continue with `run CAMPAIGN`.
Paused campaigns stay paused. Blocked campaigns retain their Coordinator failure
and require explicit `resume CAMPAIGN` after the grant. Cancelled and completed
campaigns reject new grants.

## Configuration and functions

[The settings example](../examples/solver-settings.json) uses Astra through
the public OpenAI API and its `OPENAI_API_KEY` environment variable.
`profiles.default` supplies the shared Pi profile. Override `explorer`, `editor`,
`coordinator`, `correctness`, `requirements`, `statement`, `proof`, or `reconstruction`
with a complete `{provider, model, reasoning?}` profile. Omitted reasoning uses
`max` for Pi roles and Codex research. Explicit effort overrides remain supported.
`ProfileName` and `profileNames` name these model-configuration slots. The
Verifier uses several profiles within one role invocation.
Optional fields are `baseUrl`, `apiKeyEnv`, `transport`, and `contextWindow`.
`contextWindow` selects a supported total context size for that endpoint when it
differs from Pi's catalog default. It changes the local capacity estimate, not
the provider's limits. Xean still reserves the model's maximum output and Pi's
safety margin. The example uses the public Astra API's documented 1,050,000-token
window. Gateways and subscription providers may support a different maximum.
Endpoint URLs cannot
contain credentials, query parameters, or fragments. The CLI supports
Pi's OpenAI, Codex, Anthropic, ChatGPT Web, and Claude Code providers. Library callers supply their own
native Pi `Models` collection and model objects for other providers.
Explicit Codex endpoints on `chatgpt.com` and its subdomains retain native
authentication. Custom hosts enable proxy authentication.

To use a local Claude subscription, select Opus 5.5:

```json
{
  "provider": "claude-code",
  "model": "claude-opus-5-5",
  "reasoning": "max"
}
```

Use this profile for `explorer` to develop proofs, or for `correctness`,
`requirements`, `statement`, `proof`, and `reconstruction` to select mathematical
checks. It also works as `profiles.default`. Research and independent source
review retain their separately configured Codex backend.

Install and log in to Claude Code on the executing machine. `claude auth status`
must report a first-party Claude subscription. The provider uses that login through
the pinned `pi-claude-code-provider` package's non-interactive transport. Set
`PI_CLAUDE_CODE_PROVIDER_PATH` if `claude` is outside `PATH`. Omit `baseUrl`,
`apiKeyEnv`, and `transport` for this provider. Shared gateway credentials are
not forwarded.

Pi executes the requested tools. The maintained bridge proposes calls through a
request-owned subprocess and cleans up the Claude process and temporary state.
Each request carries the current Pi transcript. The provider reports token usage
when available and sets monetary cost to zero because API prices do not describe
subscription billing. Claude subscription capacity is still consumed. Library
callers can register `claudeCodeProvider` from `xean/pi` with
`models.setProvider()`.

To use the existing Explorer with ChatGPT Pro, select its browser provider:

```json
{
  "provider": "codex-chatgpt-web",
  "model": "chatgpt-web/gpt-6-pro",
  "reasoning": "max",
  "baseUrl": "http://127.0.0.1:17841/v1"
}
```

Put this in `profiles.explorer`. The adapter derives a structured response
schema from every tool declared by Pi, including each name, description, and
argument schema. ChatGPT returns text and a list of selected calls. The adapter
validates the whole response without coercion and emits native Pi tool calls.
Pi executes the tools, applies limits, and supplies results on the next turn.
This supports arbitrary caller tools, including Explorer's `read_notes` and
`submit_result`, without role-specific behavior in the provider. An empty call
list permits a final text answer. Images remain unsupported.
`toolChoice: "none"` requests ordinary text. Each request carries the complete
transcript, including earlier results and validation feedback.

Each outer tool round sends another browser request and can consume another
ChatGPT Pro allowance. General tool support does not make these round trips
quota-free. For scarce Pro usage, prepare the full context before one mathematical
request instead of using this provider for an iterative Explorer tool loop.

The Responses bridge owns browser login and model selection. Its JSON-schema
responses must preserve the native answer source. The tested codex-chatgpt-web
build includes that extraction fix. `baseUrl` defaults to the address above on
the executing machine. Set `apiKeyEnv` if the bridge requires a key. Shared
gateway keys are not forwarded to this provider. Browser token counts remain
estimates and recorded measured usage is null. Requests use SSE and max
reasoning. Automatic replay is disabled because a disconnected request may
already be running.

The provider follows Explorer's no-search instructions but cannot enforce
disabling ChatGPT-native retrieval. It is not qualified for enforced
closed-book experiments. Library callers can register `chatGptWebProvider`
from `xean/pi` directly with Pi's `models.setProvider()`.

`maxExplorerReads` is a positive safe integer and defaults to four.
`maxExplorerResponses` is a positive safe integer and defaults to
`maxExplorerReads + 4`. An explicit response limit overrides that default.
The [read contract](#roles-and-acceptance) defines admission and the final-response
restriction. `literature` defaults to false. `limits`
uses the kernel's concurrency, attempts, and logical provider calls. Campaigns,
roles, experiments, and smoke runs have no added wall-clock deadlines. Existing
provider timeouts remain in place and are tuned from observed provider data.
Token and dollar budgets remain out of scope. Set `usagePrefix` to a
unique campaign label when using codex-lb. The frozen settings retain it, and each
call appends the kernel attempt ID. The smoke assigns a timestamped prefix.
Configuration and library entry points share bounded integer schemas for limits,
call grants, and Explorer read and response counts. Settings, declarations, and
commands are validated strictly, without converting strings or truncating numbers.

Install and authenticate the Codex CLI for research. To configure its model and
reasoning, add:

```json
{
  "research": {
    "model": "gpt-6-astra",
    "reasoning": "max"
  }
}
```

The `research` object requires `model` when present. Its optional `command`
selects another executable or launcher. Relative launcher paths resolve against
the calling directory before execution enters its temporary directory; bare
command names use `PATH`. The optional `profile` selects
a native Codex profile. Codex resolves login and provider settings normally from
`CODEX_HOME` or `~/.codex`. Ordinary Pi role credentials remain separate.
Current Codex profiles use `$CODEX_HOME/NAME.config.toml` with top-level settings.
The retired `[profiles.NAME]` layout is rejected by the deployed CLI. Follow the
[native profile documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles)
and smoke-test the configured research path before a long run.

With `usagePrefix`, the role sets `XEAN_CODEX_USAGE_TAG` to the recorded attempt
tag. Configure the native gateway provider to forward it. Xean does not rewrite
provider configuration. For a provider named `gateway`, the nonsecret settings are:

```toml
[model_providers.gateway.env_http_headers]
X-Codex-LB-Usage-Tag = "XEAN_CODEX_USAGE_TAG"

[model_providers.gateway.http_headers]
X-Codex-LB-Required-Capability = "usage_tag_v1"
```

The `xean/solve` export provides `createSolver`, `createRoles`, the native Pi
runtime configuration, and note projection. Roles remain ordinary functions.
The selected `Research` implementation declares its `retrieval` capability.
Coordinator sees whether source retrieval and literature are available. A
disabled external capability cannot be delegated to Explorer. Its reader
only accesses internal frozen notes. Codex failures expose stderr as their
diagnostic, while the journal retains the complete process output.
`createSolver` and `campaignOptions` accept either a `PiRuntime` or a factory
`() => PiRuntime`. A supplied factory runs once, on the first role invocation.
Opening, inspecting, validating commands, and exporting committed work do not
invoke it.
`createSolver` returns kernel options whose `task` is a versioned solver
declaration. Its `task.task` holds the mathematical task. Direct library campaigns
therefore enforce the same format boundary as CLI campaigns when reopened or
projected. Keep older campaigns on their original runtime.

### Replacing implementations

Library callers can replace implementations before opening a campaign:

| Replace                                                 | Public entry point                                                                        | What remains built in                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Explorer, Verifier, literature                          | Assign `solver.functions.explorer`, `.verifier`, or `.literature` after `createSolver`    | Group scheduling, publication, note projection, and acceptance                         |
| Editing and corpus review                               | Assign `solver.functions.editor` or `.editionReview` after `createSolver`                 | Exclusive editing, verification, repair scheduling, and corpus activation              |
| Planning                                                | Assign `solver.functions.coordinator`, accepting `CoordinationInput` and returning `Plan` | Signal handling and group scheduling                                                   |
| Signal handling and scheduling                          | Supply `XeanOptions.coordinator`                                                          | Kernel admission, durable publication, lifecycle, and the selected acceptance callback |
| Literature, source checking, independent review backend | Supply a `Research` object or factory to `createSolver`                                   | Built-in role procedures                                                               |
| Models and providers                                    | Supply `PiRuntime` profiles and native Pi providers                                       | Built-in role procedures                                                               |
| Standalone reconstruction or review                     | Call or replace `.reconstruct` or `.review` on the returned function set                  | Kernel publication when wrapped as a role                                              |

Replacing a planning function also replaces its validation policy, including the
single-Explorer restriction. Replacement functions are trusted code and must
honor their exported input/output types and mathematical contracts. A custom
Verifier supplies the evidence consumed by the solver's acceptance guard.
The solver still enforces editing availability and exclusive scheduling when
planning is replaced.

Individual correctness, requirements, extraction, proof, and comparison
procedures inside the built-in Verifier are fixed. Their model profiles are
replaceable. To change those procedures, supply a complete Verifier. Replacing
the standalone `.reconstruct` function does not change the reconstruction called
inside the built-in Verifier.

Choose replacements before `Xean.open` and keep them fixed for the campaign.
The Coordinator's name is part of the stored identity, but arbitrary replacement
function bodies are not serialized or fingerprinted. Retain the implementation
source with the campaign. The CLI selects the built-in implementation and has no
plugin loader or live implementation swapping.

Standalone execution invokes those same functions:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts role explorer INPUT.json ROLE.sqlite SETTINGS.json
```

The role name may also be `coordinator`, `verifier`, `reconstruct`, `literature`,
`editor`, or `editionReview`. Its input
uses the exported TypeScript contract and includes `task`. A completed standalone
role campaign records successful execution, not acceptance of a mathematical
solution. Solver acceptance, a separate review of the full proof, and catalog
closure remain distinct.

`reconstruct` takes `ReconstructionInput`: `{task, notes, targets: string[]}`.
It uses the same function as final verification and returns reconstruction checks
for any selected set and its generated dependencies. All supplied targets and
their support must already be verified for correctness and sources. It does not
run the requirements check, so intermediate lemmas can be reconstructed without
claiming to solve the original task. The library exposes this operation as
`solver.functions.reconstruct` and `createRoles(...).reconstruct`.

### Corpus editing

Editor rewrites a frozen corpus into fewer or simpler ordinary notes. It
receives every full note, its status, and verification feedback, combines related results, replaces
proofs, and removes obsolete intermediate scaffolding. The replacement should
retain useful results, hypotheses, bounds, counterexamples, limitations, and
unresolved gaps needed to continue the exact task. It need not retain each old
lemma or supply a one-to-one correspondence between old and new notes.

Run an explicit editing campaign with the locked runtime:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts edit CORPUS.json EDITED.sqlite SETTINGS.json
```

`CORPUS.json` contains `{task, notes}`. `notes` may contain the entire projected
corpus or a selected subset with all transitive support, including full texts,
import provenance, revisions, and checks from `project()` or solver inspection.
Every supplied note is within the editing scope, including supporting notes.
Library callers use
`createEditor({task, notes}, runtime, settings?, research?)` and open its
returned kernel options through `Xean.open`. Runtime construction stays lazy.
Standalone review covers only the supplied corpus. Its `deprecated` IDs describe
that snapshot. Before removing them from a larger corpus, callers must preserve
any support still required by notes outside the selection. Integrated editing
currently replaces the whole active corpus.

To let Coordinator request editing during a solver campaign, set:

```json
{ "editingThresholdTokens": 200000 }
```

Omitted or `null` disables Coordinator-directed editing. A positive safe integer
enables it and suggests editing once the active corpus reaches that estimate.
The example settings use 200,000. Coordinator may defer editing or choose it
earlier when useful. The threshold is not a token budget or a context-fit check.

Every ordinary planning input contains `corpus: {noteCount, estimatedTokens}`.
The library calculates it from the latest committed full notes, including both
summaries, text, support, and checks. Failed notes remain included while readable
in the active corpus. Deprecated editions, private proposals, and execution
history are excluded. Pi estimates tokens from serialized text length divided
by four. These are approximate corpus sizes, not measured provider usage.
Statistics require no additional model call or stored counter. Library callers
can obtain the same values with `corpusStats(project(view))`.

An `{"kind":"editor"}` request runs alone after the current worker group drains.
The first worker freezes the current corpus. During editing, `submit` and
`correct` commands are rejected for retry afterward, while guidance remains
available. A mutation committed while Coordinator was still planning makes that
editing snapshot stale, so it cannot replace the changed corpus.

The deterministic Coordinator runs the following loop without planning calls:

1. Editor proposes `{notes, retained, report}`. New notes use the ordinary
   draft schema and receive fresh identities and checks. `retained` names notes
   kept unchanged, with their support retained automatically. It may reuse
   verified notes from a previous proposal. New proofs can depend only on those
   retained notes and earlier new notes. Removed notes remain provenance, not
   hidden mathematical premises.
2. The existing Verifier checks every proposed note through correctness and
   sources, reusing checks on unchanged notes. Failed or unresolved proposals go
   back to Editor with their recorded checks. Mathematical repairs use new IDs, and the
   permanent source-verdict rule remains in effect.
3. `editionReview` compares the whole old and new corpora after every new
   note is verified. It checks useful coverage, meaningful consolidation,
   claims of supersession, and independence from removed proofs. It allows
   obsolete lemmas to disappear. FAIL or INCONCLUSIVE returns to Editor.
4. A passing review completes standalone editing with
   `{notes, deprecated, review}`. `notes` is the checked replacement revision.
   `deprecated` lists original IDs absent from it. The original snapshot and
   every proposal/check remain in the durable records. Reopening a completed
   campaign reuses its result.

The Editor has an `editor` model profile. Corpus review reuses the
`requirements` profile with its own instructions and corpus input. It checks
whether the replacement is adequate for continued research, not whether the
original research task is solved. Editing does not grant requirements or
reconstruction PASS to notes. Exact-task acceptance still uses the normal solver
checks. Independent reconstruction remains available as a separate operation.

In a solver campaign, the passing review activates the entire checked
replacement in one publication. Ordinary planning resumes with its refreshed
corpus statistics. Re-editing an unchanged successful edition is disabled until
the corpus changes. Original notes remain historical, with their identities and
checks intact. Deprecation does not mark a note mathematically dead.

Proposals stay outside the active corpus until approval. Committed checks on
retained original IDs apply immediately even if the replacement is abandoned,
preserving the final source-verdict rule. Operational editing failures return to
ordinary planning with their diagnostic. A call cap retains the editing phase
and committed progress for an explicit allowance extension. Standalone editing
uses the same loop and returns its checked revision to the caller.

Each editing proposal and review currently receives complete input in one
model context and returns one complete result. Use models whose context and
output capacity fit the corpus. Capacity errors retain prior committed work and
never truncate proofs. Automatic partitioning is not implemented. Existing
campaign call limits, extension, pause, cancellation, and whole-worker recovery
apply. The loop has no arbitrary wall-clock deadline. Model-based corpus review
is a judgment of usefulness and coverage, not a formal losslessness guarantee.

Editor and corpus review use the same full-text view as `read_notes`: IDs, both
summaries, complete texts, support, status, passed stages, and feedback on failed
or unresolved checks.
The frozen worker inputs retain every check and source quotation. Verifier uses
that complete evidence, while the reading view omits its audit records. No note
text is shortened or omitted.

Each Editor pass uses Pi's existing structured-result call with the full original
corpus. Repair passes also receive the previous proposal and the last corpus review.
There is no separate feedback digest, retrieval tool, or recursive editing runtime.
Corpus review returns only a verdict and report.

An independent Codex review consumes the exact task and the full exported
argument, without solver verdicts:

```sh
bin/fleet-nix run .#fleet-run -- ../xean/packages/cli/src/index.ts review TASK.json ARGUMENT.md REVIEW.sqlite SETTINGS.json
```

The review records PASS, FAIL, or INCONCLUSIVE in its own campaign. A completed
review means execution finished, including when its verdict is FAIL. It does not
change the solver's acceptance record. Repeating the exact completed review
makes no calls. External premises require the same web activity and passage
coverage as source verification.

The library is in `packages/core`, and `xean-cli` is in `packages/cli`. The CLI
uses public declaration/loading and campaign APIs. Distribution uses the complete
source checkout, including the dependency-installation check, lockfile, and
vendored packages. Individual workspace packages remain private. Campaign declarations
carry the [solver format version](../packages/core/src/solve/contracts.ts), with
distinct solver, standalone-role, editing, and review kinds. Only the current
declaration is supported. Historical declarations retain their original runtime
and are not read, rewritten, or migrated by this CLI. The
[kernel storage contract](kernel.md#sqlite-ownership-and-durability) defines the
campaign format. A read-only artifact reader remains future work.

Private checkpoints remain deferred. An interrupted composite verifier may repeat
its unpublished calls. Completed worker results and checks survive restart.

## Current verification

Use the [development check](../README.md#development-on-fleet) and
[provider smoke procedure](kernel-smoke.md#live-provider-checks) for the current
candidate. The suite exercises source-verdict finality, conditional dependency
checks, imported support, correction races, batch identity, and reconstruction
throughout the generated dependency chain. Editing checks cover atomic activation,
stale snapshots, failures, and continuation after a call-cap extension.

Historical mathematical benchmarks and provider smokes retain their original
source, settings, and artifacts under local `runs/` directories. Earlier versions
of this guide record those observations in Git. They are not bundled with a
release and do not establish verification of a later source revision.
