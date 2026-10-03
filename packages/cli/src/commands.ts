import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  Xean,
  inspectCampaign,
  openXeanStorage,
  UninitializedCampaignError,
} from "xean";
import {
  campaignOptions,
  declarationVersion,
  loadDeclaration,
  piRuntime,
  readCommand,
  readDeclaration,
  readSettings,
  isSolverCampaign,
  type Declaration,
} from "xean/solve";
import { verifyInstall } from "../../../scripts/dependencies.ts";
import { version } from "../../../package.json";
import {
  ownerReport,
  controlCommand,
  requestOwner,
  serveControl,
  type OwnerCommand,
} from "./control.ts";
import { campaignReport, statusReport, usageRecord } from "xean/report";
import { doctor } from "./doctor.ts";

async function print(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
}

const program = new Command("xean")
  .description("Run and inspect durable mathematical work")
  .version(version)
  .option("--campaign-dir <dir>", "Directory for named campaigns", ".xean")
  .option("--records", "Include durable call and attempt records")
  .option("--owner-id <id>", "Identify this execution owner")
  .option("--expected-owner-id <id>", "Require this live owner for a command")
  .option(
    "--usage-prefix <prefix>",
    "Attribute this execution without changing frozen settings",
  )
  .option(
    "--key-stdin",
    "Read a provider credential when opening to run offline",
  )
  .configureHelp({ showGlobalOptions: true })
  .hook("preAction", async (_program, action) => {
    if (action.name() !== "doctor")
      await verifyInstall(resolve(import.meta.dir, "../../.."));
    if (
      program.opts<Flags>().expectedOwnerId !== undefined &&
      ![
        "resume",
        "pause",
        "cancel",
        "submit",
        "guide",
        "correct",
        "extend",
      ].includes(action.name())
    )
      throw new Error("--expected-owner-id requires a live control command");
  });

type Flags = {
  records?: boolean;
  keyStdin?: boolean;
  usagePrefix?: string;
  ownerId?: string;
  expectedOwnerId?: string;
};
const records = () => program.opts<Flags>().records === true;
const read = (path: string) => Bun.file(resolve(path)).json();
const readText = (path: string) => Bun.file(resolve(path)).text();

function campaignPath(target: string): string {
  if (/[/\\]|\.(sqlite|db)$/i.test(target)) return resolve(target);
  if (!/^[A-Za-z0-9_-]+$/.test(target))
    throw new Error("Expected a campaign name or explicit database path");
  return resolve(
    program.opts<{ campaignDir: string }>().campaignDir,
    target,
    "campaign.sqlite",
  );
}

async function withCampaign(
  target: string,
  options: { declaration?: Declaration; key?: string },
  action: (engine: Xean, database: string) => Promise<void>,
) {
  const requested = campaignPath(target);
  const path = options.declaration ? requested : await realpath(requested);
  await using cleanup = new AsyncDisposableStack();
  const storage = await openXeanStorage(path);
  // Pi's SQLite close is idempotent, including after Xean assumes ownership.
  cleanup.defer(() => storage.close(BACKGROUND_CONTEXT));
  const declaration = options.declaration ?? (await loadDeclaration(storage));
  const usagePrefix = program.opts<Flags>().usagePrefix;
  const settings = readSettings({
    ...declaration.settings,
    ...(usagePrefix === undefined ? {} : { usagePrefix }),
  });
  const kernelOptions = campaignOptions(
    declaration,
    () => piRuntime(settings, options.key),
    usagePrefix,
  );
  const engine = await Xean.open(storage, kernelOptions);
  cleanup.defer(() => engine.close());
  await action(engine, await realpath(path));
}

async function runCampaign(
  target: string,
  declaration?: Declaration,
  method: "run" | "resume" = "run",
) {
  // A runtime override requires this process to acquire execution ownership.
  const { ownerId, expectedOwnerId, usagePrefix, keyStdin } =
    program.opts<Flags>();
  if (
    method === "resume" &&
    usagePrefix === undefined &&
    ownerId === undefined
  ) {
    const receipt = await requestOwner(
      await realpath(campaignPath(target)),
      {
        kind: "resume",
        records: records(),
      },
      expectedOwnerId,
    );
    if (receipt !== undefined) return print(receipt);
  }
  if (expectedOwnerId !== undefined)
    throw new Error("Expected campaign owner is unavailable");
  const key = keyStdin ? (await Bun.stdin.text()).trim() : undefined;
  if (keyStdin && !key) throw new Error("Expected a credential on stdin");
  await withCampaign(target, { declaration, key }, async (engine, database) => {
    const control = await serveControl(database, engine, ownerId);
    let shutdown: Promise<unknown> | undefined;
    const interrupt = () => {
      shutdown ??= Promise.all([control.close(true), engine.close()]);
      // The run path awaits shutdown; handle its rejection until then.
      void shutdown.catch(() => {});
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      await engine[method]().finally(() => control.close());
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      await shutdown;
    }
    if (!shutdown) await print(await ownerReport(engine, records()));
  });
}

