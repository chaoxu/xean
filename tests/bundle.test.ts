import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  campaignVersion,
  type Campaign,
  type JsonValue,
  type Work,
} from "xean";
import { completion, declarationVersion, project } from "xean/solve";
import { exportArgument } from "../packages/cli/src/export.ts";

async function fixture(
  run: (
    campaign: Campaign,
    directory: string,
    workspace: string,
  ) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "xean-bundle-test-"));
  const workspace = join(directory, "worker");
  const task = {
    problem: "Prove the exact claim.",
    completionCriteria: "A complete proof.",
  };
  const input = { task, notes: [], assignment: "Check the finite base case." };
  const note = {
    id: "n1",
    summary: "Claim",
    detailedSummary: "Claim and proof",
    text: "Proof with λ.\n\n",
    support: [] as string[],
  };
  const work = (
    id: string,
    result: JsonValue,
    publicationId: number,
  ): Work => ({
    id,
    role: "xean.explorer",
    input,
    status: "completed",
    result,
    taskId: publicationId as Work["taskId"],
    publicationId: publicationId as Work["publicationId"],
    attempts: 1,
    attemptId: id,
    error: null,
  });
  const pass = { verdict: "PASS", report: "Checked." };
  const campaign: Campaign = {
    version: campaignVersion,
    task: { kind: "xean.solve", version: declarationVersion, task },
    coordinator: "fixture",
    state: null,
    status: "completed",
    result: null,
    error: null,
    limits: { concurrency: 1, attempts: 1, providerCalls: null },
    providerCalls: 0,
    callAllowance: null,
    callLimitReached: false,
    inputs: [],
    pendingSignals: 0,
    work: [
      {
        ...work(
          "w1",
          { kind: "notes", workspace, candidate: false, notes: [note] },
          1,
        ),
        role: "xean.codex",
      },
      work(
        "w2",
        {
          kind: "notes",
          candidate: true,
          notes: [
            {
              ...note,
              text: `Proof using the base case.\n\nArtifacts: /unrelated/prose/path\n`,
              support: ["w1/n1"],
            },
          ],
        },
        2,
      ),
      {
        ...work(
          "checks",
          {
            kind: "verification",
            checks: ["w1/n1", "w2/n1"].map((noteId) => ({
              noteId,
              correctness: { ...pass, premises: [] },
              source: pass,
              ...(noteId === "w2/n1" ? { requirements: pass } : {}),
              reconstruction: {
                ...pass,
                statement: "Claim",
                proof: "Reconstructed.",
              },
            })),
          },
          3,
        ),
        role: "xean.verifier",
      },
      {
        ...work(
          "unrelated",
          {
            kind: "notes",
            workspace: "/not/a/retained/workspace",
            candidate: false,
            notes: [note],
          },
          4,
        ),
        role: "xean.codex",
      },
      {
        ...work(
          "failed",
          {
            kind: "notes",
            workspace: "/not/a/retained/workspace",
            candidate: false,
            notes: [note],
          },
          5,
        ),
        status: "failed",
        publicationId: null,
      },
    ],
  };
  campaign.result = completion(task, project(campaign))!;
  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(
      join(workspace, "input.json"),
      JSON.stringify(input) + "\n",
    );
    await writeFile(
      join(workspace, "src/check.sh"),
      "#!/bin/sh\nprintf 'verified\\n'\n",
      { mode: 0o751 },
    );
    await writeFile(join(workspace, "output.txt"), "verified\n");
    await run(campaign, directory, workspace);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("bundle preserves accepted bytes and checks, selecting artifacts from the accepted dependency closure", async () => {
  await fixture(async (campaign, directory, workspace) => {
    const destination = join(directory, "bundle");
    const argument = await exportArgument(campaign);
    expect(argument).toContain("Artifacts: /unrelated/prose/path");
    expect(await exportArgument(campaign, destination)).toBe(argument);
    expect(await readFile(join(destination, "argument.md"), "utf8")).toBe(
      argument,
    );
    expect(
      JSON.parse(await readFile(join(destination, "result.json"), "utf8")),
    ).toEqual(campaign.result);
    expect((await readdir(destination)).sort()).toEqual([
      "README.md",
      "argument.md",
      "artifacts",
      "manifest.json",
      "result.json",
    ]);
    expect(await readdir(join(destination, "artifacts"))).toEqual(["w1"]);
    const manifest = JSON.parse(
      await readFile(join(destination, "manifest.json"), "utf8"),
    );
    expect(manifest.workspaces).toEqual([
      {
        workId: "w1",
        originalPath: workspace,
        path: "artifacts/w1",
        noteIds: ["w1/n1"],
      },
    ]);
    expect(manifest.artifacts).toHaveLength(3);
    for (const artifact of manifest.artifacts) {
      const contents = await readFile(join(destination, artifact.path));
      expect(contents).toEqual(await readFile(artifact.originalPath));
      expect(artifact.bytes).toBe(contents.length);
      expect(artifact.sha256).toBe(
        createHash("sha256").update(contents).digest("hex"),
      );
      expect((await stat(join(destination, artifact.path))).mode & 0o111).toBe(
        artifact.executable,
      );
    }
    expect(
      (await stat(join(destination, "artifacts/w1/src/check.sh"))).mode & 0o777,
    ).toBe(0o751);
    await expect(exportArgument(campaign, destination)).rejects.toThrow();
    expect(await readFile(join(destination, "argument.md"), "utf8")).toBe(
      argument,
    );
    const empty = join(directory, "already-exists");
    await mkdir(empty);
    await expect(exportArgument(campaign, empty)).rejects.toThrow();
    expect(await readdir(empty)).toEqual([]);
    expect(
      (await readdir(directory)).filter((name) =>
        name.startsWith(".xean-bundle-"),
      ),
    ).toEqual([]);
  });
});

