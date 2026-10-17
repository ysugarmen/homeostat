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
  --paper: #eceff1;
  --sheet: #fafbfb;
  --surface: #fafbfb;
  --ink: #18222c;
  --ink-2: #56636f;
  --ink-3: #6f7c87;
  --rule: #c9d1d7;
  --rule-soft: #dde3e7;
  --brass: #a9772a;
  --trough: #d5e0e5;
  --series: #3d5a73;
  --series-soft: #d3dde6;
  --good: #2e6b5a;
  --warning: #b0621c;
  --critical: #b03a3a;
  --focus: #a9772a;
  --serif: Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif;
  --sans: "Gill Sans", "Gill Sans MT", Seravek, Calibri, "Trebuchet MS", sans-serif;
  --code: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --paper: #0f161c;
    --sheet: #151f27;
    --surface: #151f27;
    --ink: #e2e8ec;
    --ink-2: #a9b5be;
    --ink-3: #8794a0;
    --rule: #2b3843;
    --rule-soft: #22303a;
    --brass: #d6a352;
    --trough: #223744;
    --series: #8fb2cf;
    --series-soft: #2a4357;
    --good: #5fb39a;
    --warning: #e0954e;
    --critical: #e77b7b;
    --focus: #d6a352;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --paper: #0f161c;
  --sheet: #151f27;
  --surface: #151f27;
  --ink: #e2e8ec;
  --ink-2: #a9b5be;
  --ink-3: #8794a0;
  --rule: #2b3843;
  --rule-soft: #22303a;
  --brass: #d6a352;
  --trough: #223744;
  --series: #8fb2cf;
  --series-soft: #2a4357;
  --good: #5fb39a;
  --warning: #e0954e;
  --critical: #e77b7b;
  --focus: #d6a352;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 17px/1.55 var(--serif); font-variant-numeric: lining-nums tabular-nums; }
