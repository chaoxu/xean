import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type Patch = {
  package: string;
  path: string;
  sha256: string;
  files: Record<string, string>;
};
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export async function verifyInstall(root = resolve(import.meta.dir, "..")) {
  const manifest = JSON.parse(
    await readFile(resolve(root, "vendor/pi/provenance.json"), "utf8"),
  );
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const patches = new Map<string, Patch>();
  const configured = new Map(Object.entries(pkg.patchedDependencies ?? {}));
  for (const patch of manifest.patches as Patch[]) {
    const artifact = manifest.artifacts.find(
      (entry: { name: string }) => entry.name === patch.package,
    );
    const target = artifact && `${artifact.name}@${artifact.path}`;
    if (
      !target ||
      patches.has(patch.package) ||
      configured.get(target) !== patch.path
    )
      throw new Error(`Unmatched Pi patch: ${patch.path}`);
    if (sha256(await readFile(resolve(root, patch.path))) !== patch.sha256)
      throw new Error(`Changed Pi patch: ${patch.path}`);
    configured.delete(target);
    patches.set(patch.package, patch);
  }
  if (configured.size) throw new Error("Unrecorded dependency patch");
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(resolve(root, artifact.path));
    if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256)
      throw new Error(`Changed Pi artifact: ${artifact.path}`);
    if (pkg.overrides[artifact.name] !== `file:${artifact.path}`)
      throw new Error(`Pi package is not pinned: ${artifact.name}`);
    const installed = JSON.parse(
      await readFile(
        resolve(root, "node_modules", artifact.name, "package.json"),
        "utf8",
      ),
    );
    if (installed.version !== artifact.version)
      throw new Error(`Pi version mismatch: ${artifact.name}`);
    const changed = new Map(
      Object.entries(patches.get(artifact.name)?.files ?? {}),
    );
    for (const [name, file] of await new Bun.Archive(bytes).files()) {
      if (!name.startsWith("package/"))
        throw new Error("Unexpected Pi archive path");
      const relative = name.slice("package/".length);
      const current = await readFile(
        resolve(root, "node_modules", artifact.name, relative),
      );
      const patchedHash = changed.get(relative);
      if (
        patchedHash === undefined
          ? !current.equals(Buffer.from(await file.arrayBuffer()))
          : sha256(current) !== patchedHash
      )
        throw new Error(
          `Installed Pi differs from its recorded artifact and patches: ${artifact.name}/${relative}`,
        );
      changed.delete(relative);
    }
    if (changed.size)
      throw new Error(
        `Pi patch names an absent installed file: ${artifact.name}`,
      );
  }
}

if (import.meta.main) await verifyInstall();
