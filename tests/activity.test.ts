import { expect, test } from "bun:test";
import {
  ActivityClient,
  createActivityHandler,
  type Activity,
} from "../src/activity.ts";

const origin = "http://activity.test";
function fixture(token?: string) {
  let time = 1000;
  const handler = createActivityHandler({ token, ttlMs: 100, now: () => time });
  const send = (
    path = "",
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`${origin}/v1/activities${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const create = async (scope = "math", owner = "explorer") => {
    const response = await send("", "POST", {
      scope,
      owner,
      intent: "Try a reduction",
      refs: ["book:one@n1"],
    });
    expect(response.status).toBe(201);
    return (await response.json()) as {
      activity: { id: string; intentAt: number; expiresAt: number };
      capability: string;
    };
  };
  return { handler, send, create, advance: (delta: number) => (time += delta) };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("observations isolate exact scopes, expose timing, and expire without a reaper", async () => {
  const f = fixture();
  const first = await f.create();
  await f.create("math/child");
  await f.create(" math");
  const response = await f.send("?scope=math");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const observed = await response.json();
  expect(observed).toMatchObject({
    status: "available",
    scope: "math",
    startedAt: 1000,
    observedAt: 1000,
  });
  expect(observed.activities.map((row: { id: string }) => row.id)).toEqual([
    first.activity.id,
  ]);
  expect(JSON.stringify(observed)).not.toContain(first.capability);
  expect(observed.activities[0]).not.toHaveProperty("revision");
  f.advance(100);
  expect((await (await f.send("?scope=math")).json()).activities).toEqual([]);
});

test("capabilities protect mutations; renewal changes expiry without changing intent time", async () => {
  const f = fixture("shared-secret");
  const { activity, capability } = await f.create();
  expect(
    (await f.handler(new Request(`${origin}/v1/activities?scope=math`))).status,
  ).toBe(401);
  expect((await f.send(`/${activity.id}/renew`, "POST")).status).toBe(403);
  expect(
    (
      await f.send(`/${activity.id}`, "DELETE", undefined, {
        "X-Activity-Capability": "wrong",
      })
    ).status,
  ).toBe(403);
  f.advance(50);
  const headers = { "X-Activity-Capability": capability };
  const renewed = await (
    await f.send(`/${activity.id}/renew`, "POST", undefined, headers)
  ).json();
  expect(renewed).toMatchObject({ intentAt: 1000, expiresAt: 1150 });
  const updated = await f.send(
    `/${activity.id}`,
    "PUT",
    { intent: "Check the special case", refs: [] },
    { ...headers, "X-Activity-Revision": "2" },
  );
  expect(await updated.json()).toMatchObject({
    intentAt: 1050,
    expiresAt: 1150,
    intent: "Check the special case",
  });
  expect(
    (
      await f.send(
        `/${activity.id}`,
        "PUT",
        { intent: "Delayed old intent", refs: [] },
        { ...headers, "X-Activity-Revision": "1" },
      )
    ).status,
  ).toBe(409);
  expect(
    (await (await f.send("?scope=math")).json()).activities[0].intent,
  ).toBe("Check the special case");
});

test("expiry and finish fence late updates and renewals; repeated finish is harmless", async () => {
  const f = fixture();
  for (const finish of [false, true]) {
    const { activity, capability } = await f.create();
    const headers = {
      "X-Activity-Capability": capability,
      "X-Activity-Revision": "1",
    };
    if (finish)
      expect(
        (await f.send(`/${activity.id}`, "DELETE", undefined, headers)).status,
      ).toBe(204);
    else f.advance(100);
    expect(
      (await f.send(`/${activity.id}/renew`, "POST", undefined, headers))
        .status,
    ).toBe(404);
    expect(
      (
        await f.send(
          `/${activity.id}`,
          "PUT",
          { intent: "Late intent", refs: [] },
          headers,
        )
      ).status,
    ).toBe(404);
    expect(
      (await f.send(`/${activity.id}`, "DELETE", undefined, headers)).status,
    ).toBe(204);
  }
  expect((await (await f.send("?scope=math")).json()).activities).toEqual([]);
});

test("a body received after expiry cannot revive an old record", async () => {
  const f = fixture();
  const { activity, capability } = await f.create();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const pending = f.handler(
    new Request(`${origin}/v1/activities/${activity.id}`, {
      method: "PUT",
      headers: {
        "X-Activity-Capability": capability,
        "X-Activity-Revision": "1",
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
        },
      }),
    }),
  );
  f.advance(100);
  stream.enqueue(
    new TextEncoder().encode(JSON.stringify({ intent: "Late", refs: [] })),
  );
  stream.close();
  expect((await pending).status).toBe(404);
});

test("schema and body bounds reject knowledge fields and oversized or excessive activities", async () => {
  const f = fixture();
  const input = {
    scope: "math",
    owner: "explorer",
    intent: "Explore",
    refs: [],
  };
  for (const invalid of [
    { ...input, result: "A mathematical finding" },
    { ...input, intent: "a".repeat(1001) },
    { ...input, refs: Array(9).fill("note") },
    { ...input, refs: ["a".repeat(301)] },
  ])
    expect((await f.send("", "POST", invalid)).status).toBe(400);
  expect(
    (await f.send("", "POST", { ...input, intent: "a".repeat(17_000) })).status,
  ).toBe(413);
  expect((await f.send("?scope=")).status).toBe(400);
  for (let i = 0; i < 64; i++) await f.create();
  expect((await f.send("", "POST", input)).status).toBe(429);
  f.advance(100);
  expect((await f.send("", "POST", input)).status).toBe(201);
});

test("clients exclude their own row only, and discover peers from other runtimes", async () => {
  const f = fixture();
  const options = {
    url: origin,
    scope: "math",
    owner: "same descriptive label",
  };
  const first = new ActivityClient(options, { fetch: f.handler });
  const second = new ActivityClient(options, { fetch: f.handler });
  await first.announce("Explore reduction", []);
  const result = await second.announce("Check example", []);
  expect(result).toMatchObject({
    status: "available",
    activities: [{ intent: "Explore reduction" }],
  });
  expect(first.announced).toBe(true);
  expect(await first.observe()).toMatchObject({
    status: "available",
    activities: [{ intent: "Check example" }],
  });
  await first.close();
  expect(first.announced).toBe(false);
  await expect(first.announce("Late", [])).rejects.toThrow("closed");
  await first.renew();
  await second.close();
  expect(await first.observe()).toMatchObject({
    status: "available",
    activities: [],
  });
});

test("expiry or service restart clears renewal; only explicit intent can announce again", async () => {
  const f = fixture();
  let handler = f.handler;
  const client = new ActivityClient(
    { url: origin, scope: "math", owner: "one" },
    { fetch: (request) => handler(request) },
  );
  await client.announce("Original intent", []);
  f.advance(100);
  await client.renew();
  expect(client.announced).toBe(false);
  await client.renew();
  expect((await (await f.send("?scope=math")).json()).activities).toEqual([]);
  await client.announce("Fresh intent", []);
  handler = createActivityHandler({ now: () => 5000 });
  expect(await client.observe()).toMatchObject({
    status: "available",
    startedAt: 5000,
    activities: [],
  });
  await client.renew();
  expect(client.announced).toBe(false);
  await client.announce("Fresh after restart", []);
  expect(client.announced).toBe(true);
  await client.close();
});

test("missing, malformed and timed out observations are unavailable rather than empty", async () => {
  const options = {
    url: origin,
    scope: "math",
    owner: "one",
    token: "not-for-model",
  };
  for (const result of [
    [],
    {},
    {
      status: "available",
      scope: "other",
      startedAt: 0,
      observedAt: 0,
      activities: [],
    },
  ]) {
    const client = new ActivityClient(options, {
      fetch: async () => Response.json(result),
    });
    expect(await client.observe()).toMatchObject({ status: "unavailable" });
  }
  const denied = new ActivityClient(options, {
    fetch: async () => new Response(null, { status: 401 }),
  });
  expect(await denied.observe()).toEqual({
    status: "unavailable",
    reason: "Activity service returned HTTP 401",
  });
  let signal: AbortSignal | undefined;
  const blocked = new ActivityClient(options, {
    timeoutMs: 10,
    fetch: async (request) => {
      signal = request.signal;
      return new Promise<Response>(() => {});
    },
  });
  expect(await blocked.observe()).toMatchObject({
    status: "unavailable",
    reason: "Activity service request timed out",
  });
  expect(signal?.aborted).toBe(true);
  await expect(blocked.announce("Announce", [])).rejects.toThrow("timed out");
  expect(blocked.announced).toBe(false);
});

test("close waits for an in-flight announcement and renewal before deleting", async () => {
  const f = fixture();
  const blocked = gate(),
    entered = gate();
  const methods: string[] = [];
  const client = new ActivityClient(
    { url: origin, scope: "math", owner: "one" },
    {
      fetch: async (request) => {
        methods.push(request.method);
        if (request.method === "POST" && !request.url.endsWith("/renew")) {
          entered.release();
          await blocked.promise;
        }
        return f.handler(request);
      },
    },
  );
  const announce = client.announce("Explore", []);
  await entered.promise;
  const renew = client.renew();
  const close = client.close();
  expect(methods).toEqual(["POST"]);
  blocked.release();
  await Promise.all([announce, renew, close]);
  expect(methods).toEqual(["POST", "GET", "POST", "DELETE"]);
  expect((await (await f.send("?scope=math")).json()).activities).toEqual([]);
});

test("a timed out intention cannot overwrite a later announcement or keep renewing", async () => {
  const f = fixture();
  const blocked = gate();
  let delay = false;
  let delayed!: Promise<Response>;
  const client = new ActivityClient(
    { url: origin, scope: "math", owner: "one" },
    {
      timeoutMs: 10,
      fetch: async (request) => {
        if (delay && request.method === "PUT") {
          delay = false;
          delayed = blocked.promise.then(() => f.handler(request));
          return delayed;
        }
        return f.handler(request);
      },
    },
  );
  await client.announce("First", []);
  delay = true;
  await expect(client.announce("Delayed second", [])).rejects.toThrow(
    "timed out",
  );
  expect(client.announced).toBe(false);
  f.advance(20);
  await client.renew();
  expect(
    (await (await f.send("?scope=math")).json()).activities[0].expiresAt,
  ).toBe(1100);
  await client.announce("Third", []);
  blocked.release();
  expect((await delayed).status).toBe(409);
  expect(
    (await (await f.send("?scope=math")).json()).activities[0].intent,
  ).toBe("Third");
  await client.close();
});

test("mutation receipts must match the activation, row and requested intention", async () => {
  const cases: ["create" | "update" | "renew", Partial<Activity>][] = [
    ["create", { intent: "Different intent" }],
    ["create", { refs: ["another:note"] }],
    ["update", { id: crypto.randomUUID() }],
    ["update", { scope: "other scope" }],
    ["update", { owner: "other owner" }],
    ["update", { intent: "Different intent" }],
    ["update", { refs: ["another:note"] }],
    ["renew", { id: crypto.randomUUID() }],
    ["renew", { expiresAt: 1000 }],
  ];
  for (const [operation, corruption] of cases) {
    const f = fixture();
    let corrupt = false;
    let creates = 0;
    const client = new ActivityClient(
      { url: origin, scope: "math", owner: "one" },
      {
        fetch: async (request) => {
          const create =
            request.method === "POST" && !request.url.endsWith("/renew");
          if (create) creates++;
          const response = await f.handler(request);
          if (
            !corrupt ||
            request.method === "GET" ||
            request.method === "DELETE"
          )
            return response;
          const value = await response.json();
          Object.assign(create ? value.activity : value, corruption);
          return Response.json(value, { status: response.status });
        },
      },
    );
    if (operation !== "create") await client.announce("Explore", ["book:n1"]);
    corrupt = true;
    await expect(
      operation === "renew"
        ? client.renew()
        : client.announce(" Explore ", ["book:n1"]),
    ).rejects.toThrow("Invalid activity response");
    expect(client.announced).toBe(false);
    await client.renew();
    await client.close();
    expect(creates).toBe(1);
  }
});

test("a lost create receipt leaves only an expiring orphan, without automatic recreation", async () => {
  const f = fixture();
  let creates = 0;
  const client = new ActivityClient(
    { url: origin, scope: "math", owner: "one" },
    {
      timeoutMs: 10,
      fetch: async (request) => {
        const response = await f.handler(request);
        if (request.method === "POST") {
          creates++;
          return new Promise<Response>(() => {});
        }
        return response;
      },
    },
  );
  await expect(client.announce("Explore", [])).rejects.toThrow("timed out");
  expect(client.announced).toBe(false);
  await client.renew();
  await client.close();
  expect(creates).toBe(1);
  expect((await (await f.send("?scope=math")).json()).activities).toHaveLength(
    1,
  );
  f.advance(100);
  expect((await (await f.send("?scope=math")).json()).activities).toEqual([]);
});

test("transient renewal failures retry the same lease without recreating expired activity", async () => {
  for (const failure of ["network", "timeout", "server"] as const) {
    const f = fixture();
    let fail = false;
    let creates = 0;
    const client = new ActivityClient(
      { url: origin, scope: "math", owner: "one" },
      {
        timeoutMs: 10,
        fetch: async (request) => {
          if (request.method === "POST" && !request.url.endsWith("/renew"))
            creates++;
          if (fail && request.url.endsWith("/renew")) {
            fail = false;
            if (failure === "network")
              throw new Error("Transport disconnected");
            if (failure === "timeout") return new Promise<Response>(() => {});
            return new Response(null, { status: 503 });
          }
          return f.handler(request);
        },
      },
    );
    await client.announce("Explore", []);
    const original = (await (await f.send("?scope=math")).json()).activities[0];
    f.advance(20);
    fail = true;
    await expect(client.renew()).rejects.toThrow();
    expect(client.announced).toBe(true);
    f.advance(20);
    await client.renew();
    expect((await (await f.send("?scope=math")).json()).activities).toEqual([
      { ...original, expiresAt: 1140 },
    ]);
    f.advance(100);
    await client.renew();
    expect(client.announced).toBe(false);
    await client.renew();
    expect(creates).toBe(1);
    expect((await (await f.send("?scope=math")).json()).activities).toEqual([]);
    await client.close();
  }
});

test("forbidden and malformed renewal responses suspend further renewal", async () => {
  for (const failure of ["forbidden", "json", "schema"] as const) {
    const f = fixture();
    let renewals = 0;
    const client = new ActivityClient(
      { url: origin, scope: "math", owner: "one" },
      {
        fetch: async (request) => {
          if (!request.url.endsWith("/renew")) return f.handler(request);
          renewals++;
          if (failure === "forbidden")
            return new Response(null, { status: 403 });
          if (failure === "json") return new Response("not JSON");
          return Response.json({});
        },
      },
    );
    await client.announce("Explore", []);
    await expect(client.renew()).rejects.toThrow();
    expect(client.announced).toBe(false);
    await client.renew();
    expect(renewals).toBe(1);
    await client.close();
  }
});