code, .mono { font-family: var(--code); font-size: 0.86em; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
h1, h2, h3 { font-family: var(--sans); font-weight: 600; letter-spacing: 0; margin: 0; line-height: 1.2; }
h2 { font-size: 22px; margin-bottom: 6px; }
h3 { font-size: 17px; }
a { color: var(--ink); text-decoration-color: var(--brass); text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
a:hover { color: var(--brass); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; border-radius: 2px; }
a, button, summary, select, input[type=checkbox] { cursor: pointer; }
.shell { max-width: 1100px; margin: 0 auto; padding: 28px 24px 72px; }
@media (max-width: 600px) { .shell { padding: 20px 16px 56px; } }

/* Header: the wordmark, the four small needles, then the sections. */
header.top { display: grid; gap: 14px; padding-bottom: 14px; margin-bottom: 28px; border-bottom: 1px solid var(--rule); }
.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px 24px; flex-wrap: wrap; }
.brand { display: flex; align-items: baseline; gap: 12px; text-decoration: none; color: var(--ink); }
.brand .word { font: 600 26px/1 var(--sans); letter-spacing: 0.01em; }
.brand .sub { color: var(--ink-2); font: 15px var(--sans); }
.brand .mark { display: none; }
.strip.compact { display: flex; flex-wrap: wrap; gap: 4px 18px; }
.strip.compact a { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; color: var(--ink-2); font: 15px var(--sans); }
.strip.compact a:hover { color: var(--ink); }
.strip.compact b { color: var(--ink); font-weight: 600; }
nav { display: flex; flex-wrap: wrap; gap: 4px 20px; }
nav a { color: var(--ink-2); text-decoration: none; font: 16px var(--sans); padding: 2px 0; border-bottom: 2px solid transparent; }
nav a:hover { color: var(--ink); }
nav a[aria-current="page"] { color: var(--ink); border-bottom-color: var(--brass); }

/* Sections sit on the paper, separated by space and one rule; only grouped data gets a sheet. */
.grid { display: grid; gap: 40px 48px; grid-template-columns: repeat(12, minmax(0, 1fr)); }
.panel { grid-column: span 12; min-width: 0; }
.panel + .panel, .grid > .panel { border-top: 1px solid var(--rule); padding-top: 18px; }
.span-4 { grid-column: span 4; } .span-6 { grid-column: span 6; } .span-8 { grid-column: span 8; } .span-12 { grid-column: span 12; }
@media (max-width: 860px) { .span-4, .span-6, .span-8 { grid-column: span 12; } .grid { column-gap: 0; } }
.lede { color: var(--ink-2); margin: 2px 0 14px; max-width: 64ch; }
.label { display: block; color: var(--ink-2); font: 15px var(--sans); margin: 14px 0 4px; }
.muted { color: var(--ink-2); }
.empty { color: var(--ink-2); font-style: italic; }

/* The homeostat units: the one memorable thing. */
.units-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
@media (max-width: 860px) { .units-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.hunit { display: grid; justify-items: start; align-content: start; gap: 2px; padding: 18px 20px 20px; text-decoration: none; color: var(--ink); border-left: 1px solid var(--rule-soft); }
.hunit:first-child { border-left: 0; padding-left: 0; }
@media (max-width: 860px) { .hunit:nth-child(3) { border-left: 0; padding-left: 0; } .hunit:nth-child(n+3) { border-top: 1px solid var(--rule-soft); } }
.hunit:hover .gauge .needle { stroke: var(--ink); }
.hunit .name { font: 600 17px var(--sans); margin-top: 6px; }
.hunit .reading { font: 28px/1.15 var(--serif); }
.hunit .reading.good { color: var(--good); } .hunit .reading.warning { color: var(--warning); } .hunit .reading.critical { color: var(--critical); } .hunit .reading.off { color: var(--ink-3); }
.hunit .detail { color: var(--ink-2); font-size: 15px; max-width: 30ch; }
.gauge { display: block; overflow: visible; }
.gauge .trough { fill: none; stroke: var(--trough); stroke-linecap: round; }
.gauge .rim { fill: none; stroke: var(--ink-3); stroke-width: 1; }
.gauge .zero { stroke: var(--ink-3); stroke-width: 1.2; }
.gauge .needle { stroke: var(--brass); stroke-width: 2.4; stroke-linecap: round; transition: stroke .2s; }
.gauge .pivot { fill: var(--ink); }
.gauge.off .needle { stroke: var(--ink-3); }

/* Small multiples of data. */
.stats, .mini { display: grid; grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr)); gap: 12px 28px; margin: 8px 0 12px; }
@media (max-width: 600px) { .stats { --cols: 2 !important; } }
.stat .n, .mini .n { display: block; font: 30px/1.1 var(--serif); }
.stat .k, .mini .k { color: var(--ink-2); font: 15px var(--sans); }
.console { display: none; }

/* Tables: ruled lists, no boxes. */
table { width: 100%; border-collapse: collapse; font-size: 16px; }
th { text-align: left; font: 600 14px var(--sans); color: var(--ink-2); border-bottom: 1px solid var(--rule); padding: 6px 10px 6px 0; }
td { border-bottom: 1px solid var(--rule-soft); padding: 8px 10px 8px 0; vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.table-wrap { overflow-x: auto; }
.table-wrap > table { min-width: 620px; }
.recent { table-layout: fixed; font-size: 15px; }
.recent td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 6px 10px 6px 0; }
.recent .when { width: 104px; color: var(--ink-2); }
.recent .what { width: 150px; }
.log { font-size: 15px; }
.log:not(.recent) .when { white-space: nowrap; color: var(--ink-2); width: 1%; }
.log:not(.recent) .what { white-space: nowrap; width: 1%; }
.log .detail { overflow-wrap: anywhere; }
.kind { font: 15px var(--sans); color: var(--ink-2); }
.sym { display: inline-block; width: 1.3em; color: var(--ink-3); }
.sym.learn { color: var(--good); } .sym.alert { color: var(--critical); } .sym.run { color: var(--series); }
.legend { display: flex; gap: 18px; font: 15px var(--sans); color: var(--ink-2); margin: 0 0 6px; }
.filters { display: flex; flex-wrap: wrap; gap: 4px 16px; font: 15px var(--sans); margin: 0 0 12px; }
.filters a { color: var(--ink-2); text-decoration: none; }
.filters a[aria-current="page"] { color: var(--ink); border-bottom: 2px solid var(--brass); }

