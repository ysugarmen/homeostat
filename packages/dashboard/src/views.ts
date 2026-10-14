import {
  type Config,
  describeEvent,
  type Entry,
  type Event,
  explainEntry,
  formatEvent,
  type Issue,
  STATUSES,
} from "@homeostat/core";
import { columns, type Datum, dataTable, dial, esc, rows } from "./charts.ts";
import type { AgentLiveness, Contribution, DesirePath, Health, Impact } from "./metrics.ts";
import { currentValue, type Field, SECTIONS, type Section } from "./settings.ts";

const CSS = `
:root {
  color-scheme: light;
  --paper: #f6f5f1;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink-2: #52514e;
  --ink-3: #85847e;
  --rule: #e2e0d9;
  --grid: rgba(11, 11, 11, 0.035);
  --series: #2a78d6;
  --series-soft: #cde2fb;
  --good: #0ca30c;
  --warning: #b37a00;
  --critical: #d03b3b;
  --focus: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #121211;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink-2: #c3c2b7;
    --ink-3: #8f8e86;
    --rule: #2e2e2b;
    --grid: rgba(255, 255, 255, 0.03);
    --series: #3987e5;
    --series-soft: #184f95;
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #e66767;
    --focus: #3987e5;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #121211;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink-2: #c3c2b7;
  --ink-3: #8f8e86;
  --rule: #2e2e2b;
  --grid: rgba(255, 255, 255, 0.03);
  --series: #3987e5;
  --series-soft: #184f95;
  --warning: #fab219;
  --critical: #e66767;
  --focus: #3987e5;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background-color: var(--paper);
  background-image:
    linear-gradient(var(--grid) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid) 1px, transparent 1px);
  background-size: 24px 24px;
  color: var(--ink);
  font: 15px/1.5 "Avenir Next", "Segoe UI Variable Text", "Helvetica Neue", sans-serif;
}
.mono, code, pre, td.num, .num, .chip, .stat .n, nav a, .label { font-family: ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
h1, h2, h3 { font-family: "Iowan Old Style", Charter, "Bitstream Charter", "Sitka Text", Cambria, serif; font-weight: 600; letter-spacing: -0.01em; margin: 0; }
h1 { font-size: 28px; }
h2 { font-size: 19px; margin-bottom: 10px; }
a { color: var(--series); text-decoration-thickness: 1px; text-underline-offset: 3px; }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.shell { max-width: 1120px; margin: 0 auto; padding: 24px 16px 64px; }
header.top { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; border-bottom: 1px solid var(--rule); padding-bottom: 14px; margin-bottom: 18px; }
.brand { display: flex; align-items: baseline; gap: 12px; }
.brand .sub { color: var(--ink-3); font-size: 13px; }
nav { display: flex; flex-wrap: wrap; gap: 4px 14px; }
nav a { color: var(--ink-2); text-decoration: none; font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 0; border-bottom: 1px solid transparent; }
nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(12, 1fr); }
.panel { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 16px 18px; grid-column: span 12; min-width: 0; }
.span-4 { grid-column: span 4; } .span-6 { grid-column: span 6; } .span-8 { grid-column: span 8; }
@media (max-width: 860px) { .span-4, .span-6, .span-8 { grid-column: span 12; } }
.label { color: var(--ink-3); font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.08em; }
.lede { color: var(--ink-2); margin: 4px 0 14px; max-width: 70ch; }
.stats { display: grid; grid-template-columns: repeat(var(--cols, 3), 1fr); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 6px; overflow: hidden; }
.stat { background: var(--surface); padding: 12px 14px; }
@media (max-width: 600px) { .stats { --cols: 2 !important; } }
.recent { table-layout: fixed; font-size: 13px; }
.recent td { padding: 5px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent .when { width: 116px; color: var(--ink-3); }
.recent .what { width: 118px; color: var(--ink-2); }
.stat .n { font-size: 26px; line-height: 1.1; display: block; }
.stat .k { color: var(--ink-2); font-size: 12.5px; }
.units { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
@media (max-width: 600px) { .units { grid-template-columns: 1fr; } }
.unit { border: 1px solid var(--rule); border-radius: 6px; padding: 12px 14px; display: grid; gap: 4px; }
.unit .head { display: flex; align-items: center; gap: 8px; }
.lamp { width: 10px; height: 10px; border-radius: 50%; background: var(--ink-3); box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); color: var(--ink-3); flex: none; }
.lamp.good { background: var(--good); color: var(--good); } .lamp.warning { background: var(--warning); color: var(--warning); } .lamp.critical { background: var(--critical); color: var(--critical); }
.state { font-size: 12.5px; color: var(--ink-2); }
.chart { width: 100%; height: auto; display: block; overflow: visible; }
.chart path { fill: var(--series); }
.chart .hit { fill: transparent; }
.chart .m:hover path { fill: color-mix(in srgb, var(--series) 80%, var(--ink)); }
.chart .base { stroke: var(--rule); stroke-width: 1; }
.chart text { font: 11px ui-monospace, Menlo, monospace; fill: var(--ink-3); }
.chart text.v { fill: var(--ink-2); }
.dial { width: 100%; max-width: 260px; display: block; margin: 0 auto; }
.dial .track { fill: none; stroke: var(--rule); stroke-width: 10; stroke-linecap: round; }
.dial .fill { fill: none; stroke: var(--series); stroke-width: 10; stroke-linecap: round; }
.dial .tick { stroke: var(--ink-3); stroke-width: 1; } .dial .tick.major { stroke: var(--ink-2); stroke-width: 1.5; }
.dial .needle { stroke: var(--ink); stroke-width: 2; stroke-linecap: round; }
.dial .hub { fill: var(--ink); }
.dial-value { font: 600 26px "Iowan Old Style", Charter, Cambria, serif; fill: var(--ink); }
.dial-caption { font: 11px ui-monospace, Menlo, monospace; fill: var(--ink-3); text-transform: uppercase; letter-spacing: 0.08em; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font: 11.5px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-3); font-weight: 500; border-bottom: 1px solid var(--rule); padding: 6px 8px; }
td { border-bottom: 1px solid var(--rule); padding: 7px 8px; vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.num { text-align: right; }
.table-wrap { overflow-x: auto; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; padding: 1px 7px; border: 1px solid var(--rule); border-radius: 999px; color: var(--ink-2); white-space: nowrap; }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
.chip.accepted::before { background: var(--good); } .chip.disputed::before { background: var(--critical); } .chip.candidate::before { background: var(--warning); }
.muted { color: var(--ink-3); }
.empty { color: var(--ink-3); font-style: italic; }
pre.entry { white-space: pre-wrap; background: var(--paper); border: 1px solid var(--rule); border-radius: 6px; padding: 14px; font-size: 13px; line-height: 1.55; }
details.table-view { margin-top: 8px; } details.table-view summary { cursor: pointer; color: var(--ink-3); font: 12px ui-monospace, Menlo, monospace; }
.events { font: 12.5px/1.7 ui-monospace, Menlo, monospace; color: var(--ink-2); white-space: pre-wrap; margin: 0; overflow-x: auto; }
form.settings { display: grid; gap: 14px; max-width: 760px; }
.field { display: grid; grid-template-columns: 240px 1fr; gap: 6px 16px; align-items: start; }
@media (max-width: 700px) { .field { grid-template-columns: 1fr; } }
.field label { padding-top: 6px; color: var(--ink-2); font-size: 14px; }
.field .help { grid-column: 2; color: var(--ink-3); font-size: 12.5px; margin-top: -2px; }
@media (max-width: 700px) { .field .help { grid-column: 1; } }
input[type=text], input[type=number], select, textarea { font: 13.5px ui-monospace, Menlo, monospace; color: var(--ink); background: var(--surface); border: 1px solid var(--rule); border-radius: 5px; padding: 6px 8px; width: 100%; }
textarea { min-height: 84px; resize: vertical; }
.checks { display: flex; flex-wrap: wrap; gap: 6px 16px; padding-top: 6px; }
.rows td { padding: 4px 6px; }
.rows input[type=text] { min-width: 90px; }
button { font: 600 13px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.06em; color: var(--surface); background: var(--ink); border: 0; border-radius: 5px; padding: 9px 16px; cursor: pointer; justify-self: start; }
.notice { border: 1px solid var(--rule); border-left: 3px solid var(--good); background: var(--surface); padding: 10px 14px; border-radius: 4px; margin-bottom: 14px; }
.notice.error { border-left-color: var(--critical); }
.notice ul { margin: 6px 0 0; padding-left: 18px; }
footer { margin-top: 36px; color: var(--ink-3); font-size: 12.5px; border-top: 1px solid var(--rule); padding-top: 12px; }
@media (prefers-reduced-motion: no-preference) {
  .dial .needle { transform-origin: 110px 104px; animation: settle 1.1s cubic-bezier(.2,.9,.2,1.15) both; }
  @keyframes settle { from { transform: rotate(-90deg); } }
  .panel { animation: rise .35s ease-out both; }
  .grid > .panel:nth-child(2) { animation-delay: .04s; } .grid > .panel:nth-child(3) { animation-delay: .08s; } .grid > .panel:nth-child(4) { animation-delay: .12s; }
  @keyframes rise { from { opacity: 0; transform: translateY(4px); } }
}
`;

