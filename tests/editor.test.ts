import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Xean, openXeanStorage } from "../packages/core/src/index.ts";
import {
  createEditor,
  type EditingResult,
  type EditorInput,
  type Note,
} from "../packages/core/src/solve/index.ts";
import {
  materializeNotes,
  refresh,
  retainedNotes,
} from "../packages/core/src/solve/notes.ts";
import {
  codexResearch,
  type Research,
} from "../packages/core/src/solve/research.ts";
import { fixtureRuntime } from "./fixtures/pi.ts";
import { fullNote } from "../packages/core/src/solve/reader.ts";

const draft = (id: string, text: string, support: string[] = []) => ({
  id,
  summary: text,
  detailedSummary: text,
  text,
  support,
});
const pass = { verdict: "PASS" as const, report: "Checked." };

function editorRuntime(
  respond: (
    role: string,
    input: Omit<EditorInput, "notes" | "previous"> & {
      notes: ReturnType<typeof fullNote>[];
      previous?: ReturnType<typeof fullNote>[];
    },
    prompt: string,
  ) => unknown,
) {
  return fixtureRuntime((context, _options, selected) => {
    const input = JSON.parse(
      String(
        context.messages.find((message) => message.role === "user")!.content,
      ),
    );
    const value = respond(
      selected.id,
      input,
      String(context.messages[0]!.content),
    );
    return fauxAssistantMessage(
      [fauxToolCall("submit_result", value as never)],
      { stopReason: "toolUse" },
    );
  });
}

test("editing combines proof and coverage feedback before repair and reuses checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xean-editing-"));
  const path = join(directory, "campaign.sqlite");
  const input = {
    task: {
      problem: "The research task",
      completionCriteria: "An unconditional algorithm",
    },
    notes: refresh(
      materializeNotes(
        "original",
        [
          draft("n1", "Old useful base lemma"),
          draft("n2", "Old intermediate scaffolding", ["n1"]),
          draft("n3", "Old partial result", ["n2"]),
          draft("n4", "Old failed approach and its counterexample"),
        ],
        false,
        true,
      ),
    ),
  };
  const original = structuredClone(input);
  const judged: string[][] = [];
  const sourced: string[] = [];
  let drafts = 0;
  let reviews = 0;
  const correctness = (notes: Pick<Note, "id" | "text">[]) => ({
    results: notes.map((note) => ({
      noteId: note.id,
      result: {
        ...(note.text === "Defective proof"
          ? { verdict: "FAIL", report: "Missing boundary case" }
          : pass),
        premises: [],
      },
    })),
  });
  const research: Research = {
    ...codexResearch(),
    async source({ notes }) {
      sourced.push(...notes.map((note) => note.id));
      return notes.map((note) => ({ noteId: note.id, result: pass }));
    },
  };
  const runtime = editorRuntime((role, data, prompt) => {
    if (role === "editor") {
      drafts++;
      expect(data.notes.map((note) => note.text)).toEqual(
        original.notes.map((note) => note.text),
      );
      expect(data.notes.every((note) => !("checks" in note))).toBe(true);
      if (drafts === 1)
        return {
          retained: [],
          report: "Combine the old chain.",
          notes: [
            draft("n1", "New base"),
            draft("n2", "Defective proof", ["n1"]),
          ],
        };
      expect(drafts).toBe(2);
      expect(
        data.previous?.find((note) => note.text === "Defective proof")?.dead,
      ).toBe(true);
      expect(data.previous?.find((note) => note.dead)?.feedback).toEqual([
        "correctness: Missing boundary case",
      ]);
      expect(data.review).toEqual({
        verdict: "FAIL",
        report: "Lost counterexample",
      });
      const base = data.previous!.find((note) => note.text === "New base")!;
      expect(base.verified).toBe(true);
      return {
        retained: [],
        report:
          "Fix the proof and restore the counterexample with the checked base.",
        notes: [
          draft("n1", "Repaired proof", [base.id]),
          draft("n2", "Counterexample and limitation"),
        ],
      };
    }
    if (role === "correctness") {
      judged.push(data.notes.map((note) => note.text));
      return correctness(data.notes);
    }
    if (role === "requirements") {
      reviews++;
      expect(data.notes.every((note) => note.verified)).toBe(reviews > 1);
      if (reviews === 1)
        expect(data.notes.find((note) => note.dead)?.feedback).toEqual([
          "correctness: Missing boundary case",
        ]);
      expect(
        data.previous?.map(({ id, text, support }) => ({ id, text, support })),
      ).toEqual(
        original.notes.map(({ id, text, support }) => ({ id, text, support })),
      );
      expect(data.notes.every((note) => !("checks" in note))).toBe(true);
      expect(prompt).toContain(
        "does not ask whether the research task has been solved",
      );
      return reviews === 1
        ? { verdict: "FAIL", report: "Lost counterexample" }
        : pass;
    }
    throw new Error(`Unexpected call: ${role}`);
  });
  const options = {
    ...createEditor(input, runtime, {}, research),
    limits: { providerCalls: 2 },
  };
  let engine = await Xean.open(await openXeanStorage(path), options);
  try {
    const limited = await engine.run();
    expect(limited.status).toBe("limited");
    expect(limited.result).toBeNull();
    expect(reviews).toBe(0);
    expect(limited.work.at(-1)).toMatchObject({
      role: "xean.editionReview",
      status: "failed",
      error: "Provider call limit reached",
    });
    expect(
      limited.work
        .filter((work) => work.status === "completed")
        .map((work) => work.role),
    ).toEqual(["xean.editor", "xean.editVerifier"]);
    await engine.close();
    engine = await Xean.open(await openXeanStorage(path), options);
    await engine.extendCalls(12, "finish-editing");
    const completed = await engine.run();
    expect(completed.status).toBe("completed");
    const result = completed.result as unknown as EditingResult;
    expect(result.notes.map((note) => note.text)).toEqual([
      "New base",
      "Repaired proof",
      "Counterexample and limitation",
    ]);
    expect(
      result.notes.every(
        (note) =>
          note.verified && !note.dead && !note.accepted && !note.imported,
      ),
    ).toBe(true);
    expect(result.deprecated).toEqual(original.notes.map((note) => note.id));
    expect(
      result.notes
        .flatMap((note) => note.support)
        .every((id) => result.notes.some((note) => note.id === id)),
    ).toBe(true);
    expect(judged).toEqual([
      ["New base", "Defective proof"],
      ["Repaired proof", "Counterexample and limitation"],
    ]);
    expect(new Set(sourced).size).toBe(sourced.length);
    expect(drafts).toBe(2);
    expect(reviews).toBe(2);
    expect(input).toEqual(original);
    // A completed revision is valid input to another run, without reusing new-note IDs.
    const nextRuntime = editorRuntime((role, data) =>
      role === "editor"
        ? {
            retained: [],
            report: "Combine the checked results.",
            notes: [draft("n1", "Next complete corpus")],
          }
        : role === "correctness"
          ? correctness(data.notes)
          : pass,
    );
    const next = await Xean.open(
      await openXeanStorage(join(directory, "next.sqlite")),
      createEditor(
        { task: input.task, notes: result.notes },
        nextRuntime,
        {},
        research,
      ),
    );
    try {
      const revision = await next.run();
      expect(revision.status).toBe("completed");
      const edited = revision.result as unknown as EditingResult;
      expect(edited.notes).toHaveLength(1);
      expect(result.notes.some((note) => note.id === edited.notes[0]!.id)).toBe(
        false,
      );
      expect(edited.deprecated).toEqual(result.notes.map((note) => note.id));
    } finally {
      await next.close();
    }
  } finally {
    await engine.close();
    await rm(directory, { recursive: true });
  }
});

