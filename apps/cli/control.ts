import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SolverCommand } from "../../src/math/commands.ts";

export type OwnerCommand =
  SolverCommand | { kind: "pause" | "resume" | "cancel" };

export type ControlErrorCode =
  "owner_stopping" | "owner_changed" | "command_rejected";

export type ControlErrorBody = {
  error: { code: ControlErrorCode; message: string };
};

const reject = (code: ControlErrorCode, message: string, status = 400) =>
  Response.json({ error: { code, message } }, { status });

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
    // A failed connection must not hide an unrelated file at the socket path.
    try {
      if (!(await lstat(path)).isSocket())
        throw new Error("Control path is not a socket");
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
    }
    if (expectedOwnerId !== undefined)
      throw new Error("Expected campaign owner is unavailable");
    return undefined;
  }
  const value = await response.json();
  if (!response.ok) {
    const error = (value as Partial<ControlErrorBody>).error;
    throw new Error(
      typeof error === "object" && error !== null && "message" in error
        ? error.message
        : `Owner rejected command: HTTP ${response.status}`,
    );
  }
  return value;
}

/** Start only after the native host has acquired exclusive ownership. */
export async function serveControl(
  database: string,
  execute: (command: OwnerCommand) => Promise<unknown>,
  ownerId?: string,
) {
  const path = socketPath(database);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
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
      if (stopping) return reject("owner_stopping", "Owner is stopping", 503);
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/command"
      )
        return new Response("Not found", { status: 404 });
      try {
        const { expectedOwnerId, ...command } =
          (await request.json()) as OwnerCommand & { expectedOwnerId?: string };
        if (expectedOwnerId !== undefined && expectedOwnerId !== ownerId)
          return reject("owner_changed", "Campaign owner changed");
        if (command.kind === "resume" && stopping)
          return reject("owner_stopping", "Owner is stopping");
        if (["pause", "resume", "cancel"].includes(command.kind))
          server.timeout(request, 0);
        const operation = execute(command);
        if (command.kind === "resume") resumes.add(operation);
        return Response.json(
          await operation.finally(() => resumes.delete(operation)),
        );
      } catch (error) {
        return reject(
          "command_rejected",
          error instanceof Error ? error.message : String(error),
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