const NAV: [string, string][] = [
  ["/", "Overview"],
  ["/entries", "Entries"],
  ["/members", "Members"],
  ["/coverage", "Coverage"],
  ["/impact", "Impact"],
  ["/desire-paths", "Desire paths"],
  ["/events", "Events"],
  ["/settings", "Settings"],
];

export function layout(opts: {
  title: string;
  path: string;
  kbRoot: string;
  body: string;
  theme?: "light" | "dark";
}): string {
  const current = (href: string) =>
    href === "/" ? opts.path === "/" : opts.path === href || opts.path.startsWith(`${href}/`);
  return `<!doctype html>
<html lang="en"${opts.theme ? ` data-theme="${opts.theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · Homeostat</title>
<style>${CSS}</style>
</head>
<body>
<div class="shell">
<header class="top">
  <div class="brand"><h1>Homeostat</h1><span class="sub mono" title="${esc(opts.kbRoot)}">${esc(opts.kbRoot.split("/").filter(Boolean).at(-1) ?? opts.kbRoot)}</span></div>
  <nav aria-label="Sections">${NAV.map(([href, label]) => `<a href="${href}"${current(href) ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
</header>
<main>${opts.body}</main>
<footer>Local dashboard. It reads this checkout and its git-ignored event log; nothing leaves this machine. Settings changes are written to homeostat.yaml here: commit them on a branch and open a PR.</footer>
</div>
</body>
</html>`;
}

const fmtTime = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) : "—");
const pct = (n: number) => `${Math.round(n * 100)}%`;

