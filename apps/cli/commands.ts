import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import {
  open,
  inspect,
  exportAccepted,
  type OpenOptions,
} from "../../src/host.ts";
import { type Definition } from "../../src/core/definition.ts";
import { readCommand } from "../../src/core/math/commands.ts";
import { readReport, readStatus } from "../../src/report.ts";
import { version } from "../../package.json";
import { requestOwner, type OwnerCommand } from "./control.ts";
import {
  controlCommand,
  observeOwner,
  runOwner,
  type Owner,
} from "./lifecycle.ts";
import { doctor } from "./doctor.ts";
import { cliModels } from "./models.ts";
import { hostPath, runHost, type HostCommand } from "./host.ts";

const print = (value: unknown) =>
  Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
const read = (path: string) => Bun.file(resolve(path)).json();
const program = new Command("xean")
  .description("Native Pi mathematical research")
  .version(version)
  .option("--campaign-dir <dir>", "Directory for named campaigns", ".xean")
  .option("--owner-id <id>", "Identify this owner")
  .option("--expected-owner-id <id>", "Require this active owner")
  .option("--usage-prefix <prefix>", "Native Pi usage attribution")
  .option("--key-stdin", "Read this owner's provider credential from stdin")
  .option("--roles <module>", "Load an explicit role factory module")
  .configureHelp({ showGlobalOptions: true })
  .hook("preAction", (_program, action) => {
    if (
      program.opts<Flags>().expectedOwnerId !== undefined &&
      ![
        "resume",
        "pause",
        "cancel",
        "submit",
        "guide",
        "recheck",
        "attach",
        "detach",
      ].includes(action.name())
    )
      throw new Error("--expected-owner-id requires a live control command");
  });
type Flags = {
  ownerId?: string;
  expectedOwnerId?: string;
  usagePrefix?: string;
  keyStdin?: boolean;
  roles?: string;
};

async function readRoles(): Promise<OpenOptions["roles"]> {
  const requested = program.opts<Flags>().roles;
  if (!requested) return undefined;
  const path = await realpath(resolve(requested)).catch(() => {
    throw new Error(`Role module does not exist: ${requested}`);
  });
  const { default: roles } = await import(pathToFileURL(path).href);
  if (typeof roles !== "function")
    throw new Error(`Role module must export a default factory: ${path}`);
  return roles;
}

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
  const owner = await open(path, {
    create,
    ...(await executionOptions()),
  });
  try {
    return await action(owner, await realpath(path));
  } finally {
    await owner.close();
  }
}

async function readKey() {
  if (!program.opts<Flags>().keyStdin) return undefined;
  const key = (await Bun.stdin.text()).trim();
  if (!key) throw new Error("Expected a credential on stdin");
  return key;
}

async function executionOptions() {
  const { usagePrefix, ownerId } = program.opts<Flags>();
  return {
    key: await readKey(),
    models: await cliModels(),
    roles: await readRoles(),
    usagePrefix,
    ownerId,
  };
}

async function runCampaign(
  target: string,
  create?: Definition,
  resume = false,
) {
  return withOwner(target, create, (owner, path) =>
    runOwner(owner, path, async () => print(await observeOwner(owner)), {
      resume,
      ownerId: program.opts<Flags>().ownerId,
    }),
  );
}

async function send(target: string, command: OwnerCommand) {
  const path = await realpath(campaignPath(target));
  const flags = program.opts<Flags>();
  if (
    flags.usagePrefix !== undefined ||
    flags.keyStdin ||
    flags.roles !== undefined ||
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
  const result = await doctor(file, await readKey());
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
      print(await observeOwner(owner)),
    );
  });
program.command("run <campaign>").action(async (campaign: string) => {
  await runCampaign(campaign);
});
program
  .command("host")
  .description("Run named campaigns in one foreground process")
  .action(async () => {
    const flags = program.opts<Flags & { campaignDir: string }>();
    await runHost(flags.campaignDir, await executionOptions());
  });
for (const kind of ["attach", "detach"] as const)
  program.command(`${kind} <campaign>`).action(async (campaign: string) => {
    const flags = program.opts<Flags & { campaignDir: string }>();
    if (flags.roles || flags.keyStdin || flags.ownerId || flags.usagePrefix)
      throw new Error("Set execution overrides on the shared host");
    const directory = await realpath(resolve(flags.campaignDir));
    const receipt = await requestOwner<HostCommand>(
      hostPath(directory),
      {
        kind,
        database: await realpath(campaignPath(campaign)),
      },
      flags.expectedOwnerId,
    );
    if (receipt === undefined)
      throw new Error("No shared host is running for this campaign directory");
    await print(receipt);
  });
for (const kind of ["resume", "pause", "cancel"] as const)
  program.command(`${kind} <campaign>`).action(async (campaign: string) => {
    await send(campaign, { kind });
  });
program.command("status <campaign>").action(async (campaign: string) => {
  const status = await inspect(campaignPath(campaign), readStatus);
  await print({ observedAt: new Date().toISOString(), ...status });
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
  const argument = await exportAccepted(campaignPath(campaign));
  await Bun.write(Bun.stdout, argument + "\n");
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
for (const kind of ["submit", "guide", "recheck"] as const) {
  const command = program
    .command(`${kind} <campaign> <file>`)
    .requiredOption("--id <id>", "Stable command ID for exact retries");
  if (kind === "submit")
    command
      .description(
        "Publish notes with permanent IDs input/<command-id>/<name>, or edit existing IDs",
      )
      .option(
        "--untrusted",
        "Require ordinary verification of submitted notes and edits, overriding per-note trust",
      );
  command.action(
    async (
      campaign: string,
      file: string,
      flags: { id: string; untrusted?: boolean },
    ) => {
      const content =
        kind === "guide"
          ? { text: await Bun.file(resolve(file)).text() }
          : await read(file);
      const value = readCommand({ ...content, kind, id: flags.id });
      if (value.kind === "submit" && flags.untrusted)
        for (const note of [...value.notes, ...(value.edits ?? [])])
          note.trusted = false;
      await send(campaign, value);
    },
  );
}

await program.parseAsync();
