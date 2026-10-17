import {
  type Config,
  describeEvent,
  type Entry,
  type Event,
  type Issue,
  isRejectedDecision,
  type SectionUsage,
  STATUSES,
  score,
} from "@homeostat/core";
import type { AutomationView, Lamp } from "./automation.ts";
import { columns, type Datum, dataTable, dial, esc, rows } from "./charts.ts";
import type { AgentLiveness, Contribution, DesirePath, Health, Impact } from "./metrics.ts";
import { currentValue, type Field, SECTIONS, type Section } from "./settings.ts";

const CSS = `
:root {
  color-scheme: light;
  --paper: #eef0ed;
  --surface: #f9faf8;
  --inset: #e7eae5;
  --ink: #0d1110;
  --ink-2: #4a524e;
  --ink-3: #7d8681;
  --rule: #d6dbd6;
  --grid: rgba(13, 17, 16, 0.04);
  --series: #2a78d6;
  --series-soft: #cde2fb;
  --good: #0f9d4a;
  --warning: #b27300;
  --critical: #cf3a3a;
  --focus: #2a78d6;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #0a0c0d;
    --surface: #111416;
    --inset: #0c0f10;
    --ink: #e8ece9;
    --ink-2: #a7afab;
    --ink-3: #6c7571;
    --rule: #222829;
    --grid: rgba(232, 236, 233, 0.025);
    --series: #4a9bf0;
    --series-soft: #17406e;
    --good: #3fd174;
    --warning: #f2b23a;
    --critical: #f06a6a;
    --focus: #4a9bf0;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0a0c0d;
  --surface: #111416;
  --inset: #0c0f10;
  --ink: #e8ece9;
  --ink-2: #a7afab;
  --ink-3: #6c7571;
  --rule: #222829;
  --grid: rgba(232, 236, 233, 0.025);
  --series: #4a9bf0;
  --series-soft: #17406e;
  --good: #3fd174;
  --warning: #f2b23a;
  --critical: #f06a6a;
  --focus: #4a9bf0;
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
header.top { border-bottom: 1px solid var(--rule); padding-bottom: 12px; margin-bottom: 18px; display: grid; gap: 12px; }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px 20px; flex-wrap: wrap; }
.brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: var(--ink); }
.brand .word { font: 600 15px ui-monospace, "SFMono-Regular", Menlo, monospace; letter-spacing: 0.28em; }
.brand .mark { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid var(--ink-2); position: relative; flex: none; }
.brand .mark::after { content: ""; position: absolute; left: 50%; top: 50%; width: 7px; height: 1.5px; background: var(--good); transform-origin: 0 50%; transform: rotate(-35deg); }
.brand .sub { color: var(--ink-3); font: 12.5px ui-monospace, Menlo, monospace; }
.strip.compact { display: flex; flex-wrap: wrap; gap: 6px; }
.strip.compact a { display: inline-flex; align-items: center; gap: 7px; text-decoration: none; color: var(--ink-2); font: 11.5px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.06em; border: 1px solid var(--rule); border-radius: 999px; padding: 3px 10px 3px 8px; background: var(--surface); }
.strip.compact a:hover { border-color: var(--ink-3); color: var(--ink); }
.strip.compact b { color: var(--ink); font-weight: 600; }
.console { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--rule); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
@media (max-width: 860px) { .console { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.cell { background: var(--surface); padding: 14px 16px 16px; display: grid; gap: 6px; text-decoration: none; color: var(--ink); position: relative; }
.cell:hover { background: color-mix(in srgb, var(--surface) 92%, var(--ink)); }
.cell .k { display: flex; align-items: center; gap: 8px; font: 11.5px ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-3); }
.cell .v { font: 600 34px/1 ui-monospace, "SFMono-Regular", Menlo, monospace; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.cell .d { color: var(--ink-2); font-size: 13px; }
.cell.critical { box-shadow: inset 0 3px 0 var(--critical); } .cell.warning { box-shadow: inset 0 3px 0 var(--warning); } .cell.good { box-shadow: inset 0 3px 0 var(--good); }
.mini { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; margin: 4px 0 12px; }
.mini .n { font: 600 24px/1.1 ui-monospace, Menlo, monospace; display: block; font-variant-numeric: tabular-nums; }
.mini .k { color: var(--ink-3); font-size: 12px; }
.legend { display: flex; gap: 14px; font: 11.5px ui-monospace, Menlo, monospace; color: var(--ink-3); margin: -4px 0 8px; }
.sym { display: inline-block; width: 1.2em; text-align: center; }
.sym.learn { color: var(--good); } .sym.alert { color: var(--critical); } .sym.run { color: var(--series); }
nav { display: flex; flex-wrap: wrap; gap: 4px 14px; }
nav a { color: var(--ink-2); text-decoration: none; font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 0; border-bottom: 1px solid transparent; }
nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--ink); }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(12, minmax(0, 1fr)); }
.panel { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 16px 18px; grid-column: span 12; min-width: 0; }
.span-4 { grid-column: span 4; } .span-6 { grid-column: span 6; } .span-8 { grid-column: span 8; } .span-12 { grid-column: span 12; }
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
.unit .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.unit .head h3 { white-space: nowrap; }
.unit .head .state { flex-basis: 100%; padding-left: 18px; }
.lamp { width: 10px; height: 10px; border-radius: 50%; background: var(--ink-3); box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent); color: var(--ink-3); flex: none; }
.lamp { box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 18%, transparent), 0 0 10px color-mix(in srgb, currentColor 45%, transparent); }
.lamp.off { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ink-3) 15%, transparent); }
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
.table-wrap > table { min-width: 620px; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; padding: 1px 7px; border: 1px solid var(--rule); border-radius: 999px; color: var(--ink-2); white-space: nowrap; }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ink-3); }
.chip.accepted::before { background: var(--good); } .chip.disputed::before { background: var(--critical); } .chip.candidate::before { background: var(--warning); }
.muted { color: var(--ink-3); }
.empty { color: var(--ink-3); font-style: italic; }
.entry-head { display: grid; gap: 6px; margin: 6px 0 16px; }
.entry-head h2 { font-size: 24px; margin: 0; }
.entry-head .tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tag { font: 11.5px ui-monospace, Menlo, monospace; color: var(--ink-2); border: 1px solid var(--rule); border-radius: 4px; padding: 1px 7px; }
.tag.no { color: var(--critical); border-color: color-mix(in srgb, var(--critical) 45%, var(--rule)); }
.statement { border-left: 3px solid var(--series); padding: 2px 0 2px 14px; margin: 0 0 14px; }
.statement.rejected { border-left-color: var(--critical); }
.statement .label { display: block; margin-bottom: 2px; }
.statement p { margin: 0; max-width: 72ch; }
.statement.rule p { font: 18px/1.45 "Iowan Old Style", Charter, Cambria, serif; color: var(--ink); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; margin: 18px 0 0; padding-top: 14px; border-top: 1px solid var(--rule); font-size: 14px; }
.facts dt { color: var(--ink-3); font: 11.5px/1.9 ui-monospace, Menlo, monospace; text-transform: uppercase; letter-spacing: 0.06em; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.reasons { list-style: none; padding: 0; margin: 0; }
.reasons li { font: 13px ui-monospace, Menlo, monospace; }
.reasons .d { display: inline-block; width: 3ch; text-align: right; margin-right: 8px; }
.reasons .d.pos { color: var(--good); } .reasons .d.neg { color: var(--critical); }
.flag { border-left: 3px solid var(--warning); padding-left: 10px; margin: 4px 0; }
.log { font-size: 13px; }
.log td { padding: 5px 8px; }
.log:not(.recent) .when { white-space: nowrap; color: var(--ink-3); width: 1%; }
.log:not(.recent) .what { white-space: nowrap; width: 1%; }
.log .detail { color: var(--ink-2); overflow-wrap: anywhere; }
.kind { font: 11.5px ui-monospace, Menlo, monospace; padding: 1px 6px; border-radius: 4px; background: color-mix(in srgb, var(--ink-3) 14%, transparent); color: var(--ink-2); }
.kind.learn { background: color-mix(in srgb, var(--good) 16%, transparent); }
.kind.alert { background: color-mix(in srgb, var(--critical) 16%, transparent); }
.kind.run { background: color-mix(in srgb, var(--series) 16%, transparent); }
.filters { display: flex; flex-wrap: wrap; gap: 4px 12px; font: 12.5px ui-monospace, Menlo, monospace; margin: 0 0 12px; }
.filters a[aria-current="page"] { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--ink); }
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
.rows select { min-width: 104px; }
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
  ["/automation", "Automation"],
  ["/entries", "Entries"],
  ["/members", "Members"],
  ["/coverage", "Coverage"],
  ["/impact", "Impact"],
  ["/documents", "Documents"],
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
  /** The console lamps, shown on every page. */
  status?: Lamp[];
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
  <div class="bar"><a class="brand" href="/" aria-label="Homeostat overview"><span class="mark" aria-hidden="true"></span><span class="word">HOMEOSTAT</span><span class="sub" title="${esc(opts.kbRoot)}">${esc(opts.kbRoot.split("/").filter(Boolean).at(-1) ?? opts.kbRoot)}</span></a>${opts.status?.length ? `<div class="strip compact" aria-label="Status">${opts.status.map((l) => `<a href="${l.href}" title="${esc(`${l.label}: ${l.value} · ${l.detail}`)}"><span class="lamp ${l.state}" aria-hidden="true"></span>${esc(l.label)} <b>${esc(l.value)}</b></a>`).join("")}</div>` : ""}</div>
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

/** Cron as words for the common shapes (`0 6 * * *` → daily at 06:00 UTC); anything else as is. */
export function schedule(expr: string): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(expr.trim());
  if (!m) return `${expr} UTC`;
  const at = `${(m[2] ?? "").padStart(2, "0")}:${(m[1] ?? "").padStart(2, "0")} UTC`;
  return m[3] === "*" ? `daily at ${at}` : `${days[Number(m[3])]}s at ${at}`;
}

/** Event families, for colour: what was learned, what went wrong, what ran. Rest is plain. */
const KIND: Record<string, string> = {
  "entry-created": "learn",
  "entry-flagged": "alert",
  "handoff-requested": "learn",
  "mcp-unknown-tool": "alert",
  "agent-run": "run",
  "seed-run": "run",
  "auto-merged": "learn",
};
/** Routine plumbing: kept in the log, left out of the overview's short list. */
const ROUTINE = new Set(["model-call", "mcp-call", "doc-injection"]);

const eventRow = (e: Event, when: string) => {
  const detail = describeEvent(e);
  return `<tr><td class="when mono">${esc(when)}</td><td class="what"><span class="sym ${KIND[e.type] ?? ""}" aria-hidden="true">${SYMBOL[KIND[e.type] ?? ""] ?? "·"}</span><span class="kind ${KIND[e.type] ?? ""}">${esc(e.type)}</span></td><td class="detail" title="${esc(detail)}">${esc(detail)}</td></tr>`;
};

function unit(a: AgentLiveness): string {
  const lamp = lampFor(a);
  const name = a.agent === "curator" ? "Daily run" : "Deep dive";
  return `<div class="unit">
  <div class="head"><span class="lamp ${lamp.cls}" aria-hidden="true"></span><h3>${name}</h3><span class="state">${lamp.text}</span></div>
  <div class="mono muted" title="${esc(a.schedule)}">${esc(schedule(a.schedule))}</div>
  <div>Last run <span class="mono">${fmtTime(a.lastRun?.ts)}</span>${a.lastRun?.summary ? ` · ${esc(a.lastRun.summary)}` : ""}</div>
  <div>Next run <span class="mono">${fmtTime(a.nextRun)}</span></div>
  <div>Failures this week <span class="mono">${a.failures7d}</span></div>