function lampFor(a: AgentLiveness): { cls: string; text: string } {
  if (!a.enabled) return { cls: "", text: "Disabled" };
  if (!a.lastRun) return { cls: "warning", text: "No run recorded here" };
  return a.lastRun.ok
    ? { cls: "good", text: "Last run succeeded" }
    : { cls: "critical", text: "Last run failed" };
}

function unit(a: AgentLiveness): string {
  const lamp = lampFor(a);
  const name = a.agent === "curator" ? "Curator" : "Deep dive";
  return `<div class="unit">
  <div class="head"><span class="lamp ${lamp.cls}" aria-hidden="true"></span><h3>${name}</h3><span class="state">${lamp.text}</span></div>
  <div class="mono muted">${esc(a.schedule)} UTC</div>
  <div>Last run <span class="mono">${fmtTime(a.lastRun?.ts)}</span>${a.lastRun?.summary ? ` · ${esc(a.lastRun.summary)}` : ""}</div>
  <div>Next run <span class="mono">${fmtTime(a.nextRun)}</span></div>
  <div>Failures this week <span class="mono">${a.failures7d}</span></div>
</div>`;
}

/** The latest events as a compact table: when, what, and the detail cut to one line. */
function recentTable(events: Event[]): string {
  return `<table class="recent"><tbody>${events
    .map((e) => {
      const detail = describeEvent(e);
      return `<tr><td class="when mono">${esc(e.ts.slice(5, 16).replace("T", " "))}</td><td class="what mono">${esc(e.type)}</td><td title="${esc(detail)}">${esc(detail)}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

export function overviewPage(
  h: Health,
  agents: AgentLiveness[],
  imp: Impact,
  recent: Event[],
): string {
  const stat = (n: number | string, k: string) =>
    `<div class="stat"><span class="n">${n}</span><span class="k">${k}</span></div>`;
  const daily: Datum[] = imp.injectionsByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.count,
    title: `${d.day}: ${d.count} injections`,
  }));
  return `<div class="grid">
<section class="panel span-4" aria-labelledby="stability"><h2 id="stability">Stability</h2>
${dial(h.stability, { title: "Share of entries accepted, fresh and unflagged", caption: "accepted · fresh · unflagged" })}
<p class="lede">Of ${h.total} entries, the share an agent can rely on today: accepted, confirmed within the stale limit, and not flagged.</p></section>
<section class="panel span-8" aria-labelledby="kb"><h2 id="kb">Knowledge base</h2>
<div class="stats" style="--cols: 3">${stat(h.total, "entries")}${stat(h.byStatus.accepted, "accepted")}${stat(h.byStatus.candidate, "awaiting review")}${stat(h.flagged.length, "flagged")}${stat(h.stale.length, "stale")}${stat(h.byStatus.disputed, "disputed")}</div>
<div style="margin-top:14px"><span class="label">Injections into sessions, last 14 days</span>${columns(daily, { title: "Injections per day", labelled: "ends", tickEvery: 7 })}${dataTable(daily, ["Day", "Injections"])}</div></section>
<section class="panel span-6" aria-labelledby="agents"><h2 id="agents">Agents</h2><p class="lede">Runs recorded in this checkout's log (shared box or local runs). CI runs show up as their PRs on the KB repo.</p><div class="units">${agents.map(unit).join("")}</div></section>
<section class="panel span-6" aria-labelledby="recent"><h2 id="recent">Recent events</h2>${recent.length ? recentTable(recent) : '<p class="empty">No events yet. Sessions, MCP calls and captures will appear here.</p>'}<p><a href="/events">All events</a></p></section>
</div>`;
}

