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

test("selected provider routes source calls without a native login or unrelated user configuration", async () => {
  const setup = await fixture({ auth: false, customHome: true });
  await writeFile(
    join(setup.authHome, "config.toml"),
    `
model_provider = "gateway"
developer_instructions = "USER INSTRUCTIONS MUST NOT BE INHERITED"
[features]
shell_tool = true
[model_providers.gateway]
name = "Example gateway"
base_url = "https://gateway.example.test/v1"
env_key = "GATEWAY_KEY"
supports_websockets = true
supports_standalone_web_search = true
http_headers = { "X-Private-Header" = "fixture-header-secret", "X-Usage-Tag" = "static-tag" }
env_http_headers = { "x-usage-tag" = "XEAN_SOURCE_HEADER_0" }
`,
  );
  const options = {
    ...setup.options,
    environment: {
      ...setup.options.environment,
      GATEWAY_KEY: "fixture-gateway-secret",
      XEAN_SOURCE_HEADER_0: "fixture/attempt-1",
      SSL_CERT_FILE: "/example/ca.pem",
    },
  };
  await requireCodex(options);
  const result = await codexExec(options)({
    protocol: "xean/codex-exec/v1",
    model: "fixture-model",
    reasoning: "low",
    search: true,
    developerInstructions: "Verify this source.",
    prompt: "Exact task.",
    outputSchema: { type: "object" },
  });
  expect(result.state).toBe("succeeded");
  const captures = await setup.captures();
  expect(captures.some((capture) => capture.args.includes("login"))).toBe(
    false,
  );
  const execution = captures.at(-1)!;
  expect(execution.args).toContain('model_provider="xean-source"');
  expect(
    execution.args.indexOf('model_provider="xean-source"'),
  ).toBeGreaterThan(execution.args.indexOf("exec"));
  expect(execution.args).toContain(
    'model_providers.xean-source.base_url="https://gateway.example.test/v1"',
  );
  expect(execution.args).toContain(
    'model_providers.xean-source.env_key="GATEWAY_KEY"',
  );
  expect(execution.args).toContain("--ignore-user-config");
  expect(execution.args).toContain('web_search="live"');
  expect(execution.args).toContain("features.shell_tool=false");
  expect(execution.args).toContain("features.apps=false");
  expect(execution.args).toContain(
    "model_providers.xean-source.supports_standalone_web_search=true",
  );
  expect(execution.input).toBe("Exact task.");
  expect(execution.env["GATEWAY_KEY"]).toBe("fixture-gateway-secret");
  expect(execution.env["XEAN_SOURCE_HEADER_0"]).toBe("fixture/attempt-1");
  expect(execution.env["SSL_CERT_FILE"]).toBe("/example/ca.pem");
  expect(execution.env["OTHER_SECRET"]).toBeUndefined();
  expect(execution.files).toEqual(["auth.json"]);
  expect(execution.auth).not.toBe(join(setup.authHome, "auth.json"));
  const args = execution.args.join("\n");
  expect(args).not.toContain("fixture-gateway-secret");
  expect(args).not.toContain("fixture-header-secret");
  expect(args).not.toContain("USER INSTRUCTIONS");
  const headerArgument = execution.args.find((arg) =>
    arg.startsWith("model_providers.xean-source.env_http_headers="),
  )!;
  const parsed = Bun.TOML.parse(headerArgument) as {
    model_providers: Record<
      string,
      { env_http_headers: Record<string, string> }
    >;
  };
  const headerVariable =
    parsed.model_providers["xean-source"]!.env_http_headers[
      "x-private-header"
    ]!;
  expect(execution.env[headerVariable]).toBe("fixture-header-secret");
  expect(
    parsed.model_providers["xean-source"]!.env_http_headers["x-usage-tag"],
  ).toBe("XEAN_SOURCE_HEADER_0");
  expectCleaned(captures);
});

test("missing selected provider credentials never fall back to the native account", async () => {
  const setup = await fixture({ customHome: true });
  await writeFile(
    join(setup.authHome, "config.toml"),
    `
model_provider = "gateway"
[model_providers.gateway]
name = "Example gateway"
base_url = "https://gateway.example.test/v1"
env_key = "ABSENT_GATEWAY_KEY"
`,
  );
  await expect(requireCodex(setup.options)).rejects.toThrow(
    "source provider requires environment variable ABSENT_GATEWAY_KEY",
  );
  expect(existsSync(join(setup.directory, "capture.jsonl"))).toBe(false);
  const result = await codexExec(setup.options)({
    protocol: "xean/codex-exec/v1",
    model: "fixture-model",
    reasoning: "low",
    search: true,
    developerInstructions: "Verify.",
    prompt: "Task.",
    outputSchema: { type: "object" },
  });
  expect(result.state).toBe("failed");
  expect(existsSync(join(setup.directory, "capture.jsonl"))).toBe(false);
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