/* State, always in words and shape as well as colour. */
.chip { display: inline-flex; align-items: center; gap: 6px; font: 15px var(--sans); color: var(--ink-2); white-space: nowrap; }
.chip::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--ink-3); }
.chip.accepted::before { background: var(--good); } .chip.disputed::before { background: var(--critical); } .chip.candidate::before { background: var(--warning); }
.lamp { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--ink-3); flex: none; }
.lamp.good { background: var(--good); } .lamp.warning { background: var(--warning); } .lamp.critical { background: var(--critical); }
.icon { flex: none; } .icon.good { color: var(--good); } .icon.warning { color: var(--warning); } .icon.critical { color: var(--critical); } .icon.off { color: var(--ink-3); }
.state { font: 15px var(--sans); color: var(--ink-2); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tag { font: 15px var(--sans); color: var(--ink-2); border-bottom: 1px dotted var(--rule); }
.tag.no { color: var(--critical); border-bottom-color: var(--critical); }

/* Agent units on older pages. */
.units { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 600px) { .units { grid-template-columns: 1fr; } }
.unit { display: grid; gap: 4px; }
.unit .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* Charts. */
.chart { width: 100%; max-width: 640px; height: auto; display: block; overflow: visible; }
.chart path { fill: var(--series); }
.chart .hit { fill: transparent; }
.chart .m:hover path { fill: var(--brass); }
.chart .base { stroke: var(--rule); stroke-width: 1; }
.chart text { font: 13px var(--sans); fill: var(--ink-2); }
.chart text.v { fill: var(--ink); }
.dial { width: 100%; max-width: 220px; display: block; margin: 0 auto; }
.dial .track { fill: none; stroke: var(--trough); stroke-width: 10; stroke-linecap: round; }
.dial .fill { fill: none; stroke: var(--series); stroke-width: 10; stroke-linecap: round; }
.dial .tick { stroke: var(--ink-3); stroke-width: 1; } .dial .tick.major { stroke: var(--ink-2); stroke-width: 1.5; }
.dial .needle { stroke: var(--brass); stroke-width: 2.4; stroke-linecap: round; }
.dial .hub { fill: var(--ink); }
.dial-value { font: 26px var(--serif); fill: var(--ink); }
.dial-caption { font: 14px var(--sans); fill: var(--ink-2); }
details.table-view { margin-top: 6px; } details.table-view summary { color: var(--ink-2); font: 15px var(--sans); }

/* Entry pages. */
.entry-head { display: grid; gap: 6px; margin: 8px 0 18px; }
.entry-head h2 { font-size: 30px; margin: 0; max-width: 32ch; }
.entry-head .tags { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; }
.statement { padding: 0; margin: 0 0 18px; max-width: 64ch; }
.statement .label { margin: 0 0 2px; }
.statement p { margin: 0; }
.statement.rule p { font-size: 22px; line-height: 1.45; }
.statement.rejected p { font-size: 22px; line-height: 1.45; text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--critical) 60%, transparent); text-decoration-thickness: 1.5px; }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 22px; margin: 22px 0 0; padding-top: 14px; border-top: 1px solid var(--rule); }
.facts dt { color: var(--ink-2); font: 15px/1.7 var(--sans); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.reasons { list-style: none; padding: 0; margin: 2px 0 0; }
.reasons .d { display: inline-block; width: 3ch; text-align: right; margin-right: 8px; }
.reasons .d.pos { color: var(--good); } .reasons .d.neg { color: var(--critical); }
.flag { border-left: 3px solid var(--warning); padding-left: 12px; margin: 6px 0; }
pre.entry { white-space: pre-wrap; }
.events { white-space: pre-wrap; }

/* Settings. */
form.settings { display: grid; gap: 16px; max-width: 760px; }
.field { display: grid; grid-template-columns: 240px 1fr; gap: 6px 18px; align-items: start; }
@media (max-width: 700px) { .field { grid-template-columns: 1fr; } }
.field label { padding-top: 6px; color: var(--ink); font: 16px var(--sans); }
.field .help { grid-column: 2; color: var(--ink-2); font-size: 15px; margin-top: -2px; }
@media (max-width: 700px) { .field .help { grid-column: 1; } }
input[type=text], input[type=number], select, textarea { font: 15px var(--code); color: var(--ink); background: var(--sheet); border: 1px solid var(--rule); border-radius: 3px; padding: 7px 9px; width: 100%; }
textarea { min-height: 84px; resize: vertical; }
.checks { display: flex; flex-wrap: wrap; gap: 6px 18px; padding-top: 6px; }
.rows td { padding: 4px 8px 4px 0; }
.rows input[type=text] { min-width: 90px; }
.rows select { min-width: 104px; }
button { font: 600 16px var(--sans); color: var(--sheet); background: var(--ink); border: 0; border-radius: 3px; padding: 9px 18px; justify-self: start; }
button:hover { background: var(--brass); }
.notice { border-left: 3px solid var(--good); background: var(--sheet); padding: 10px 14px; margin-bottom: 16px; }
.notice.error { border-left-color: var(--critical); }
.notice ul { margin: 6px 0 0; padding-left: 18px; }
footer { margin-top: 48px; color: var(--ink-2); font-size: 15px; border-top: 1px solid var(--rule); padding-top: 14px; max-width: 80ch; }
.themes { display: flex; gap: 14px; margin-top: 8px; font: 15px var(--sans); }
.themes a { color: var(--ink-2); }
.themes a[aria-current="true"] { color: var(--ink); text-decoration: none; }

.dial .needle { transform-origin: 110px 104px; }
/* One moment of motion: the needles settle into place, as the machine finds equilibrium. */
@media (prefers-reduced-motion: no-preference) {
  .gauge .needle, .dial .needle { transform-box: view-box; animation: settle 1.4s cubic-bezier(.25,1.6,.4,1) both; }
  @keyframes settle { from { transform: rotate(var(--from, -40deg)); } }
}
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
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
  <div class="bar"><a class="brand" href="/" aria-label="Homeostat overview"><span class="word">Homeostat</span><span class="sub" title="${esc(opts.kbRoot)}">${esc(opts.kbRoot.split("/").filter(Boolean).at(-1) ?? opts.kbRoot)}</span></a>${opts.status?.length ? `<div class="strip compact" aria-label="Status">${opts.status.map((l) => `<a href="${l.href}" title="${esc(`${l.label}: ${l.detail}`)}">${gauge(l.state, 26)}${esc(l.label)} <b>${esc(l.value)}</b></a>`).join("")}</div>` : ""}</div>
  <nav aria-label="Sections">${NAV.map(([href, label]) => `<a href="${href}"${current(href) ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
</header>
<main>${opts.body}</main>
<footer>Local dashboard. It reads this checkout and its git-ignored event log; nothing leaves this machine. Settings changes are written to homeostat.yaml here: commit them on a branch and open a PR.<span class="themes" aria-label="Theme">Theme ${(["dark", "light"] as const).map((t) => `<a href="?theme=${t}"${(opts.theme ?? "dark") === t ? ' aria-current="true"' : ""}>${t}</a>`).join("")}</span></footer>
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
  return `<tr><td class="when">${esc(when)}</td><td class="what"><span class="sym ${KIND[e.type] ?? ""}" aria-hidden="true">${SYMBOL[KIND[e.type] ?? ""] ?? "·"}</span><span class="kind ${KIND[e.type] ?? ""}">${esc(e.type)}</span></td><td class="detail" title="${esc(detail)}">${esc(detail)}</td></tr>`;
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

/**
 * A state as a shape as well as a colour (never colour alone): a tick, a warning triangle, a
 * cross, a dash. Plain strokes in currentColor, so they follow the theme.
 */
export function stateIcon(state: Lamp["state"], size = 16): string {
  const shape = {
    good: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    warning: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    critical: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    off: '<path d="M6 12h12"/>',
  }[state];
  return `<svg class="icon ${state}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shape}</svg>`;
}

/** How far the needle swings from upright for each state, in degrees. */
const SWING: Record<Lamp["state"], number> = { good: 0, warning: 30, critical: 62, off: -66 };

/**
 * One homeostat unit: Ashby's trough of water with a needle on a pivot. Upright is steady; the
 * further the needle swings, the further the loop has drifted from equilibrium.
 */
export function gauge(state: Lamp["state"], width = 120, title = ""): string {
  const cx = 60;
  const cy = 66;
  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(cx + r * Math.sin(a)).toFixed(1)},${(cy - r * Math.cos(a)).toFixed(1)}`;
  };
  const arc = (r: number) => `M${pt(-70, r)} A${r},${r} 0 0 1 ${pt(70, r)}`;
  const swing = SWING[state];
  const small = width < 60;
  return `<svg class="gauge ${state}" width="${width}" height="${Math.round((width * 72) / 120)}" viewBox="0 0 120 72" role="img" aria-label="${esc(title || STATE_WORD[state])}">
<path class="trough" d="${arc(48)}" stroke-width="${small ? 14 : 9}"/>${small ? "" : `<path class="rim" d="${arc(54)}"/>`}
<line class="zero" x1="${cx}" y1="${cy - 58}" x2="${cx}" y2="${cy - 40}"/>
<g transform="rotate(${swing} ${cx} ${cy})"><line class="needle" x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 52}" style="transform-origin:${cx}px ${cy}px;--from:${swing > 0 ? -40 : 40}deg" stroke-width="${small ? 6 : 2.4}"/></g>
<circle class="pivot" cx="${cx}" cy="${cy}" r="${small ? 7 : 3.5}"/></svg>`;
}

/** The console: four lamps, large, each a link to where its detail lives. */
function consoleRow(ls: readonly Lamp[]): string {
  return `<div class="units-row" aria-label="Status">${ls
    .map(
      (l) =>
        `<a class="hunit" href="${l.href}">${gauge(l.state, 120, `${l.label}: ${STATE_WORD[l.state]}`)}<span class="name">${esc(l.label)}</span><span class="reading ${l.state}">${esc(l.value)}</span><span class="detail">${esc(l.detail)}</span></a>`,
    )
    .join("")}</div>`;
}

const SYMBOL: Record<string, string> = { learn: "◆", alert: "▲", run: "▶" };
const STATE_WORD: Record<Lamp["state"], string> = {
  good: "all good",
  warning: "needs attention",
  critical: "act now",
  off: "no data yet",
};

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
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const prs = (r?.members ?? []).flatMap((m) => [
    ...(m.dailyPr ? [`<a href="${esc(m.dailyPr)}">${esc(m.member)}'s daily PR</a>`] : []),
    ...(m.reviewPr ? [`<a href="${esc(m.reviewPr)}">${esc(m.member)}'s review PR</a>`] : []),
  ]);
  const run = r
    ? `<p class="lede">On ${esc(r.at.slice(0, 10))} at ${esc(r.at.slice(11, 16))} UTC the daily run merged ${plural(sum("merged"), "lesson")}, sent ${sum("review")} to a reviewer and declined ${sum("declined")}. Reviewers settled ${r.settled} from earlier runs.</p>${prs.length ? `<p>${prs.join(", ")}</p>` : ""}`
    : '<p class="empty">No daily run on record in this clone yet. It runs in the KB repo\'s CI and records its decisions on the homeostat/state branch.</p>';
  // "The daily run is scheduled daily at 06:00 UTC and the deep dive on Mondays at 07:00 UTC."
  const when = (a: AgentLiveness) => esc(schedule(a.schedule).replace(/^(\w+days) at/, "on $1 at"));
  const schedules = agents
    .map(
      (a, i) =>
        `${i === 0 ? "The" : "the"} ${a.agent === "curator" ? "daily run" : "deep dive"}${i === 0 ? " is scheduled" : ""} ${when(a)}`,
    )
    .join(" and ");
  return `<div class="grid">
<section class="span-12" aria-label="Status">${consoleRow(ls)}</section>
<section class="panel span-6" aria-labelledby="run"><h2 id="run">Last daily run</h2>${run}<p class="muted">${schedules}.</p><p><a href="/automation">Decisions, review queue and sync</a></p></section>
<section class="panel span-6" aria-labelledby="kb"><h2 id="kb">Knowledge base</h2>
<div class="mini">${mini(h.byStatus.accepted, "rules in force")}${mini(h.byStatus.candidate, "awaiting review")}${mini(h.flagged.length + h.byStatus.disputed, "flagged or disputed")}${mini(h.stale.length, "not confirmed in 180 days")}</div></section>
<section class="panel span-12" aria-labelledby="use"><h2 id="use">Sessions</h2><p class="lede">${plural(imp.sessions, "session")} started with team rules in the last 14 days, ${imp.rulesPerInjection.toFixed(1)} rules each on average.</p>
${columns(daily, { title: "Sessions given rules, per day", height: 110, labelled: "ends", tickEvery: 7 })}${dataTable(daily, ["Day", "Sessions"])}</section>
<section class="panel span-12" aria-labelledby="recent"><h2 id="recent">Recent activity</h2><div class="legend"><span><span class="sym learn">◆</span>learned</span><span><span class="sym alert">▲</span>needs attention</span><span><span class="sym run">▶</span>a run</span></div>${recent.length ? recentTable(recent) : '<p class="empty">Nothing yet. Sessions, MCP calls and saved lessons will show up here.</p>'}<p><a href="/events">All events</a></p></section>
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
    .join("");
  return `<section class="panel"><h2>Entries</h2><nav class="filters" aria-label="Status">${filters}</nav>
