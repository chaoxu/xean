import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import {
  bool,
  defineJob,
  defineState,
  int,
  obj,
  opt,
  str,
  unknown,
  type JobHandle,
  type RunningEntry,
  type Schema,
  type SingletonHandle,
  type StoreSelf,
  type Tx,
} from "@earendil-works/chord/next";
import {
  admitNotes,
  appendNotes,
  project,
  readNotebook,
  type Definition,
} from "./state.ts";
import {
  explorerResultFor,
  noteIdAfter,
  pick,
  selectionResultFor,
  sourceVerdictsFor,
  type Note,
  type Verification,
  type VerifierInput,
} from "./policy/contracts.ts";
import type { PiRoleProfile } from "./policy/settings.ts";
import type { CallDescriptor } from "./policy/prompts.ts";
import { directSupport, supportClosure } from "./policy/support.ts";
import { verificationPrefix } from "./policy/verification.ts";
import type { CodexRequest, CodexResult } from "./policy/source.ts";
import { verify } from "./verification.ts";
import {
  copy,
  type ResearchData,
  type WorkInput,
  type WorkerArgs,
  type WorkerResult,
  type WorkerState,
} from "./records.ts";

export type SourceExecutor = (
  request: CodexRequest,
  signal: AbortSignal,
) => Promise<CodexResult>;
export type WorkerRequest =
  | { kind: "explorer"; guidance?: string }
  | { kind: "verifier"; verify?: Verification[] }
  | { kind: "retry"; job: string };
export type ActiveWorker = Exclude<
  RunningEntry<WorkerArgs, WorkerState>,
  { phase: "blocked" }
>;
export type RoleCalls = {
  call(
    origin: string,
    attempt: number,
    key: string,
    descriptor: CallDescriptor,
    profile: PiRoleProfile,
    context: Context,
  ): Promise<{ call: number; value: JsonValue }>;
};
const fullVerification = ({ verifiers }: Verification) =>
  verifiers.includes("requirements") && verifiers.includes("reconstruction");
export const claimOf = ({
  args,
  state,
}: {
  args: WorkerArgs;
  state: WorkerState;
}) =>
  state.claim ?? (args.work.kind === "verify" ? args.work.input : undefined);
const offeredBy = (work: Extract<WorkInput, { kind: "selector" }>) =>
  work.verify?.map(({ note }) => note) ?? work.input.notes.map(({ id }) => id);
const State = defineState("xean.worker.state", {
  version: 1,
  schema: obj({ claim: opt(unknown() as Schema<VerifierInput>) }),
  initial: (): WorkerState => ({}),
  persist: true,
  checkpointWhen: () => false,
});

function claimFor(
  work: Extract<WorkInput, { kind: "selector" }>,
  selected: Verification[],
  notes: Note[],
) {
  if (work.input.verifyOnSolution) {
    const roots = selected
      .filter(fullVerification)
      .map(({ note }) => pick(notes, note));
    const related = new Set([
      ...roots.map(({ id }) => id),
      ...supportClosure(roots, notes),
      ...(work.input.nominatedSupport ?? []),
    ]);
    selected = selected.filter(({ note }) => related.has(note));
  }
  const batch = verificationPrefix(selected, notes, work.settings.window);
  if (!batch.length) return;
  const listed = batch.map(({ note }) => pick(notes, note));
  const ids = new Set(listed.map(({ id }) => id));
  return {
    task: work.input.task,
    verify: batch,
    notes: listed,
    support: directSupport(listed, notes).filter(({ id }) => !ids.has(id)),
  } satisfies VerifierInput;
}