test("replacement support retains its closure without reviving rejected or forward references", () => {
  const notes = refresh(
    materializeNotes(
      "old",
      [draft("n1", "Base"), draft("n2", "Result", ["n1"])],
      false,
      true,
    ),
  );
  const proposal = {
    retained: [],
    notes: [draft("n1", "Uses the old result", ["old/n2"])],
    report: "Reuse its complete proof chain",
  };
  expect(retainedNotes(proposal, notes).map((note) => note.id)).toEqual([
    "old/n1",
    "old/n2",
  ]);
  expect(() =>
    retainedNotes(
      { ...proposal, notes: [draft("n1", "Unknown support", ["missing"])] },
      notes,
    ),
  ).toThrow("Unknown note");
  const shadowed = notes.map((note, index) => ({
    ...note,
    id: `n${index + 1}`,
    support: index ? ["n1"] : [],
  }));
  expect(() =>
    retainedNotes(
      {
        ...proposal,
        notes: [draft("n1", "Collides with an ancestor", ["n2"])],
      },
      shadowed,
    ),
  ).toThrow("New local IDs must not collide");
  for (const id of ["n1", "n2"])
    expect(() =>
      retainedNotes(
        {
          ...proposal,
          notes: [draft("n1", "Invalid local use", [id]), draft("n2", "Later")],
        },
        shadowed,
      ),
    ).toThrow("Unknown, dead, or forward support");
  expect(
    retainedNotes(
      {
        ...proposal,
        notes: [
          draft("n1", "New base"),
          draft("n2", "Valid local use", ["n1"]),
        ],
      },
      shadowed,
    ),
  ).toEqual([]);
  const retained = retainedNotes(
    { retained: ["old/n2"], notes: [], report: "Keep the result" },
    notes,
  );
  expect(retained.map((note) => note.id)).toEqual(["old/n1", "old/n2"]);
  notes[0]!.checks.push({
    noteId: "old/n1",
    correctness: { verdict: "FAIL", report: "Defect", premises: [] },
  });
  refresh(notes);
  expect(() => retainedNotes(proposal, notes)).toThrow("Cannot retain dead");
  expect(() =>
    retainedNotes(
      { retained: ["old/n2"], notes: [], report: "Cannot revive" },
      notes,
    ),
  ).toThrow("Cannot retain dead");
});