<div class="table-wrap"><table><thead><tr><th>Status</th><th class="num">Score</th><th>Entry</th><th>Area</th><th>Owner</th><th>Confirmed</th></tr></thead><tbody>
${shown
  .map(
    (e) =>
      `<tr><td><span class="chip ${e.frontmatter.status}">${e.frontmatter.status}</span></td><td class="num">${e.frontmatter.score}</td><td><a href="/entries/${esc(e.frontmatter.id)}">${esc(e.frontmatter.title)}</a><div class="mono muted">${esc(e.frontmatter.id)}${e.frontmatter.flags?.length ? `, ${e.frontmatter.flags.length} open ${e.frontmatter.flags.length === 1 ? "flag" : "flags"}` : ""}</div></td><td>${esc(e.frontmatter.area)}</td><td>${esc(e.frontmatter.owner)}</td><td class="mono">${esc(e.frontmatter.lastConfirmed)}</td></tr>`,
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
      ? `, <a href="${esc(url)}">${esc(url.replace(/^https:\/\/[^/]+\//, ""))}</a>`
      : "";
  const fact = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
  return `<section class="panel"><p><a href="/entries">Back to entries</a></p>
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
${fact("Source", `${esc(fm.source.type)} by <span class="mono">${esc(fm.source.author)}</span>${fm.source.changedCode ? ", and the code changed after the comment" : ""}${link(fm.source.url)}`)}
${fact("Score", `<span class="mono">${fm.score}</span>${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li><span class="d ${r.delta > 0 ? "pos" : "neg"}">${r.delta > 0 ? "+" : ""}${r.delta}</span>${esc(r.note)}</li>`).join("")}</ul>` : ""}`)}
${fact("Dates", `created ${esc(fm.created)}, last confirmed ${esc(fm.lastConfirmed)}${fm.approvedBy ? `, approved by <span class="mono">${esc(fm.approvedBy)}</span>` : ""}`)}
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
