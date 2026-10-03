# Mathematical solver

Xean's solver runs Explorer, Coordinator, verification, and optional literature
and Codex workers over the existing kernel. The task contains only `problem`
and `completionCriteria`.
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
  Notes should help continue the exact task. Task-permitted background may be
  reused with its hypotheses stated and uncertain claims or sources flagged for
  checking. Background proofs are useful when they advance that task.
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
- Verifier requests select a stopping stage: `correctness`, `source`,
  `requirements`, or `reconstruction`. Each stage checks multiple notes in one
  model request and returns a verdict per note. Dependencies must pass correctness
  and source before a target becomes verified. Caller-imported notes establish
  those stages by trust. Completed PASS checks and imported trust are reused.
  A request may establish outstanding dependencies even when the target's own
  requested stages are already satisfied.
- Literature is optional and disabled by default. It can complete once per
  campaign and returns ordinary unverified notes, including useful source
  mismatches and bounded unsuccessful searches with their remaining uncertainty.
  An unsuccessful search does not establish that a theorem does not exist. Coordinator may retry
  failed literature workers. When enabled, it requests a specific external theorem
  or source gap, rather than a general survey. Task-granted assumptions and
  self-contained arguments need no survey. The startup setting remains the
  authority for availability. This search limit belongs to the built-in Coordinator.
