import { html, nothing, render, type TemplateResult } from "lit-html";
import { keyed } from "lit-html/directives/keyed.js";
import { repeat } from "lit-html/directives/repeat.js";
import renderMath from "katex/contrib/auto-render";
import "katex/dist/katex.min.css";
import { acceptedArgument } from "../../../src/math/argument.ts";
import type { Run, RunStatus } from "../server.ts";
import { noteStatus } from "./notes.ts";

const app = document.querySelector<HTMLElement>("#app")!;
const connection = document.querySelector<HTMLElement>("#connection")!;
type Snapshot = NonNullable<Run["snapshot"]>;
type Note = Snapshot["notes"][number];
type Patch = Record<string, string | number | null>;
const pageSize = 50;
let runs: RunStatus[] = [];
let selected: Run | undefined;
let pending: AbortController | undefined;
let params = new URLSearchParams(location.hash.slice(1));
const renderedMath = new WeakMap<HTMLElement, string>();
const count = (value: number | undefined | null) =>
  value == null ? "Unknown" : value.toLocaleString();
const state = (run: Run | RunStatus) =>
  run.snapshot?.status.status ?? (run.error ? "Unavailable" : "Unknown");
const age = (run: { observedAt: string }) => {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(run.observedAt)) / 1000),
  );
  return `${seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} ago`;
};
const math = (text: string) =>
  html`<div class="math" .mathSource=${text}></div>`;
const badge = (label: string) => html`<span class="badge">${label}</span>`;
const metrics = (
  values: Record<string, string | number | null | undefined | TemplateResult>,
  className = "metrics",
) =>
  html`<dl class=${className}>
    ${Object.entries(values).map(
      ([label, value]) =>
        html`<div>
          <dt>${label}</dt>
          <dd>
            ${typeof value === "number" || value == null ? count(value) : value}
          </dd>
        </div>`,
    )}
  </dl>`;

function href(patch: Patch) {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  return `#${next}`;
}
function replace(patch: Patch) {
  history.replaceState(null, "", href(patch));
  params = new URLSearchParams(location.hash.slice(1));
  draw();
}
function disclosure(key: string, label: string, body: () => TemplateResult) {
  const opened = new Set((params.get("open") ?? "").split(",").filter(Boolean));
  const open = opened.has(key);
  return html`<details
    .open=${open}
    @toggle=${(event: Event) => {
      const details = event.currentTarget as HTMLDetailsElement;
      if (!details.isConnected) return;
      const now = details.open;
      if (now === open) return;
      if (now) opened.add(key);
      else opened.delete(key);
      replace({ open: [...opened].join(",") });
    }}
  >
    <summary>${label}</summary>
    ${open ? body() : ""}
  </details>`;
}
function search(label: string, key: string, reset?: string) {
  return html`<label class="search"
    >${label}<input
      type="search"
      .value=${params.get(key) ?? ""}
      @input=${(event: Event) => replace({ [key]: (event.target as HTMLInputElement).value, ...(reset ? { [reset]: null } : {}) })}
  /></label>`;
}
function filter(label: string, key: string, options: string[], reset?: string) {
  return html`<label
    >${label}<select
      @change=${(event: Event) => replace({ [key]: (event.target as HTMLSelectElement).value, ...(reset ? { [reset]: null } : {}) })}
    >
      ${options.map((option) => html`<option value=${option} .selected=${option === (params.get(key) ?? "all")}>${option === "all" ? "All" : option}</option>`)}
    </select></label
  >`;
}
function paginate<T>(items: T[], key: string) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const requested = Number(params.get(key) ?? 1);
  const page = Math.max(
    1,
    Math.min(pages, Number.isSafeInteger(requested) ? requested : 1),
  );
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    navigation: html`<nav
      class="pagination"
      aria-label=${`${key === "notePage" ? "Note" : "Work"} pages`}
    >
      ${page > 1 ? html`<a href=${href({ [key]: page - 1 })}>← Previous</a>` : html`<span>← Previous</span>`}
      <span>Page ${page} of ${pages}, ${count(items.length)} results</span>
      ${page < pages ? html`<a href=${href({ [key]: page + 1 })}>Next →</a>` : html`<span>Next →</span>`}
    </nav>`,
  };
}
const noteBadges = (snapshot: Snapshot, note: Note) =>
  html`<div class="badges">
    ${badge(noteStatus(note, snapshot.status.acceptedNoteId))}${note.imported ? badge("Imported") : ""}${note.verified ? badge("Verified") : ""}
  </div>`;
