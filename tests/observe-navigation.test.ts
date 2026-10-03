import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

test("a completed poll cannot hide navigation or retain the previous run", async () => {
  const source = await Bun.file(
    new URL("../packages/observe/web/app.ts", import.meta.url),
  ).text();
  const code = new Bun.Transpiler({
    loader: "ts",
    target: "browser",
  }).transformSync(source.slice(source.indexOf("const app =")));
  for (const destination of ["", "#run=beta"]) {
    const handlers: Record<string, () => void> = {};
    const requests: { url: string; resolve: (value: unknown) => void }[] = [];
    const element = {
      querySelectorAll: () => [],
      querySelector: () => undefined,
      addEventListener() {},
      focus() {},
      textContent: "",
    };
    const context = {
      URLSearchParams,
      AbortController,
      Date,
      location: { hash: "#run=alpha" },
      document: {
        hidden: false,
        querySelector: () => element,
        addEventListener() {},
      },
      window: {
        addEventListener(name: string, callback: () => void) {
          handlers[name] = callback;
        },
      },
      html: (...values: unknown[]) => values,
      nothing: "",
      render() {},
      keyed: (_key: unknown, value: unknown) => value,
      repeat: (
        values: unknown[],
        _key: unknown,
        body: (v: unknown) => unknown,
      ) => values.map(body),
      renderMath() {},
      setInterval() {},
      fetch: (url: string) =>
        new Promise((resolve) => requests.push({ url, resolve })),
      state: undefined as unknown as () => string | undefined,
      refresh: undefined as unknown as () => Promise<void>,
    };
    runInNewContext(
      code +
        "\nglobalThis.state = () => selected?.id; globalThis.refresh = refresh;",
      context,
    );
    const evidence = (id: string) => ({
      id,
      source: `/runs/${id}`,
      kind: "heartbeat",
      observedAt: new Date().toISOString(),
      heartbeat: {
        task: { problem: "Task", completionCriteria: "Proof" },
        rounds: 1,
      },
    });
    const ok = (value: unknown) => ({
      ok: true,
      status: 200,
      json: async () => value,
    });
    requests[0]!.resolve(ok(evidence("alpha")));
    await setImmediate();
    const pending = context.refresh();
    context.location.hash = destination;
    requests[1]!.resolve(ok(evidence("alpha")));
    await pending;
    // Browsers can dispatch hashchange after an already queued fetch completes.
    handlers.hashchange!();
    expect(context.state()).toBeUndefined();
    expect(requests.map(({ url }) => url)).toEqual([
      "/api/runs/alpha",
      "/api/runs/alpha",
      destination ? "/api/runs/beta" : "/api/runs?view=status",
    ]);
    requests[2]!.resolve(ok(destination ? evidence("beta") : []));
    await setImmediate();
    expect(context.state()).toBe(destination ? "beta" : undefined);
  }
});
