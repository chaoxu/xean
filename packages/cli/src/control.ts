import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Xean } from "xean";
import { submitCommand, type SolverCommand } from "xean/solve";
import { campaignReport } from "xean/report";

export type OwnerCommand =
  SolverCommand | { kind: "pause" | "resume" | "cancel"; records: boolean };

export async function controlCommand(engine: Xean, command: OwnerCommand) {
  switch (command.kind) {
    case "pause":
    case "resume":
    case "cancel":
      await engine[command.kind]();
      return ownerReport(engine, command.records);
    default:
      return submitCommand(engine, command);
  }
}

export async function ownerReport(engine: Xean, records: boolean) {
  const snapshot = records
    ? await engine.inspectWithRecords()
    : { campaign: await engine.inspect() };
  return campaignReport(snapshot);
}

/** The caller resolves the database's real path before choosing its socket. */
export function socketPath(database: string): string {
  const name = `${createHash("sha256").update(database).digest("hex").slice(0, 24)}.sock`;
  // Stable across client environments and below macOS's 104-byte address limit.
  return join("/tmp", `xean-${process.getuid?.() ?? "user"}`, name);
}

/** Failure to connect permits trying exclusive database ownership locally. */
export async function requestOwner(
  database: string,
  command: OwnerCommand,
  expectedOwnerId?: string,
): Promise<unknown | undefined> {
  const path = socketPath(database);
  let response: Response;
  try {
    const uid = process.getuid?.();
    const directory = await lstat(dirname(path));
    if (
      !directory.isDirectory() ||
      directory.uid !== uid ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error(
        "Control socket directory must be private and belong to the current user",
      );
    const socket = await lstat(path);
    if (!socket.isSocket()) throw new Error("Control path is not a socket");
    if (socket.uid !== uid)
      throw new Error("Control socket must belong to the current user");
    response = await fetch("http://xean/command", {
      unix: path,
      timeout: false,
      redirect: "error",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...command, expectedOwnerId }),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      ![
        "ENOENT",
        "ECONNREFUSED",
        "ConnectionRefused",
        "FailedToOpenSocket",
      ].includes(code ?? "")
    )
      throw error;
    // Bun collapses path and permission errors into FailedToOpenSocket.
    try {
      if (!(await lstat(path)).isSocket())
        throw new Error("Control path is not a socket");
      await access(path, constants.W_OK);
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
    if (expectedOwnerId !== undefined)
      throw new Error("Expected campaign owner is unavailable");
    return undefined;
  }
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      (value as { error?: string }).error ??
        `Owner rejected command: HTTP ${response.status}`,
    );
  return value;
}

/** Start only after acquiring this campaign's exclusive kernel ownership. */
export async function serveControl(
  database: string,
  engine: Xean,
  ownerId?: string,
) {
  const path = socketPath(database);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const permissions = await lstat(directory);
  if (!permissions.isDirectory() || permissions.uid !== process.getuid?.())
    throw new Error("Control socket directory must belong to the current user");
  await chmod(directory, 0o700);
  const stale = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (stale) {
    if (!stale.isSocket())
      throw new Error("Control socket path is not a socket");
    await unlink(path);
  }

  let stopping = false;
  const resumes = new Set<Promise<unknown>>();
  const server = Bun.serve({
    unix: path,
    async fetch(request, server) {
      if (stopping)
        return Response.json({ error: "Owner is stopping" }, { status: 503 });
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/command"
      )
        return new Response("Not found", { status: 404 });
      try {
        const { expectedOwnerId, ...command } =
          (await request.json()) as OwnerCommand & { expectedOwnerId?: string };
        if (expectedOwnerId !== undefined && expectedOwnerId !== ownerId)
          throw new Error("Campaign owner changed");
        if (command.kind === "resume" && stopping)
          throw new Error("Owner is stopping");
        if (["pause", "resume", "cancel"].includes(command.kind))
          server.timeout(request, 0);
        const operation = controlCommand(engine, command);
        if (command.kind === "resume") resumes.add(operation);
        return Response.json(
          await operation.finally(() => resumes.delete(operation)),
        );
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
    },
  });
  const close = async (interrupt = false) => {
    // A resume accepted as the original run finishes keeps this owner serving.
    while (!interrupt && resumes.size) await Promise.allSettled(resumes);
    stopping = true;
    // Interrupt closes incomplete request bodies. Bun still drains handlers
    // committing parsed commands before removing the socket.
    return server.stop(interrupt);
  };
  try {
    await chmod(path, 0o600);
  } catch (error) {
    await close();
    throw error;
  }
  return { close };
}