export function entriesPage(entries: readonly Entry[], status: string | null): string {
  const shown = entries
    .filter((e) => !status || e.frontmatter.status === status)
    .sort(
      (a, b) =>
        a.frontmatter.area.localeCompare(b.frontmatter.area) ||
        b.frontmatter.score - a.frontmatter.score,
    );
  const filters = ["all", ...STATUSES]
    .map((s) => {
      const active = (s === "all" && !status) || s === status;
      return `<a href="/entries${s === "all" ? "" : `?status=${s}`}"${active ? ' aria-current="page"' : ""}>${s}</a>`;
    })
    .join(" · ");
  return `<section class="panel"><h2>Entries</h2><p class="lede mono">${filters}</p>
<div class="table-wrap"><table><thead><tr><th>Status</th><th class="num">Score</th><th>Entry</th><th>Area</th><th>Owner</th><th>Confirmed</th></tr></thead><tbody>
${shown
  .map(
    (e) =>
      `<tr><td><span class="chip ${e.frontmatter.status}">${e.frontmatter.status}</span></td><td class="num">${e.frontmatter.score}</td><td><a href="/entries/${esc(e.frontmatter.id)}">${esc(e.frontmatter.title)}</a><div class="mono muted">${esc(e.frontmatter.id)}${e.frontmatter.flags?.length ? ` · ${e.frontmatter.flags.length} flag(s)` : ""}</div></td><td>${esc(e.frontmatter.area)}</td><td>${esc(e.frontmatter.owner)}</td><td class="mono">${esc(e.frontmatter.lastConfirmed)}</td></tr>`,
  )
  .join("")}
</tbody></table></div>${shown.length ? "" : '<p class="empty">No entries with this status.</p>'}</section>`;
}

