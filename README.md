# Xean

Xean 4.0 ports the Xean 1.0.0 mathematical workflow to native Pi Durable. Explorer
appends notes, Coordinator selects verification work, and Verifier checks source,
correctness, task requirements, and blind reconstruction in that order. Pi owns
conversations, tasks, checkpoints, and SQLite storage.

The runtime uses Pi 1.2.0 at `b45e0eb`, with retained patches listed in
[provenance](vendor/pi/provenance.json). Pi handles responses interrupted by
`max_output_tokens` or `max_messages` limits, transport retries, and
interrupted-response context. Xean configures role limits and the
output-continuation prompt through Pi settings.
Pi retains truncated tool calls as text for resubmission. This recovery context
differs from the old agent loop, while the mathematical role instructions, tool
schemas, and verification sequence retain the v1.0.0 contracts.

Coordinator sends source records in a stable initial message, followed by current
note state and other notes when present. Current state overrides source-record
defaults by note ID. For a fresh campaign containing only newly admitted, verified
sources, the first Coordinator request ends at the source message so later calls
can reuse that boundary for implicit caching. Coordinator uses stable routing
headers for OpenAI Responses calls within a campaign. Cache reuse depends on
provider support, input length, retention, and availability. Adding sources changes
the prefix.

The policy reference is Xean 1.0.0 at `d4af872`, with the transport repair at
`949a385`. This port requires Explorer continuation to be off. A valid note submission ends
that Explorer call. Mathematical note content is append-only, and corrections
use new notes. Coordinator may update summaries.
Internal acceptance remains a model judgment requiring independent mathematical
review. The former 3.5 implementation develops separately as Yean.

## Run a fresh campaign

Use Bun 1.4.2 or later on macOS or Linux:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run xean init examples/task.json .xean/demo.sqlite examples/settings.json
bun run xean run .xean/demo.sqlite
bun run xean status .xean/demo.sqlite
bun run xean inspect .xean/demo.sqlite
bun run xean export .xean/demo.sqlite
```

The example settings use public OpenAI with `gpt-6-astra` and `max` reasoning.
Set `OPENAI_API_KEY` in the environment. The CLI also uses Pi's saved credentials
in `~/.pi/agent/auth.json`. Use `bun run pi` and `/login` to configure a supported
subscription. Set the matching provider and model in each role profile.
`PI_CODING_AGENT_DIR` selects another Pi credential directory.

`init` freezes the task and settings without model calls. `run` starts or recovers
the current native task. Closing the process suspends unfinished work. `resume`
explicitly retries failed work from its recorded progress. A turn-limit result
remains stopped. Inspect the returned outcome: `accepted`, `turn-limit`, or `call-failure`.
A successful process exit alone does not establish acceptance.

`status` reads compact progress. `inspect` includes notes, verification
evidence, and Pi's native per-conversation usage ledgers. These ledgers do not
count every outbound request or include external Codex source usage. Both read a consistent SQLite snapshot without starting model calls.
`export` writes an accepted candidate and its support as Markdown. Keep the
campaign database as the record of the attempt.

Supply caller notes or guidance while the campaign owner is closed:

```sh
bun run xean submit .xean/demo.sqlite notes.json --id initial-notes
bun run xean guide .xean/demo.sqlite guidance.txt --id try-construction
```

`notes.json` contains `{ "notes": [{ "text": "...", "support": [] }] }`.
A stable `--id` makes an exact retry idempotent. Reusing it with different input
fails. These commands queue input without starting models or reopening a terminal
result. An active library owner can call `submitNotes` or `guide` through
`owner.root.commit`. Cross-process admission to a running CLI owner is not
implemented.

The six role profiles in [settings](examples/settings.json) select the models.
`maxExplorerTurns` defaults to 10. `window` defaults to 100,000 characters for
verification batches. The example source profile runs through Pi without web
access. To use native Codex search for source verification, select
`{ "provider": "codex", "model": "gpt-6-astra", "reasoning": "high", "search": true }`
for `source` and authenticate the Codex CLI separately. `search: false` disables
that search. Set `XEAN_CODEX_COMMAND` for another Codex executable. The source
adapter uses a temporary configuration and the native Codex credential. It ignores
user configuration and execpolicy rules, suppresses skill instructions, and
disables plugins. This source path provides live search,
with no historical date cutoff. The host adds no process isolation of its own.

## Library

```ts
import { open, inspect, readReport } from "xean";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";

const task = await Bun.file("examples/task.json").json();
const settings = await Bun.file("examples/settings.json").json();
const owner = await open("campaign.sqlite", { create: { task, settings } });
try {
  await owner.root.waitForIdle(context);
} finally {
  await owner.close();
}
const report = await inspect("campaign.sqlite", readReport);
```

`open` accepts injected Pi `models`, a role `execute` callback, and a `source`
executor. It returns the native `harness`, root conversation, `close`, and
`resume`. Library callers using saved Pi credentials supply authenticated
`models`. Application data lives in Pi documents and task records.

Use fresh databases. Earlier Xean and Yean campaigns require their recorded
runtimes. This port provides no database migration.

## Check and package

```sh
bun run check
bun run pack
```

`check` runs TypeScript, formatting, and the parity tests. Historical fixtures
check role prompts, tool schemas, and source request fields against the archived
v1.0.0 runtime. Native Pi tests cover provider-limit recovery and persisted limits.
`pack` installs a fresh source archive, checks its imports and CLI, runs the
packaged tests, and writes
`dist/xean-4.0.0.tgz`. These checks exercise scripted behavior. Live mathematical
performance and full equivalence to historical runs require separate experiments.
The pinned Pi artifacts and patches are recorded in
[vendor/pi/provenance.json](vendor/pi/provenance.json).
