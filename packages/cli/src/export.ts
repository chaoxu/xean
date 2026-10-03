import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Campaign } from "xean";
import {
  closure,
  isSolverCampaign,
  project,
  type SolverResult,
} from "xean/solve";

type Artifact = {
  originalPath: string;
  path: string;
  bytes: number;
  sha256: string;
  executable: number;
};

const instructions = `# Accepted argument bundle

argument.md contains the accepted argument unchanged. result.json retains the
exact task, accepted note ID, and verification evidence. These are Xean's
internal acceptance records; they do not establish independent review.

manifest.json maps original worker paths to files under artifacts/<work-id>/,
with SHA-256 hashes, byte sizes, and executable permission bits. Only workers
whose notes contribute to the accepted argument are included. Original paths
in the argument are preserved; use the manifest to locate their copied files.

Inspect the retained programs, inputs, outputs, and commands before rerunning
them from their mapped directories. Absolute paths may need adjustment.
The export does not install dependencies or supply runtimes, credentials,
or external services.
The bundle does not guarantee that programs run in a different environment.
Worker artifacts are copied as retained; inspect their contents before sharing.
`;

/** Export only accepted solver results; ordinary export keeps its original bytes. */
export async function exportArgument(
  campaign: Campaign,
  destination?: string,
): Promise<string> {
  const result = campaign.result as {
    argument?: string;
    noteId: string;
    checks: { noteId: string }[];
  } | null;
  if (
    !isSolverCampaign(campaign) ||
    campaign.status !== "completed" ||
    typeof result?.argument !== "string" ||
    !result.argument
  )
    throw new Error("No accepted argument");
  if (destination === undefined) return result.argument;

  const notes = closure([result.noteId], project(campaign));
  const accepted = new Set(result.checks.map((check) => check.noteId));
  if (
    notes.length !== accepted.size ||
    notes.some((note) => !accepted.has(note.id))
  )
    throw new Error(
      "Accepted checks do not match the argument's dependency closure",
    );

  const requested = resolve(destination);
  const output = join(await realpath(dirname(requested)), basename(requested));
  const workspaces = [];
  for (const work of [...campaign.work].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (work.status !== "completed") continue;
    const value = work.result as unknown as SolverResult;
    if (value.kind !== "notes") continue;
    const noteIds = value.notes
      .map((note) => `${work.id}/${note.id}`)
      .filter((id) => accepted.has(id));
    if (!noteIds.length) continue;
    if (value.workspace === undefined && work.role !== "xean.codex") continue;
    if (!value.workspace || !isAbsolute(value.workspace))
      throw new Error(`Missing absolute workspace for ${work.id}`);
    if (!/^[A-Za-z0-9_-]+$/.test(work.id))
      throw new Error(`Unsafe artifact work ID: ${work.id}`);
    if (!(await lstat(value.workspace)).isDirectory())
      throw new Error(
        `Workspace must be a directory, not a symlink: ${value.workspace}`,
      );
    const source = await realpath(value.workspace);
    const within = relative(source, output);
    if (
      within === "" ||
      (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`))
    )
      throw new Error(
        "Bundle destination must be outside every source workspace",
      );
    const input = join(source, "input.json");
    if (
      !(await lstat(input)).isFile() ||
      !isDeepStrictEqual(JSON.parse(await readFile(input, "utf8")), work.input)
    )
      throw new Error(`Workspace input does not match ${work.id}`);
    workspaces.push({
      workId: work.id,
      originalPath: value.workspace,
      path: `artifacts/${work.id}`,
      noteIds,
    });
  }

  const stage = await mkdtemp(join(dirname(output), ".xean-bundle-"));
  let reserved = false;
  try {
    const artifacts: Artifact[] = [];
    const copy = async (source: string, path: string): Promise<void> => {
      const stat = await lstat(source);
      const target = join(stage, path);
      if (stat.isDirectory()) {
        await mkdir(target, { recursive: true });
        for (const name of (await readdir(source)).sort())
          await copy(join(source, name), `${path}/${name}`);
      } else if (stat.isFile()) {
        await copyFile(source, target);
        await chmod(target, stat.mode & 0o777);
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(target)) {
          hash.update(chunk);
          bytes += chunk.length;
        }
        artifacts.push({
          originalPath: source,
          path,
          bytes,
          sha256: hash.digest("hex"),
          executable: stat.mode & 0o111,
        });
      } else {
        throw new Error(
          `Artifact must be a regular file or directory: ${source}`,
        );
      }
    };
    for (const workspace of workspaces)
      await copy(workspace.originalPath, workspace.path);
    await writeFile(join(stage, "argument.md"), result.argument);
    await writeFile(
      join(stage, "result.json"),
      JSON.stringify(campaign.result, null, 2) + "\n",
    );
    await writeFile(
      join(stage, "manifest.json"),
      JSON.stringify(
        {
          format: "xean-argument-bundle/v1",
          noteId: result.noteId,
          workspaces,
          artifacts,
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(join(stage, "README.md"), instructions);
    // Reserve exclusively before rename: plain rename can replace an existing empty directory.
    await mkdir(output);
    reserved = true;
    await rename(stage, output);
    reserved = false;
  } finally {
    if (reserved) await rmdir(output);
    await rm(stage, { recursive: true, force: true });
  }
  return result.argument;
}
