# Install the solver

The [`main` branch on GitHub](https://github.com/chaoxu/xean) is the current release. Install and update from that branch. Existing numbered releases are historical archives.

Xean requires Bun 1.3.13 or newer on macOS or Linux. Clone the repository and install its locked dependencies:

```sh
git clone --branch main https://github.com/chaoxu/xean.git
cd xean
bun install --frozen-lockfile
bun packages/solve/solve.ts contract
```

The checkout contains the kernel, solver, and examples under the MIT license. Run the commands below from its root. Campaigns use Bun's SQLite database, with TypeScript computing note verification and support closure.

## Choose a provider

With an OpenAI Codex subscription, use Pi's `/login` command to authenticate the **OpenAI Codex** provider:

```sh
bunx --package @earendil-works/pi-coding-agent@0.85.1 pi
```

Xean uses Pi's saved credential for these roles. Source verification and independent review use the Codex CLI, selected by `XEAN_CODEX_COMMAND` or found on the path. By default, authenticate it with `codex login`; its credential is read from `CODEX_HOME` or `~/.codex`. A selected custom provider in that home’s `config.toml` can instead use its configured endpoint and `env_key` credential.

After logging in and exiting Pi, run the small setup example. This profile uses the public Codex endpoint at `https://chatgpt.com/backend-api` and Luna with low reasoning for every role:

```sh
bun packages/solve/solve.ts run packages/solve/examples/task-even-sum.json campaign.db packages/solve/examples/settings-openai-codex.json
```

With an OpenAI API account, configure `OPENAI_API_KEY` in your environment or the OpenAI credential through Pi. This profile uses `https://api.openai.com/v1`:

```sh
bun packages/solve/solve.ts run packages/solve/examples/task-even-sum.json campaign.db packages/solve/examples/settings-openai.json
```

Explorer, coordinator, correctness, requirements, and reconstruction use public provider endpoints and Pi credentials. Source verification also requires the Codex CLI and configured credentials, and always enables web search. The examples require no Fleet services, private model registry, or lab certificate. Use a new campaign path when changing profiles because the settings are frozen.

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

For Codex source verification and independent review, configure the selected custom provider using the standard Codex configuration:

```toml
model_provider = "gateway"

[model_providers.gateway]
name = "My model gateway"
base_url = "https://gateway.example/v1"
wire_api = "responses"
env_key = "GATEWAY_API_KEY"
supports_websockets = true
```

The adapter reads this provider’s connection fields from `CODEX_HOME/config.toml` (default `~/.codex/config.toml`) and passes only its named credentials and headers to the isolated CLI. Supported fields are `name`, `base_url`, `wire_api`, `env_key`, `requires_openai_auth`, `supports_websockets`, `supports_standalone_web_search`, `http_headers`, and `env_http_headers`. Set `supports_standalone_web_search = true` when the gateway implements Codex’s `alpha/search` endpoint; current Codex models require this tool for source retrieval. Header values stay out of process arguments. User instructions, tools, hooks, and rules are not inherited. A missing configured credential is an error; it never falls back to the native account. Connection settings are runtime configuration and do not change the campaign’s task, role prompts, or response allowance.

## Diagnose provider failures

`No credential for provider(s): openai-codex` requires Pi login for **OpenAI Codex**. An `openai` credential error requires an OpenAI API credential or selection of the Codex subscription profile.

When `run` returns `call-failure`, its JSON `reason` contains the provider error, including the HTTP status and response message when available. Configuration errors appear on standard error. Inspection exposes saved provider errors under `calls[].error`.

When reporting a failure, include the exact command, package version or Git revision, provider/model, and full error with credentials removed. Use the HTTP status and message to distinguish authentication, model access, quota, and connection failures.

## Inspect and guide

```sh
bun packages/solve/solve.ts inspect campaign.db
bun packages/solve/solve.ts guide --id try-direct-proof campaign.db packages/solve/examples/guidance.txt
bun packages/solve/solve.ts inspect --include-guidance campaign.db
bun packages/solve/solve.ts export campaign.db
```

Submit guidance while a campaign is active or paused for delivery to a future Explorer turn. Advice on a completed campaign remains pending. Repeat the original `run` command after an interruption to resume, and use `export` after acceptance to obtain the argument for external review. [Agent usage](agent-usage.md) explains receipts, delivery, and recovery.

## Update and reproduce a run

In a clean checkout of `main`, update the source and its dependencies together:

```sh
git pull --ff-only
bun install --frozen-lockfile
```

Record `git rev-parse HEAD` with each run. For a reproducible installation, check out that exact commit and run `bun install --frozen-lockfile`. Keep the original revision available for unfinished campaigns because changed workflow declarations can require their original runtime. Use a separate checkout when running old and current campaigns together.
