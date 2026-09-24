# Terms

This is the vocabulary of xean and `xean-solve`. Work in this repository uses these words for these concepts and no others. A new concept gets an entry here in the same change that introduces it. A synonym is collapsed into the existing term, never added beside it. Code identifiers compose these terms, as in `roleLabels`, `verifierNames`, and `journalVerdicts`. Each row defines a term; [SPEC.md](../SPEC.md) states the kernel's rules and [role-runner.md](../packages/solve/docs/role-runner.md) states the solver's.

## Kernel

| Term | Meaning |
| --- | --- |
| campaign | One SQLite database holding one journal, opened as a writer or a reader. Its first entry is the declaration. |
| declaration | The campaign's first entry: application id and config. The solver's config carries `kind` and `schemaVersion`. |
| journal | The append-only entry sequence in a campaign. Every entry has `seq` and `atMs`. |
| entry | One journal record: campaign, evidence, call, tool-call, call-result, tool-result. |
| call | One journaled invocation: label, optional role, optional parent call, exact request, declared tools. |
| call summary | A call's identity (`call`), optional `parent`, timing, settlement `state`, tool identities, Pi outcomes, checkpoints, and accounting, derived from captured entries without response text or transcript attachments. It validates metadata, not attachment bytes. |
| settled | A call whose call-result is written. `inspect` reports `settledAtMs`, `elapsedMs`, and the call-result state. |
| state | The state of a call-result, `returned` or `threw`, or of a Pi or Codex call, `succeeded`, `failed`, or `cancelled`. Never the workflow phase. |
| label | The string naming a call. |
| role | The category of a call: explorer, coordinator, literature, or verifier. |
| request | The exact JSON input of a call. For a Pi call it holds the model, the system prompt, and the prompt. For a Codex call it holds the model, reasoning, search, developer instructions, prompt, and output schema. |
| payload | A JSON value stored immutably by content digest for a provider request, Pi result attachment, or Codex log. Identical payloads share one row. Versioned call records explicitly reference payloads. Ordinary entry JSON never expands a reference implicitly. |
| tool, submission | A model-callable tool, and the structured value the model passed to it. The solver's Pi submit tools are `submit_notes`, `submit_coordination`, `submit_verdict`, `submit_statement`, and `submit_proof`. A Codex literature, source, or independent-review call submits its final JSON message. A caller's submission through `submit` is a local journaled request containing text notes, with no model call. |
| evidence | One application-owned JSON receipt bound to a successfully returned call. The kernel enforces call binding and uniqueness; the application validates its meaning. A solver receipt lists admitted note verdicts. |
| transcript | The provider messages of a settled call. A Pi call-result references its saved transcript through `transcriptRef`. A Codex call's transcript is its JSONL output. |
| spend | The accounting derived from durable request completions: request counts, request errors, measured usage in tokens, and estimated cost. A Codex call's usage is on its submission. |
| first request | The first provider operation within one logical Pi call. |
| continuation | Any subsequent provider operation within that same logical Pi call, including recovery and length continuation. |
| submission gate | The optional frozen Pi policy `{completeArgument, emptyArgument?, contextBudgetTokens?, maxResponses?, continuationPrompt}` for one submission tool, callable once per assistant response, which decides when a gated call ends. |
| terminal tool | The optional frozen Pi `terminalTool` name. Successful calls to other tools continue the conversation. It is separate from a submission gate. The coordinator uses `submit_coordination` as its terminal tool and `read_notes` for exact frozen note texts. |
| response budget | The gate's `maxResponses`: the maximum non-error model responses in one gated Pi call, including the first. The solver sets it from `maxExplorerResponses`. It is separate from `maxTurns`. |
| context budget | The gate's `contextBudgetTokens`: the preferred total-context allocation for a gated call, bounded by the model's context window. The solver sets it from `explorerContextBudgetTokens`. It is separate from model capacity, input-based pricing thresholds, and cumulative billed usage. |
| recovered request error | A provider error inside a Pi call that ultimately succeeds. It remains an error in the journal and does not imply complete usage accounting. |
| accounting | The inspection report of measured cost and its completeness: missing request usage, unaccounted calls and their saved request checkpoints, and calls without recorded prices. Missing cost remains unknown. |

## xean-solve

