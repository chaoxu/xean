# xean

`xean` (pronounced “zine”) is a Bun and TypeScript toolkit for mathematical exploration with durable evidence. A campaign is a SQLite journal that records the task, model calls, tool activity, candidate material, verdicts, request checkpoints, and provider accounting. The journal lets an application inspect progress, add notes or guidance, and continue work after an interruption.

The product family has clear boundaries:

| Package | Role |
| --- | --- |
| `xean` | Kernel, Pi runner, storage, observation, and accounting APIs |
| `xean-solve` | Explorer, coordinator, and verifier workflow at `packages/solve` |
| `xean-lab` | Experiment execution and provenance |
| `xean-observe` | Read-only HTTP observation and rendering |

The kernel records facts and enforces journal, call, tool, candidate, verdict, and accounting contracts. The model chooses mathematical methods. Applications provide context, tools, budgets, verification policy, publication, and filesystem boundaries. A complete mathematical result requires independent verification of the candidate and its supporting work.

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
bunx --package @earendil-works/pi-coding-agent@0.85.1 pi
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

`run` creates a campaign or resumes the next missing workflow action after matching the task and settings recorded in its declaration. `inspect` derives the phase, notes, verdicts, result, and spend from the journal. `export` emits an accepted note with its transitive support.

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

Notes and guidance are journaled immediately. Guidance reaches a later Explorer turn whose input is not frozen. Every note keeps its text and declared support; a correction creates a new note. The four verifiers check source use, correctness, task requirements, and reconstruction. A note is accepted only when all required checks pass over verified support.

## Build an application

The kernel API supports append-only campaigns, exact candidate bytes, structured tools, Pi calls, request checkpoints, result attachments, and derived verification status. Start with [`docs/application-author.md`](docs/application-author.md). The normative contract is [`SPEC.md`](SPEC.md). [`docs/philosophy.md`](docs/philosophy.md) explains the division of responsibility, and [`docs/terms.md`](docs/terms.md) defines the vocabulary.

The deterministic verifier example is [`examples/scripted-verifier.ts`](examples/scripted-verifier.ts). [`examples/pi-smoke.ts`](examples/pi-smoke.ts) exercises an LLM verdict through Pi.

## xean-solve workflow

`xean-solve` runs one workflow from a task to `accepted` or `turn-limit`. The Explorer writes self-contained notes, the coordinator files notes and selects support, and verifiers record structured verdicts. The workflow derives notes, support closure, dead notes, verified candidates, phase, and result from journal records. It never treats model prose or process stdout as verification authority.

Explorer continuation is enabled by default. Set `explorerContinuation: false` for ordinary Explorer handoff. When enabled, the Explorer can submit notes repeatedly in one context until it claims completion, submits an empty note set, reaches `maxExplorerResponses` (default 4: the initial response plus three continuations), or reaches its context budget. Set `maxExplorerResponses: 1` for first-response handoff. Each submission is journaled, and a fresh user message directs the next step. The context budget is bounded by model capacity. Provider retries, cancellation, output limits, and context overflow remain recorded outcomes with bounded handling. A Pi role profile may set `replayReasoning: false` so later responses in one call receive the transcript without the model's earlier reasoning items; the journal still records them, and the input for each response shrinks by the reasoning it would have replayed.

The source verifier inspects primary-source passages for nonroutine external results and checks their exact hypotheses and application. It records bibliographic corrections without failing verified mathematics. The separate `review` command runs a full independent Codex audit of a final argument and its citations:

```sh
bun packages/solve/solve.ts review task.json argument.md review.db packages/solve/examples/profile-review.json
```

Solver workflow declarations are versioned. An incompatible declaration requires its original runtime. Start a fresh campaign with the current revision and use `submit` or `guide` to carry selected prior work forward. The SQLite journal and execution contract remain at schema 1.

## Development

```sh
bun install --frozen-lockfile
bun run check:all
bun run e2e:roles
```

Run logs, measurements, reviews, and research material belong in ignored `runs/` artifacts. The MIT license is in [`LICENSE`](LICENSE).

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
