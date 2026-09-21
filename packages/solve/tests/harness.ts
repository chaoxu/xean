import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCampaign,
  type AuditedTool,
  type Campaign,
  type Json,
} from "xean";
import { initializeAllowance } from "../allowance";
import { applicationId } from "../roles";
import type { WorkflowConfig } from "../workflow";
import { storePiResult, type PiResult, type PiRunOptions } from "xean/pi";

import { defaultCoordinatorBehavior, type SolveSettings } from "../pi-roles";
import type { SolveModels } from "../runtime";
import type { CodexRequest, CodexResult } from "../source";
import { fakePiRequest, fakePiTelemetry } from "./fake-pi";
import { codexStdout } from "./fixtures/codex-stdout";

const model = {
  id: "model-v1",
  name: "Model",
  api: "openai-responses" as const,
  provider: "test",
  baseUrl: "https://invalid.test/v1",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 20_000,
};

export interface Reply {
  /** A test boundary after the request is journaled and before its result. */
  readonly onStarted?: (tools: readonly AuditedTool[]) => Promise<void>;
  readonly submission?: Json;
  readonly state?: "succeeded" | "failed" | "cancelled";
  readonly error?: string;
  readonly transcript?: readonly Json[];
  /** A source verifier answer, delivered through the fake Codex instead of Pi. */
  readonly codex?: Json;
  readonly searched?: boolean;
}

const directories: string[] = [];

export function campaignPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "xean-solve-test-"));
  directories.push(directory);
  return join(directory, "campaign.db");
}

export function cleanupCampaigns(): void {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
}

export function roleSettings(): SolveSettings {
  const profile = {
    provider: model.provider,
    model: model.id,
    reasoning: "high" as const,
  };
  return {
    window: 100_000,
    maxExplorerResponses: 1,
    workflowMode: "fixed",
    maxCoordinatorSteps: 32,
    coordinatorBehavior: defaultCoordinatorBehavior,
    explorer: profile,
    coordinator: profile,
    correctness: profile,
    source: {
      model: "codex-model",
      reasoning: "low",
    },
    requirements: profile,
    reconstruction: profile,
  };
}

export async function createWorkflowCampaign(
  path: string,
  config: WorkflowConfig & Readonly<Record<string, Json>>,
  turns = 4,
) {
  const campaign = createCampaign(path, applicationId, config);
  await initializeAllowance(campaign, turns);
  return campaign;
}

export function dependencies(replies: readonly Reply[]) {
  const queue = [...replies];
  const calls: PiRunOptions[] = [];
  const allCalls: {
    label: string;
    role?: string;
    system: string;
    prompt: string;
  }[] = [];
  const codexCalls: CodexRequest[] = [];
  const models: SolveModels = {
    getModel(provider, id) {
      return provider === model.provider && id === model.id ? model : undefined;
    },
    streamSimple() {
      throw new Error("fake runner owns execution");
    },
  };
  return {
    models,
    calls,
    allCalls,
    codexCalls,
    async run(campaign: Campaign, options: PiRunOptions): Promise<PiResult> {
      calls.push(options);
      allCalls.push({
        label: options.label,
        ...(options.role === undefined ? {} : { role: options.role }),
        system: options.system ?? "",
        prompt: options.prompt,
      });
      const reply = queue.shift();
      if (reply === undefined) throw new Error(`no reply for ${options.label}`);
      if (reply.codex !== undefined) {
        throw new Error(`expected a Codex call, got ${options.label}`);
      }
      expect(options.stopAfterToolResult).toBe(true);
      expect(options.transport).toBe(
        options.model.api === "openai-codex-responses" ? "auto" : "sse",
      );
      return respond(campaign, options, reply);
    },
    async codex(request: CodexRequest): Promise<CodexResult> {
      codexCalls.push(request);
      const literature = request.developerInstructions.includes(
        "literature-note writer",
      );
      allCalls.push({
        label: literature
          ? "xean-solve/literature"
          : "xean-solve/verifier/source",
        role: literature ? "literature" : "verifier",
        system: request.developerInstructions,
        prompt: request.prompt,
      });
      const reply = queue.shift();
      if (reply?.codex === undefined) {
        throw new Error("expected a Pi call, got the source verifier");
      }
      if (reply.state === "failed") {
        return {
          state: "failed",
          stdout: "",
          stderr: "",
          error: reply.error ?? "failed",
        };
      }
      return {
        state: "succeeded",
        codexVersion: "fake",
        stdout: codexStdout(reply.codex, reply.searched ?? true),
        stderr: "",
      };
    },
  };
}

async function respond(
  campaign: Campaign,
  options: PiRunOptions,
  reply: Reply,
): Promise<PiResult> {
  const state = reply.state ?? "succeeded";
  const telemetry = fakePiTelemetry(options, state);
  const body =
    state === "succeeded"
      ? ({ state, transcript: [], text: "", telemetry } as const)
      : state === "failed"
        ? ({
            state,
            error: reply.error ?? "failed",
            providerRetryable: false,
            truncated: false,
            transcript: reply.transcript ?? [],
            text: "",
            telemetry,
          } as const)
        : ({
            state,
            error: reply.error ?? "cancelled",
            transcript: reply.transcript ?? [],
            text: "",
            telemetry,
          } as const);
  const receipt = await campaign.call(
    {
      label: options.label,
      ...(options.role === undefined ? {} : { role: options.role }),
      request: fakePiRequest(options),
      ...(options.candidate === undefined
        ? {}
        : { candidate: options.candidate }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    },
    async ({ call, tools }) => {
      if (reply.onStarted !== undefined) await reply.onStarted(tools);
      if (reply.submission !== undefined) {
        await tools[0]!.execute(reply.submission);
      }
      return storePiResult(campaign, { call, ...body });
    },
  );
  return { call: receipt.call, ...body };
}
