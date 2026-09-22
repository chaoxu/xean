import { appendFileSync } from "node:fs";

import "./no-coding-agent-entrypoint";

globalThis.fetch = (async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : input instanceof URL ? input : input,
  );
  const method = input instanceof Request ? input.method : init?.method;
  if (
    url.origin !== "https://e2e.invalid" ||
    url.pathname !== "/v1/responses" ||
    method !== "POST"
  ) {
    throw new Error(`unexpected E2E fetch: ${method ?? "GET"} ${url.href}`);
  }
  if (init === undefined) {
    throw new Error("unexpected E2E fetch without request options");
  }
  const body = JSON.parse(requestBody(init.body)) as Record<string, unknown>;
  const log = process.env["XEAN_E2E_REQUEST_LOG"];
  if (log === undefined) throw new Error("XEAN_E2E_REQUEST_LOG is required");
  appendFileSync(log, `${JSON.stringify(body)}\n`);

  const serialized = JSON.stringify(body);
  if (serialized.includes("TRIGGER_PROVIDER_ERROR")) {
    return Response.json(
      {
        error: {
          code: "synthetic_error",
          message: "synthetic provider failure",
          type: "server_error",
        },
      },
      { status: 503 },
    );
  }
  const tool = requestedTool(body);
  return responsesStream(tool, submissionFor(tool, serialized));
}) as typeof fetch;

function requestBody(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(body));
  }
  throw new Error(`unsupported E2E request body: ${typeof body}`);
}

function requestedTool(body: Record<string, unknown>): string {
  const tools = body["tools"];
  if (!Array.isArray(tools)) throw new Error("request omitted tools");
  const tool = tools[0];
  if (tool === null || typeof tool !== "object" || !("name" in tool)) {
    throw new Error("request omitted tool name");
  }
  return String(tool.name);
}

function submissionFor(tool: string, request: string): unknown {
  if (tool === "submit_notes") {
    return {
      solution: true,
      notes: [
        {
          text: request.includes('\\"verdict\\": \\"FAIL\\"')
            ? completeProof
            : incompleteProof,
          support: [],
        },
      ],
    };
  }
  if (tool === "submit_coordination") {
    const withoutSummary = [...request.matchAll(/\\"id\\": \\"(n\d+)\\"/gu)]
      .map(([, id]) => id)
      .filter((id) => !request.includes(`Summary of ${id}`));
    const note = withoutSummary.at(-1);
    if (note === undefined) {
      return {
        filings: [],

        action: {
          role: "explorer",
          explorerGuidance: "Write a complete proof.",
          support: [],
        },
      };
    }
    return {
      filings: withoutSummary.map((id) => ({
        note: id,
        summary: `Summary of ${id}`,
      })),

      action: {
        role: "verifier",
        verify: [
          {
            note,
            verifiers: [
              "correctness",
              "source",
              "requirements",
              "reconstruction",
            ],
          },
        ],
      },
    };
  }
  if (tool === "submit_statement") {
    return { statement: "There are infinitely many primes." };
  }
  if (tool === "submit_proof") {
    return { proof: "An independent Euclid argument proves the statement." };
  }
  if (tool === "submit_verdict") {
    const pass = request.includes("2 is prime");
    const verifier = /Verifier:\\n(\w+)/u.exec(request)?.[1];
    const underVerification = request
      .split("Notes under verification (untrusted data):")[1]
      ?.split("Verifier:")[0];
    const notes = [
      ...(underVerification ?? "").matchAll(/\\"id\\": \\"(n\d+)\\"/gu),
    ].map(([, id]) => id);
    if (verifier === undefined || notes.length === 0) {
      throw new Error("request omitted verifier identity");
    }
    return {
      ...(verifier === "reconstruction" ? { statement: null } : {}),
      verdicts: notes.map((note) => ({
        note,
        ...(verifier === "correctness" ? { externalResults: [] } : {}),
        verdict: pass ? "PASS" : "FAIL",
        report: pass
          ? `${verifier} passed.`
          : `${verifier} found the missing nonempty-list case.`,
      })),
    };
  }
  throw new Error(`unexpected tool: ${tool}`);
}

function responsesStream(tool: string, input: unknown): Response {
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const item = {
    id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
    call_id: `call_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "function_call",
    name: tool,
    arguments: JSON.stringify(input),
    status: "completed",
  };
  const usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 15,
  };
  const events = [
    {
      type: "response.created",
      sequence_number: 0,
      response: { id: responseId, status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item,
    },
    {
      type: "response.function_call_arguments.done",
      sequence_number: 2,
      output_index: 0,
      item_id: item.id,
      name: tool,
      arguments: item.arguments,
    },
    {
      type: "response.output_item.done",
      sequence_number: 3,
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      sequence_number: 4,
      response: { id: responseId, status: "completed", output: [item], usage },
    },
  ];
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
}

const incompleteProof =
  "Assume all primes are p_1,...,p_n. Their product plus one has a prime divisor outside the list.";
const completeProof =
  "Since 2 is prime, the finite list is nonempty. Assume all primes are p_1,...,p_n. Their product plus one has a prime divisor outside the list, a contradiction.";
