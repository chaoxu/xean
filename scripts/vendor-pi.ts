import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const metadata = await Bun.file(join(root, "vendor/pi-ai.json")).json();
const sha256 = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const patch = await readFile(join(root, metadata.patch));
if (sha256(patch) !== metadata.patchSha256)
  throw new Error("Pi patch digest differs from its provenance");
const artifact = join(root, metadata.artifact);
if (dirname(artifact) !== join(root, "vendor"))
  throw new Error("Invalid Pi artifact path");
if (sha256(await readFile(artifact)) !== metadata.artifactSha256)
  throw new Error("Pi artifact digest differs from its provenance");
const temporary = await mkdtemp(join(tmpdir(), "elenx-pi-rebuild-"));
async function run(args: string[], cwd: string) {
  const process = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [status, error] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
    new Response(process.stdout).text(),
  ]);
  if (status !== 0) throw new Error(args[0] + " failed: " + error);
}
try {
  const response = await fetch(metadata.source);
  if (!response.ok)
    throw new Error("Pi source download failed: " + response.status);
  const source = new Uint8Array(await response.arrayBuffer());
  if (
    "sha512-" + createHash("sha512").update(source).digest("base64") !==
    metadata.sourceIntegrity
  )
    throw new Error("Pi source integrity mismatch");
  await writeFile(join(temporary, "source.tgz"), source);
  await run(
    ["tar", "-xzf", join(temporary, "source.tgz"), "-C", temporary],
    temporary,
  );
  const unpacked = join(temporary, "package");
  await run(["git", "apply", "--", join(root, metadata.patch)], unpacked);
  const manifestPath = join(unpacked, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const rebuilt = join(temporary, "rebuilt.tgz");
  await run(
    [
      process.execPath,
      "pm",
      "pack",
      "--filename",
      rebuilt,
      "--ignore-scripts",
      "--quiet",
    ],
    unpacked,
  );
  const recorded = join(temporary, "recorded");
  const reproduced = join(temporary, "reproduced");
  await mkdir(recorded);
  await mkdir(reproduced);
  await run(["tar", "-xzf", artifact, "-C", recorded], temporary);
  await run(["tar", "-xzf", rebuilt, "-C", reproduced], temporary);
  // Bun's archive metadata can vary. Compare every packaged file's contents
  // and executable mode, while the recorded archive itself has a pinned hash.
  await run(
    [
      "git",
      "diff",
      "--no-index",
      "--exit-code",
      "--",
      join(recorded, "package"),
      join(reproduced, "package"),
    ],
    temporary,
  );
  console.log(
    "Pi artifact contents reproduce from the pinned source and reviewed patch.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
