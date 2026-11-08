#!/usr/bin/env bun
import { resolve } from "node:path";
import { Command } from "commander";
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

const print = (value: unknown) =>
  Bun.write(Bun.stdout, JSON.stringify(value, null, 2) + "\n");
const program = new Command("xean")
  .description("Mathematical research with conditional note verification")
  .version(version);
program
  .command("init <task> <campaign> <settings>")
  .description("Freeze a task and settings in a fresh campaign database")
  .option(
    "--verify-on-solution",
    "Defer checks until a Verifier selects a claimed complete solution",
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
      await using owner = await open(resolve(campaign), {
        create: {
          task: await Bun.file(task).json(),
          settings: config,
        },
      });
      await print(readStatus(owner.state));
    },
  );
for (const command of ["run", "resume"] as const) {
  program
    .command(`${command} <campaign>`)
    .description(
      command === "run"
        ? "Run or recover the current campaign"
        : "Explicitly resume a stopped campaign with its recorded progress",
    )
    .action(async (campaign: string) => {
      const owner = await open(resolve(campaign), {
        execute: true,
        models: await cliModels(),
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
        if (!interrupted) await owner.wait();
      } catch (error) {
        if (!interrupted) throw error;
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await owner.close();
      }
      await print(await inspect(resolve(campaign), readStatus));
      if (interrupted) process.exitCode = 130;
    });
}
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
        await using owner = await open(resolve(campaign));
        const receipt = await owner.change((data) =>
          command === "submit"
            ? submitNotes(data, options.id, value)
            : guide(data, options.id, value),
        );
        await print(receipt);
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
