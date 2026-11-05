import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { abortable, complete, fixture } from "./worker-fixture.ts";

/** Simulate an unfinished job written by a newer runtime, preserving its args/state. */
function requireNewerWorker(path: string, job: string) {
  using database = new Database(path);
  const stored = database
    .query<{ document_id: number; seq: number; content: string }, [string]>(
      `SELECT r.document_id, r.seq, r.content
       FROM chord_revisions r JOIN chord_documents d ON d.id = r.document_id
       WHERE d.owner = 'xean.research' AND d.namespace = 'chord.jobs'
         AND d.kind = 'xean.worker' AND d.key = ? AND d.retired_at IS NULL
       ORDER BY r.seq DESC LIMIT 1`,
    )
    .get(job);
  expect(stored).not.toBeNull();
  const record = JSON.parse(stored!.content);
  expect(record.version).toBe(1);
  expect(record.phase).toBe("stopped");
  record.version = 2;
  database
    .query(
      "UPDATE chord_revisions SET content = ? WHERE document_id = ? AND seq = ?",
    )
    .run(JSON.stringify(record), stored!.document_id, stored!.seq);
}

test("an incompatible native job fails recovery without reviving Pi calls or losing pending work", async () => {
  const initial = Promise.withResolvers<void>();
  let initialCalls = 0;
  let reopening = false;
  const run = await fixture(
    async (request) => {
      if (request.descriptor.kind !== "explorer")
        throw new Error("Blocked campaign must not admit verification");
      if (reopening) throw new Error("Incompatible recovery revived a Pi call");
      if (++initialCalls === 2) initial.resolve();
      await abortable(request.signal);
      return complete(request);
    },
    {
      automatic: true,
      settings: { maxWorkers: 2, maxExplorerTurns: 2 },
    },
  );
  await initial.promise;
  const original = run.running().map(({ id }) => id);
  expect(original).toHaveLength(2);
  await run.owner.close();
  const pending = await run.tasks();
  expect(pending).toHaveLength(2);
  for (const task of pending) {
    expect(task.kind).toBe("pi.generation");
    expect(task.state.status).toBe("pending");
  }
  requireNewerWorker(run.path, original[0]!);

  reopening = true;
  await run.reopen();
  const result = await run.owner.wait();
  expect(result).toMatchObject({ outcome: "call-failure", turns: 0 });
  expect(result.error).toContain(`Worker ${original[0]} blocked: version`);
  expect(result.accepted).toBeUndefined();
  expect(run.history()).toHaveLength(1);
  expect(run.history()[0]).toMatchObject({
    id: original[1],
    status: "failed",
    error: "A blocked worker requires recovery",
  });
  expect(run.running()).toEqual([
    expect.objectContaining({
      id: original[0],
      phase: "blocked",
      reason: "version",
    }),
  ]);
  expect(run.requests).toHaveLength(2);
  expect(await run.tasks()).toEqual(pending);
  expect(await run.notes()).toEqual([]);

  const before = run.owner.state;
  await expect(run.owner.resume()).rejects.toThrow(
    "Blocked native jobs require repair before resume",
  );
  expect(run.owner.state).toEqual(before);
  await run.reopen();
  expect(await run.owner.wait()).toEqual(result);
  expect(run.running()).toEqual([
    expect.objectContaining({
      id: original[0],
      phase: "blocked",
      reason: "version",
    }),
  ]);
  expect(run.owner.state).toEqual(before);
  expect(run.requests).toHaveLength(2);
  expect(await run.tasks()).toEqual(pending);
}, 10000);