- The optional [Codex worker](#codex-worker) implements assignments with native
  shell and file tools. Coordinator supplies the assignment and selects note IDs.
  Mathematical reasoning remains Explorer's job. Codex is used sparingly for
  concrete implementation requirements with specified inputs, outputs, constraints,
  and checks, supplied directly or through the selected notes.
  The worker returns ordinary unverified notes and may nominate a candidate.
  It chooses its own implementation and tools.

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
For supporting lemmas and partial results, Coordinator normally stops at
`source`. It targets a claimed complete solution through `reconstruction` for
final acceptance. Supporting lemmas are reconstructed as dependencies, without
separate requirements checks asking each lemma to solve the whole task.
Correctness judges supporting and partial claims on their own terms. A cited
theorem note can pass conditionally on source verification without reproducing
its external proof. Requirements alone checks the original completion criteria.
Correctness checks the hypotheses of established support at each application
without asking source verification to establish the same supporting result again.
Its `premises` array contains exact standalone external claims that still require
source checking, with complete hypotheses, definitions, and qualifications.
Source names and citations are allowed. Proof ideas, application explanations,
and validation commentary belong in the existing `report`, not in a premise.
Substantive algorithmic guarantees remain part of the claim. Source verification
and independent review use the same field name. Ordinary notes remain free-form
research records, including failed approaches, experiments, and partial results.

Correctness checks dependent reasoning conditionally on declared support, even
when that support is checked in the same batch. A failed dependency invalidates
its dependents; an inconclusive dependency blocks their verification and acceptance.
Source checking combines notes with external premises into one Codex invocation;
notes without external premises pass that stage without a call. Requirements
checks only verified notes and receives their recorded source verdicts and bound
evidence, or explicit caller-import trust. Historical prose about awaiting
validation cannot override those records. Source PASS does not establish stronger
claims or unrelated completion criteria, and caller import alone does not satisfy
an explicit retrieval requirement. Missing, duplicate, or unexpected result IDs reject
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
For an imported candidate that relies on external theorems beyond the task's
granted assumptions or permitted background, import those theorems as supporting
notes and declare the support links. Imported notes skip correctness
and its premise extraction, so blind reconstruction receives those assumptions
through declared support.

Source checking assesses these exact premise strings and their suitability for
blind reuse before approving them. This is also the contract for custom research
implementations. Code carries the approved strings unchanged through extraction,
proof, judgment, and reuse. The extractor returns only the note's claim and has
no premise field to change. There is no second normalized premise list.
Code guarantees unchanged text; source checking and comparison judge its
suitability for blind reuse.
Extracted statements, proofs, verifier reports, and premises reject non-whitespace
ASCII control characters through schema validation. Invalid Pi tool submissions
can be corrected within the existing invocation allowance. Text is never stripped
or repaired by guessing mathematical symbols.
Contaminated or ambiguous premise wording gives INCONCLUSIVE at source checking;
a concrete mathematical mismatch still gives FAIL. Later evidence or repaired
wording requires a new note, following source-verdict finality.

The blind prover receives the task, extracted statements, permitted premises,
and dependency links. Original proofs, index and detailed summaries, and verifier reports are
withheld. Each proof may use only its declared transitive support and permitted
background. Shared dependencies appear once. Previously checked descendants
are excluded when retrying an unresolved ancestor.

One comparison call checks statement fidelity and both arguments for each
pending note, including the assumptions used. Supporting lemmas need only prove
their own claims. Requirements alone checks the original completion criteria.
The judge receives the original premise strings and their recorded source PASS
with its operation ID when available, or explicit caller-import trust. Those
external claims are permitted assumptions at this stage. Stale prose about
awaiting validation cannot reopen their source status. The judge still checks
exact hypotheses, applicability, and every new proof step. Source PASS never
permits a stronger claim or hides a proof defect. Proof hints discovered in a
supplied premise make reconstruction inconclusive without rewriting that
premise or reopening its source verdict.
An incomplete or incorrect independent proof, or an unfaithful extraction, gives
INCONCLUSIVE unless the original argument has a concrete defect. Successful
checks retain the statement and proof for reuse. Permitted premises always come
from the note's original assessment. A conditional PASS
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
Mathematical verification receives both summaries alongside the full text and
checks their consistency. The independent prover still receives only extracted
statements and permitted premises.
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
Neither role exposes the reader when its frozen index is empty. Private
Explorer submissions remain in its conversation, not in the reader's published
snapshot, and must not be requested by their local IDs.

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
reader has no per-invocation read allowance. An empty frozen index gives Explorer
an effective read allowance of zero without changing its response allowance.

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
invalidates the note and its dependents. Requirements FAIL is final for that note
ID and leaves useful partial results available as support. Harmless corrections
preserve the rejection. A substantive repair requires a new note. Requirements
INCONCLUSIVE remains retryable. Reconstruction FAIL requires a defect in the candidate;
failure of the independent proof alone is INCONCLUSIVE.

Notes can receive harmless corrections through the command interface below.
The editor is trusted to preserve mathematical meaning. Corrections retain
checks and verification status, increment the revision, and leave dependencies
unchanged. A change to a claim, assumptions, argument, or dependencies requires
a new note. Original worker results and command receipts remain immutable.

A verdict may include `correction: {summary, detailedSummary, text}` containing
the complete note and consistent summaries with harmless edits. When the check
otherwise warrants PASS, a checker may restore a summary to the hypotheses,
conclusion, bounds, conditionality, and limitations already explicit in the
authoritative full text. For this repair it copies `text` exactly and explains
the mismatch in its report. Missing assumptions or proof steps in the full note,
and unmet task criteria, still require substantive work and cannot be repaired
through summary edits. This is the trusted checker's correction policy, not a
mechanical test of mathematical equivalence. Historical FAIL verdicts remain final.
Only the stage's final PASS applies a correction, including after any
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
`submit_result` tool. Explorer continuation stays in the same Pi conversation.
Each Pi verification stage has its own conversation, reused during recovery.
Prompts preserve Xean's exact-task, dependency, and independent-proof principles
in shorter form.
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
within an invocation that has a nonempty index and a provider that supports the reader.
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
Response recovery fails when retries are exhausted, admission is refused, or
retained reasoning leaves insufficient answer space. It publishes no partial
mathematical result on those failures. This response recovery
is local to a live invocation. Across process restarts, Pi resumes the role's
private conversation: completed generations and tool results remain in its
transcript, accepted submissions and consumed reads remain in its document, and
the response allowance is derived from the transcript. An interrupted request
may run again and requires a new call admission. ChatGPT Web fails before
resending an interrupted browser request.

Each Pi stage has a private conversation owned by the worker or Coordinator.
Reopening a composite verifier reuses successful Pi stages and resumes the
unfinished stage with its original input. A logical retry of a terminal failure
gets a fresh conversation. The worker still publishes one complete result and
one Coordinator signal together. Pi role functions require the execution context
supplied by a campaign. Standalone CLI role commands use this same path. Library
callers can use Pi's `MemoryStorage` for an ephemeral campaign; only persistent
storage survives process restarts. The verifier retains each validated source
batch in its task's native memo, keyed by the exact source input. This preserves
source evidence and later Pi stage identities on recovery. Interrupted Codex
subprocesses restart as whole calls.

Codex research uses developer instructions, JSON stdin, and an output schema.
Its source schema requires `correction`, with `null` meaning no edit.
The adapter omits that null in local verdicts. This follows OpenAI's
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
and no token or dollar budget is imposed.

Codex implements literature, source verification, and independent full-proof
review. It owns the search and reading tools used inside those functions. Pi
runs Coordinator, Explorer, correctness, requirements, statement extraction,
proof, and reconstruction.
When correctness explicitly lists no external premise, the source check records
PASS without invoking Codex. Correctness checks the scope and application of
task-granted assumptions and omits them from external premises. Source checks
also receive the exact task, so any remaining task-granted premise can be
established from that input.

The optional `research` object configures the backend. Omission selects Codex
with `gpt-6-astra` and `max` reasoning.
Codex starts only when a research function needs it. Literature remains an
optional scheduling choice, disabled by default.
Literature answers its supplied query and stops when the relevant evidence is
established. It returns only useful new theorem notes, or an empty list when
there is no useful new result. It records citations in ordinary note text without
a mandatory bibliographic schema or a Xean web-action cap. Citation typos alone do not fail
otherwise checked mathematics.

Research calls `codex exec` through Execa with
`web_search="live"`, a read-only sandbox, structured output, and a temporary
working directory. Research disables
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

### Codex worker

Configure `settings.codex` to enable the built-in Codex worker.
The assignment states the deliverable, input domain, expected output, constraints,
and checks. Selected notes can supply the exact specification:

```json
{
  "kind": "codex",
  "assignment": "Implement the construction specified in the selected note for n <= 6. Output a witness for each n and check every stated constraint independently. Retain the program, inputs, outputs, and rerun command.",
  "notes": ["w3-1/n1"]
}
```

The library freezes the exact task, assignment, and full selected notes with
their transitive support. An empty `notes` array is allowed. Dead notes remain
available for diagnosis and cannot supply mathematical support. The worker
uses the ordinary note schema and dependency validation. Its notes must state
the findings, relevant program and output evidence, reasoning, and limitations
needed for verification. Execution success supplies no mathematical verdict.

Each invocation creates a fresh retained directory below `codex.workspace`,
writes its frozen input to `input.json`, and runs Codex there with native shell
tools and the `workspace-write` sandbox. Native web search is disabled for this
role. Codex uses its native project-instruction loading and configuration for
its tools and execution environment. Literature, source checking, and review
retain their separate read-only invocation settings.

The result's `workspace` field and each full note record the artifact directory.
Artifact filenames and rerun commands belong in note text, while `support`
contains mathematical note IDs. Keep the artifact tree with the campaign and
restore its recorded paths when moving a run. Files remain external to SQLite:
verification reads the evidence in notes, and plain argument export includes
note text without collecting artifact files. Directories survive failed and
cancelled invocations too. Recovery starts a fresh directory and repeats the
whole worker under the [kernel recovery contract](kernel.md#results-and-execution-failures).

Operators provide any supervised tools needed for resource-heavy execution.
The worker is instructed to report missing facilities instead of launching heavy
work locally. Xean uses its existing admission, call accounting, cancellation,
and atomic note publication. Files and remote effects follow the kernel's
[external-effect contract](kernel.md#atomic-publication).

### Closed-book experiments

The [bounded runner](../scripts/bounded-solve.ts) accepts
`RUN_DIRECTORY --offline` with literature disabled (the default). This
disables literature, online review, and source retrieval. Correctness checks may
establish standard background permitted by the task after assessing its exact
statement, hypotheses, and application. Forbidden black boxes remain defects.
Uncertain or otherwise unresolved external premises stay INCONCLUSIVE until
proved in notes. This uses the existing correctness batch and adds no model call.
Mathematical roles have no browsing, shell, or filesystem tools. Model inference
still uses the configured endpoint. The runner rejects `settings.codex` and
ChatGPT Web Explorer because those paths do not enforce closed-book execution.

These campaigns use `xean.solve.offline` and require the same runner and flag
when reopening for execution. CLI inspection and accepted-argument export
support online, closed-book, and direct-library campaigns. The
[experiment protocol](steinitz-run.md) keeps round allowances private to the
runner and operators, with no remaining-round information in role inputs.
The bounded runner opts into the CLI's live owner control. Guidance, note
submissions, and lifecycle commands reach the active owner. Round allowances
remain an outer-runner setting. Observation is a separate application. Use its
[snapshot publisher](../packages/observe/README.md#snapshot-publishing) when a
remote dashboard needs live exports.

## Running

Use `bun run xean --help` or `bun run xean <command> --help` for the command's
arguments and options.

After [installation](../README.md#install-and-run), use `bun run xean` from the
source checkout. For example:

```sh
bun run xean doctor SETTINGS.json
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

`doctor SETTINGS` checks the installation receipt, settings and frozen model
names, provider credential availability, Codex executables, and permissions for
the campaign root and configured Codex workspace, using the nearest existing
parent when a directory has not been created. It returns `{ok, checks}` as JSON.
Each check has a `name`, `status` (`ok`, `error`, or `unchecked`), and `message`.
An error makes `ok` false and exits with status 1. Unchecked items do not fail
the command. Credential values remain private.
It creates no campaigns or probe files and makes no model or Codex requests.
It does not validate live credentials, browser sessions, or Codex login. Use the
[provider smoke procedure](kernel-smoke.md#live-provider-checks) to qualify those paths.

`init TASK CAMPAIGN SETTINGS` creates the frozen campaign declaration and initial
state without model calls. `run CAMPAIGN` opens that campaign, uses its stored
task and settings, and prints its state and notes as JSON. Only
`campaign.status: "completed"` means an accepted argument. `export` prints the
accepted argument with all its supporting proofs. Initialization, inspection,
export, offline input commands, and reopening completed work do not construct
the Pi model runtime. `inspect`, `status`, and `export` use independent read-only
database connections, including while a campaign is running. `inspect --records`
returns campaign state and journal records from the same SQLite snapshot.
`status` supplies the [compact report](#checking-status) from the same coherent
snapshot.

`export CAMPAIGN --bundle NEW_DIRECTORY` also writes an artifact bundle and keeps
the usual argument on stdout. The new directory contains `argument.md` with the
exact accepted text, `result.json` with the accepted result and its checks,
`manifest.json`, and a README. Only retained workspaces from completed workers
whose notes contribute to the accepted dependency chain are copied under
`artifacts/`. The manifest maps original paths to bundled paths and records file
hashes, sizes, and executable bits.

The destination must be new, have an existing parent directory, and sit outside
the copied workspaces. Missing workspaces, mismatched frozen inputs, symbolic
links, and special files are rejected. Notes and rerun commands retain their
original text. Use the path mappings when running the retained programs with
their original dependencies and external services.
Campaign databases, settings, transcripts, and runtime environments stay outside
the bundle. Keep those separately to continue or inspect the original campaign.

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
The [live verification procedure](kernel-smoke.md#live-provider-checks) covers
the gateway and solver smoke launchers, credentials, retained artifacts, and
qualification boundaries.

### Checking status

Use the source checkout and Bun runtime recorded by the run's launcher. For a
frozen run, invoke those paths explicitly:

```sh
/path/to/frozen/bun --no-install --no-env-file /path/to/frozen/xean/packages/cli/src/index.ts status /path/to/run/campaign.sqlite
```

For a remote run, execute the same command on its host through SSH or in its
recorded worker allocation. Runtime discovery belongs to the launcher or
operator. Historical campaigns keep their original readers and report fields.
Opening them with current `main` is not an upgrade procedure.

The CLI report includes `observedAt`, campaign state, work counts, pending
signals, imported and generated note counts, and `acceptedNoteId`. A solver
campaign is internally accepted only when `status` is `completed`. Standalone
role and review campaigns can complete with a FAIL or INCONCLUSIVE result.

`verification` counts each note's effective committed verdict at each stage.
`trusted` identifies imported trust without a model verdict. `unchecked` means
no verdict or import trust at that stage, including checks not required for
that note. These counts differ from fully verified notes, which also require
verified dependencies. Earlier judgments remain in the full inspection.

When present, `nextAction` suggests how to continue from the reported state.
`verificationIssues.items` lists unresolved checks for claimed, unaccepted
candidates and their support as `{noteId, stage, verdict, report}`.
`verificationIssues.omitted` counts entries left out of the preview. Supporting
notes are checked on their own claims, without asking them to meet the whole
task's requirements. Imported support is assumed during reconstruction unless
it is itself the candidate. These fields describe committed state and do not
schedule work or establish acceptance.

`activity` shows active work before queued work, with each worker's ID, role,
status, and attempt count. Use `inspect` for its frozen input. Results become
shared only when the worker publishes its complete result. `failures` lists
failed work in reverse request order. Each work list contains at most ten items with an
explicit `omitted` count. Diagnostics are previews of at most 500 characters,
ending in an ellipsis when shortened. Full proofs, prompts, and logs stay out
of this report.

Call totals include unsettled calls and settled calls without measured usage.
`calls.byModel` retains native numeric field names and shows at most ten groups,
with `byModelOmitted` for the remainder. Overlapping usage fields are not added
into a new token total. Price estimates and provider-bill reconciliation remain
outside this report.

Library callers use the same projection:

```ts
import { inspectCampaign } from "xean";
import { statusReport, usageRecord } from "xean/report";

const report = statusReport(await inspectCampaign(path, usageRecord));
```

Use `inspect CAMPAIGN` for an explicit detailed read, `inspect --records` for
execution evidence, and `export CAMPAIGN` for the accepted argument. Capture
large output to a file before selecting the needed detail.

For repeated observation, use the existing
[Observe publisher and compact API](../packages/observe/README.md#compact-status):
the publisher's `--watch` updates snapshots while the caller or observer owns
any completion notification. Read a snapshot's observation time and `stale`
flag before reporting it as current. Campaign acceptance, process state, and
an independent-review receipt are separate evidence. Observe supplies the
latter two alongside the compact campaign report.

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

For initial guidance, run `guide` after `init` and before `run`, or call
`submitCommand` before the library's first `run`. Later guidance takes effect
when Coordinator next plans work. Each dispatched Explorer retains its exact
guidance in its frozen input, including on recovery. Guidance can change the
approach or scheduling among available roles while the exact task and acceptance
checks remain fixed.

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
`profiles.default` supplies the shared Pi profile. Override `explorer`,
`coordinator`, `correctness`, `requirements`, `statement`, `proof`, or `reconstruction`
with a complete `{provider, model, reasoning?}` profile. Omitted reasoning uses
`max` for Pi roles and Codex research. Explicit effort overrides remain supported.
`ProfileName` and `profileNames` name these model-configuration slots. The
Verifier uses several profiles within one role invocation.
Optional fields are `baseUrl`, `apiKeyEnv`, and `transport`. Endpoint URLs cannot
contain credentials, query parameters, or fragments. An explicit `apiKeyEnv`
must name a present, nonblank variable when the runtime is constructed.
The CLI supports Pi's OpenAI, Codex, Anthropic, Google Gemini, and ChatGPT Web
providers. Library callers supply their own native Pi `Models` collection and
model objects for other providers.
Explicit Codex endpoints on `chatgpt.com` and its subdomains retain native
authentication. Custom hosts enable proxy authentication.

Gemini uses Pi's native Google provider with a Gemini API key:

```json
{
  "provider": "google",
  "model": "gemini-3.1-pro-preview",
  "reasoning": "max",
  "apiKeyEnv": "GEMINI_API_KEY"
}
```

Use this profile in any Pi slot, including `profiles.default`. Pi maps `max` to
the model's highest supported thinking level and handles tools, thought
signatures, streaming, and usage through `@google/genai`. This uses Gemini API
access, separately from a Google AI Pro/Ultra subscription. The pinned Pi no
longer includes Gemini CLI or Antigravity subscription authentication.

Claude uses Pi's native Anthropic provider. For a Pro/Max subscription, supply
a valid OAuth token through your environment or secret manager:

```json
{
  "provider": "anthropic",
  "model": "claude-opus-5-5",
  "reasoning": "max",
  "apiKeyEnv": "ANTHROPIC_OAUTH_TOKEN"
}
```

Use this profile in any Pi slot, including `profiles.default`. For API billing,
set `apiKeyEnv` to `ANTHROPIC_API_KEY` instead. The explicit variable prevents
fallback to another credential. Tokens stay outside task/settings files and
recorded request bodies.

The CLI uses Pi's in-memory credential store and does not load a saved Pi login.
Operators renew environment tokens outside Xean. Library callers can supply a
Pi `Models` collection with a credential store for native OAuth login and refresh.

Pi owns bearer/API-key authentication, message conversion, tools, reasoning,
cancellation, and usage through `@anthropic-ai/sdk`. Xean uses this model provider
without a Claude-specific adapter or subprocess. Native token counts are retained
when available. Xean omits Pi's catalog price estimates from usage reports because
they do not measure subscription charges. See the
[native subscription qualification](kernel-smoke.md#native-anthropic).

Source checking, literature, and independent review use the separately configured
Codex CLI, regardless of Pi model profiles. This research contract preserves exact
premises, quotations, URLs, and PASS/FAIL/INCONCLUSIVE evidence rules. Library
callers can supply a `Research` implementation to `createSolver` for another backend.

ChatGPT Web connects to a user-managed browser service. Its logical contract is
**one self-contained prompt plus model/settings → exact completed answer or error**.
The service owns browser login, model selection, submission, waiting, and answer
extraction. Xean/Pi owns the supplied history, tool schemas, answer validation,
tool execution, and research workflow.

A conforming service preserves original answer text, including JSON escapes and
mathematical notation, distinguishes completion from partial output, and avoids
resubmitting after uncertain acknowledgement. Unsupported model/settings or
oversized input must fail rather than silently substitute or truncate. Each
request carries the full supplied context, including earlier tool results, so
correctness must not depend on a retained browser conversation.

The built-in adapter uses the [Responses transport contract](pi-alignment.md#provider-integration)
tested with [codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web).
The operator supplies a conforming endpoint and owns installation, any required
patches, browser authentication, and process management. Set `baseUrl` and, when
the service requires a bearer credential, `apiKeyEnv` naming its environment
variable. Browser credentials remain outside Xean.

This scarce subscription is an explicit, one-response Explorer backend.
Select it only under `profiles.explorer`, with a non-ChatGPT default:

```json
{
  "provider": "codex-chatgpt-web",
  "model": "chatgpt-web/gpt-6-pro",
  "reasoning": "max",
  "baseUrl": "http://127.0.0.1:17841/v1"
}
```

The adapter derives the JSON answer schema from Pi's current tool names,
descriptions, and argument schemas. It validates the entire answer without
coercion before emitting native Pi calls. Pi executes those calls and supplies
their results on the next turn. The service only returns text and needs no
knowledge of notes or roles. An empty call list permits a final text answer only
when the caller allows that completion form. Explorer requires `submit_result`.
`toolChoice: "none"` requests ordinary text. Images remain unsupported.
The [live smoke](kernel-smoke.md#chatgpt-web) qualifies structured answers only.

Xean's ChatGPT profile supplies only `submit_result`: Explorer receives the
summaries once and returns in a single response. It has no note-reading or
continuation calls and cannot be a default, Coordinator, or Verifier profile.
Settings reject response budgets other than one. Direct `createRoles()` calls
also cap Explorer at one response without a note reader, overriding a larger
caller allowance. Built-in campaigns admit no additional ChatGPT Explorer work.
Coordinator sees that Explorer is unavailable after its first attempt and may
return an empty plan when no useful remaining work can be scheduled. The campaign
then waits for external input with status `running`, without claiming completion.
Unavailable requests from replacement planners are rejected rather than dropped.

Each outer tool round can consume another Pro allowance. Recovered browser
workers fail before sending, using the durable attempt ordinal, even if the
original interruption preceded submission. Xean cannot observe other applications
or campaigns using the subscription. Account-wide quota tracking stays external.

Xean retains answer text received from the service. Upstream schema rejection
may expose only an error. Browser usage remains unknown, and a requested model
alias alone does not establish served identity. The adapter records a served
model only when the service explicitly supplies `served_model`.

The provider follows Explorer's no-search instructions but cannot enforce
disabling ChatGPT-native retrieval. It is not qualified for enforced
closed-book experiments. Library callers can register `chatGptWebProvider`
from `xean/pi` directly with Pi's `models.setProvider()`.

`maxExplorerReads` is a positive safe integer and defaults to four.
Except for the one-response ChatGPT profile, `maxExplorerResponses` is a positive
safe integer and defaults to `maxExplorerReads + 4`. An explicit response limit
overrides that default.
The [read contract](#roles-and-acceptance) defines admission and the final-response
restriction. `literature` defaults to false. `limits`
uses the kernel's concurrency, attempts, and logical provider calls. Campaigns,
roles, experiments, and smoke runs have no added wall-clock deadlines. Existing
provider timeouts remain in place and are tuned from observed provider data.
Token and dollar budgets remain out of scope. Set `usagePrefix` to a
unique campaign label when using codex-lb. The frozen settings retain it, and each
call appends the kernel attempt ID. The smoke assigns a timestamped prefix.
Supervisors can use `xean resume CAMPAIGN --usage-prefix PREFIX` to attribute
each process attempt separately. This overrides the prefix for that execution
in both Pi and Codex calls while preserving the campaign's frozen settings.
An override requires this invocation to acquire ownership. It cannot change an
already-running owner's attribution.
Configuration and library entry points share bounded integer schemas for limits,
call grants, and Explorer read and response counts. JSON settings, declarations,
and library command values are validated without converting strings or truncating
numbers. Numeric CLI arguments are parsed before that validation.

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
the calling directory before execution enters its working directory. Bare
command names use `PATH`. The optional `profile` selects
a native Codex profile. Codex resolves login and provider settings normally from
`CODEX_HOME` or `~/.codex`. Ordinary Pi role credentials remain separate.
Configure profiles for the installed Codex version using its
[native profile documentation](https://learn.chatgpt.com/docs/config-file/config-advanced#profiles).
Xean forwards the selected profile without managing its file format. Smoke-test
the exact command and profile before a long run.

To enable the [Codex worker](#codex-worker), add a separate configuration:

```json
{
  "codex": {
    "model": "gpt-6-astra",
    "reasoning": "max",
    "workspace": "/absolute/path/to/campaign-artifacts"
  }
}
```

`codex` requires `model` and an absolute `workspace` directory. Its optional
`command`, `profile`, and `reasoning` use the same native Codex configuration
described above. Omit `codex` to disable the worker. The workspace is created
only during execution. Qualify the configured tools and workspace in the
deployed environment before a long run.

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
Coordinator sees whether source retrieval, literature, and the Codex worker are
available. A disabled external capability cannot be delegated to Explorer. Its reader
only accesses internal frozen notes. Codex failures expose stderr as their
diagnostic, while the journal retains the complete process output.

`createSolver` and `campaignOptions` accept either a `PiRuntime` or a factory
`() => PiRuntime`. A supplied factory runs once, when a role first needs a Pi
model. Codex workers, literature, and review run without constructing Pi profiles
or requiring their credentials. Opening, inspecting, validating commands, and
exporting committed work also leave the factory unused. Supply a `Research`
object to `createSolver`, using `codexResearch(options, usagePrefix)` for Codex
attribution. `campaignOptions` accepts an optional third argument to override
Codex attribution without changing frozen settings.

`createSolver` returns kernel options whose `task` is a versioned solver
declaration. Its `task.task` holds the mathematical task. Direct library campaigns
therefore enforce the same format boundary as CLI campaigns when reopened or
projected. Keep older campaigns on their original runtime.

### Replacing implementations

Library callers can replace implementations before opening a campaign:

| Replace                                                 | Public entry point                                                                               | What remains built in                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Explorer, Verifier, literature, Codex                   | Assign `solver.functions.explorer`, `.verifier`, `.literature`, or `.codex` after `createSolver` | Group scheduling, publication, note projection, and acceptance                         |
| Planning                                                | Assign `solver.functions.coordinator`, accepting `CoordinationInput` and returning `Plan`        | Signal handling and group scheduling                                                   |
| Signal handling and scheduling                          | Supply `XeanOptions.coordinator`                                                                 | Kernel admission, durable publication, lifecycle, and the selected acceptance callback |
| Literature, source checking, independent review backend | Supply a `Research` object to `createSolver`                                                     | Built-in role procedures                                                               |
| Models and providers                                    | Supply `PiRuntime` profiles and native Pi providers                                              | Built-in role procedures                                                               |
| Standalone reconstruction or review                     | Call or replace `.reconstruct` or `.review` on the returned function set                         | Kernel publication when wrapped as a role                                              |

Replacing a planning function also replaces its validation policy, including the
single-Explorer restriction. Replacement functions are trusted code and must
honor their exported input/output types and mathematical contracts. A custom
Verifier supplies the evidence consumed by the solver's acceptance guard.
A replacement `.codex` supplies its own runtime configuration and enables Codex
requests without `settings.codex`. The built-in planner enables literature only
with `literature: true` and a retrieval-capable research backend.

`CoordinationInput.explorerUsed` records whether the built-in Explorer has prior
work, including failed attempts. For a replacement Explorer the field is `false`,
and that role owns its invocation policy. The built-in planner combines it with its actual
provider to expose availability. Dispatch enforces the built-in browser allowance
even when the planner is replaced. `Research.source` receives `summary`,
`detailedSummary`, and `text` for each target, alongside its ID and exact premises.

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

The role name may also be `coordinator`, `verifier`, `reconstruct`, `literature`, or
`codex`. Its input uses the exported TypeScript contract and includes `task`. A completed standalone
role campaign records successful execution, not acceptance of a mathematical
solution. Solver acceptance, a separate review of the full proof, and catalog
closure remain distinct.

Standalone Coordinator input includes `explorerUsed`. Set it to `false` when no
Explorer work has been attempted and to `true` after an attempt. An API Explorer
remains available in either case, while the built-in browser Explorer is one-shot.

For standalone Codex work, use `bun run xean role codex INPUT.json ROLE.sqlite SETTINGS.json`.
Its `CodexInput` contains `{task, assignment, notes}`, where `notes` holds full
note objects and their support, rather than the IDs in a Coordinator request.
It requires `settings.codex` and uses the same retained-workspace procedure.

`reconstruct` takes `ReconstructionInput`: `{task, notes, targets: string[]}`.
It uses the same function as final verification and returns reconstruction checks
for any selected set and its generated dependencies. All supplied targets and
their support must already be verified for correctness and sources. It does not
run the requirements check, so intermediate lemmas can be reconstructed without
claiming to solve the original task. The library exposes this operation as
`solver.functions.reconstruct` and `createRoles(...).reconstruct`.

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

The library is in `packages/core`, and the optional `xean-cli` app is in
`packages/cli`. Core has no CLI or observer dependency. Both apps use public
library APIs, including shared status reports from `xean/report`. Distribution uses the complete
source checkout, including the dependency-installation check, lockfile, and
vendored packages. Individual workspace packages remain private. Campaign declarations are
version 12, with distinct solver, standalone-role, and review kinds. Only this
declaration is supported. Historical declarations retain their original runtime
and are not read, rewritten, or migrated by this CLI. The
[kernel storage contract](kernel.md#sqlite-ownership-and-durability) defines the
campaign format.

Completed Pi stages and memoized source batches survive interruption before
shared publication. A source call interrupted before its memo commits may repeat.

## Current verification

Use the [development check](../README.md#development-on-fleet) and
[provider smoke procedure](kernel-smoke.md#live-provider-checks) for the current
candidate. The suite exercises source-verdict finality, conditional dependency
checks, imported support, correction races, batch identity, and reconstruction
throughout the generated dependency chain.

For correctness-prompt changes, the [prompt screen](../scripts/prompt-eval.ts)
uses [known cases](../examples/prompt-cases.json) covering a valid proof, a false
claim, and a summary that overstates a valid proof. Run it from the source
checkout:

```sh
bun scripts/prompt-eval.ts examples/solver-settings.json runs/prompt-preview
bun scripts/prompt-eval.ts examples/solver-settings.json runs/prompt-baseline --run
```

The default command makes no model calls. It copies settings, cases, and role
inputs into a new output directory and records source hashes and the Bun version
in `manifest.json`. Existing output directories are rejected. `--run` executes
the cases through the standalone Verifier, retaining process output, results,
failures, and timings, plus campaign databases and usage when available. Source
and saved-input hashes are checked before and after each case. A detected change
stops the remaining cases. These runs use the current checkout, not a bundled runtime.

Screen one prompt change at a time in separate baseline and candidate directories,
with identical cases, model settings, and allowances. Inspect the reports and
corrected summaries independently. An automated `matched` result only checks the
expected verdict and submission shape, not mathematical or summary quality.
Keep cases used for tuning separate from held-out evaluation.

Historical mathematical benchmarks and provider smokes retain their original
source, settings, and artifacts under local `runs/` directories. Earlier versions
of this guide record those observations in Git. They are not bundled with a
release and do not establish verification of a later source revision.
