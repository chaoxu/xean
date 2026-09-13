# Install the solver

Elenx requires Bun 1.3.13 or newer. Release `v0.10.0` includes the `elenx` kernel at version 0.10.0 and `elenx-solve` at version 0.36.0. Install both packages in a project directory:

```sh
mkdir elenx-project
cd elenx-project
bun add --minimum-release-age 86400 https://github.com/chaoxu/elenx/releases/download/v0.10.0/elenx-0.10.0.tgz https://github.com/chaoxu/elenx/releases/download/v0.10.0/elenx-solve-0.36.0.tgz
bun pm trust cozo-node
bun run elenx-solve contract
```

The install command uses Bun's one-day release-age filter to avoid partially published upstream dependency versions. The trust command allows Cozo's install script to install the native database binding used by this release. Current source checkouts use TypeScript for the projection and support closure and require no Cozo binding or trust command. Both packages include the MIT license. The release assets also include `SHA256SUMS` for checking downloaded archives.

## Choose a provider

With an OpenAI Codex subscription, use Pi's `/login` command to authenticate the **OpenAI Codex** provider:

```sh
bunx --package @earendil-works/pi-coding-agent@0.85.1 pi
```

Elenx uses Pi's saved credential, which is separate from Codex CLI login. After logging in and exiting Pi, run the small setup example. This profile uses the public Codex endpoint at `https://chatgpt.com/backend-api` and Luna with low reasoning for every role:

```sh
bun run elenx-solve run node_modules/elenx-solve/examples/task-even-sum.json campaign.db node_modules/elenx-solve/examples/settings-openai-codex.json
```

With an OpenAI API account, configure `OPENAI_API_KEY` in your environment or the OpenAI credential through Pi. This profile uses `https://api.openai.com/v1`:

```sh
bun run elenx-solve run node_modules/elenx-solve/examples/task-even-sum.json campaign.db node_modules/elenx-solve/examples/settings-openai.json
```

These profiles use public provider endpoints and Pi credentials. They require no Fleet services, private model registry, or lab certificate. The source verifier in both examples runs through Pi without web search. Use a new campaign path when changing profiles, since each campaign fixes its settings.

For a private deployment, set `ELENX_MODELS_PATH` to the absolute path of a valid Pi `models.json` containing the provider override. Elenx reads a custom model registry only through that explicit setting. `OPENAI_BASE_URL` does not override Pi's model endpoints.

## Diagnose provider failures

`No credential for provider(s): openai-codex` requires Pi login for **OpenAI Codex**. An `openai` credential error requires an OpenAI API credential or selection of the Codex subscription profile.

When `run` returns `call-failure`, its JSON `reason` contains the provider error, including the HTTP status and response message when available. Configuration errors appear on standard error. Current source checkouts also expose saved provider errors in `inspect` under `calls[].error`. Released Solver 0.35.0 shows only the kernel call state there, so retain the original `run` output.

When reporting a failure, include the exact command, package version or Git revision, provider/model, and full error with credentials removed. Use the HTTP status and message to distinguish authentication, model access, quota, and connection failures.

## Inspect and guide

```sh
bun run elenx-solve inspect campaign.db
bun run elenx-solve guide --id try-direct-proof campaign.db node_modules/elenx-solve/examples/guidance.txt
bun run elenx-solve inspect --include-guidance campaign.db
bun run elenx-solve export campaign.db
```

Submit guidance while a campaign is active or paused for delivery to a future Explorer turn. Advice on a completed campaign remains pending. Repeat the original `run` command after an interruption to resume, and use `export` after acceptance to obtain the argument for external review. [Agent usage](agent-usage.md) explains receipts, delivery, and recovery.

## Existing campaigns

Release Elenx 0.10.0 and Solver 0.36.0 use workflow schema 36 and execution-contract schema 9. They support optional Explorer continuation, externally verified notes, and acceptance of a supplied complete proof after all four checks with zero Explorer turns. Current development uses workflow schema 37 and hands off to the coordinator on the first empty Explorer submission. The published Elenx 0.9.4 and Solver 0.35.0 packages use workflow schema 24 and execution-contract schema 8. Keep that published-release provenance unchanged. The CLI run arguments remain unchanged. Campaigns from earlier workflow or kernel schemas need their matching implementation. Preserve a campaign together with its task, settings, and package revision.