| Term | Meaning |
| --- | --- |
| workflow | The solver's one protocol: the turn loop from a task to `accepted` or `turn-limit`. It is the declaration kind `workflow` and the contract's `protocol`. Standalone role commands write the declaration kind `calls` and are not a second workflow. |
| task | `problem` and `completionCriteria`. Fixed for a campaign. |
| completion criteria | The task's statement of what an accepted note must do. Only the requirements verifier judges a note against them, so a task that would accept a counterexample says so here. |
| note | `id`, `summary`, `text`, `support`, `verdicts`, `verified`, `dead`, and optional external `verification`. Immutable: a change is a new note. Numbered `n1`, `n2`, and so on in the order notes enter the workflow. One self-contained text: a result with its proof, a partial result with its gaps stated, or a failed approach with the reason. Its writer decides the split and says in the text when it meets the completion criteria. |
| external verification | A caller-supplied note's optional `verification: {source, report}`: the caller explicitly establishes a result, naming the reviewer or caller in `source` and the basis in `report`. This field is separate from the source verifier's evidence. |
| verified | A note's projected flag: correctness and source have passed it or it carries external verification, every note in its support is verified, and it is not dead. |
| summary | The coordinator's navigation text for a note: the note's exact statement as a mathematician would state the result, not a description of the note, plus only what the text itself says about its status, a gap, a failed approach, or a claim to meet the completion criteria. Never verified, never a judgment of the text. |
| text | The mathematics supplied by Explorer or a caller in a note, stored exactly. Validation does not infer dependencies from its prose or notation. |
| dead | A note that correctness, source, or reconstruction failed, or whose support contains a dead note, so it can never be verified. Derived by the projection from the verdicts and the support edges; nothing is stored. An `INCONCLUSIVE` or a requirements `FAIL` is not death. |
| explorer | The role that writes note texts toward the original task, choosing its mathematical work and method. |
| explorer continuation | Explorer's repeated `submit_notes` submissions within one gated call, which continues in one context until a claimed solution, an empty submission, the response budget, or the context threshold. |
| empty submission | A valid Explorer submission with `notes: []`. The first one ends the Explorer call and hands all saved notes to the coordinator, whose input then carries `emptySubmission: true`. |
| coordinator | The role that files summaries, gives explorer guidance for the next turn, selects support, and lists the notes to verify with their verifiers. It also chooses one typed action for the next role, following the campaign's coordinator behavior. |
| literature | The opt-in role that searches for papers and writes a small set of self-contained candidate notes, each preserving the cited result's hypotheses, limitations, and source details, projected directly from its settled report. |
| literature status | The coordinator's view of discovery history: `not-started`, `completed`, or `inconclusive`. It schedules the literature role and is not mathematical evidence. |
| action | The typed role choice in a coordinator result: `explorer`, `literature` with a request, or `verifier`. When overlap is enabled, every verifier action must also supply Explorer guidance and support to dispatch Explorer concurrently. |
| overlap | One coordinator turn that runs an Explorer turn concurrently with a verifier dispatch. When `coordinatorBehavior.overlap` is true, every verifier dispatch uses it in either verification mode. Its local opening freezes the role inputs, each role replays independently, and its durable join precedes the next coordinator or terminal result. |
| input | The typed JSON value frozen by the host and handed to a role function. Each logical call records this exact input, and its successful return is the canonical output used by replay. |
| role function | A replaceable async function in `RoleImplementations` that receives typed input and execution capabilities and returns typed output. It receives no campaign or parent call IDs. It may call Pi or Codex, or return without a model. Explorer may also submit intermediate notes. |
| role host | `createRoleHost`: validates and records function inputs and outputs, owns Explorer submissions, runs the verification chain, admits evidence, and handles recovery and cancellation. |
| model call | A Pi or Codex child of a logical role call, retaining its provider request, transcript, submission, and accounting. A role function may make zero or more model calls. |
| notes | Notes as handed to a role, written by Explorer or submitted by a caller or the literature role. |
| support | The notes whose results a text uses without proving them, in any form: a fact cited, a case inherited, an object taken as defined, or a hypothesis assumed established, declared by the writer in the note's `support` array. Also the notes the coordinator has Explorer read in full. In caller submissions, strings name existing campaign notes and positive integers name earlier notes in that submission, counted from 1. A verifier receives support as established and not under review. |
| closure | A note's transitive support: its support, their support, and so on, in id order. `export` emits it before the accepted note. |
| support graph | Note IDs and their support edges. The traversal in `support.ts` computes their transitive closure. It carries no verification authority. |
| filing | The coordinator's pairing of a note id with a summary. |
| verify | The coordinator's ordered list of notes to verify, each with the verifiers to run: a prefix of the verifier order. |
| verification | A local opening that freezes the notes and requested checks for the longest prefix of the coordinator action's `verify` list fitting the window, always its first entry. Its call ID is the `parent` of the verifier calls and the `verification` field in the accepted result. |
| window | The settings cap on the characters of note texts and their complete support closure that one verification reads, shared texts counted once. The first listed note is always taken with its full closure, even when that alone exceeds the window. |
| verifier | The role, and each of `correctness`, `source`, `requirements`, `reconstruction`, which run in that order. |
| independent review | A separate full Codex audit of the exact task and complete argument, including all supporting proofs and citations, without trusting internal solver verdicts. Its request, transcript, and verdict are recorded in a separate review journal. |
| sources | Passages inspected during source verification or an independent review, including evidence of a mismatch. Each entry has `result` naming the checked result, `source` identifying the paper and theorem or section, `url` for the source page, and `quote` for the relevant passage. In source verification each entry also has `resultId`, one of the call's assigned premise IDs, and `result` holds the assigned text; an independent review names its result by text. |
| externalResults | The exact nonroutine external premises identified by correctness while reading the complete proof and support. Each states its hypotheses, conclusion, and claimed application. Immediate routine facts, results proved in the note, and declared supporting results need no entry. |
| obligation | The fixed instruction of one verifier. The correctness obligation includes the search for counterexamples and missing cases. |
| verdict | `verifier`, `note`, `PASS`, `FAIL`, or `INCONCLUSIVE`, `report`, and optional `correctedText` on PASS, recorded on the note it names, always a note under verification. `FAIL` requires a concrete defect or an unmet completion criterion; `INCONCLUSIVE` means the check could not settle the claim and identifies what remains unresolved. |
| correctedText | The complete replacement note text explicitly approved in a PASS verdict under the local-correction policy. Later checks and exports use it; the original submission remains in the journal. |
| statement | What a text establishes, with nothing of how: one or several propositions, each with hypotheses, quantifiers, parameters, side conditions, and conclusion. The reconstruction verifier's first submission for a note; a reconstruction judgment may return a corrected `statement` instead of a verdict. |
| proof | The reconstruction verifier's evidence: a proof written by a separate function receiving only the task, statement, and support notes, never the target note's text. It may leave something unproved and say so. |
| report | The text of a verdict. Qualified as execution report: a run's result with `schemaVersion`, `application`, and `protocol`, as `run` and `inspect` emit it. |
| turn | One workflow cycle: one coordinator call and the work it dispatches, including both roles in an overlap. Capped by the cumulative journaled allowance, exposed as `maxTurns`. |
| allowance | A journaled authorization for a positive number of turns, identified by an id and the previously spent `afterTurns`, outside the frozen task and settings. The sum is the effective `maxTurns`. |
| phase | Where the fold stands: the role to call next (`explorer`, `coordinator`, `literature`, or `verifier`), an `overlap` with unfinished concurrent work, or the terminal kind `accepted` or `turn-limit`. |
| outcome | A run's ending: `accepted`, `turn-limit`, `paused`, `call-failure`, `interrupted`. |
| result | A run's outcome with its data. Terminal results carry the turns, notes, and for `accepted` the note and verification ID. Resumable results carry the phase as `at` and an optional reason. `inspect.result` is derived from the journal for terminal phases. |
| export | The accepted note and its complete corrected support closure as UTF-8 text. The `exportSolution` API and `solution` byte field expose this argument; the CLI command is `export`. |
| fold | `deriveWorkflow`: the derivation of notes and phase from canonical role outputs and saved Explorer submissions in the journal, matching calls by ownership, exact frozen typed input, and journal order. It builds the projection and asks it which notes exist at a journal sequence, which are accepted, and for a note's closure. |
| projection | `Projection`: the fold's in-memory maps of notes, summaries, support, and verdicts. Recovery rebuilds it from the journal, and a running workflow retains completed turns while replaying unfinished work. It is never persisted and alone derives verified, dead, and accepted. |
| schema version | The number identifying a persisted contract's current format and meaning. Older formats are unsupported. |
| contract | The output of `xean-solve contract`: command, arguments, outcomes, and the execution report schema. |
| settings | One profile for the explorer, one for the coordinator, one per verifier, role response and context budgets, `window`, and the frozen `coordinatorBehavior` policy. Fixed for the campaign. |
| coordinator behavior | The frozen campaign policy supplied in each coordinator prompt: a `literature` mode, a `verification` mode, `overlap` defaulting to false, and optional `instructions`. |
| guidance | Fallible advice for the next Explorer turn, carried in its `explorerGuidance` string: the coordinator's recommendation joined with external advice appended by `guide`. |
| inbox | Caller input waiting in the campaign until a boundary freezes it into the next role input: guidance for the next Explorer turn and submitted notes for the next coordinator. A shared boundary records the channel and the receipt range, preserving each channel's intake time. |
| profile | A Pi profile selects a provider, model, and reasoning level. A Codex profile is `{model, reasoning}`, used by source verification, literature, and independent review. |
| run, inspect, export | The commands that start or resume a campaign, derive its phase and result, and emit the accepted note with its transitive support. |
| guide | The command that appends guidance to an existing workflow campaign. |
| init | The command that creates a workflow declaration or matches its exact task and settings, with no provider setup or model calls. Its arguments are the same as `run`. |
| submit | The command that appends text notes with optional external verification to an existing workflow campaign, with no model calls. |

The `xean-lab` terms experiment, arm, replicate, attempt, and generation describe experiment execution and provenance.

## Words not to use

These were collapsed into the terms above and must not return as names for those concepts: auditor and audit for a verifier, adversarial for a verifier, whose search is part of the correctness obligation, finding for a note, index and context for lists of notes, nominate, proposal, and answer for verifying a note, batch and queue for a verification and for what it leaves unverified, `ACCEPT` and `REJECT` for verdicts, candidate kind, solution, refutation, and refuted, repair for a new note, unfiled for a note without a summary, standing and trust for what a note's verdicts show, unverified, record for a verdict, state for the phase, agent for a call, resolve for meeting the completion criteria, mint for numbering notes, turn for a single call. Ordinary English elsewhere, such as review findings in the development loop or the untrusted-data labels in prompts, is not a system term.
