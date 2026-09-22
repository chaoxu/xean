# xean

`xean` (pronounced “zine”) is a Bun and TypeScript toolkit for mathematical exploration with durable evidence. A campaign is a SQLite journal that records the task, model calls, tool activity, evidence, request checkpoints, and provider accounting. The journal lets an application inspect progress, add notes or guidance, and continue work after an interruption.

The product family has clear boundaries:

| Package | Role |
| --- | --- |
| `xean` | Kernel, Pi runner, storage, observation, and accounting APIs |
| `xean-solve` | Explorer, coordinator, and verifier workflow at `packages/solve` |
| `xean-lab` | Experiment execution and provenance |
| `xean-observe` | Read-only HTTP observation and rendering |

The kernel records facts and enforces journal, call, tool, evidence, and accounting contracts. The model chooses mathematical methods. Applications own verification and acceptance, context, tools, budgets, publication, and filesystem boundaries. A complete mathematical result requires independent verification of the argument and its supporting work.

## Install and run

The [`main` branch on GitHub](https://github.com/chaoxu/xean) is the current release. Install and update from that branch. Existing numbered releases are historical archives.

Use Bun 1.3.13 or newer on macOS or Linux:

```sh
git clone --branch main https://github.com/chaoxu/xean.git
cd xean
bun install --frozen-lockfile
bun packages/solve/solve.ts contract
```

The Codex profile uses Pi's OpenAI Codex provider. Authenticate it with Pi:

```sh
bunx --package @earendil-works/pi-coding-agent@0.87.0 pi
```

Enter `/login`, choose **OpenAI Codex**, and exit. The OpenAI API profile uses `OPENAI_API_KEY` and `packages/solve/examples/settings-openai.json`. Provider access, credentials, and model availability come from Pi and the selected profile. The solver examples use public OpenAI endpoints and need no xean-lab service.

Source verification and independent review also require the Codex CLI with configured credentials. Install the CLI and authenticate with `codex login` before running either profile. Xean selects the CLI through `XEAN_CODEX_COMMAND` or the path, reads its configuration from `CODEX_HOME` or `~/.codex`, and enables web search for these checks. [Provider setup](packages/solve/docs/installation.md#choose-a-provider) also covers custom endpoints.

After authenticating, run the small example:

```sh
bun packages/solve/solve.ts run packages/solve/examples/task-even-sum.json campaign.db packages/solve/examples/settings-openai-codex.json
bun packages/solve/solve.ts inspect campaign.db
bun packages/solve/solve.ts export campaign.db
```

To update the checkout, run `git pull --ff-only` followed by `bun install --frozen-lockfile`. Record `git rev-parse HEAD` with a run so its runtime can be reproduced. Keep the original revision available when resuming an older campaign. The [installation guide](packages/solve/docs/installation.md) gives the complete setup and update instructions.

The task is one JSON object:

```json
{
  "problem": "Prove that the sum of two even integers is even.",
  "completionCriteria": "Give a standalone proof for arbitrary even integers."
}
```

`run` creates a campaign or resumes it, `inspect` derives its phase, notes, verdicts, result, and spend from the journal, and `export` emits an accepted note with its transitive support.

## Supply work and guidance

Create a campaign and add mathematical notes before the first model call when useful:

```sh
bun packages/solve/solve.ts init task.json campaign.db settings.json
bun packages/solve/solve.ts submit --id initial-work campaign.db notes.json
bun packages/solve/solve.ts run task.json campaign.db settings.json
```

Add guidance while a campaign is active or paused:

```sh
bun packages/solve/solve.ts guide --id next-route campaign.db guidance.txt
bun packages/solve/solve.ts inspect --include-guidance campaign.db
```

The [inbox rules](packages/solve/docs/role-runner.md#inbox) state when notes and guidance reach a role.

## Build an application

The kernel API supports append-only campaigns, parent-bound calls, structured tools, Pi calls, request checkpoints, result attachments, and application-owned evidence. Start with [`docs/application-author.md`](docs/application-author.md). The normative contract is [`SPEC.md`](SPEC.md). [`docs/philosophy.md`](docs/philosophy.md) explains the division of responsibility, and [`docs/terms.md`](docs/terms.md) defines the vocabulary.

The deterministic verifier example is [`examples/scripted-verifier.ts`](examples/scripted-verifier.ts). [`examples/pi-smoke.ts`](examples/pi-smoke.ts) exercises an LLM verdict through Pi.

## xean-solve workflow

`xean-solve` runs one workflow from a task to `accepted` or `turn-limit`. The coordinator opens every campaign and, after its dispatched work settles, chooses Explorer, literature, or a verifier. Setting `coordinatorBehavior.overlap` to `true` pairs every verifier dispatch with Explorer, in either verification mode. It defaults to `false` and is frozen when the campaign starts. Each dispatch, including a concurrent pair, is one turn of the journaled allowance. Explorer writes self-contained notes, four verifiers record structured verdicts, and the journal alone determines the notes, phase, and result. The [workflow guide](packages/solve/docs/role-runner.md) is the authority on this behavior, and the solver [README](packages/solve/README.md) lists its commands and settings. The separate `review` command runs a full independent Codex audit of a final argument and its citations:

```sh
bun packages/solve/solve.ts review task.json argument.md review.db packages/solve/examples/profile-review.json
```

## Development

```sh
bun install --frozen-lockfile
bun run check:fast
bun run check
```

`check:fast` runs formatting, types, and offline tests. `check` also verifies the packed consumer and CLI. See the [development guide](docs/development.md) for focused tests, architecture boundaries, and reproducible line counts. Run logs, measurements, reviews, and research material belong in ignored `runs/` artifacts. The MIT license is in [`LICENSE`](LICENSE).

## Cite

Cite the repository rather than a version. GitHub's "Cite this repository" button reads [`CITATION.cff`](CITATION.cff), and this BibTeX matches it:

```bibtex
@software{xu2026xean,
  author  = {Xu, Chao},
  title   = {xean: mathematical exploration with durable evidence},
  year    = {2026},
  url     = {https://github.com/chaoxu/xean},
  license = {MIT}
}
```

Where reproducibility matters, add the tag or commit of the checkout to the entry's `note` field. A result produced with xean should also name the model and provider recorded in the campaign journal, since the journal, not xean, is the evidence for the mathematics.
