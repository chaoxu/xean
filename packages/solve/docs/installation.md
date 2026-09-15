# Install the solver

Xean requires Bun 1.3.13 or newer. Install the Xean 1.1.1 kernel and solver archives in a project directory:

```sh
mkdir xean-project
cd xean-project
bun add --minimum-release-age 86400 /path/to/xean-1.1.1.tgz /path/to/xean-solve-1.1.1.tgz
bun run xean-solve contract
```

Replace the archive paths with your downloaded or locally packed files. The install command uses Bun's one-day release-age filter for upstream dependencies. Both packages include the MIT license. Campaigns use Bun's SQLite database, with TypeScript computing note verification and support closure.

From a source checkout, install dependencies with `bun install --frozen-lockfile` and run `bun packages/solve/solve.ts`. The examples below use installed packages. In a checkout, their files are under `packages/solve/examples`.

## Choose a provider

With an OpenAI Codex subscription, use Pi's `/login` command to authenticate the **OpenAI Codex** provider:

```sh
bunx --package @earendil-works/pi-coding-agent@0.85.1 pi
```

Xean uses Pi's saved credential for these roles. Source verification and independent review require a separate native Codex CLI login. Before running either profile, install the Codex CLI and authenticate it with `codex login`. The CLI is selected by `XEAN_CODEX_COMMAND` or found on the path, and its native credential is read from `CODEX_HOME` or `~/.codex`.

After logging in and exiting Pi, run the small setup example. This profile uses the public Codex endpoint at `https://chatgpt.com/backend-api` and Luna with low reasoning for every role:

```sh
bun run xean-solve run node_modules/xean-solve/examples/task-even-sum.json campaign.db node_modules/xean-solve/examples/settings-openai-codex.json
```

With an OpenAI API account, configure `OPENAI_API_KEY` in your environment or the OpenAI credential through Pi. This profile uses `https://api.openai.com/v1`:

```sh
bun run xean-solve run node_modules/xean-solve/examples/task-even-sum.json campaign.db node_modules/xean-solve/examples/settings-openai.json
```

Explorer, coordinator, correctness, requirements, and reconstruction use public provider endpoints and Pi credentials. Source verification also requires the Codex CLI and its native login, and always enables web search. The examples require no Fleet services, private model registry, or lab certificate. Use a new campaign path when changing profiles because the settings are frozen.

For a private deployment, set `XEAN_MODELS_PATH` to the absolute path of a valid Pi `models.json` containing the provider override. Xean reads a custom model registry only through that explicit setting. `OPENAI_BASE_URL` does not override Pi's model endpoints.

Pi `ModelRuntime` resolves each provider's configured `headers`. For codex-lb attribution, add this field to the `codex-lb` provider in `models.json`:

```json
{
  "headers": {
    "X-Codex-LB-Usage-Tag": "$XEAN_LAB_CODEX_LB_USAGE_TAG",
    "X-Codex-LB-Required-Capability": "usage_tag_v1"
  }
}
```

Set `XEAN_LAB_CODEX_LB_USAGE_TAG` to the attempt's stable usage tag before starting the solver. Pi rejects an unresolved configured tag before transport. The generic `runPi` runner does not inject these headers from the environment.

## Diagnose provider failures

`No credential for provider(s): openai-codex` requires Pi login for **OpenAI Codex**. An `openai` credential error requires an OpenAI API credential or selection of the Codex subscription profile.

When `run` returns `call-failure`, its JSON `reason` contains the provider error, including the HTTP status and response message when available. Configuration errors appear on standard error. Inspection exposes saved provider errors under `calls[].error`.

When reporting a failure, include the exact command, package version or Git revision, provider/model, and full error with credentials removed. Use the HTTP status and message to distinguish authentication, model access, quota, and connection failures.

## Inspect and guide

```sh
bun run xean-solve inspect campaign.db
bun run xean-solve guide --id try-direct-proof campaign.db node_modules/xean-solve/examples/guidance.txt
bun run xean-solve inspect --include-guidance campaign.db
bun run xean-solve export campaign.db
```

Submit guidance while a campaign is active or paused for delivery to a future Explorer turn. Advice on a completed campaign remains pending. Repeat the original `run` command after an interruption to resume, and use `export` after acceptance to obtain the argument for external review. [Agent usage](agent-usage.md) explains receipts, delivery, and recovery.