export function entryPage(entry: Entry, config: Config): string {
  return `<section class="panel"><p class="mono"><a href="/entries">← Entries</a></p><pre class="entry">${esc(explainEntry(entry, config))}</pre>
<p class="lede">To dispute it, run <code>homeostat flag ${esc(entry.frontmatter.id)} --reason "…"</code> or use the flag tool from any agent.</p></section>`;
}

export function membersPage(rowsData: Contribution[]): string {
  return `<section class="panel"><h2>Members</h2><p class="lede">What each person's sessions, reviews and captures have fed into the shared knowledge base. Listed alphabetically: this is contribution to a shared product, not a ranking.</p>
<div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th class="num">Entries authored</th><th class="num">Accepted</th><th class="num">Accepted share</th><th class="num">Captured, 30 days</th><th class="num">Flags raised</th></tr></thead><tbody>
${rowsData
  .map(
    (c) =>
      `<tr><td class="mono">${esc(c.member)}</td><td>${esc(c.role)}</td><td class="num">${c.authored}</td><td class="num">${c.accepted}</td><td class="num">${c.acceptedRatio === undefined ? "—" : pct(c.acceptedRatio)}</td><td class="num">${c.captured30d}</td><td class="num">${c.flagsRaised}</td></tr>`,
  )
  .join("")}
</tbody></table></div></section>`;
}

