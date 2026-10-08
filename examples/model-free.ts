import { resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defaultSettings, inspect, open, readReport } from "xean";

if (process.argv.length !== 3)
  throw new Error("Usage: examples/model-free.ts NEW_DATABASE.sqlite");
const path = resolve(process.argv[2]!);
const pass = { verdict: "PASS" as const, report: "Scripted fixture judgment." };

// Scripted roles demonstrate the native workflow without calling a model.
// Their preset judgments are not evidence of mathematical performance.
const owner = await open(path, {
  create: {
    task: {
      problem: "Prove 1 = 1.",
      completionCriteria: "A self-contained proof.",
    },
    settings: { ...defaultSettings, research: false },
  },
  roles: () => ({
    coordinator: async (input) => ({
      work: input.notes.length
        ? {
            kind: "verifier",
            notes: [input.notes[0].id],
            through: "reconstruction",
          }
        : { kind: "explorer", guidance: "Use reflexivity." },
    }),
    explorer: async () => ({
      kind: "notes",
      candidate: true,
      notes: [
        {
          id: "n1",
          summary: "Equality is reflexive.",
          detailedSummary: "Reflexivity proves the equality.",
          text: "1 = 1.\n\nBy reflexivity, 1 = 1.",
          support: [],
        },
      ],
    }),
    verifier: async (input) => ({
      kind: "verification",
      checks: [
        {
          noteId: input.targets[0],
          correctness: { ...pass, statement: "1 = 1.", premises: [] },
          source: pass,
          requirements: pass,
          reconstruction: {
            ...pass,
            proof: "Reflexivity.",
          },
        },
      ],
    }),
  }),
});
try {
  await owner.root.waitForIdle(context);
} finally {
  await owner.close();
}
console.log(JSON.stringify((await inspect(path, readReport)).status));
