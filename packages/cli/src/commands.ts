import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { Xean, inspectCampaign, openXeanStorage } from "xean";
import {
  campaignOptions,
  declarationVersion,
  loadDeclaration,
  piRuntime,
  readCommand,
  readDeclaration,
  type Declaration,
} from "xean/solve";
import { verifyInstall } from "../../../scripts/dependencies.ts";
import { version } from "../../../package.json";
import {
  campaignReport,
  ownerReport,
  controlCommand,
  requestOwner,
  serveControl,
  type OwnerCommand,
} from "./control.ts";
import { statusReport, usageRecord } from "./report.ts";

async function print(value: unknown): Promise<void> {
  await Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
}

const program = new Command("xean")
  .description("Run and inspect durable mathematical work")
  .version(version)
  .option("--campaign-dir <dir>", "Directory for named campaigns", ".xean")
  .option("--records", "Include durable call and attempt records")
  .option(
    "--key-stdin",
    "Read a provider credential when opening to run offline",
  )
  .configureHelp({ showGlobalOptions: true })
  .hook("preAction", async () =>
    verifyInstall(resolve(import.meta.dir, "../../..")),
  );

type Flags = { records?: boolean; keyStdin?: boolean };
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
  const kernelOptions = campaignOptions(declaration, () =>
    piRuntime(declaration.settings, options.key),
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
  if (method === "resume") {
    const receipt = await requestOwner(await realpath(campaignPath(target)), {
      kind: "resume",
      records: records(),
    });
    if (receipt !== undefined) {
      await print(receipt);
      return;
    }
  }
  const { keyStdin } = program.opts<Flags>();
  const key = keyStdin ? (await Bun.stdin.text()).trim() : undefined;
  if (keyStdin && !key) throw new Error("Expected a credential on stdin");
  await withCampaign(target, { declaration, key }, async (engine, database) => {
    const control = await serveControl(database, engine);
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
  const receipt = await requestOwner(path, command);
  if (receipt !== undefined) await print(receipt);
  else
    await withCampaign(path, {}, async (engine) => {
      await print(await controlCommand(engine, command));
    });
}

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
program.command("inspect <campaign>").action(async (campaign: string) => {
  const snapshot = await inspectCampaign(campaignPath(campaign), records());
  await print(
    campaignReport(records() ? snapshot : { campaign: snapshot.campaign }),
  );
});
program
  .command("status <campaign>")
  .action(async (campaign: string) =>
    print(
      statusReport(await inspectCampaign(campaignPath(campaign), usageRecord)),
    ),
  );
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
  .command("edit <input> <campaign> <settings>")
  .description("Rewrite and verify a frozen corpus into a replacement revision")
  .action(async (file: string, campaign: string, settings: string) => {
    const input = await read(file);
    await runCampaign(
      campaign,
      readDeclaration({
        version: declarationVersion,
        kind: "xean.edit",
        input,
        task: input.task,
        settings: await read(settings),
      }),
    );
  });
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
    (campaign.task as Declaration).kind !== "xean.solve" ||
    campaign.status !== "completed" ||
    !result?.argument
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
