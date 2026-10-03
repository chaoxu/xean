import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Xean, openXeanStorage } from "xean";
import { sumOfSquares } from "./sum-of-squares.ts";

const path =
  process.argv[2] ?? resolve(import.meta.dir, "../runs/deterministic.sqlite");
const xean = await Xean.open(await openXeanStorage(path), {
  ...sumOfSquares,
  task: { operation: "sum of squares", values: [3, 4] },
  limits: { concurrency: 2, attempts: 2 },
  roles: [
    {
      name: "xean.square",
      async run(input, _execution, context) {
        if (typeof input !== "number") throw new Error("Expected a number");
        await delay(20, undefined, { signal: context.abortSignal });
        return input * input;
      },
    },
  ],
});

try {
  const campaign = await xean.run();
  console.log(
    JSON.stringify({ status: campaign.status, result: campaign.result }),
  );
} finally {
  await xean.close();
}
