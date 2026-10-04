import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { setImmediate } from "node:timers/promises";
import { campaignVersion, type Campaign } from "xean";
import { declarationVersion, type Note } from "xean/solve";
import { acceptedArgument } from "xean/solve/argument";
import { statusReport } from "xean/report";

test("observer results, stale recovery, and navigation share the current selected run", async () => {
  const source = await Bun.file(
    new URL("../packages/observe/web/app.ts", import.meta.url),
  ).text();
  const code = new Bun.Transpiler({
    loader: "ts",
    target: "browser",
  }).transformSync(source.slice(source.indexOf("const app =")));
  const note: Note = {
    id: "n1",
    summary: "Candidate",
    detailedSummary: "Candidate summary",
    text: "Proof body",
    support: [],
    revision: 0,
    checks: [],
    imported: true,
    candidate: true,
    verified: true,
    dead: false,
    accepted: true,
  };
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
      location: { hash: "#run=alpha&view=work&open=result" },
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
      acceptedArgument,
      setInterval() {},
      fetch: (url: string) =>
        new Promise((resolve) => requests.push({ url, resolve })),
      state: undefined as unknown as () =>
        | { id: string; stale?: boolean; heartbeat?: { rounds: number } }
        | undefined,
      refresh: undefined as unknown as () => Promise<void>,
      view: undefined as unknown as (value: unknown) => unknown[],
    };
    runInNewContext(
      code +
        "\nglobalThis.state = () => selected; globalThis.refresh = refresh; globalThis.view = detailView;",
      context,
    );
    for (const kind of [
      "xean.solve",
      "xean.solve.offline",
      "xean.solve.library",
      "xean.role",
      null,
    ]) {
      const solver = kind?.startsWith("xean.solve") === true;
      const notes = solver ? [note] : [];
      const campaign: Campaign = {
        version: campaignVersion,
        task: { kind, version: declarationVersion },
        coordinator: "fixture",
        status: "completed",
        state: null,
        work: [],
        inputs: [],
        limits: { attempts: 1, concurrency: 1 },
        providerCalls: 0,
        pendingSignals: 0,
        error: null,
        result: solver ? { noteId: note.id } : { answer: "opaque result" },
      };
      const snapshot = {
        kind,
        status: statusReport({ campaign, notes }),
        notes,
        work: [],
        result: campaign.result,
        task: null,
        observedAt: new Date().toISOString(),
      };
      const output = context
        .view({ id: "example", kind: "snapshot", snapshot })
        .flat(Infinity)
        .filter((value) => typeof value === "string")
        .join("");
      expect(output).toContain(
        solver ? "## n1\n\nProof body" : '"answer": "opaque result"',
      );
    }
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
    const failed = context.refresh();
    requests[1]!.resolve(
      ok({
        ...evidence("alpha"),
        heartbeat: undefined,
        error: "Malformed selected snapshot",
      }),
    );
    await failed;
    expect(context.state()).toMatchObject({
      id: "alpha",
      stale: true,
      heartbeat: { rounds: 1 },
    });
    const recovered = context.refresh();
    requests[2]!.resolve(ok(evidence("alpha")));
    await recovered;
    expect(context.state()?.stale).toBeUndefined();
    const pending = context.refresh();
    context.location.hash = destination;
    requests[3]!.resolve(ok(evidence("alpha")));
    await pending;
    // Browsers can dispatch hashchange after an already queued fetch completes.
    handlers.hashchange!();
    expect(context.state()).toBeUndefined();
    expect(requests.map(({ url }) => url)).toEqual([
      "/api/runs/alpha",
      "/api/runs/alpha",
      "/api/runs/alpha",
      "/api/runs/alpha",
      destination ? "/api/runs/beta" : "/api/runs?view=status",
    ]);
    requests[4]!.resolve(ok(destination ? evidence("beta") : []));
    await setImmediate();
    expect(context.state()?.id).toBe(destination ? "beta" : undefined);
  }
});
