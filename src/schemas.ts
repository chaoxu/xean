import { z } from "zod";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export const entryId = z.number().int().positive();
export type EntryId = z.output<typeof entryId>;
export const json = z.json() as z.ZodType<Json>;
export const verdict = z.enum(["PASS", "FAIL", "INCONCLUSIVE"]);

export const ENTRY_KINDS = {
  campaign: "campaign",
  candidate: "candidate",
  verdict: "verdict",
  call: "call",
  toolCall: "tool-call",
  callResult: "call-result",
  toolResult: "tool-result",
} as const;

const base = {
  seq: entryId,
  atMs: z.number().int().nonnegative(),
};
const tool = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: json,
});

function resultEntries<
  const Kind extends
    typeof ENTRY_KINDS.callResult | typeof ENTRY_KINDS.toolResult,
>(kind: Kind) {
  return z.discriminatedUnion("state", [
    z.strictObject({
      ...base,
      kind: z.literal(kind),
      parent: entryId,
      state: z.literal("returned"),
      output: json,
    }),
    z.strictObject({
      ...base,
      kind: z.literal(kind),
      parent: entryId,
      state: z.literal("threw"),
      error: z.string(),
    }),
  ]);
}

export const entry = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    kind: z.literal(ENTRY_KINDS.campaign),
    application: z.string().min(1),
    config: json,
  }),
  z.strictObject({
    ...base,
    kind: z.literal(ENTRY_KINDS.candidate),
    requiredVerifiers: z.array(z.string().min(1)).min(1).readonly(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal(ENTRY_KINDS.verdict),
    call: entryId,
    verdict,
    evidence: json,
  }),
  z.strictObject({
    ...base,
    kind: z.literal(ENTRY_KINDS.call),
    label: z.string().min(1),
    role: z.string().min(1).optional(),
    candidate: entryId.optional(),
    request: json,
    tools: z.array(tool).readonly(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal(ENTRY_KINDS.toolCall),
    call: entryId,
    tool: z.string().min(1),
    source: z.string().min(1).optional(),
    input: json,
  }),
  resultEntries(ENTRY_KINDS.callResult),
  resultEntries(ENTRY_KINDS.toolResult),
]);

export type Entry = z.output<typeof entry>;
export type EntryDraft = Entry extends infer E
  ? E extends Entry
    ? Omit<E, "seq" | "atMs">
    : never
  : never;
export type ToolDeclaration = z.output<typeof tool>;
export type Verdict = z.output<typeof verdict>;

export function copyJson(value: unknown): Json {
  return json.parse(value);
}