async function sendCommand(target: string, command: OwnerCommand) {
  const path = await realpath(campaignPath(target));
  const receipt = await requestOwner(
    path,
    command,
    program.opts<Flags>().expectedOwnerId,
  );
  if (receipt !== undefined) return print(receipt);
  await withCampaign(path, {}, async (engine) => {
    await print(await controlCommand(engine, command));
  });
}

program.command("doctor <settings>").action(async (settings: string) => {
  const report = await doctor(settings, () =>
    verifyInstall(resolve(import.meta.dir, "../../..")),
  );
  await print(report);
  if (!report.ok) process.exitCode = 1;
});
program
  .command("init <task> <campaign> <settings>")
  .action(async (task: string, campaign: string, settings: string) => {
    const declaration = readDeclaration({
      version: declarationVersion,
      kind: "xean.solve",
      task: await read(task),
      settings: await read(settings),
    });
    await withCampaign(campaign, { declaration }, async (engine) => {
      await print(await ownerReport(engine, records()));
    });
  });
for (const method of ["run", "resume"] as const)
  program
    .command(`${method} <campaign>`)
    .action((campaign: string) => runCampaign(campaign, undefined, method));
for (const kind of ["pause", "cancel"] as const)
  program
    .command(`${kind} <campaign>`)
    .action((campaign: string) =>
      sendCommand(campaign, { kind, records: records() }),
    );
program
  .command("inspect <campaign>")
  .option(
    "--allow-uninitialized",
    "Report a campaign whose initialization has not committed as null",
  )
  .action(async (campaign: string, flags: { allowUninitialized?: boolean }) => {
    try {
      const snapshot = await inspectCampaign(campaignPath(campaign), records());
      await print(
        campaignReport(records() ? snapshot : { campaign: snapshot.campaign }),
      );
    } catch (error) {
      if (
        !flags.allowUninitialized ||
        !(error instanceof UninitializedCampaignError)
      )
        throw error;
      await print({ campaign: null });
    }
  });
program.command("status <campaign>").action(async (campaign: string) => {
  const report = statusReport(
    await inspectCampaign(campaignPath(campaign), usageRecord),
  );
  await print({ observedAt: new Date().toISOString(), ...report });
});
program
  .command("role <name> <input> <campaign> <settings>")
  .action(
    async (name: string, file: string, campaign: string, settings: string) => {
      const input = await read(file);
      const declaration = readDeclaration({
        version: declarationVersion,
        kind: "xean.role",
        role: name,
        input,
        task: input.task,
        settings: await read(settings),
      });
      await runCampaign(campaign, declaration);
    },
  );
program
  .command("review <task> <argument> <campaign> <settings>")
  .action(
    async (
      task: string,
      argument: string,
      campaign: string,
      settings: string,
    ) => {
      const declaration = readDeclaration({
        version: declarationVersion,
        kind: "xean.review",
        task: await read(task),
        argument: await readText(argument),
        settings: await read(settings),
      });
      await runCampaign(campaign, declaration);
    },
  );
program.command("export <campaign>").action(async (target: string) => {
  const { campaign } = await inspectCampaign(campaignPath(target), false);
  const result = campaign.result as { argument?: string } | null;
  if (
    !isSolverCampaign(campaign) ||
    campaign.status !== "completed" ||
    typeof result?.argument !== "string" ||
    !result.argument
  )
    throw new Error("No accepted argument");
  await Bun.write(Bun.stdout, result.argument + "\n");
});
for (const kind of ["submit", "guide", "correct"] as const) {
  program
    .command(`${kind} <campaign> <file>`)
    .requiredOption("--id <id>", "Stable command ID for exact retries")
    .action(async (campaign: string, file: string, flags: { id: string }) => {
      const content =
        kind === "guide" ? { text: await readText(file) } : await read(file);
      await sendCommand(
        campaign,
        readCommand({ ...content, kind, id: flags.id }),
      );
    });
}
program
  .command("extend <campaign> <calls>")
  .requiredOption("--id <id>", "Stable command ID for exact retries")
  .action(async (campaign: string, calls: string, flags: { id: string }) => {
    await sendCommand(campaign, {
      kind: "extend",
      calls: Number(calls),
      id: flags.id,
    });
  });

await program.parseAsync();
