import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { open } from "../../src/host.ts";
import { Control } from "../../src/workflow.ts";
import { readStatus } from "../../src/report.ts";
import { serveControl, type OwnerCommand } from "./control.ts";

export type Owner = Awaited<ReturnType<typeof open>>;
export const observeOwner = (owner: Owner) =>
  owner.root.commit((tx) => readStatus(tx, owner.root.id), BACKGROUND_CONTEXT);

/** Serve live controls while Pi runs; the caller owns the final close. */
export async function runOwner(
  owner: Owner,
  path: string,
  finish: () => Promise<unknown>,
  options: { resume?: boolean; ownerId?: string } = {},
) {
  let control: Awaited<ReturnType<typeof serveControl>> | undefined;
  let shutdown: Promise<unknown> | undefined;
  const interrupt = () => {
    process.exitCode = 130;
    shutdown ??= Promise.all([control?.close(true), owner.close()]);
    void shutdown.catch(() => {});
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    control = await serveControl(
      path,
      (command) => controlCommand(owner, command),
      options.ownerId,
    );
    if (shutdown) return;
    if (options.resume) await controlCommand(owner, { kind: "resume" });
    else await owner.root.waitForIdle(BACKGROUND_CONTEXT);
    await control.close();
    if (!shutdown) await finish();
  } catch (error) {
    if (!shutdown) throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await control?.close(true);
    await shutdown;
  }
}

/** CLI policy changes native conversation documents; Pi executes and drains work. */
export async function controlCommand(owner: Owner, command: OwnerCommand) {
  if (
    command.kind !== "pause" &&
    command.kind !== "resume" &&
    command.kind !== "cancel"
  ) {
    const id = await owner.root.commit(
      (tx) => owner.workflow.input(tx, owner.root.id, command),
      BACKGROUND_CONTEXT,
    );
    return { id, command };
  }
  const before = await observeOwner(owner);
  if (before.status === "completed" || before.status === "cancelled") {
    if (command.kind === "resume")
      throw new Error("Cannot resume terminal research");
    return before;
  }
  await owner.root.commit(async (tx) => {
    if (command.kind === "resume")
      await owner.workflow.resume(tx, owner.root.id);
    else {
      const control = await tx.doc(Control, owner.root.id);
      if (command.kind === "cancel") control.cancelled = true;
      else control.paused = true;
    }
  }, BACKGROUND_CONTEXT);
  if (command.kind === "cancel") await owner.root.abort(BACKGROUND_CONTEXT);
  else await owner.root.waitForIdle(BACKGROUND_CONTEXT);
  return observeOwner(owner);
}