function noteLink(snapshot: Snapshot, id: string) {
  const index = snapshot.notes.findIndex((note) => note.id === id);
  const note = snapshot.notes[index];
  return note
    ? html`<a
        href=${href({ view: "notes", note: id, noteFilter: null, notesQuery: null, notePage: Math.floor(index / pageSize) + 1 })}
        >${note.summary} <code>${id}</code></a
      >`
    : html`<code>${id}</code>
        <span class="muted">(not in this snapshot)</span>`;
}
function noteLinks(snapshot: Snapshot, ids: string[]) {
  return ids.length
    ? html`<ul class="links">
        ${ids.map((id) => html`<li>${noteLink(snapshot, id)}</li>`)}
      </ul>`
    : html`<p class="muted">None recorded.</p>`;
}
function resultView(value: unknown): TemplateResult {
  if (Array.isArray(value))
    return value.length
      ? html`<ol>
          ${value.map((item) => html`<li>${resultView(item)}</li>`)}
        </ol>`
      : html`<span class="muted">None recorded.</span>`;
  if (value !== null && typeof value === "object")
    return html`<dl class="result-fields">
      ${Object.entries(value).map(
        ([key, item]) =>
          html`<div>
            <dt>
              ${key === "premise" ? "Premise index (from 0)" : key.replace(/([a-z])([A-Z])/g, "$1 $2")}
            </dt>
            <dd>${resultView(item)}</dd>
          </div>`,
      )}
    </dl>`;
  if (typeof value === "string") {
    if (["PASS", "FAIL", "INCONCLUSIVE"].includes(value)) return badge(value);
    if (/^https?:\/\/\S+$/i.test(value))
      return html`<a href=${value} target="_blank" rel="noopener noreferrer"
        >${value}</a
      >`;
    return math(value);
  }
  return html`<span class="muted"
    >${value === undefined ? "Not recorded" : String(value)}</span
  >`;
}
function notesView(snapshot: Snapshot) {
  const query = (params.get("notesQuery") ?? "").toLocaleLowerCase();
  const selectedFilter = params.get("noteFilter") ?? "all";
  const filtered = snapshot.notes.filter(
    (note) =>
      (selectedFilter === "all" ||
        (selectedFilter === "Imported"
          ? note.imported
          : selectedFilter === "Verified"
            ? note.verified
            : noteStatus(note, snapshot.status.acceptedNoteId) ===
              selectedFilter)) &&
      (!query ||
        `${note.id}\n${note.summary}\n${note.detailedSummary}`
          .toLocaleLowerCase()
          .includes(query)),
  );
  const page = paginate(filtered, "notePage");
  const selected = snapshot.notes.find(
    (note) => note.id === params.get("note"),
  );
  return html`<section aria-labelledby="notes-heading">
    <h2 id="notes-heading">Notes and verification</h2>
    <div class="controls">
      ${search("Search note IDs and summaries", "notesQuery", "notePage")}${filter("Note status", "noteFilter", ["all", "Supporting / partial", "Candidate", "Accepted", "Rejected", "Imported", "Verified"], "notePage")}
    </div>
    <p class="muted">
      Supporting and partial notes retain useful knowledge without claiming the
      exact task. Acceptance is the solver's internal decision.
    </p>
    <div class="reader-layout">
      <div class="note-index">
        ${page.navigation}
        <ol class="note-list">
          ${repeat(
            page.items,
            (note) => note.id,
            (note) =>
              html`<li class=${selected?.id === note.id ? "selected" : ""}>
                <a
                  href=${href({ note: note.id })}
                  aria-current=${selected?.id === note.id ? "true" : "false"}
                  >${note.summary}</a
                >
                <code>${note.id}</code>${noteBadges(snapshot, note)}
              </li>`,
          )}
        </ol>
        ${!filtered.length ? html`<p class="muted">No matching notes.</p>` : ""}${page.navigation}
      </div>
      <article class="reader" aria-label="Selected note">
        ${
          selected
            ? keyed(
                selected.id,
                html`<h3>${selected.summary}</h3>
                  <p class="muted">
                    <code>${selected.id}</code>, revision ${selected.revision}
                  </p>
                  ${noteBadges(snapshot, selected)}${math(selected.detailedSummary)}
                  ${disclosure("full", "Full note", () => math(selected.text))}
                  ${disclosure("checks", `Checks (${selected.checks.length})`, () => resultView(selected.checks))}
                  <h4>Dependencies</h4>
                  ${noteLinks(snapshot, selected.support)}
                  <h4>Used by</h4>
                  ${noteLinks(
                    snapshot,
                    snapshot.notes
                      .filter((note) => note.support.includes(selected.id))
                      .map((note) => note.id),
                  )}
                  <h4>Related work</h4>
                  <ul class="links">
                    ${snapshot.work
                      .filter((work) => work.noteIds.includes(selected.id))
                      .map(
                        (work) =>
                          html`<li>
                            <a href=${href({ view: "work", work: work.id })}
                              ><code>${work.id}</code>, ${work.role},
                              ${work.status}</a
                            >
                          </li>`,
                      )}
                  </ul> `,
              )
            : html`<p class="muted">
                ${params.has("note") ? "The selected note is not in this snapshot." : "Select a note to read its summary, proof, dependencies, and checks."}
              </p>`
        }
      </article>
    </div>
  </section>`;
}
function workView(snapshot: Snapshot) {
  const selectedFilter = params.get("workFilter") ?? "all";
  const filtered = snapshot.work.filter(
    (work) => selectedFilter === "all" || work.status === selectedFilter,
  );
  const page = paginate(filtered, "workPage");
  const selected = snapshot.work.find((work) => work.id === params.get("work"));
  return html`<section aria-labelledby="work-heading">
    <h2 id="work-heading">Work history</h2>
    <div class="controls">
      ${filter("Work status", "workFilter", ["all", "queued", "active", "completed", "failed", "cancelled"], "workPage")}
    </div>
    ${page.navigation}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Work</th>
            <th>Role</th>
            <th>Status</th>
            <th>Notes / checks</th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            page.items,
            (work) => work.id,
            (work) =>
              html`<tr class=${selected?.id === work.id ? "selected" : ""}>
                <td>
                  <a
                    href=${href({ work: work.id })}
                    aria-current=${selected?.id === work.id ? "true" : "false"}
                    ><code>${work.id}</code></a
                  >
                </td>
                <td>${work.role}</td>
                <td>${work.status}</td>
                <td>${work.noteIds.length} / ${work.checkCount}</td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${!filtered.length ? html`<p class="muted">No matching work.</p>` : ""}${page.navigation}
    <article class="reader" aria-label="Selected work">
      ${
        selected
          ? keyed(
              selected.id,
              html`<h3>${selected.role}, <code>${selected.id}</code></h3>
                <p>${badge(selected.status)}</p>
                ${
                  selected.retryOf
                    ? html`<p>
                        Retry of
                        <a href=${href({ work: selected.retryOf })}
                          ><code>${selected.retryOf}</code></a
                        >.
                      </p>`
                    : nothing
                }
                <h4>Guidance</h4>
                ${selected.guidance ? math(selected.guidance) : html`<p class="muted">No guidance recorded for this work.</p>`}
                ${
                  selected.error
                    ? html`<h4>Error</h4>
                        <pre class="error">${selected.error}</pre>`
                    : ""
                }
                <h4>Affected notes</h4>
                ${noteLinks(snapshot, selected.noteIds)}
                <p>${selected.checkCount} checks published.</p>`,
            )
          : html`<p class="muted">
              ${params.has("work") ? "The selected work is not in this snapshot." : "Select work to inspect its guidance, outcome, and affected notes."}
            </p>`
      }
    </article>
  </section>`;
}
function usageView(snapshot: Snapshot) {
  const calls = snapshot.status.calls;
  return html`<section>
    <h2>Native usage</h2>
    ${metrics({
      "Recorded responses": calls.recordedResponses,
      "Codex invocations": calls.codexInvocations,
      "Unknown usage": calls.unknownUsage,
    })}
    <p class="muted">
      Zero is a reported count. Unknown means no native usage was recorded.
      Provider retry attempts are not inferred from responses.
    </p>
    ${calls.byModel.items.map(
      (group) =>
        html`<article class="usage-group">
          <h3>${group.model}</h3>
          <p class="muted">
            ${group.provider}, ${group.api}, served model:
            ${group.servedModel ?? "Unknown"}. ${count(group.responses)}
            responses, ${count(group.invocations)} Codex invocations
          </p>
          ${
            Object.keys(group.reportedUsage).length
              ? metrics(group.reportedUsage)
              : html`<p>Native usage: Unknown</p>`
          }
        </article>`,
    )}
    ${
      calls.byModel.omitted
        ? html`<p class="muted">
            ${count(calls.byModel.omitted)} additional model groups omitted.
            Totals include all groups.
          </p>`
        : nothing
    }
    <p class="muted">${snapshot.status.usageNote}</p>
  </section>`;
}
function detailView(run: Run) {
  const snapshot = run.snapshot;
  const currentTask = snapshot?.task;
  const view = params.get("view") ?? "notes";
  const active =
    snapshot?.work.filter(
      (work) => work.status === "active" || work.status === "queued",
    ) ?? [];
  return html`<a
      class="back"
      href=${href({ run: null, note: null, work: null, open: null, view: null })}
      >← All runs</a
    >
    <div class="title">
      <h1>${run.id}</h1>
      ${badge(state(run))}
    </div>
    <p class="muted">
      ${snapshot ? "Database observation" : "No campaign evidence"},
      ${age(run)}${snapshot?.kind ? `, ${snapshot.kind}` : ""}
    </p>
    ${run.stale ? html`<p class="error">Stale campaign data: showing the last successful observation. The latest read failed.</p>` : ""}
    ${run.error ? html`<pre class="error">${run.error}</pre>` : ""}${snapshot?.status.error ? html`<pre class="error">${snapshot.status.error}</pre>` : ""}
    ${snapshot?.status.nextAction ? html`<p>${snapshot.status.nextAction}</p>` : ""}
    ${
      snapshot?.status.verificationIssues
        ? html`<section>
            <h2>Candidate verification</h2>
            <p>
              Recorded checks that have not passed for claimed solutions or
              their supporting notes.
            </p>
            <ul>
              ${snapshot.status.verificationIssues.items.map(
                (issue) =>
                  html`<li>
                    <code>${issue.noteId}</code>: ${issue.stage} —
                    ${issue.verdict}
                    ${issue.report ? html`<pre>${issue.report}</pre>` : ""}
                  </li>`,
              )}
            </ul>
            ${snapshot.status.verificationIssues.omitted ? html`<p>${snapshot.status.verificationIssues.omitted} further checks omitted.</p>` : ""}
          </section>`
        : ""
    }
    <section>
      <h2>Problem</h2>
      ${
        currentTask
          ? html`${math(currentTask.problem)}
            ${disclosure("criteria", "Completion criteria", () => math(currentTask.completionCriteria))}`
          : html`<p class="muted">
              No mathematical task is available in this observation.
            </p>`
      }
    </section>
    ${metrics(
      {
        "Recorded responses": snapshot?.status.calls.recordedResponses,
        Notes: snapshot ? (snapshot.status.notes?.total ?? 0) : undefined,
        "Internally accepted": snapshot
          ? Number(snapshot.status.acceptedNoteId !== null)
          : undefined,
        "Active work": snapshot?.status.work.active,
      },
      "stats",
    )}
    ${
      active.length
        ? html`<section>
            <h2>Current work</h2>
            <ul class="links">
              ${active.map(
                (work) =>
                  html`<li>
                    <a href=${href({ view: "work", work: work.id })}
                      ><code>${work.id}</code>, ${work.role}</a
                    >
                    ${badge(work.status)}
                  </li>`,
              )}
            </ul>
          </section>`
        : ""
    }
    ${
      snapshot
        ? html`<nav class="tabs" aria-label="Campaign views">
              ${["notes", "work", "usage"].map((name) => html`<a href=${href({ view: name })} aria-current=${view === name ? "page" : "false"}>${name[0]!.toUpperCase() + name.slice(1)}</a>`)}
            </nav>
            ${view === "work" ? workView(snapshot) : view === "usage" ? usageView(snapshot) : notesView(snapshot)}
            ${
              snapshot.status.acceptedNoteId === null && snapshot.result == null
                ? ""
                : html`<section>
                    <h2>Campaign result</h2>
                    ${disclosure("result", "Read campaign result", () => {
                      const result = snapshot.result;
                      if (snapshot.status.acceptedNoteId !== null)
                        return math(
                          acceptedArgument(
                            snapshot.notes,
                            snapshot.status.acceptedNoteId,
                          ),
                        );
                      return resultView(result);
                    })}
                  </section>`
            }`
        : html`<section>
            <h2>Campaign details</h2>
            <p class="muted">
              Notes, checks, work history, and native usage are unavailable in
              this observation.
            </p>
          </section>`
    }
    <footer>
      <code>${run.database}</code
      ><a
        href=${`/api/runs/${encodeURIComponent(run.id)}`}
        target="_blank"
        rel="noopener noreferrer"
        >View JSON</a
      >
    </footer>`;
}
function indexView() {
  const query = (params.get("runsQuery") ?? "").toLocaleLowerCase();
  const selectedFilter = params.get("runFilter") ?? "all";
  const filtered = runs.filter(
    (run) =>
      (!query ||
        `${run.id}\n${run.problem ?? ""}\n${run.database}`
          .toLocaleLowerCase()
          .includes(query)) &&
      (selectedFilter === "all" ||
        (selectedFilter === "Stale"
          ? run.stale
          : state(run) === selectedFilter)),
  );
  return html`<div class="title">
      <h1>Runs</h1>
      <span class="muted">${runs.length} configured</span>
    </div>
    <p class="muted">
      Inspect committed work and verification. Refreshes every ten seconds.
    </p>
    <div class="controls">
      ${search("Search runs", "runsQuery")}${filter("Campaign status", "runFilter", ["all", ...new Set(runs.map(state)), "Stale"])}
    </div>
    <p class="muted">${filtered.length} matching runs</p>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Campaign status</th>
            <th>Recorded responses</th>
            <th>Notes</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          ${repeat(
            filtered,
            (run) => run.id,
            (run) =>
              html`<tr>
                <td>
                  <a
                    href=${href({ run: run.id, view: null, note: null, work: null, notePage: null, workPage: null, open: null })}
                    >${run.id}</a
                  >
                  <p class="excerpt">${run.problem ?? "No task available"}</p>
                </td>
                <td>${state(run)}</td>
                <td>${count(run.snapshot?.status.calls.recordedResponses)}</td>
                <td>${count(run.snapshot?.status.notes?.total)}</td>
                <td>
                  ${run.snapshot ? "Database" : "Unavailable"}<br /><span
                    class="muted"
                    >${age(run)}</span
                  >${run.error ? html`<br /><span class="error">${run.stale ? "Stale" : "Read error"}</span>` : ""}
                </td>
              </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${!filtered.length ? html`<p class="muted">No matching configured runs.</p>` : ""}`;
}
function draw() {
  const id = params.get("run");
  render(
    id && selected?.id === id
      ? keyed(selected.id, detailView(selected))
      : id
        ? html`<h1>${pending ? "Loading run" : "Run unavailable"}</h1>
            <p><code>${id}</code></p>
            <a href="#">All runs</a>`
        : indexView(),
    app,
  );
  for (const element of app.querySelectorAll<
    HTMLElement & { mathSource: string }
  >(".math")) {
    const source = element.mathSource;
    if (renderedMath.get(element) === source) continue;
    element.textContent = source;
    renderMath(element, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "\\[", right: "\\]", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\(", right: "\\)", display: false },
      ],
      throwOnError: false,
      trust: false,
    });
    renderedMath.set(element, source);
  }
}
async function refresh() {
  if (pending) return;
  const controller = new AbortController();
  pending = controller;
  const id = params.get("run");
  draw();
  try {
    const response = await fetch(
      id ? `/api/runs/${encodeURIComponent(id)}` : "/api/runs?view=status",
      { signal: controller.signal },
    );
    if (id && response.status === 404) selected = undefined;
    else {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = await response.json();
      if (controller.signal.aborted) return;
      if (id) {
        const run = value as Run;
        selected =
          run.error &&
          !run.snapshot &&
          selected?.database === run.database &&
          selected.snapshot
            ? {
                ...run,
                observedAt: selected.observedAt,
                snapshot: selected.snapshot,
                stale: true,
              }
            : run;
      } else runs = value as RunStatus[];
    }
    connection.textContent = `Checked ${new Date().toLocaleTimeString()}. Evidence ages show when campaign data was observed.`;
  } catch (error) {
    if (!controller.signal.aborted)
      connection.textContent = `Refresh failed: ${error}. Showing the last received data.`;
  } finally {
    if (pending === controller) {
      pending = undefined;
      draw();
    }
  }
}
document
  .querySelector("#refresh")!
  .addEventListener("click", () => void refresh());
document.querySelector(".skip-link")!.addEventListener("click", (event) => {
  event.preventDefault();
  app.focus();
});
window.addEventListener("hashchange", () => {
  const before = params;
  params = new URLSearchParams(location.hash.slice(1));
  if (before.get("run") !== params.get("run")) {
    pending?.abort();
    pending = undefined;
    selected = undefined;
    void refresh();
  } else draw();
  if (
    ["note", "work"].some(
      (key) => params.get(key) && params.get(key) !== before.get(key),
    )
  )
    app
      .querySelector<HTMLElement>(".reader")
      ?.scrollIntoView({ block: "start" });
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
setInterval(() => {
  if (!document.hidden) void refresh();
}, 10_000);
void refresh();
