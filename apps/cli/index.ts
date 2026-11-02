#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { version } from "../../package.json";
import {
  open,
  inspect,
  exportAccepted,
  readStatus,
  readReport,
  submitNotes,
  guide,
} from "../../src/index.ts";
import { cliModels } from "./models.ts";
import { createActivityHandler } from "../../src/activity.ts";

const print = (value: unknown) =>
  Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
const program = new Command("xean")
  .description("Mathematical research with joint dependency reconstruction")
  .version(version);
program
  .command("init <task> <campaign> <settings>")
  .description("Freeze a task and settings in a fresh campaign database")
  .option(
    "--verify-on-solution",
    "Defer verification until a claimed complete solution",
  )
  .action(
    async (
      task: string,
      campaign: string,
      settings: string,
      options: { verifyOnSolution?: boolean },
    ) => {
      const config = await Bun.file(settings).json();
      if (options.verifyOnSolution) config.verifyOnSolution = true;
      const owner = await open(resolve(campaign), {
        create: {
          task: await Bun.file(task).json(),
          settings: config,
        },
      });
      try {
        await print(
          await owner.root.commit(
            (tx) => readStatus(tx, owner.root.id),
            context,
          ),
        );
      } finally {
        await owner.close();
      }
    },
  );
for (const command of ["run", "resume"] as const) {
  program
    .command(`${command} <campaign>`)
    .description(
      command === "run"
        ? "Run or recover the current native campaign task"
        : "Explicitly resume a stopped campaign with its recorded progress",
    )
    .option("--activity-url <url>", "Observe and announce Explorer activity")
    .option("--activity-scope <scope>", "Exact shared problem identity")
    .option(
      "--activity-owner <label>",
      "Agent label, defaults to campaign name",
    )
    .action(
      async (
        campaign: string,
        options: {
          activityUrl?: string;
          activityScope?: string;
          activityOwner?: string;
        },
      ) => {
        if (
          (options.activityUrl ||
            options.activityScope ||
            options.activityOwner) &&
          !(options.activityUrl && options.activityScope)
        )
          throw new Error(
            "Activity requires --activity-url and --activity-scope",
          );
        const owner = await open(resolve(campaign), {
          models: await cliModels(),
          activity: options.activityUrl
            ? {
                url: options.activityUrl,
                scope: options.activityScope!,
                owner: options.activityOwner ?? basename(campaign),
                token: process.env.XEAN_ACTIVITY_TOKEN || undefined,
              }
            : undefined,
        });
        let interrupted = false;
        const stop = () => {
          interrupted = true;
          void owner.close().catch(() => {});
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        try {
          if (command === "resume") await owner.resume();
          if (!interrupted) await owner.root.waitForIdle(context);
        } catch (error) {
          if (!interrupted) throw error;
        } finally {
          process.off("SIGINT", stop);
          process.off("SIGTERM", stop);
          await owner.close();
        }
        await print(await inspect(resolve(campaign), readStatus));
        if (interrupted) process.exitCode = 130;
      },
    );
}
program
  .command("activity-serve")
  .description("Serve temporary agent activity in memory")
  .option("--hostname <host>", "Listen address", "127.0.0.1")
  .option("--port <port>", "Listen port", "3480")
  .action(async (options: { hostname: string; port: string }) => {
    const token = process.env.XEAN_ACTIVITY_TOKEN || undefined;
    if (!["127.0.0.1", "::1", "localhost"].includes(options.hostname) && !token)
      throw new Error(
        "Non-loopback activity serving requires XEAN_ACTIVITY_TOKEN",
      );
    const server = Bun.serve({
      hostname: options.hostname,
      port: z.coerce.number().int().min(0).max(65535).parse(options.port),
      fetch: createActivityHandler({ token }),
    });
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await print({ url: server.url.toString() });
      await stopped;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.stop(true);
    }
  });
for (const command of ["submit", "guide"] as const) {
  program
    .command(`${command} <campaign> <input>`)
    .description(
      command === "submit"
        ? "Queue caller notes while the campaign owner is closed"
        : "Add guidance while the campaign owner is closed",
    )
    .requiredOption("--id <id>", "Stable request ID for exact retries")
    .action(
      async (campaign: string, input: string, options: { id: string }) => {
        const value =
          command === "submit"
            ? await Bun.file(input).json()
            : await Bun.file(input).text();
        const owner = await open(resolve(campaign));
        try {
          const receipt = await owner.root.commit(
            async (tx) =>
              command === "submit"
                ? submitNotes(tx, owner.root.id, options.id, value)
                : guide(tx, owner.root.id, options.id, value),
            context,
          );
          await print(receipt);
        } finally {
          await owner.close();
        }
      },
    );
}
program
  .command("status <campaign>")
  .description("Read compact campaign status without starting work")
  .action(async (campaign: string) => {
    await print(await inspect(resolve(campaign), readStatus));
  });
program
  .command("inspect <campaign>")
  .description(
    "Read the task, notebook, and verification evidence without starting work",
  )
  .action(async (campaign: string) => {
    await print(await inspect(resolve(campaign), readReport));
  });
program
  .command("export <campaign>")
  .description("Write the accepted argument and its support as Markdown")
  .action(async (campaign: string) => {
    await Bun.write(Bun.stdout, await exportAccepted(resolve(campaign)));
  });

await program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
