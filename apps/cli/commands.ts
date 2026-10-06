import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { open, inspect } from "../../src/host.ts";
import type { Definition } from "../../src/definition.ts";
import { readCommand } from "../../src/math/commands.ts";
import { acceptedArgument } from "../../src/math/argument.ts";
import { readReport } from "../../src/report.ts";
import { version } from "../../package.json";
import { requestOwner, serveControl, type OwnerCommand } from "./control.ts";
import { controlCommand, observeOwner, type Owner } from "./lifecycle.ts";
import { doctor } from "./doctor.ts";
import { verifyInstall } from "../../scripts/dependencies.ts";

const print = (value: unknown) =>
  Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
const read = (path: string) => Bun.file(resolve(path)).json();
const program = new Command("xean")
  .description("Native Pi mathematical research")
  .version(version)
  .option("--campaign-dir <dir>", "Directory for named campaigns", ".xean")
  .option("--owner-id <id>", "Identify this owner")
  .option("--expected-owner-id <id>", "Require this active owner")
  .option("--usage-prefix <prefix>", "Execution-specific usage attribution")
  .option("--key-stdin", "Read this owner's provider credential from stdin")
  .configureHelp({ showGlobalOptions: true })
  .hook("preAction", async (_program, action) => {
    if (action.name() !== "doctor") await verifyInstall();
    if (
      program.opts<Flags>().expectedOwnerId !== undefined &&
      !["resume", "pause", "cancel", "submit", "guide", "correct"].includes(
        action.name(),
      )
    )
      throw new Error("--expected-owner-id requires a live control command");
  });
type Flags = {
  ownerId?: string;
  expectedOwnerId?: string;
  usagePrefix?: string;
  keyStdin?: boolean;
};

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

async function withOwner(
  target: string,
  create: Definition | undefined,
  action: (owner: Owner, path: string) => Promise<unknown>,
) {
  const requested = campaignPath(target);
  const path = create ? requested : await realpath(requested);
  const { keyStdin, usagePrefix } = program.opts<Flags>();
  const key = keyStdin ? (await Bun.stdin.text()).trim() : undefined;
  if (keyStdin && !key) throw new Error("Expected a credential on stdin");
  const owner = await open(path, { create, key, usagePrefix });
  try {
    return await action(owner, await realpath(path));
  } finally {
    await owner.close();
  }
}

async function runCampaign(
  target: string,
  create?: Definition,
  resume = false,
) {
  const flags = program.opts<Flags>();
  return withOwner(target, create, async (owner, path) => {
    const control = await serveControl(
      path,
      (command) => controlCommand(owner, command),
      flags.ownerId,
    );
    let shutdown: Promise<unknown> | undefined;
    const interrupt = () => {
      shutdown ??= Promise.all([control.close(true), owner.close()]);
      void shutdown.catch(() => {});
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      if (resume) await controlCommand(owner, { kind: "resume" });
      else await owner.root.waitForIdle(BACKGROUND_CONTEXT);
      await control.close();
      if (!shutdown) await print((await observeOwner(owner)).status);
    } catch (error) {
      if (!shutdown) throw error;
      process.exitCode = 130;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      await control.close(true);
      await shutdown;
    }
  });
}

async function send(target: string, command: OwnerCommand) {
  const path = await realpath(campaignPath(target));
  const flags = program.opts<Flags>();
  if (
    flags.usagePrefix !== undefined ||
    flags.keyStdin ||
    flags.ownerId !== undefined
  ) {
    if (flags.expectedOwnerId !== undefined)
      throw new Error("Execution overrides require local ownership");
  } else {
    const receipt = await requestOwner(path, command, flags.expectedOwnerId);
    if (receipt !== undefined) return print(receipt);
  }
  if (command.kind === "resume") return runCampaign(path, undefined, true);
  return withOwner(path, undefined, async (owner) =>
    print(await controlCommand(owner, command)),
  );
}

program.command("doctor <settings>").action(async (file: string) => {
  const result = await doctor(file);
  await print(result);
  if (!result.ok) process.exitCode = 1;
});
program
  .command("init <task> <campaign> <settings>")
  .action(async (task: string, campaign: string, settings: string) => {
    const definition = {
      task: await read(task),
      settings: await read(settings),
    };
    await withOwner(campaign, definition, async (owner) =>
      print((await observeOwner(owner)).status),
    );
  });
program.command("run <campaign>").action(async (campaign: string) => {
  await runCampaign(campaign);
});
program.command("resume <campaign>").action(async (campaign: string) => {
  await send(campaign, { kind: "resume" });
});
for (const kind of ["pause", "cancel"] as const)
  program.command(`${kind} <campaign>`).action(async (campaign: string) => {
    await send(campaign, { kind });
  });
program.command("status <campaign>").action(async (campaign: string) => {
  const report = await inspect(campaignPath(campaign), readReport);
  await print({ observedAt: new Date().toISOString(), ...report.status });
});
program
  .command("inspect <campaign>")
  .option("--records", "Include native tasks and transcript records")
  .action(async (campaign: string, flags: { records?: boolean }) => {
    await print(
      await inspect(campaignPath(campaign), (tx, root) =>
        readReport(tx, root, { records: flags.records }),
      ),
    );
  });
program.command("export <campaign>").action(async (campaign: string) => {
  const report = await inspect(campaignPath(campaign), readReport);
  if (report.status.acceptedNoteId === null)
    throw new Error("No accepted argument");
  await Bun.write(
    Bun.stdout,
    acceptedArgument(report.notes, report.status.acceptedNoteId) + "\n",
  );
});
program
  .command("role <name> <input> <campaign> <settings>")
  .action(
    async (name: string, file: string, campaign: string, settings: string) => {
      const { task, ...input } = await read(file);
      await runCampaign(campaign, {
        task,
        settings: await read(settings),
        mode: { role: name, input },
      });
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
      await runCampaign(campaign, {
        task: await read(task),
        settings: await read(settings),
        mode: {
          role: "review",
          input: { argument: await Bun.file(resolve(argument)).text() },
        },
      });
    },
  );
for (const kind of ["submit", "guide", "correct"] as const)
  program
    .command(`${kind} <campaign> <file>`)
    .requiredOption("--id <id>", "Stable command ID for exact retries")
    .action(async (campaign: string, file: string, flags: { id: string }) => {
      const content =
        kind === "guide"
          ? { text: await Bun.file(resolve(file)).text() }
          : await read(file);
      await send(campaign, readCommand({ ...content, kind, id: flags.id }));
    });

await program.parseAsync();
