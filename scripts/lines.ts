import { resolve } from "node:path";

const directories = process.argv.slice(2);
if (directories.length === 0) directories.push(".");
console.log(
  "Physical TS/JS lines in tracked working-tree files, including comments and blanks.\n",
);
for (const directory of directories) {
  const root = resolve(directory);
  const git = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  const kernel =
    (await Bun.file(resolve(root, "package.json")).json()).name === "xean";
  const counts = new Map<string, { files: number; lines: number }>();
  let production = 0;
  for (const path of git.stdout.toString().split("\0")) {
    if (!/\.[cm]?[jt]sx?$/.test(path) || /^(vendor|runs)\//.test(path))
      continue;
    const file = Bun.file(resolve(root, path));
    if (!(await file.exists())) continue;
    const text = await file.text();
    const lines =
      text === "" ? 0 : text.split("\n").length - Number(text.endsWith("\n"));
    const group =
      /(^|\/)(tests?|fixtures)\//.test(path) ||
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
        ? "Tests and fixtures"
        : /(^|\/)(scripts|examples)\//.test(path)
          ? "Scripts and examples"
          : path.startsWith("packages/solve/")
            ? "Solver"
            : path === "src/observe.ts"
              ? "Observe API"
              : path.startsWith("src/") && kernel
                ? "Kernel and Pi"
                : "Application";
    const count = counts.get(group) ?? { files: 0, lines: 0 };
    count.files++;
    count.lines += lines;
    counts.set(group, count);
    if (group !== "Tests and fixtures" && group !== "Scripts and examples")
      production += lines;
  }
  console.log(root);
  console.log("| Area | Files | Lines |\n| --- | ---: | ---: |");
  for (const [group, { files, lines }] of counts)
    console.log(`| ${group} | ${files} | ${lines} |`);
  console.log(
    `Production: ${production}; total: ${[...counts.values()].reduce((sum, count) => sum + count.lines, 0)}\n`,
  );
}