/** One Chord job owns each invocation, its selected claim, and its native recovery. */
export function createWorkers(
  self: StoreSelf,
  data: SingletonHandle<ResearchData>,
  definition: Definition,
  calls: RoleCalls,
  source?: SourceExecutor,
) {
  const Research = defineJob("xean.worker", {
    version: 1,
    args: obj({
      campaign: bool(),
      epoch: int(),
      attempt: int(),
      origin: opt(str()),
      work: unknown() as Schema<WorkInput>,
    }),
    result: unknown() as Schema<WorkerResult>,
    state: State,
    concurrency: definition.settings.maxWorkers,
    persist: { resume: "rerun" },
  });
  let job!: JobHandle<WorkerArgs, WorkerResult, WorkerState>;
  function views() {
    const active = job.running.value.map((entry) => {
      if (entry.phase === "blocked")
        throw new Error("A blocked worker requires recovery");
      return entry;
    });
    return {
      active,
      claimed: active.flatMap(
        (entry) => claimOf(entry)?.verify.map(({ note }) => note) ?? [],
      ),
      offered: active.flatMap((entry) =>
        !claimOf(entry) && entry.args.work.kind === "selector"
          ? offeredBy(entry.args.work)
          : [],
      ),
      nominatedSupport(notes: Note[]) {
        const roots = new Set(
          [...data.value.history, ...active].flatMap(
            (entry) =>
              claimOf(entry)
                ?.verify.filter(fullVerification)
                .map(({ note }) => note) ?? [],
          ),
        );
        return [
          ...new Set(
            [...roots]
              .filter((id) => !pick(notes, id).dead)
              .flatMap((id) => supportClosure([pick(notes, id)], notes)),
          ),
        ];
      },
    };
  }
  job = self.job(Research, {
    run: async (args, ctx) => {
      // Pi resumes its whole session, so blocked jobs must be repaired first.
      views();
      const origin = args.origin ?? ctx.jobId;
      const work = args.work;
      const call = (
        key: string,
        descriptor: CallDescriptor,
        profile: PiRoleProfile,
      ) => calls.call(origin, args.attempt, key, descriptor, profile, ctx);
      if (work.kind === "explorer") {
        const input = work.input;
        const answer = await call(
          "role",
          { kind: "explorer", input },
          work.profile,
        );
        const { notes } = explorerResultFor(input.notes, input.namespace).parse(
          answer.value,
        );
        const stored = notes.map((note, index) => ({
          ...note,
          id: noteIdAfter(input.namespace, index),
        }));
        await data.change((draft) => {
          appendNotes(draft.notebook, stored, `xean/${origin}`);
        }, ctx);
        return {
          status: "completed",
          verify: [],
          notes: stored.map(({ id }) => id),
        };
      }
      let claim = ctx.state.value.claim;
      if (!claim) {
        let selected = work.kind === "selector" ? work.verify : undefined;
        if (work.kind === "selector" && selected === undefined) {
          if (!work.input.notes.length)
            return { status: "no-work", verify: [] };
          const answer = await call(
            "selection",
            { kind: "selection", input: work.input },
            work.settings.correctness,
          );
          selected = selectionResultFor(work.input.notes).parse(
            answer.value,
          ).verify;
        }
        const acquired = await ctx.state.change((draft) => {
          if (draft.claim) return copy(draft.claim);
          const occupied = new Set(
            views()
              .active.filter(({ id }) => id !== ctx.jobId)
              .flatMap(
                (entry) => claimOf(entry)?.verify.map(({ note }) => note) ?? [],
              ),
          );
          let candidate: VerifierInput | undefined;
          if (work.kind === "verify") candidate = work.input;
          else {
            const { notes } = project(readNotebook(data.value.notebook));
            const parsed = selectionResultFor(notes).safeParse({
              verify: selected,
            });
            if (parsed.success)
              candidate = claimFor(work, parsed.data.verify, notes);
          }
          if (!candidate) return "no-work" as const;
          if (candidate.verify.some(({ note }) => occupied.has(note)))
            return "busy" as const;
          draft.claim = copy(candidate);
          return copy(candidate);
        }, ctx);
        if (typeof acquired === "string")
          return { status: acquired, verify: [] };
        claim = acquired;
      }
      await verify(claim, work.settings, {
        call,
        recorded: async () =>
          data.value.notebook.checks
            .filter((check) => check.candidate === origin)
            .flatMap((check) => check.values),
        record: (id, values) =>
          data.change((draft) => {
            if (!draft.notebook.checks.some((check) => check.call === id))
              draft.notebook.checks.push({
                candidate: origin,
                call: id,
                values: copy(values),
              });
          }, ctx),
        source: async (key, request, judged) => {
          if (!source)
            throw new Error("Codex source execution is not registered");
          const id = `${origin}/${args.attempt}/${key}`;
          const prior = data.value.sources.find((entry) => entry.id === id);
          const output =
            prior?.output ?? (await source(request, ctx.abortSignal!));
          const validate = () => {
            if (output.state !== "succeeded")
              throw new Error(`verifier failed: ${output.error}`);
            const value = sourceVerdictsFor(judged).parse(output.output);
            if (
              !request.search &&
              value.verdicts.some(({ sources }) => sources.length)
            )
              throw new Error("Source citations require search to be enabled");
            return value;
          };
          let value: ReturnType<typeof validate> | undefined, error: unknown;
          try {
            value = validate();
          } catch (cause) {
            error = cause;
          }
          await data.change((draft) => {
            if (!draft.sources.some((entry) => entry.id === id))
              draft.sources.push({
                id,
                origin,
                attempt: args.attempt,
                key,
                request: copy(request),
                output: copy(output),
              });
            if (
              value &&
              !draft.notebook.checks.some((check) => check.call === id)
            )
              draft.notebook.checks.push({
                candidate: origin,
                call: id,
                values: value.verdicts.map(({ note, verdict, report }) => ({
                  note,
                  verdict,
                  report,
                  verifier: "source",
                })),
              });
          }, ctx);
          if (!value) throw error;
        },
      });
      return { status: "completed", verify: claim.verify };
    },
    finish: async (outcome, tx) => {
      const draft = await tx.draft(data);
      draft.history.push({
        id: outcome.id,
        origin: outcome.args.origin ?? outcome.id,
        args: copy(outcome.args),
        state: copy(outcome.state),
        ...(outcome.kind === "done"
          ? { status: "completed" as const, result: copy(outcome.result) }
          : {
              status: "failed" as const,
              error:
                outcome.error.kind === "threw"
                  ? outcome.error.error.message
                  : outcome.error.kind,
            }),
      });
    },
  });

  async function admit(
    tx: Tx,
    requests: readonly WorkerRequest[],
    options: { campaign: boolean; epoch: number; eligible?: readonly string[] },
  ) {
    if (!requests.length) throw new Error("Worker group must be nonempty");
    const draft = await tx.draft(data);
    const current = views(),
      { active } = current;
    if (options.campaign) {
      if (draft.campaign?.status !== "running")
        throw new Error("Campaign is not running");
      if (active.some(({ args }) => !args.campaign))
        throw new Error("Campaign has live outside workers");
    } else if (
      draft.campaign &&
      (draft.campaign.status !== "terminal" ||
        draft.campaign.outcome === "call-failure")
    )
      throw new Error(
        "Campaign work must settle or resume before outside admission",
      );
    const origins = new Set(active.map(({ args, id }) => args.origin ?? id));
    const occupied = new Set(current.claimed);
    const prepared = requests.map((request) => {
      if (request.kind !== "retry") return request;
      const prior = draft.history.find(({ id }) => id === request.job);
      if (!prior || prior.status !== "failed")
        throw new Error("Retry requires a failed worker");
      if (
        draft.history.findLast(({ origin }) => origin === prior.origin)?.id !==
        prior.id
      )
        throw new Error("Retry reference has been superseded");
      if (prior.args.campaign !== options.campaign)
        throw new Error("Retry must belong to its campaign");
      if (origins.has(prior.origin))
        throw new Error("Worker already has a live retry");
      origins.add(prior.origin);
      let work = prior.args.work;
      if (prior.state.claim && work.kind !== "explorer")
        work = {
          kind: "verify",
          input: prior.state.claim,
          settings: work.settings,
        };
      if (work.kind === "verify")
        for (const { note } of work.input.verify) {
          if (occupied.has(note))
            throw new Error(
              "Verification claim is busy; retry after competing work settles",
            );
          occupied.add(note);
        }
      return copy({
        ...prior.args,
        origin: prior.origin,
        attempt: prior.args.attempt + 1,
        work,
      });
    });
    if (active.length + prepared.length > definition.settings.maxWorkers)
      throw new Error("maxWorkers limit exceeded");
    if (
      requests.some(({ kind }) => kind === "explorer") ||
      (!active.length &&
        requests.some(
          (request) =>
            request.kind === "verifier" && request.verify === undefined,
        ))
    )
      admitNotes(draft.notebook);
    const { notes, accepted } = project(readNotebook(draft.notebook));
    if (accepted.length && requests.some(({ kind }) => kind !== "retry"))
      throw new Error("Campaign is already accepted");
    const claimed = [...occupied];
    const reserved = new Set([
      ...claimed,
      ...current.offered,
      ...prepared.flatMap((request) => {
        if ("work" in request)
          return request.work.kind === "selector"
            ? offeredBy(request.work)
            : [];
        return request.kind === "verifier"
          ? (request.verify ?? []).map(({ note }) => note)
          : [];
      }),
    ]);
    const eligible = options.eligible && new Set(options.eligible);
    const available = notes.filter(
      ({ id, dead }) =>
        !dead && !reserved.has(id) && (!eligible || eligible.has(id)),
    );
    const selectors = requests.filter(
      (request) => request.kind === "verifier" && request.verify === undefined,
    ).length;
    const selectionViews = Array.from({ length: selectors }, (_, slot) => {
      const targets = available.filter(
        (_, index) => index % selectors === slot,
      );
      if (!definition.settings.verifyOnSolution) return targets;
      const related = new Set([
        ...targets.map(({ id }) => id),
        ...supportClosure(targets, notes),
      ]);
      return notes.filter(
        ({ id }) =>
          related.has(id) &&
          !reserved.has(id) &&
          (!eligible || eligible.has(id)),
      );
    });
    const nominated = definition.settings.verifyOnSolution
      ? current.nominatedSupport(notes)
      : [];
    let slot = 0;
    const args = prepared.map((request): WorkerArgs => {
      if ("work" in request) return request;
      const work: WorkInput =
        request.kind === "explorer"
          ? {
              kind: "explorer",
              profile: definition.settings.explorer,
              input: {
                namespace: `w${draft.nextNoteNamespace++}`,
                task: definition.task,
                explorerGuidance: request.guidance ?? "",
                notes: notes.map(
                  ({ text: _text, detailedSummary: _detail, ...note }) => note,
                ),
              },
            }
          : {
              kind: "selector",
              settings: definition.settings,
              input: {
                task: definition.task,
                notes:
                  request.verify === undefined
                    ? selectionViews[slot++]!
                    : notes,
                claimed,
                ...(definition.settings.verifyOnSolution
                  ? { verifyOnSolution: true, nominatedSupport: nominated }
                  : {}),
              },
              ...(request.verify === undefined
                ? {}
                : {
                    verify: selectionResultFor(notes).parse({
                      verify: request.verify,
                    }).verify,
                  }),
            };
      return copy({
        campaign: options.campaign,
        epoch: options.epoch,
        attempt: 0,
        work,
      });
    });
    return args.map((input) => tx.start(job, input));
  }
  const startGroup = (requests: readonly WorkerRequest[]) =>
    self.tx(
      (tx) =>
        admit(tx, requests, {
          campaign: false,
          epoch: data.value.campaign?.epoch ?? 0,
        }),
      BACKGROUND_CONTEXT,
    );
  return {
    job,
    running: job.running,
    views,
    admit,
    startGroup,
    start: async (request: WorkerRequest) => (await startGroup([request]))[0]!,
  };
}
