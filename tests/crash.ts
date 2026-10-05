import { open } from "../src/host.ts";
import { context, fixture, task, settings, recoveryRoles } from "./fixture.ts";
const provider = fixture(async (role) => {
  if (role === "coordinator")
    return { work: [{ kind: "explorer", guidance: "survive" }] };
  console.log("ready");
  return new Response(Bun.stdin.stream()).text();
});
const owner = await open(process.argv[2]!, {
  create: { task, settings },
  models: provider.models,
  roles: recoveryRoles,
});
await owner.root.waitForIdle(context);
