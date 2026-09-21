# Development workflow

Read [`docs/role-runner.md`](docs/role-runner.md) before editing `roles.ts`, `pi-roles.ts`, `source.ts`, or `workflow.ts`. It is the authority on solver behavior, and a behavior change updates it in the same change.

Use the vocabulary in [`../../docs/terms.md`](../../docs/terms.md) for every schema field, prompt, document, and identifier. Do not introduce a new term or a synonym; when a change needs a new concept, add its entry there in the same change.

Xean Lab derives a worker result from `inspect.result`, never from solver stdout as a second authority.

Send changing task directions, coordinator guidance, continuation prompts, and correction requests as user messages. Keep stable role definitions and contracts in system or developer instructions, and factual results or validation errors in tool receipts. Inspect the constructed provider payload when checking this boundary; a field or helper name alone does not establish the message role.

The solver's versioned contracts are the workflow declaration in `workflow.ts`, the execution contract and its report in `execution-contract.ts`, and the local request schemas of allowances, receipts, and boundaries. The root [`AGENTS.md`](../../AGENTS.md) rule on schema versions applies to each. Bump the execution contract only when its report shape or meaning changes, and keep the `run` command and the execution report unchanged when only role schemas change. No document states the workflow declaration or execution contract schema number; the code is the authority.

Use one bounded completion loop for implementation work:

1. Collect known blockers and define the observable success condition before editing.
2. Make one focused edit batch.
3. Run `bun run check`.
4. Run one fresh live smoke only when runtime, prompt, provider, or replay semantics changed.
5. Stage the intended files and freeze the diff.
6. Run one correctness review and one simplification review concurrently against that diff. Give each reviewer the exact frozen patch and completed check summary. Reviewers inspect that evidence only. They do not search memory or rerun tests. Default to Luna at high reasoning.
7. Wait at most five minutes. Correctness, security, regression, and direct user-requirement findings block. Advisory cleanup does not.
8. Repair blocking findings, verify the affected checks, and review only the repair delta when its interaction is local. Repeat the full review only when the repair changes the contract.
9. Commit immediately after the blocking gates pass.

Do not add another review layer, repeat a smoke, or keep manually inspecting the same campaign unless new evidence identifies a distinct risk. Public documentation covers installation, usage, integration, and current contracts. Keep measurements, run logs, internal reviews, and research drafts under `runs/` untracked. Do not push unless the user asks.
