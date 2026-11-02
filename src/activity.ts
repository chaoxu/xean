import { z } from "zod";

const label = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim().length > 0);
const intention = z.strictObject({
  intent: z.string().trim().min(1).max(1000),
  refs: z.array(z.string().min(1).max(300)).max(8),
});
const announcement = intention.extend({ scope: label, owner: label });
const activity = announcement.extend({
  id: z.uuid(),
  intentAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
const available = z.strictObject({
  status: z.literal("available"),
  scope: label,
  observedAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  activities: z.array(activity).max(64),
});
const receipt = z.strictObject({ activity, capability: z.uuid() });

export type Activity = z.infer<typeof activity>;
export type Observation =
  z.infer<typeof available> | { status: "unavailable"; reason: string };
export type ActivityOptions = {
  url: string;
  scope: string;
  owner: string;
  token?: string;
};

class ActivityError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

async function readJson(message: Request | Response, limit: number) {
  const reader = message.body?.getReader();
  if (!reader) throw new ActivityError("Missing JSON body", 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        void reader.cancel().catch(() => {});
        throw new ActivityError("Activity body too large", 413);
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** An advisory activity registry. Losing this handler loses all its records. */
export function createActivityHandler(
  options: { token?: string; ttlMs?: number; now?: () => number } = {},
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date.now;
  const ttlMs = z
    .number()
    .int()
    .positive()
    .parse(options.ttlMs ?? 120_000);
  const startedAt = now();
  const records = new Map<
    string,
    { activity: Activity; capability: string; revision: number }
  >();
  const respond = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
  return async (request) => {
    try {
      if (
        options.token !== undefined &&
        request.headers.get("Authorization") !== `Bearer ${options.token}`
      )
        throw new ActivityError("Activity authentication required", 401);
      const url = new URL(request.url);
      const collection = url.pathname === "/v1/activities";
      const match = /^\/v1\/activities\/([^/]+)(\/renew)?$/.exec(url.pathname);
      if (!collection && !match)
        throw new ActivityError("Activity route not found", 404);
      const method = request.method;
      const input =
        method === "PUT" || (collection && method === "POST")
          ? await readJson(request, 16_384)
          : undefined;
      // Read time after the body: a slow request must not revive an expired row.
      const observedAt = now();
      for (const [id, record] of records)
        if (record.activity.expiresAt <= observedAt) records.delete(id);
      if (collection && method === "GET") {
        const scope = label.parse(url.searchParams.get("scope"));
        return respond({
          status: "available",
          scope,
          observedAt,
          startedAt,
          activities: [...records.values()]
            .map((record) => record.activity)
            .filter((value) => value.scope === scope),
        });
      }
      if (collection && method === "POST") {
        const value = announcement.parse(input);
        if (
          records.size >= 1024 ||
          [...records.values()].filter(
            (row) => row.activity.scope === value.scope,
          ).length >= 64
        )
          throw new ActivityError("Activity capacity reached", 429);
        const record = {
          activity: {
            ...value,
            id: crypto.randomUUID(),
            intentAt: observedAt,
            expiresAt: observedAt + ttlMs,
          },
          capability: crypto.randomUUID(),
          revision: 0,
        };
        records.set(record.activity.id, record);
        return respond(
          { activity: record.activity, capability: record.capability },
          201,
        );
      }
      const id = match?.[1];
      const renew = match?.[2] !== undefined;
      if (
        !id ||
        (!((method === "PUT" || method === "DELETE") && !renew) &&
          !(method === "POST" && renew))
      )
        throw new ActivityError("Activity method not allowed", 405);
      const record = records.get(id);
      if (!record) {
        if (method === "DELETE") return new Response(null, { status: 204 });
        throw new ActivityError("Activity expired or unknown", 404);
      }
      if (request.headers.get("X-Activity-Capability") !== record.capability)
        throw new ActivityError("Activity capability required", 403);
      if (method === "DELETE") {
        records.delete(id);
        return new Response(null, { status: 204 });
      }
      if (method === "PUT") {
        const value = intention.parse(input);
        const revision = z.coerce
          .number()
          .int()
          .positive()
          .parse(request.headers.get("X-Activity-Revision"));
        if (revision <= record.revision)
          throw new ActivityError("Activity intention superseded", 409);
        Object.assign(record.activity, value, { intentAt: observedAt });
        record.revision = revision;
      }
      record.activity.expiresAt = observedAt + ttlMs;
      return respond(record.activity);
    } catch (error) {
      return respond(
        {
          error:
            error instanceof ActivityError
              ? error.message
              : "Invalid activity request",
        },
        error instanceof ActivityError ? (error.status ?? 400) : 400,
      );
    }
  };
}

/** One activation owns one client; close it when that activation ends. */
export class ActivityClient {
  private lease?: { id: string; capability: string };
  private confirmed = false;
  private closed = false;
  private revision = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly options: ActivityOptions;
  private readonly transport: (request: Request) => Promise<Response>;
  private readonly timeoutMs: number;

  constructor(
    options: ActivityOptions,
    transport: {
      fetch?: (request: Request) => Promise<Response>;
      timeoutMs?: number;
    } = {},
  ) {
    const url = new URL(options.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error(
        "Activity URL must be an HTTP origin without credentials",
      );
    this.options = {
      ...options,
      url: url.origin,
      scope: label.parse(options.scope),
      owner: label.parse(options.owner),
    };
    this.transport = transport.fetch ?? ((request) => fetch(request));
    this.timeoutMs = z
      .number()
      .int()
      .positive()
      .parse(transport.timeoutMs ?? 2000);
  }

  get announced() {
    return !this.closed && this.confirmed;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => {});
    return result;
  }

  private validateActivity(raw: unknown, expected?: z.infer<typeof intention>) {
    const parsed = activity.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.scope !== this.options.scope ||
      parsed.data.owner !== this.options.owner ||
      (this.lease && parsed.data.id !== this.lease.id) ||
      parsed.data.expiresAt <= parsed.data.intentAt ||
      (expected &&
        (parsed.data.intent !== expected.intent ||
          parsed.data.refs.length !== expected.refs.length ||
          parsed.data.refs.some((ref, index) => ref !== expected.refs[index])))
    )
      throw new ActivityError("Invalid activity response");
    return parsed.data;
  }

  private async request(path: string, method = "GET", body?: unknown) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const headers = new Headers();
    if (this.options.token !== undefined)
      headers.set("Authorization", `Bearer ${this.options.token}`);
    if (this.lease && method !== "GET") {
      headers.set("X-Activity-Capability", this.lease.capability);
      if (method === "PUT")
        headers.set("X-Activity-Revision", String(++this.revision));
    }
    if (body !== undefined) headers.set("Content-Type", "application/json");
    try {
      return await Promise.race([
        (async () => {
          const request = new Request(`${this.options.url}${path}`, {
            method,
            headers,
            redirect: "error",
            signal: controller.signal,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          let response: Response;
          try {
            response = await this.transport(request);
          } catch {
            throw new ActivityError(
              "Activity service unavailable",
              undefined,
              true,
            );
          }
          if (!response.ok)
            throw new ActivityError(
              `Activity service returned HTTP ${response.status}`,
              response.status,
              response.status >= 500,
            );
          return response.status === 204
            ? undefined
            : await readJson(response, 1_048_576);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(
              new ActivityError(
                "Activity service request timed out",
                undefined,
                true,
              ),
            );
          }, this.timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof ActivityError) throw error;
      throw new ActivityError(
        "Activity service unavailable or invalid response",
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async observe(): Promise<Observation> {
    try {
      const result = available.parse(
        await this.request(
          `/v1/activities?scope=${encodeURIComponent(this.options.scope)}`,
        ),
      );
      if (
        result.scope !== this.options.scope ||
        result.activities.some(
          (row) =>
            row.scope !== result.scope || row.expiresAt <= result.observedAt,
        )
      )
        throw new Error("Invalid observation");
      return {
        ...result,
        activities: result.activities.filter(
          (row) => row.id !== this.lease?.id,
        ),
      };
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof ActivityError
            ? error.message
            : "Invalid activity observation",
      };
    }
  }

  async announce(intent: string, refs: string[]): Promise<Observation> {
    if (this.closed) throw new Error("Activity client is closed");
    const value = intention.parse({ intent, refs });
    return this.serialize(async () => {
      this.confirmed = false;
      if (this.lease) {
        try {
          this.validateActivity(
            await this.request(`/v1/activities/${this.lease.id}`, "PUT", value),
            value,
          );
        } catch (error) {
          if (!(error instanceof ActivityError) || error.status !== 404)
            throw error;
          this.lease = undefined;
        }
      }
      if (!this.lease) {
        const result = receipt.parse(
          await this.request("/v1/activities", "POST", {
            ...value,
            scope: this.options.scope,
            owner: this.options.owner,
          }),
        );
        this.validateActivity(result.activity, value);
        this.lease = { id: result.activity.id, capability: result.capability };
      }
      this.confirmed = true;
      return this.observe();
    });
  }

  renew(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.serialize(async () => {
      if (!this.lease || !this.confirmed) return;
      try {
        this.validateActivity(
          await this.request(`/v1/activities/${this.lease.id}/renew`, "POST"),
        );
      } catch (error) {
        if (error instanceof ActivityError && error.retryable) throw error;
        this.confirmed = false;
        if (!(error instanceof ActivityError) || error.status !== 404)
          throw error;
        this.lease = undefined;
      }
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.serialize(async () => {
      if (!this.lease) return;
      await this.request(`/v1/activities/${this.lease.id}`, "DELETE");
      this.lease = undefined;
      this.confirmed = false;
    });
  }
}