test("bundle rejects missing, unrelated, linked, and special artifacts without publishing a partial directory", async () => {
  await fixture(async (campaign, directory, workspace) => {
    const destination = join(directory, "bundle");
    const rejected = async () => {
      await expect(exportArgument(campaign, destination)).rejects.toThrow();
      expect(await readdir(directory)).not.toContain("bundle");
      expect(
        (await readdir(directory)).filter((name) =>
          name.startsWith(".xean-bundle-"),
        ),
      ).toEqual([]);
    };
    const result = campaign.work[0]!.result as { workspace?: string };
    delete result.workspace;
    await rejected();
    result.workspace = join(directory, "missing");
    await rejected();
    result.workspace = directory;
    await rejected();
    result.workspace = workspace;
    const input = join(workspace, "input.json");
    const original = await readFile(input);
    await writeFile(input, "{}");
    await rejected();
    await writeFile(input, original);
    const link = join(workspace, "outside");
    await symlink(directory, link);
    await rejected();
    await rm(link);
    const rootLink = join(directory, "workspace-link");
    await symlink(workspace, rootLink);
    result.workspace = rootLink;
    await rejected();
    result.workspace = workspace;
    await expect(
      exportArgument(campaign, join(rootLink, "bundle")),
    ).rejects.toThrow("outside every source workspace");
    expect(await readdir(workspace)).not.toContain("bundle");
    const socketPath = join(workspace, "socket");
    const server = Bun.listen({ unix: socketPath, socket: { data() {} } });
    try {
      await rejected();
    } finally {
      server.stop(true);
    }
  });
});

test("bundle requires an accepted solver argument and matching recorded support", async () => {
  await fixture(async (campaign, directory) => {
    const destination = join(directory, "bundle");
    await expect(
      exportArgument({ ...campaign, status: "paused" }, destination),
    ).rejects.toThrow("No accepted argument");
    await expect(
      exportArgument({ ...campaign, task: { kind: "xean.role" } }, destination),
    ).rejects.toThrow("No accepted argument");
    const result = campaign.result as { checks: { noteId: string }[] };
    result.checks.pop();
    await expect(exportArgument(campaign, destination)).rejects.toThrow(
      "dependency closure",
    );
    expect(await readdir(directory)).not.toContain("bundle");
  });
});
