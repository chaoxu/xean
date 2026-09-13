import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`${command[1]} failed`);
}

async function reject(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) === 0) throw new Error(`${command[1]} succeeded`);
}

const root = process.cwd();
const manifest = await Bun.file(join(root, "package.json")).json();
const temporary = await mkdtemp(join(tmpdir(), "elenx-package-"));
const consumer = join(temporary, "consumer");
const archive = join(temporary, "elenx.tgz");
try {
  await run(
    [
      process.execPath,
      "pm",
      "pack",
      "--filename",
      archive,
      "--ignore-scripts",
      "--quiet",
    ],
    root,
  );
  await mkdir(consumer);
  await Bun.write(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        elenx: `file:${archive}`,
        zod: manifest.dependencies.zod,
      },
      devDependencies: {
        "@earendil-works/pi-coding-agent": "0.85.1",
        "@types/bun": manifest.devDependencies["@types/bun"],
        typescript: manifest.devDependencies.typescript,
      },
    }),
  );
  await Bun.write(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2023"],
        module: "ESNext",
        moduleResolution: "bundler",
        strict: true,
        noEmit: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        skipLibCheck: true,
        types: ["bun"],
      },
      include: ["index.ts"],
    }),
  );
  await Bun.write(
    join(consumer, "index.ts"),
    `import {
  createCampaign, defineTool, deriveCandidateStatus, entryIdSchema,
  openCampaign, openReader, returnedToolSubmission, verdictSchema,
  type CallReceipt, type Campaign, type Entry, type Json, type Verdict,
} from "elenx";
import {
  builtinPi, derivePiSpend, ELENX_PI_TELEMETRY_SCHEMA,
  InMemoryCredentialStore, piReasoning, piRequest,
  piRequestAttempts, piStoredResult,
  PI_TELEMETRY_SCHEMA_VERSIONS, piTelemetry, runPi,
  type PiResult, type PiSpend,
} from "elenx/pi";
import {
  inspectCoreCampaign, inspectCoreCampaignSummary,
  type CoreCampaignObservationV1, type CoreCampaignSummaryV1,
} from "elenx/observe";
import { z } from "zod";

const campaign = createCampaign("consumer.db", "packed-consumer", null);
try {
  const candidate = campaign.submitCandidate(new TextEncoder().encode("x"), ["v1"]);
  deriveCandidateStatus(campaign.records(), candidate);
  derivePiSpend(campaign.records());
  piRequest.parse({ protocol: "elenx/pi-run/v1", model: { provider: "p", id: "m", api: "a" }, modelProfile: null, prompt: "x" });
  piStoredResult.parse({ state: "succeeded", text: "x", transcript: [],
    telemetry: { schemaVersions: PI_TELEMETRY_SCHEMA_VERSIONS, spans: [] } });
  builtinPi({ credentials: new InMemoryCredentialStore() });
  defineTool({ name: "read", description: "Read", input: z.strictObject({}), replay: "safe", async run() { return null; } });
  const native = await import(Bun.resolveSync(
    "@earendil-works/pi-ai/api/openai-codex-responses",
    Bun.resolveSync("elenx/pi", import.meta.dir),
  ));
  const proxyModel = {
    id: "packed-proxy", name: "Packed proxy fixture", api: "openai-codex-responses" as const,
    provider: "openai-codex", baseUrl: "https://invalid.test/backend-api", reasoning: false,
    input: ["text"] as ["text"], contextWindow: 20_000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsStrictMode: true, codexProxyAuth: true },
  };
  const stubFetch: typeof fetch = Object.assign(async () => new Response(
    "data: " + JSON.stringify({ type: "response.failed", response: {
      id: "packed-failure", status: "failed", output: [],
      error: { code: "invalid_request_error", message: "offline fixture" },
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15,
        output_tokens_details: { reasoning_tokens: 3 } },
    } }) + "\\n\\n", { headers: { "content-type": "text/event-stream" } },
  ), { preconnect: fetch.preconnect });
  const runtimeModule = new URL("./core/model-runtime.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { ModelRuntime } = await import(runtimeModule.href);
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: "./auth.json", refreshOnCreate: false });
  runtime.registerProvider("packed-proxy", { api: "openai-codex-responses", baseUrl: proxyModel.baseUrl,
    apiKey: "offline-proxy-key", models: [{ ...proxyModel, provider: "packed-proxy" }],
    streamSimple: native.streamSimple,
  });
  const configured = runtime.getModel("packed-proxy", proxyModel.id);
  if (!configured) throw new Error("ModelRuntime did not retain the proxy model");
  const probe = await runPi(campaign, { model: configured, label: "packed-pi", prompt: "Offline fixture",
    models: { streamSimple(requestModel, context, options) {
      return runtime.streamSimple(requestModel, context, { ...options,
        transport: "sse", fetch: stubFetch });
    } },
  });
  const spend = derivePiSpend(campaign.records()).summary;
  if (probe.state !== "failed" || spend.logicalProviderRequests !== 1 ||
    !("measuredUsage" in spend) || spend.measuredUsage.reasoning !== 3)
    throw new Error("Packed consumer did not receive the patched native Pi provider");
} finally { campaign.close(); }
void [entryIdSchema, verdictSchema, openCampaign, openReader,
  returnedToolSubmission, ELENX_PI_TELEMETRY_SCHEMA, PI_TELEMETRY_SCHEMA_VERSIONS,
  piReasoning, piRequestAttempts, piTelemetry, runPi];
void (undefined as unknown as CallReceipt | Campaign | Entry | Json | Verdict |
  PiResult | PiSpend | CoreCampaignObservationV1 | CoreCampaignSummaryV1);
void [inspectCoreCampaign, inspectCoreCampaignSummary];
`,
  );
  await run(
    [
      process.execPath,
      "install",
      "--ignore-scripts",
      "--cache-dir",
      join(temporary, "cache"),
      "--minimum-release-age",
      "86400",
    ],
    consumer,
  );
  await reject(
    [process.execPath, "-e", 'await import("elenx/src/campaign")'],
    consumer,
  );
  await run([process.execPath, "x", "tsc", "--noEmit"], consumer);
  await run([process.execPath, "run", "index.ts"], consumer);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
