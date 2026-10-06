import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { open } from "../../src/host.ts";
import { Control } from "../../src/workflow.ts";
import { readReport } from "../../src/report.ts";
import type { OwnerCommand } from "./control.ts";

export type Owner = Awaited<ReturnType<typeof open>>;
export const observeOwner = (owner: Owner) =>
  owner.root.commit((tx) => readReport(tx, owner.root.id), BACKGROUND_CONTEXT);

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
  if (
    before.status.status === "completed" ||
    before.status.status === "cancelled"
  ) {
    if (command.kind === "resume")
      throw new Error("Cannot resume terminal research");
    return before.status;
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
  return (await observeOwner(owner)).status;
}