export function coveragePage(cov: {
  areas: { area: string; globs: readonly string[]; accepted: number; candidates: number }[];
  sources: { repo: string; entries: number }[];
}): string {
  const bare = cov.areas.filter((a) => a.accepted === 0);
  const data: Datum[] = cov.areas.map((a) => ({
    label: a.area,
    value: a.accepted,
    title: `${a.area}: ${a.accepted} accepted, ${a.candidates} awaiting review`,
  }));
  return `<div class="grid"><section class="panel span-8"><h2>Accepted rules by area</h2>${rows(data, { title: "Accepted entries per area", labelWidth: 180 })}${dataTable(data, ["Area", "Accepted"])}
<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Area</th><th>Paths</th><th class="num">Accepted</th><th class="num">Awaiting review</th></tr></thead><tbody>${cov.areas
    .map(
      (a) =>
        `<tr><td>${esc(a.area)}</td><td class="mono">${esc(a.globs.join(", "))}</td><td class="num">${a.accepted}</td><td class="num">${a.candidates}</td></tr>`,
    )
    .join("")}</tbody></table></div></section>
<section class="panel span-4"><h2>Gaps</h2>${bare.length ? `<p class="lede">No accepted rules yet for:</p><ul>${bare.map((a) => `<li class="mono">${esc(a.area)}</li>`).join("")}</ul>` : '<p class="lede">Every area has at least one accepted rule.</p>'}
<h2 style="margin-top:18px">Source repos</h2>${cov.sources.length ? `<table><thead><tr><th>Repo</th><th class="num">Entries from its reviews</th></tr></thead><tbody>${cov.sources.map((s) => `<tr><td class="mono">${esc(s.repo)}</td><td class="num">${s.entries}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No sources configured (Settings → Repos and sources).</p>'}</section></div>`;
}

export function impactPage(imp: Impact): string {
  const stat = (n: number | string, k: string) =>
    `<div class="stat"><span class="n">${n}</span><span class="k">${k}</span></div>`;
  const inj: Datum[] = imp.injectionsByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.count,
    title: `${d.day}: ${d.count} injections`,
  }));
  const mcp: Datum[] = imp.mcpCallsByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.count,
    title: `${d.day}: ${d.count} MCP calls`,
  }));
  const top: Datum[] = imp.topRules.map((r) => ({ label: r.id, value: r.injections }));
  return `<div class="grid"><section class="panel"><div class="stats" style="--cols: 4">${stat(imp.sessions, "sessions with rules")}${stat(imp.rulesPerInjection, "rules per session")}${stat(imp.tokensPerInjection, "tokens per session")}${stat(
    imp.toolUse.reduce((n, t) => n + t.calls, 0),
    "MCP tool calls",
  )}</div></section>
<section class="panel span-6"><h2>Injections per day</h2>${columns(inj, { title: "Injections per day, last 14 days", labelled: "ends", tickEvery: 7 })}${dataTable(inj, ["Day", "Injections"])}</section>
<section class="panel span-6"><h2>MCP calls per day</h2>${columns(mcp, { title: "MCP calls per day, last 14 days", labelled: "ends", tickEvery: 7 })}${dataTable(mcp, ["Day", "Calls"])}</section>
<section class="panel span-8"><h2>Most-used rules</h2>${top.length ? rows(top, { title: "Times each rule was put into a session" }) + dataTable(top, ["Rule", "Injections"]) : '<p class="empty">No injections recorded yet.</p>'}</section>
<section class="panel span-4"><h2>Tools agents call</h2>${imp.toolUse.length ? `<table><thead><tr><th>Tool</th><th class="num">Calls</th></tr></thead><tbody>${imp.toolUse.map((t) => `<tr><td class="mono">${esc(t.tool)}</td><td class="num">${t.calls}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No MCP calls recorded yet.</p>'}</section></div>`;
}

export function desirePathsPage(paths: DesirePath[]): string {
  return `<section class="panel"><h2>Desire paths</h2><p class="lede">Tool names agents tried that are not the real ones. Resolved guesses already work as aliases; unresolved ones that keep coming back are worth turning into real tools.</p>
${
  paths.length
    ? `<div class="table-wrap"><table><thead><tr><th>Name tried</th><th>Resolved to</th><th class="num">Times</th><th>Last</th></tr></thead><tbody>${paths
        .map(
          (p) =>
            `<tr><td class="mono">${esc(p.name)}</td><td>${p.resolved ? `<span class="mono">${esc(p.resolved)}</span>` : '<span class="chip disputed">unknown</span>'}</td><td class="num">${p.count}</td><td class="mono">${fmtTime(p.last)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<p class="empty">No guessed tool names yet.</p>'
}</section>`;
}

export function eventsPage(events: Event[]): string {
  return `<section class="panel"><h2>Events, last 7 days</h2>${events.length ? `<pre class="events">${esc(events.map(formatEvent).join("\n"))}</pre>` : '<p class="empty">No events in the last 7 days.</p>'}</section>`;
}

export function settingsIndex(): string {
  return `<section class="panel"><h2>Settings</h2><p class="lede">Every key in homeostat.yaml, as forms. Changes are validated before anything is written, and comments in the file are kept.</p>
<table><tbody>${SECTIONS.map((s) => `<tr><td><a href="/settings/${s.id}">${esc(s.title)}</a></td><td class="muted">${esc(s.intro)}</td></tr>`).join("")}</tbody></table></section>`;
}

function input(field: Field, value: unknown): string {
  const name = esc(field.path.join("."));
  const id = `f-${name.replace(/\./g, "-")}`;
  let control: string;
  switch (field.kind) {
    case "checkbox":
      control = `<div class="checks"><input type="checkbox" id="${id}" name="${name}"${value ? " checked" : ""}></div>`;
      break;
    case "checks":
      control = `<div class="checks">${(field.options ?? [])
        .map(
          (o) =>
            `<label><input type="checkbox" name="${name}" value="${esc(o)}"${(value as string[] | undefined)?.includes(o) ? " checked" : ""}> ${esc(o)}</label>`,
        )
        .join("")}</div>`;
      break;
    case "select":
      control = `<select id="${id}" name="${name}">${(field.options ?? [])
        .map(
          (o) =>
            `<option value="${esc(o)}"${String(value ?? "") === o ? " selected" : ""}>${esc(o || "(none)")}</option>`,
        )
        .join("")}</select>`;
      break;
    case "lines":
      control = `<textarea id="${id}" name="${name}">${esc(((value as string[] | undefined) ?? []).join("\n"))}</textarea>`;
      break;
    case "number":
      control = `<input type="number" id="${id}" name="${name}" value="${esc(value ?? "")}">`;
      break;
    default:
      control = `<input type="text" id="${id}" name="${name}" value="${esc(value ?? "")}">`;
  }
  return `<div class="field"><label for="${id}">${esc(field.label)}</label>${control}${field.help ? `<div class="help">${esc(field.help)}</div>` : ""}</div>`;
}

function rowEditor(section: Section, config: Config): string {
  if (section.rows === "team") {
    const members = [...config.team.members, ...Array(3).fill(undefined)];
    return `<div class="table-wrap"><table class="rows"><thead><tr><th>Id</th><th>Handle</th><th>Role</th><th>Areas</th><th title="The curator never reads this member's pull requests or review comments">Opted out</th><th>Remove</th></tr></thead><tbody>${members
      .map(
        (m, i) =>
          `<tr><td><input type="text" name="member.${i}.id" value="${esc(m?.id ?? "")}" aria-label="Member id"></td><td><input type="text" name="member.${i}.handle" value="${esc(m?.handle ?? "")}" aria-label="Handle"></td><td><select name="member.${i}.role" aria-label="Role">${["member", "senior"].map((r) => `<option${(m?.role ?? "member") === r ? " selected" : ""}>${r}</option>`).join("")}</select></td><td><input type="text" name="member.${i}.areas" value="${esc(m?.areas.join(", ") ?? "")}" aria-label="Areas"></td><td><input type="checkbox" name="member.${i}.optOut"${m?.optOut ? " checked" : ""} aria-label="Opted out"></td><td>${m ? `<input type="checkbox" name="member.${i}.remove" aria-label="Remove ${esc(m.id)}">` : ""}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div><p class="muted">Blank rows add members. Areas are comma-separated.</p>`;
  }
  const areas = [...Object.entries(config.areas), ...Array(3).fill(undefined)];
  return `<div class="table-wrap"><table class="rows"><thead><tr><th>Area</th><th>Path globs</th><th>Remove</th></tr></thead><tbody>${areas
    .map(
      (a, i) =>
        `<tr><td><input type="text" name="area.${i}.name" value="${esc(a?.[0] ?? "")}" aria-label="Area name"></td><td><input type="text" name="area.${i}.globs" value="${esc((a?.[1] as string[] | undefined)?.join(", ") ?? "")}" aria-label="Path globs"></td><td>${a ? `<input type="checkbox" name="area.${i}.remove" aria-label="Remove ${esc(a[0])}">` : ""}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><p class="muted">Blank rows add areas. Globs are comma-separated.</p>`;
}

export function settingsPage(
  section: Section,
  config: Config,
  token: string,
  notice?: { saved?: boolean; issues?: Issue[] },
): string {
  const banner = notice?.saved
    ? '<div class="notice" role="status">Saved to homeostat.yaml. Commit it on a branch and open a PR.</div>'
    : notice?.issues?.length
      ? `<div class="notice error" role="alert">Not saved: the result would be invalid.<ul>${notice.issues.map((i) => `<li class="mono">${esc(i.message)}</li>`).join("")}</ul></div>`
      : "";
  const body = section.rows
    ? rowEditor(section, config)
    : (section.fields ?? []).map((f) => input(f, currentValue(config, f))).join("");
  return `<section class="panel"><p class="mono"><a href="/settings">← Settings</a></p><h2>${esc(section.title)}</h2><p class="lede">${esc(section.intro)}</p>${banner}
<form class="settings" method="post" action="/settings/${section.id}"><input type="hidden" name="_token" value="${esc(token)}">${body}<button type="submit">Save</button></form></section>`;
}

export function messagePage(title: string, text: string): string {
  return `<section class="panel"><h2>${esc(title)}</h2><p class="lede">${esc(text)}</p></section>`;
}