</div>`;
}

/** The latest events as a compact table: when, what, and the detail cut to one line. */
function recentTable(events: Event[]): string {
  return `<table class="recent log"><tbody>${events
    .filter((e) => !ROUTINE.has(e.type))
    .slice(0, 10)
    .map((e) => eventRow(e, e.ts.slice(5, 16).replace("T", " ")))
    .join("")}</tbody></table>`;
}

/** The console: four lamps, large, each a link to where its detail lives. */
function consoleRow(ls: readonly Lamp[]): string {
  return `<div class="console" aria-label="Status">${ls
    .map(
      (l) =>
        `<a class="cell ${l.state}" href="${l.href}"><span class="k"><span class="lamp ${l.state}" aria-hidden="true"></span>${esc(l.label)}</span><span class="v">${esc(l.value)}</span><span class="d">${esc(l.detail)}</span></a>`,
    )
    .join("")}</div>`;
}

const SYMBOL: Record<string, string> = { learn: "◆", alert: "▲", run: "▶" };

export function overviewPage(
  h: Health,
  agents: AgentLiveness[],
  imp: Impact,
  recent: Event[],
  v: AutomationView,
  ls: readonly Lamp[],
): string {
  const mini = (n: number | string, k: string) =>
    `<div><span class="n">${n}</span><span class="k">${k}</span></div>`;
  const daily: Datum[] = imp.injectionsByDay.map((d) => ({
    label: d.day.slice(5),
    value: d.count,
    title: `${d.day}: ${d.count} injections`,
  }));
  const r = v.lastRun;
  const sum = (k: "merged" | "review" | "declined") =>
    r?.members.reduce((n, m) => n + m[k], 0) ?? 0;
  const prs = (r?.members ?? []).flatMap((m) => [
    ...(m.dailyPr ? [`<a href="${esc(m.dailyPr)}">${esc(m.member)} daily</a>`] : []),
    ...(m.reviewPr ? [`<a href="${esc(m.reviewPr)}">${esc(m.member)} review</a>`] : []),
  ]);
  const run = r
    ? `<p class="lede mono">${esc(r.at.replace("T", " ").slice(0, 16))} UTC</p><div class="mini">${mini(sum("merged"), "merged")}${mini(sum("review"), "to review")}${mini(sum("declined"), "declined")}${mini(r.settled, "settled by reviewers")}</div>${prs.length ? `<p class="mono" style="font-size:12.5px">${prs.join(" · ")}</p>` : ""}`
    : '<p class="empty">No daily run on record in this clone yet. It runs in the KB repo\'s CI and writes to the homeostat/state branch.</p>';
  const agentLine = (a: AgentLiveness) =>
    `<li><span class="lamp ${lampFor(a).cls || "off"}" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-right:8px"></span>${a.agent === "curator" ? "Daily run" : "Deep dive"} <span class="muted mono" style="margin-left:6px">${esc(schedule(a.schedule))}</span></li>`;
  return `<div class="grid">
<section class="span-12" aria-label="Console">${consoleRow(ls)}</section>
<section class="panel span-4" aria-labelledby="run"><h2 id="run">Last daily run</h2>${run}<p><a href="/automation">Decisions, queue and sync</a></p></section>
<section class="panel span-4" aria-labelledby="kb"><h2 id="kb">Knowledge base</h2>
<div class="mini">${mini(h.byStatus.accepted, "rules in force")}${mini(h.byStatus.candidate, "awaiting review")}${mini(h.flagged.length + h.byStatus.disputed, "flagged or disputed")}${mini(h.stale.length, "stale")}</div>
<div style="max-width:210px;margin:0 auto">${dial(h.stability, { title: "Share of entries accepted, fresh and unflagged", caption: "accepted · fresh · unflagged" })}</div></section>
<section class="panel span-4" aria-labelledby="use"><h2 id="use">Sessions</h2>
<div class="mini">${mini(imp.sessions, "sessions with rules")}${mini(imp.rulesPerInjection.toFixed(1), "rules per session")}</div>
<span class="label">Injections, last 14 days</span>${columns(daily, { title: "Injections per day", height: 90, labelled: "ends", tickEvery: 7 })}${dataTable(daily, ["Day", "Injections"])}
<ul style="list-style:none;padding:0;margin:12px 0 0;display:grid;gap:4px;font-size:13.5px">${agents.map(agentLine).join("")}</ul></section>
<section class="panel span-12" aria-labelledby="recent"><h2 id="recent">Recent</h2><div class="legend"><span><span class="sym learn">◆</span>learned</span><span><span class="sym alert">▲</span>alert</span><span><span class="sym run">▶</span>run</span></div>${recent.length ? recentTable(recent) : '<p class="empty">No events yet. Sessions, MCP calls and captures will appear here.</p>'}<p><a href="/events">All events</a></p></section>
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
  const fm = entry.frontmatter;
  const rejected = isRejectedDecision(fm);
  const reasons = score(fm, { config }).reasons;
  const link = (url?: string) =>
    url && /^https:\/\//.test(url)
      ? ` · <a href="${esc(url)}">${esc(url.replace(/^https:\/\/[^/]+\//, ""))}</a>`
      : "";
  const fact = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
  return `<section class="panel"><p class="mono"><a href="/entries">← Entries</a></p>
<header class="entry-head"><h2>${esc(fm.title)}</h2>
<div class="tags"><span class="chip ${fm.status}">${fm.status}</span>${rejected ? '<span class="tag no">decided against</span>' : fm.kind ? `<span class="tag">${esc(fm.kind)}</span>` : ""}<span class="tag">${esc(fm.area)}</span><span class="mono muted">${esc(fm.id)}</span></div></header>
${rejected ? '<p class="lede">Considered and not adopted. Agents see it as context, never as an instruction, so they stop proposing it unless something below no longer holds.</p>' : ""}
<div class="statement ${rejected ? "rejected" : "rule"}"><span class="label">${rejected ? "Proposal" : "Rule"}</span><p>${esc(entry.sections.rule ?? "")}</p></div>
<div class="statement"><span class="label">${rejected ? "Why not" : "Why"}</span><p>${esc(entry.sections.why ?? "")}</p></div>
${entry.sections.example ? `<div class="statement"><span class="label">Example</span><p class="mono">${esc(entry.sections.example)}</p></div>` : ""}
${(fm.flags ?? []).map((f) => `<p class="flag">Flagged by <span class="mono">${esc(f.by)}</span> on <span class="mono">${esc(f.date)}</span>: ${esc(f.reason)}</p>`).join("")}
<dl class="facts">
${fact("Applies to", fm.scope.map((s) => `<code>${esc(s)}</code>`).join(", "))}
${fact("Owner", `<span class="mono">${esc(fm.owner)}</span>`)}
${fact("Source", `${esc(fm.source.type)} by <span class="mono">${esc(fm.source.author)}</span>${fm.source.changedCode ? " · code changed after the comment" : ""}${link(fm.source.url)}`)}
${fact("Score", `<span class="mono">${fm.score}</span>${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li><span class="d ${r.delta > 0 ? "pos" : "neg"}">${r.delta > 0 ? "+" : ""}${r.delta}</span>${esc(r.note)}</li>`).join("")}</ul>` : ""}`)}
${fact("Dates", `created <span class="mono">${esc(fm.created)}</span> · last confirmed <span class="mono">${esc(fm.lastConfirmed)}</span>${fm.approvedBy ? ` · approved by <span class="mono">${esc(fm.approvedBy)}</span>` : ""}`)}
${fm.conflictsWith?.length ? fact("Conflicts with", fm.conflictsWith.map((c) => `<a href="/entries/${esc(c)}">${esc(c)}</a>`).join(", ")) : ""}
${fm.supersedes ? fact("Supersedes", `<a href="/entries/${esc(fm.supersedes)}">${esc(fm.supersedes)}</a>`) : ""}
</dl>
<p class="lede" style="margin-top:16px">Wrong or out of date? <code>homeostat flag ${esc(fm.id)} --reason "…"</code> takes it out of sessions and sends it back for review.</p></section>`;
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
<section class="panel span-8"><h2>Most-used rules</h2>${top.length ? rows(top, { title: "Times each rule was put into a session", labelWidth: 320 }) + dataTable(top, ["Rule", "Injections"]) : '<p class="empty">No injections recorded yet.</p>'}</section>
<section class="panel span-4"><h2>Tools agents call</h2>${imp.toolUse.length ? `<table><thead><tr><th>Tool</th><th class="num">Calls</th></tr></thead><tbody>${imp.toolUse.map((t) => `<tr><td class="mono">${esc(t.tool)}</td><td class="num">${t.calls}</td></tr>`).join("")}</tbody></table>` : '<p class="empty">No MCP calls recorded yet.</p>'}</section></div>`;
}

export function documentsPage(usage: readonly SectionUsage[]): string {
  const decaying = usage.filter((u) => u.decaying);
  const stat = (n: number | string, k: string) =>
    `<div class="stat"><span class="n">${n}</span><span class="k">${k}</span></div>`;
  const docs = new Set(usage.map((u) => u.doc)).size;
  const used = usage.filter((u) => u.reads + u.injected > 0).length;
  return `<div class="grid"><section class="panel"><div class="stats" style="--cols: 4">${stat(docs, "documents")}${stat(usage.length, "sections")}${stat(used, "used in 90 days")}${stat(decaying.length, "to review")}</div></section>
<section class="panel"><h2>Section usage</h2><p class="lede">Reads through MCP and sessions each section was given in full, from this machine's event log over the last 90 days. A section nobody used or confirmed in 90 days is a review candidate: its owner confirms, updates or removes it.</p>
${
  usage.length
    ? `<div class="table-wrap"><table><thead><tr><th>Section</th><th class="num">Reads</th><th class="num">In sessions</th><th>Last used</th><th>Confirmed</th><th></th></tr></thead><tbody>${usage
        .map(
          (u) =>
            `<tr><td><span class="mono">${esc(u.doc)}#${esc(u.id)}</span><br>${esc(u.heading)}</td><td class="num">${u.reads}</td><td class="num">${u.injected}</td><td class="mono">${u.lastUsed ? fmtTime(u.lastUsed) : "never"}</td><td class="mono">${esc(u.confirmed)}</td><td>${u.decaying ? '<span class="chip disputed">review</span>' : ""}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<p class="empty">No documents yet. Add them under knowledge/&lt;area&gt;/docs/, or run homeostat docs convert or homeostat seed.</p>'
}</section></div>`;
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

export function eventsPage(events: Event[], type: string | null = null): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  const filters = [
    `<a href="/events"${type ? "" : ' aria-current="page"'}>all ${events.length}</a>`,
    ...[...counts]
      .sort((a, b) => b[1] - a[1])
      .map(
        ([t, n]) =>
          `<a href="/events?type=${encodeURIComponent(t)}"${t === type ? ' aria-current="page"' : ""}>${esc(t)} ${n}</a>`,
      ),
  ].join("");
  const shown = type ? events.filter((e) => e.type === type) : events;
  return `<section class="panel"><h2>Events, last 7 days</h2>${
    events.length
      ? `<nav class="filters" aria-label="Event types">${filters}</nav><div class="table-wrap"><table class="log"><tbody>${shown
          .map((e) => eventRow(e, e.ts.replace("T", " ").slice(0, 19)))
          .join("")}</tbody></table></div>`
      : '<p class="empty">No events in the last 7 days.</p>'
  }</section>`;
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
          `<tr><td><input type="text" name="member.${i}.id" value="${esc(m?.id ?? "")}" aria-label="Member id"></td><td><input type="text" name="member.${i}.handle" value="${esc(m?.handle ?? "")}" aria-label="Handle"></td><td><select name="member.${i}.role" aria-label="Role">${["junior", "member", "senior", "lead"].map((r) => `<option${(m?.role ?? "member") === r ? " selected" : ""}>${r}</option>`).join("")}</select></td><td><input type="text" name="member.${i}.areas" value="${esc(m?.areas.join(", ") ?? "")}" aria-label="Areas"></td><td><input type="checkbox" name="member.${i}.optOut"${m?.optOut ? " checked" : ""} aria-label="Opted out"></td><td>${m ? `<input type="checkbox" name="member.${i}.remove" aria-label="Remove ${esc(m.id)}">` : ""}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table></div><p class="muted">Blank rows add members. Areas are comma-separated.</p>`;
  }
  if (section.rows === "teams") {
    const teams = [...Object.entries(config.teams), ...Array(2).fill(undefined)];
    const cell = (i: number, key: string, value: string, label: string) =>
      `<td><input type="text" name="teamrow.${i}.${key}" value="${esc(value)}" aria-label="${label}"></td>`;
    return `<div class="table-wrap"><table class="rows"><thead><tr><th>Team</th><th>Handle</th><th>Members</th><th>Areas</th><th>Repos</th><th>Remove</th></tr></thead><tbody>${teams
      .map(([name, t] = ["", undefined], i) =>
        [
          "<tr>",
          cell(i, "name", name, "Team name"),
          cell(i, "handle", t?.handle ?? "", "Team handle"),
          cell(i, "members", t?.members.join(", ") ?? "", "Members"),
          cell(i, "areas", t?.areas.join(", ") ?? "", "Areas"),
          cell(i, "repos", t?.repos.join(", ") ?? "", "Repos"),
          `<td>${t ? `<input type="checkbox" name="teamrow.${i}.remove" aria-label="Remove ${esc(name)}">` : ""}</td></tr>`,
        ].join(""),
      )
      .join(
        "",
      )}</tbody></table></div><p class="muted">Blank rows add teams. Lists are comma-separated; the handle is an @org/team.</p>`;
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
