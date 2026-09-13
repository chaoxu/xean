import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { codexExec, requireCodex } from "../source";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface Capture {
  args: string[];
  input: string;
  cwd: string;
  env: Record<string, string>;
  auth: string;
  files: string[];
}

async function fixture(
  options: {
    auth?: boolean;
    customHome?: boolean;
    missingFlag?: string;
    versionExit?: number;
    loginExit?: number;
  } = {},
) {
  const directory = await mkdtemp(
    join(tmpdir(), "xean-source-preflight-test-"),
  );
  directories.push(directory);
  const authHome = join(
    directory,
    options.customHome ? "custom-codex" : ".codex",
  );
  await mkdir(authHome);
  if (options.auth !== false) {
    await writeFile(
      join(authHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "fixture-only" } }),
    );
  }
  await writeFile(join(authHome, "config.toml"), "# must not be inherited\n");
  await writeFile(join(directory, "options.json"), JSON.stringify(options));
  await writeFile(
    join(directory, "fake-codex"),
    `#!${process.execPath}
import { appendFile, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
const options = JSON.parse(await readFile(join(process.env.HOME, "options.json"), "utf8"));
const args = Bun.argv.slice(2);
const executing = args.includes("exec") && !args.includes("--help");
const input = executing ? await Bun.stdin.text() : "";
const home = process.env.CODEX_HOME;
await appendFile(join(process.env.HOME, "capture.jsonl"), JSON.stringify({
  args, input, cwd: process.cwd(), env: process.env,
  auth: await realpath(join(home, "auth.json")), files: await readdir(home),
}) + "\\n");
if (args.includes("--version")) {
  console.log("codex-cli fixture-1.0");
  console.error("credential-output-must-stay-private");
  process.exitCode = options.versionExit ?? 0;
} else if (args.includes("--help")) {
  console.log("--search --disable --model --config --ephemeral --ignore-user-config --ignore-rules --strict-config --skip-git-repo-check --sandbox --json --color --output-schema --cd"
    .split(" ").filter(flag => flag !== options.missingFlag).join(" "));
} else if (args.includes("login") && args.includes("status")) {
  const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
  console.log("credential-output-must-stay-private");
  console.error("credential-output-must-stay-private");
  process.exitCode = options.loginExit || (auth.tokens ? 0 : 1);
} else if (executing) {
  console.log("{}");
} else {
  process.exitCode = 90;
}
`,
    { mode: 0o700 },
  );
  const environment = {
    PATH: directory + ":" + dirname(process.execPath),
    HOME: directory,
    ...(options.customHome ? { CODEX_HOME: authHome } : {}),
    HTTPS_PROXY: "http://proxy.invalid:1234",
    NO_PROXY: "proxy.invalid",
    OPENAI_API_KEY: "ambient-key-must-not-be-used",
    CODEX_API_KEY: "ambient-key-must-not-be-used",
    CODEX_API_BASE_URL: "http://unwanted-provider.invalid",
    OTHER_SECRET: "unrelated-secret-must-not-be-inherited",
  };
  return {
    directory,
    authHome,
    options: { command: "fake-codex", environment },
    async captures(): Promise<Capture[]> {
      return (await readFile(join(directory, "capture.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Capture);
    },
  };
}

function expectCleaned(captures: readonly Capture[]) {
  for (const capture of captures) {
    expect(existsSync(dirname(capture.env["CODEX_HOME"] ?? ""))).toBe(false);
    expect(existsSync(capture.env["CODEX_HOME"] ?? "")).toBe(false);
  }
}

test("preflight and execution share the isolated auth and environment boundary", async () => {
  const setup = await fixture({ customHome: true });
  await requireCodex(setup.options);
  const prompt = "Exact prompt bytes.\n☃\n";
  const result = await codexExec(setup.options)({
    protocol: "xean/codex-exec/v1",
    model: "fixture-model",
    reasoning: "low",
    search: true,
    developerInstructions: "Verify the cited source.",
    prompt,
    outputSchema: { type: "object" },
  });
  expect(result.state).toBe("succeeded");
  const captures = await setup.captures();
  expect(
    captures.map(
      (capture) =>
        capture.args.includes("exec") && !capture.args.includes("--help"),
    ),
  ).toEqual([false, false, false, false, false, true]);
  for (const capture of captures) {
    expect(capture.env["HOME"]).toBe(setup.directory);
    expect(capture.env["PATH"]).toBe(setup.options.environment.PATH);
    expect(capture.env["HTTPS_PROXY"]).toBe("http://proxy.invalid:1234");
    expect(capture.env["NO_PROXY"]).toBe("proxy.invalid");
    expect(capture.env["OPENAI_API_KEY"]).toBeUndefined();
    expect(capture.env["CODEX_API_KEY"]).toBeUndefined();
    expect(capture.env["CODEX_API_BASE_URL"]).toBeUndefined();
    expect(capture.env["OTHER_SECRET"]).toBeUndefined();
    expect(capture.auth).toBe(
      await realpath(join(setup.authHome, "auth.json")),
    );
    expect(capture.files).toEqual(["auth.json"]);
    expect(capture.env["CODEX_HOME"]).not.toBe(setup.authHome);
    if (capture.args.includes("login") || capture.input !== "") {
      expect(capture.args).toContain('cli_auth_credentials_store="file"');
    }
  }
  expect(captures.at(-1)?.input).toBe(prompt);
  expectCleaned(captures);
  expect(existsSync(join(setup.authHome, "auth.json"))).toBe(true);
});

test("preflight uses HOME/.codex when CODEX_HOME is absent", async () => {
  const setup = await fixture();
  await requireCodex(setup.options);
  const captures = await setup.captures();
  expect(captures.at(-1)?.args).toEqual([
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
    "status",
  ]);
  expect(captures.at(-1)?.auth).toBe(
    await realpath(join(setup.authHome, "auth.json")),
  );
  expectCleaned(captures);
});

test("preflight rejects a missing executable", async () => {
  const setup = await fixture();
  await expect(
    requireCodex({
      ...setup.options,
      command: join(setup.directory, "missing"),
    }),
  ).rejects.toThrow("source verifier requires an executable Codex CLI");
});

test.each([
  "--search",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
])(
  "preflight rejects a CLI missing %s without invoking a model",
  async (missingFlag) => {
    const setup = await fixture({ missingFlag });
    await expect(requireCodex(setup.options)).rejects.toThrow(
      "source verifier requires Codex CLI options: " + missingFlag,
    );
    const captures = await setup.captures();
    expect(captures.every((capture) => capture.input === "")).toBe(true);
    expectCleaned(captures);
  },
);

test("ambient API credentials cannot satisfy missing native credentials", async () => {
  const setup = await fixture({ auth: false });
  await expect(requireCodex(setup.options)).rejects.toThrow(
    "source verifier requires native Codex credentials",
  );
  const captures = await setup.captures();
  expect(captures.some((capture) => capture.args.includes("login"))).toBe(
    false,
  );
  expectCleaned(captures);
});

test("rejected login status suppresses credential output and cleans up", async () => {
  const setup = await fixture({ loginExit: 1 });
  let message = "";
  try {
    await requireCodex(setup.options);
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain(
    "source verifier requires native Codex credentials",
  );
  expect(message).not.toContain("credential-output-must-stay-private");
  expectCleaned(await setup.captures());
});

test("a broken CLI version check suppresses command output and cleans up", async () => {
  const setup = await fixture({ versionExit: 1 });
  await expect(requireCodex(setup.options)).rejects.toThrow(
    "source verifier requires an executable Codex CLI",
  );
  expectCleaned(await setup.captures());
});

test("an aborted preflight starts no CLI process", async () => {
  const setup = await fixture();
  await expect(
    requireCodex({ ...setup.options, signal: AbortSignal.abort() }),
  ).rejects.toThrow("source verifier preflight cancelled");
  expect(existsSync(join(setup.directory, "capture.jsonl"))).toBe(false);
});
