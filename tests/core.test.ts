import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

import {
  createCampaign,
  defineTool,
  openReader,
  openCampaign,
  returnedToolSubmission,
  type ToolExecutionContext,
} from "../src";

const directories: string[] = [];

function database(): string {
  const directory = mkdtempSync(join(tmpdir(), "xean-v1-"));
  directories.push(directory);
  return join(directory, "campaign.db");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true });
  }
});

describe("small kernel", () => {
  test("projects one returned tool submission without constraining its output", async () => {
    const campaign = createCampaign(database(), "test", null);
    const submit = defineTool({
      name: "submit_verdict",
      description: "Submit a verdict",
      input: z.strictObject({
        verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
        evidence: z.json(),
      }),
      async run() {
        return null;
      },
    });
    const audit = await campaign.call(
      {
        label: "audit/v1",
        request: null,
        tools: [submit],
      },
      async ({ tools }) => {
        await tools[0]!.execute({
          verdict: "PASS",
          evidence: { reason: "checked" },
        });
        return { state: "succeeded" };
      },
    );
    const projected = returnedToolSubmission(
      campaign.records(),
      audit.call,
      submit.name,
    );
    expect(projected).toMatchObject({
      input: { verdict: "PASS", evidence: { reason: "checked" } },
      output: null,
    });
    expect(projected.toolCall).toBeLessThan(projected.toolResult);
    const report = z
      .strictObject({
        verdict: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
        evidence: z.json(),
      })
      .parse(projected.input);
    const evidence = campaign.recordEvidence(audit.call, report);
    expect(campaign.record(evidence)).toMatchObject({ evidence: report });
    campaign.close();
  });

  test("rejects missing, duplicate, and thrown tool submissions", async () => {
    const campaign = createCampaign(database(), "test", null);
    const submit = defineTool({
      name: "submit_verdict",
      description: "Submit a verdict",
      input: z.strictObject({ verdict: z.literal("PASS") }),
      async run() {
        return null;
      },
    });
    const empty = await campaign.call(
      { label: "audit/v1", request: null, tools: [submit] },
      async () => ({ state: "succeeded" }),
    );
    expect(() =>
      returnedToolSubmission(campaign.records(), empty.call, submit.name),
    ).toThrow("exactly one submission");
    const duplicate = await campaign.call(
      {
        label: "audit/v1",
        request: null,
        tools: [submit],
      },
      async ({ tools }) => {
        await tools[0]!.execute({ verdict: "PASS" });
        await tools[0]!.execute({ verdict: "PASS" });
        return { state: "succeeded" };
      },
    );
    expect(() =>
      returnedToolSubmission(campaign.records(), duplicate.call, submit.name),
    ).toThrow("exactly one submission");

    const throwing = defineTool({
      ...submit,
      async run() {
        throw new Error("submission failed");
      },
    });
    await expect(
      campaign.call(
        {
          label: "audit/v1",
          request: null,
          tools: [throwing],
        },
        ({ tools }) => tools[0]!.execute({ verdict: "PASS" }),
      ),
    ).rejects.toThrow("submission failed");
    const thrown = campaign
      .records()
      .findLast((entry) => entry.kind === "call")!;
    expect(() =>
      returnedToolSubmission(campaign.records(), thrown.seq, submit.name),
    ).toThrow("returned tool result");
  });

  test("rejects missing or non-call parents before writing", async () => {
    const campaign = createCampaign(database(), "test", null);
    for (const parent of [1, 2, 999]) {
      await expect(
        campaign.call({ label: "child", parent, request: null }, async () => {
          throw new Error("must not run");
        }),
      ).rejects.toThrow("earlier call");
      expect(campaign.records()).toHaveLength(1);
    }
    const opening = await campaign.call(
      { label: "opening", request: "claim" },
      async () => null,
    );
    const child = await campaign.call(
      { label: "child", parent: opening.call, request: null },
      async () => ({ state: "succeeded" }),
    );
    expect(campaign.record(child.call)).toMatchObject({ parent: opening.call });
    campaign.close();
  });

  test("evidence accepts any returned JSON but rejects missing, unsettled, thrown, and reused calls", async () => {
    const path = database();
    const campaign = createCampaign(path, "test", null);
    for (const output of [
      null,
      true,
      7,
      "complete",
      [],
      {},
      { state: "complete" },
      { state: "failed" },
      { state: "cancelled" },
    ]) {
      const call = await campaign.call(
        { label: "audit", request: null },
        async () => output,
      );
      const evidence = campaign.recordEvidence(call.call, output);
      expect(campaign.record(evidence)).toMatchObject({ evidence: output });
    }
    for (const call of [1, 999]) {
      expect(() => campaign.recordEvidence(call, null)).toThrow(
        "returned call",
      );
    }
    await expect(
      campaign.call({ label: "thrown", request: null }, async ({ call }) => {
        expect(() => campaign.recordEvidence(call, null)).toThrow(
          "returned call",
        );
        throw new Error("interrupted");
      }),
    ).rejects.toThrow("interrupted");
    const thrown = campaign.records({
      kinds: ["call"],
      labels: ["thrown"],
    })[0]!;
    expect(() => campaign.recordEvidence(thrown.seq, null)).toThrow(
      "returned call",
    );
    const passed = await campaign.call(
      { label: "audit", request: null },
      async () => ({ state: "succeeded" }),
    );
    const receipt = campaign.recordEvidence(passed.call, {
      verdict: "PASS",
      reason: "checked",
    });
    expect(() =>
      campaign.recordEvidence(passed.call, { verdict: "FAIL" }),
    ).toThrow();
    campaign.close();
    const reader = openReader(path);
    expect(reader.record(receipt)).toMatchObject({
      kind: "evidence",
      call: passed.call,
      evidence: { verdict: "PASS", reason: "checked" },
    });
    reader.close();
    const reopened = openCampaign(path);
    expect(() =>
      reopened.recordEvidence(passed.call, { verdict: "FAIL" }),
    ).toThrow(/UNIQUE|constraint/i);
    expect(
      reopened.records({ kinds: ["evidence"], call: passed.call }),
    ).toHaveLength(1);
    reopened.close();
  });

  test("records calls and tool effects before returning", async () => {
    const campaign = createCampaign(database(), "test", null);
    let executionContext: ToolExecutionContext | undefined;
    const add = defineTool({
      name: "add",
      description: "Add two integers",
      input: z.strictObject({
        left: z.number().int(),
        right: z.number().int(),
      }),
      async run({ left, right }, context) {
        executionContext = context;
        return { sum: left + right };
      },
    });

    const receipt = await campaign.call(
      { label: "math", request: { prompt: "add" }, tools: [add] },
      async ({ request, tools }) => ({
        request,
        result: await tools[0]!.execute(
          { left: 2, right: 3 },
          "provider-add-1",
        ),
      }),
    );
    expect(receipt.output).toEqual({
      request: { prompt: "add" },
      result: { sum: 5 },
    });
    const records = campaign.records();
    expect(records.map((entry) => entry.kind)).toEqual([
      "campaign",
      "call",
      "tool-call",
      "tool-result",
      "call-result",
    ]);
    const call = records.find((entry) => entry.kind === "call")!;
    const toolCall = records.find((entry) => entry.kind === "tool-call")!;
    expect(receipt.call).toBe(call.seq);
    expect(executionContext).toMatchObject({
      call: call.seq,
      toolCall: toolCall.seq,
      source: "provider-add-1",
    });
    expect(executionContext?.signal).toBeInstanceOf(AbortSignal);
    expect(
      records.some(
        (entry) =>
          entry.kind === "tool-result" && entry.parent === toolCall.seq,
      ),
    ).toBe(true);
    expect(
      records.some(
        (entry) => entry.kind === "call-result" && entry.parent === call.seq,
      ),
    ).toBe(true);
  });

  test("runs against the request snapshot stored with the call", async () => {
    const campaign = createCampaign(database(), "test", null);
    const request = { value: "before" };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = campaign.call(
      { label: "snapshot", request },
      async ({ request: recorded }) => {
        await blocked;
        return recorded;
      },
    );
    request.value = "after";
    release();

    expect((await running).output).toEqual({ value: "before" });
    expect(
      campaign.records().find((entry) => entry.kind === "call")?.request,
    ).toEqual({ value: "before" });
  });

  test("rejects invalid tool input through the promised interface", async () => {
    const campaign = createCampaign(database(), "test", null);
    let ran = false;
    let returnedPromise = false;
    const tool = defineTool({
      name: "restricted",
      description: "Accept only the declared input",
      input: z.strictObject({ safe: z.literal(true) }),
      async run() {
        ran = true;
        return null;
      },
    });

    await expect(
      campaign.call(
        { label: "admission", request: null, tools: [tool] },
        ({ tools }) => {
          const execution = tools[0]!.execute({ safe: false });
          returnedPromise = execution instanceof Promise;
          return execution;
        },
      ),
    ).rejects.toThrow();
    expect(returnedPromise).toBe(true);
    expect(ran).toBe(false);
    expect(campaign.records().map((entry) => entry.kind)).toEqual([
      "campaign",
      "call",
      "call-result",
    ]);
  });

  test("allows refined tool schemas and rejects transformed schemas", async () => {
    const campaign = createCampaign(database(), "test", null);
    const refined = defineTool({
      name: "refined",
      description: "Accept nonblank text",
      input: z.strictObject({
        value: z.string().refine((value) => value.trim().length > 0),
      }),
      async run({ value }) {
        return { value };
      },
    });
    await expect(
      campaign.call(
        { label: "refinement", request: null, tools: [refined] },
        ({ tools }) => tools[0]!.execute({ value: "accepted" }),
      ),
    ).resolves.toMatchObject({ output: { value: "accepted" } });

    const transformed = defineTool({
      name: "transformed",
      description: "Trim text",
      input: z.string().transform((value) => value.trim()),
      async run(value) {
        return value;
      },
    });
    await expect(
      campaign.call(
        { label: "transform", request: null, tools: [transformed] },
        async () => null,
      ),
    ).rejects.toThrow("Transforms cannot be represented in JSON Schema");
    expect(
      campaign.records().filter((entry) => entry.kind === "call"),
    ).toHaveLength(1);
  });

  test("waits for detached tools and rejects late invocations", async () => {
    const campaign = createCampaign(database(), "test", null);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = defineTool({
      name: "effect",
      description: "Finish one effect",
      input: z.strictObject({}),
      async run() {
        await blocked;
        return { done: true };
      },
    });
    let retained: (() => Promise<unknown>) | undefined;
    const settlement = campaign.call(
      { label: "detached", request: null, tools: [tool] },
      async ({ tools }) => {
        retained = () => tools[0]!.execute({});
        void retained();
        return { runner: "done" };
      },
    );
    await Promise.resolve();
    expect(campaign.records().at(-1)?.kind).toBe("tool-call");
    expect(() => campaign.close()).toThrow("active calls");
    release();
    await settlement;
    await expect(retained!()).rejects.toThrow("no longer accepting");
    expect(campaign.records().at(-1)?.kind).toBe("call-result");
  });

  test("handles a detached tool rejection on the promise it returns", () => {
    const path = database();
    const fixture = resolve("tests/fixtures/detached-tool-rejection.ts");
    const child = Bun.spawnSync([process.execPath, fixture, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(0);

    const reader = openReader(path);
    expect(reader.records().map(({ kind }) => kind)).toEqual([
      "campaign",
      "call",
      "tool-call",
      "tool-result",
      "call-result",
    ]);
    reader.close();
  });

  test("records thrown calls and tools, then rethrows", async () => {
    const campaign = createCampaign(database(), "test", null);
    const fail = defineTool({
      name: "fail",
      description: "Fail",
      input: z.strictObject({}),
      async run() {
        throw new Error("tool failed");
      },
    });
    await expect(
      campaign.call(
        { label: "failure", request: null, tools: [fail] },
        ({ tools }) => tools[0]!.execute({}),
      ),
    ).rejects.toThrow("tool failed");
    expect(
      campaign
        .records()
        .map((entry) => [
          entry.kind,
          "state" in entry ? entry.state : undefined,
        ]),
    ).toEqual([
      ["campaign", undefined],
      ["call", undefined],
      ["tool-call", undefined],
      ["tool-result", "threw"],
      ["call-result", "threw"],
    ]);
  });

  test("rejects duplicate tool names before writing a call row", async () => {
    const campaign = createCampaign(database(), "test", null);
    const effect = defineTool({
      name: "effect",
      description: "Effect",
      input: z.strictObject({}),
      async run() {
        return null;
      },
    });

    await expect(
      campaign.call(
        { label: "duplicate", request: null, tools: [effect, effect] },
        async () => null,
      ),
    ).rejects.toThrow("duplicate tool name: effect");
    expect(campaign.records().map((entry) => entry.kind)).toEqual(["campaign"]);
  });
});
