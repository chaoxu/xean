import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const fleet = resolve(
  process.env.XEAN_FLEET_INFRA ?? resolve(root, "../fleet-infra"),
);
const [command = "check", ...args] = process.argv.slice(2);
const flake = `path:${fleet}#fleet-run`;
const check = (source: string, mode: string, tests: string[] = []) => [
  "--read-only-dir",
  source,
  "build",
  "--file",
  resolve(source, "nix/check.nix"),
  "--impure",
  "--no-link",
  "--print-build-logs",
  "--argstr",
  "fleetRoot",
  fleet,
  "--argstr",
  "projectRoot",
  source,
  "--argstr",
  "tests",
  tests.join(" "),
  "--argstr",
  "mode",
  mode,
];

async function run(argv: string[], cwd: string) {
  const code = await Bun.spawn(argv, {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, FLEET_INFRA_ROOT: fleet },
  }).exited;
  if (code !== 0) throw new Error(`Command failed with status ${code}`);
}

let argv: string[];
if (command === "check" || command === "test") {
  for (const file of args)
    if (!/^tests\/[\w./-]+\.test\.ts$/.test(file))
      throw new Error(`Invalid test path: ${file}`);
  argv = check(root, command, args);
} else if (command === "format") {
  argv = [
    "run",
    flake,
    "--",
    resolve(root, "node_modules/prettier/bin/prettier.cjs"),
    "--write",
    ...[
      "src",
      "apps",
      "tests",
      "scripts",
      "examples",
      "README.md",
      "AGENTS.md",
      "docs",
      "package.json",
      "tsconfig.json",
    ].map((path) => resolve(root, path)),
  ];
} else if (command === "install") {
  argv = [
    "run",
    flake,
    "--",
    "install",
    "--cwd",
    root,
    "--ignore-scripts",
    ...(args.includes("--update-lockfile") ? [] : ["--frozen-lockfile"]),
  ];
} else if (command === "distribution") {
  if (args.length) throw new Error("Usage: scripts/dev.ts distribution");
  const directory = await mkdtemp(resolve(tmpdir(), "xean-distribution-"));
  try {
    const archive = resolve(directory, "source.tgz");
    await run(
      [
        process.execPath,
        "pm",
        "pack",
        "--ignore-scripts",
        "--quiet",
        "--filename",
        archive,
      ],
      root,
    );
    // npm-style packing omits Bun's lockfile. A reproducible source archive
    // carries it alongside the native packer's selected files.
    const files = await new Bun.Archive(
      await Bun.file(archive).bytes(),
    ).files();
    const lockfile = await Bun.file(resolve(root, "bun.lock")).text();
    const bytes = await new Bun.Archive(
      {
        ...Object.fromEntries(files),
        "package/bun.lock": lockfile,
      },
      { compress: "gzip" },
    ).bytes();
    await new Bun.Archive(bytes).extract(directory);
    const source = resolve(directory, "package");
    if ((await Bun.file(resolve(source, "bun.lock")).text()) !== lockfile)
      throw new Error("Source archive changed the frozen lockfile");
    await run(
      [
        process.execPath,
        "install",
        "--cwd",
        source,
        "--production",
        "--frozen-lockfile",
        "--ignore-scripts",
      ],
      source,
    );
    await run(
      [resolve(fleet, "bin/fleet-nix"), ...check(source, "distribution")],
      fleet,
    );
    console.log(
      JSON.stringify({
        distribution: "PASS",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  process.exit(0);
} else
  throw new Error(
    "Usage: scripts/dev.ts check|test [tests/*.test.ts]|format|install [--update-lockfile]|distribution",
  );
await run([resolve(fleet, "bin/fleet-nix"), ...argv], fleet);
