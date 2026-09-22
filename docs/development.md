# Development

Install the locked dependencies with `bun install --frozen-lockfile`. Use `bun run check:fast` while editing. It runs formatting, type checking, and the offline test suite. Use `bun run check` before committing. It also packs the library, installs it into a temporary consumer, checks its exported API and narrow Pi runtime import, and exercises the solver CLI. The packed-consumer check needs registry access.

## Focused checks

```sh
bun run test:kernel
bun run test:solve
bun run e2e:roles
bun test ./packages/solve/tests/source-workflow.test.ts -t 'source'
```

Give Bun an explicit relative path beginning with `./` for an individual file. A bare path can act as a filter and discover copies inside archived runs. The package test commands restrict discovery to current test directories and exclude `runs/`. CLI end-to-end tests use fake providers and require no credentials.

The standalone `explorer`, `coordinator`, `literature`, and `verifier` commands remain useful for isolating a role. Their inputs and settings use the same contracts as the workflow. `inspect` reads journal evidence without making model calls. Runtime, prompt, provider, or replay changes also require a fresh live smoke as described in [the solver development workflow](../packages/solve/AGENTS.md).

## Ownership and contracts

The [kernel specification](../SPEC.md) defines stored evidence and call integrity. The [solver workflow guide](../packages/solve/docs/role-runner.md) defines mathematical verification and scheduling. The [vocabulary](terms.md) defines names shared across schemas, prompts, and inspectors. Update the current contract and its consumers together when changing stored formats. Preserve old run evidence with its exact runtime revision.

Pi supplies exploration and mathematical verification. The Codex CLI supplies literature, external-source checking, and independent review. The solver imports Pi's model runtime through its narrow entrypoint. The packed-consumer and model-runtime tests already guard that boundary.

Import solver schemas and types from their defining modules: `roles.ts` owns role data and `pi-roles.ts` exports `solveSettings` and `SolveSettings`. The CLI command table owns its argument validation and help signatures. Workflow, standalone roles, and independent review share declaration matching through `openConfiguredCampaign`; they keep their own execution and signal policies. Inspection and export over captured records are synchronous.

## Line counts

```sh
bun run lines
bun run lines . ../xean-lab ../xean-observe
```

The report counts physical TS/JS lines in each repository's tracked working-tree files, including comments and blank lines. It separates production code from tests, fixtures, scripts, and examples. Xean's Observe API appears separately from its kernel and solver. Lab and the Observe web application are separate repository totals. Run artifacts and vendored code are excluded. Deleted files contribute no lines, and new files enter the report when staged. These counts measure the current checkout, so record its commit and working-tree diff when comparing changes.
