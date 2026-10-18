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
import {
  areaChart,
  columns,
  type Datum,
  dataTable,
  dial,
  esc,
  info,
  rings,
  rows,
} from "./charts.ts";
import type { AgentLiveness, Contribution, DesirePath, Health, Impact } from "./metrics.ts";
import { currentValue, type Field, SECTIONS, type Section } from "./settings.ts";

const CSS = `
:root {
  color-scheme: dark;
  --paper: #121316;
  --side: #17181c;
  --surface: #1e1f24;
  --raised: #26272d;
  --ink: #f4f4f6;
  --ink-2: #b4b5bd;
  --ink-3: #8a8b94;
  --rule: #2c2d34;
  --accent: #8b5cf6;
  --accent-2: #3b82f6;
  --series: #8b5cf6;
  --series-soft: #3b2a63;
  --good: #22c55e;
  --warning: #f59e0b;
  --critical: #ef4444;
  --pink: #ec4899;
  --focus: #a78bfa;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI Variable Display", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --code: "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
  --radius: 20px;
}
:root[data-theme="light"] {
  color-scheme: light;
  --paper: #f3f4f7;
  --side: #ffffff;
  --surface: #ffffff;
  --raised: #f1f2f6;
  --ink: #16171b;
  --ink-2: #4b4d57;
  --ink-3: #6b6d78;
  --rule: #e4e5ea;
  --series-soft: #e9e1fd;
  --good: #16a34a;
  --warning: #d97706;
  --critical: #dc2626;
  --focus: #7c3aed;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums; }
a { color: var(--accent-2); text-decoration: none; }
a:hover { text-decoration: underline; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 6px; }
a, button, summary, select, input[type=checkbox] { cursor: pointer; }
code, .mono { font-family: var(--code); font-size: 0.88em; }
h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -0.01em; line-height: 1.2; }
h2 { font-size: 18px; display: flex; align-items: center; gap: 6px; }
h2 a { color: inherit; }
h3 { font-size: 15px; }
.num { text-align: right; }
.muted { color: var(--ink-2); }
.empty { color: var(--ink-3); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* App frame: sidebar + main. */
.app { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; }
.side { background: var(--side); border-right: 1px solid var(--rule); padding: 22px 14px; display: flex; flex-direction: column; gap: 22px; position: sticky; top: 0; height: 100vh; }
.logo { display: flex; align-items: center; gap: 10px; color: var(--ink); font-weight: 700; font-size: 18px; padding: 0 8px; }
.logo:hover { text-decoration: none; }
.logo svg { flex: none; }
.menu { display: grid; gap: 4px; }
.menu a { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px; color: var(--ink-2); font-weight: 550; }
.menu a:hover { background: var(--raised); color: var(--ink); text-decoration: none; }
.menu a[aria-current="page"] { background: var(--raised); color: var(--ink); }
.menu svg { flex: none; }
.side-foot { margin-top: auto; display: grid; gap: 12px; padding: 0 8px; }
.kbname { color: var(--ink-3); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.switch { display: flex; align-items: center; justify-content: space-between; color: var(--ink); font-weight: 550; }
.switch:hover { text-decoration: none; }
.switch .track { width: 38px; height: 22px; border-radius: 999px; background: var(--raised); border: 1px solid var(--rule); position: relative; transition: background .2s; }
.switch .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--ink-3); transition: transform .2s, background .2s; }
.switch.on .track { background: var(--accent); border-color: var(--accent); }
.switch.on .knob { transform: translateX(16px); background: #fff; }
.main { min-width: 0; padding: 22px 32px 48px; }
.topbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 26px; }
.search { flex: 1 1 260px; max-width: 360px; position: relative; }
.search input { width: 100%; background: var(--surface); border: 1px solid var(--rule); color: var(--ink); border-radius: 12px; padding: 11px 14px 11px 40px; font: 15px var(--sans); }
.search svg { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--ink-3); }
.status { display: flex; gap: 8px; flex-wrap: wrap; margin-left: auto; }
.pill { display: inline-flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: 999px; background: var(--surface); border: 1px solid var(--rule); color: var(--ink-2); font-size: 13px; font-weight: 550; white-space: nowrap; }
.pill:hover { color: var(--ink); text-decoration: none; border-color: var(--ink-3); }
.pill b { color: var(--ink); }
.btn { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 10px 18px; font-weight: 650; font-size: 14px; }
.btn.primary { background: var(--accent-2); color: #fff; }
.btn.primary:hover { filter: brightness(1.1); text-decoration: none; }
@media (max-width: 900px) {
  .app { grid-template-columns: 1fr; }
  .side { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; padding: 12px 16px; gap: 10px; }
  .menu { display: flex; flex-wrap: wrap; gap: 2px; }
  .menu a { padding: 7px 10px; }
  .menu a span { display: none; }
  .side-foot { margin: 0 0 0 auto; padding: 0; }
  .kbname { display: none; }
  .main { padding: 18px 16px 40px; }
  .status { margin-left: 0; }
}

/* Greeting and cards. */
.hello { color: var(--ink-2); margin: 0 0 2px; font-size: 15px; }
.welcome { font-size: 30px; font-weight: 700; margin: 0 0 22px; }
.grid { display: grid; gap: 20px; grid-template-columns: repeat(12, minmax(0, 1fr)); }
.panel, .card { background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); padding: 22px 24px; grid-column: span 12; min-width: 0; }
.span-4 { grid-column: span 4; } .span-5 { grid-column: span 5; } .span-6 { grid-column: span 6; } .span-7 { grid-column: span 7; } .span-8 { grid-column: span 8; } .span-12 { grid-column: span 12; }
@media (max-width: 1000px) { .span-4, .span-5, .span-6, .span-7, .span-8 { grid-column: span 12; } .grid { gap: 16px; } }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.detail-link { font-weight: 600; font-size: 14px; display: inline-flex; align-items: center; gap: 4px; }
.lede { color: var(--ink-2); margin: 4px 0 14px; max-width: 70ch; }
.label { display: block; color: var(--ink-3); font-size: 13px; margin: 10px 0 4px; }

/* Hero card. */
.hero-body { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.4fr); gap: 24px; align-items: end; }
@media (max-width: 1000px) { .hero-body { grid-template-columns: 1fr; } }
.tabs { display: inline-flex; gap: 4px; padding: 4px; border-radius: 999px; background: var(--raised); margin-bottom: 26px; }
.tabs a, .tabs span { padding: 7px 14px; border-radius: 999px; color: var(--ink-3); font-size: 14px; font-weight: 550; }
.tabs a:hover { color: var(--ink); text-decoration: none; }
.tabs .on { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgb(0 0 0 / .25); }
.big { font-size: 56px; font-weight: 750; letter-spacing: -0.03em; line-height: 1; display: flex; align-items: center; gap: 14px; }
.trend { display: inline-flex; align-items: center; gap: 5px; font-size: 14px; font-weight: 650; letter-spacing: 0; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--rule); }
.trend.up { color: var(--good); } .trend.down { color: var(--critical); } .trend.flat { color: var(--ink-3); }
.big-sub { color: var(--ink-3); margin-top: 10px; font-size: 14px; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin-top: 22px; border: 1px solid var(--rule); border-radius: 16px; }
.kpi { padding: 16px 20px; border-left: 1px solid var(--rule); }
.kpi:first-child { border-left: 0; }
.kpi .k { color: var(--ink-2); font-size: 14px; display: block; margin-bottom: 6px; }
.kpi .v { font-size: 24px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
@media (max-width: 700px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpi:nth-child(3) { border-left: 0; } .kpi:nth-child(n+3) { border-top: 1px solid var(--rule); } }
.area { width: 100%; height: auto; display: block; overflow: visible; }
.area .curve { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }
.area .gridline { stroke: var(--rule); stroke-dasharray: 3 5; }
.area .xl { fill: var(--ink-3); font: 12px var(--sans); }
.area .pt { fill: transparent; }
.area .pt:hover { fill: color-mix(in srgb, var(--accent) 30%, transparent); }
.area .last { fill: var(--accent); stroke: #fff; stroke-width: 2.5; }
.area .callout rect { fill: var(--ink); }
.area .callout .cl { fill: var(--ink-3); font: 11px var(--sans); }
.area .callout .cv { fill: var(--paper); font: 700 14px var(--sans); }
.area .callout .cu { font: 500 11px var(--sans); }

/* Decisions card: total, legend, rings. */
.split { display: grid; grid-template-columns: minmax(0, 1fr) 200px; gap: 16px; align-items: center; }
@media (max-width: 520px) { .split { grid-template-columns: 1fr; } }
.total .k { color: var(--ink-2); font-size: 14px; }
.total .v { font-size: 34px; font-weight: 750; display: block; margin: 2px 0 14px; }
.legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.legend li { display: flex; align-items: center; gap: 10px; font-weight: 550; }
.legend .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.legend b { margin-left: auto; padding-right: 8px; }
.rings { width: 100%; max-width: 200px; display: block; }
.rings .ring-track { fill: none; stroke: var(--raised); stroke-width: 11; }
.rings .ring { fill: none; stroke-width: 11; stroke-linecap: round; }

/* Pills for status in tables. */
.chip, .status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12.5px; font-weight: 650; white-space: nowrap; background: var(--raised); color: var(--ink-2); }
.chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.chip.accepted, .status-pill.merged { background: color-mix(in srgb, var(--good) 18%, transparent); color: var(--good); }
.chip.candidate, .status-pill.review { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
.chip.disputed, .status-pill.declined { background: color-mix(in srgb, var(--critical) 18%, transparent); color: var(--critical); }
.chip.retired { color: var(--ink-3); }

/* Tables. */
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--ink-3); font-weight: 550; font-size: 13px; padding: 8px 10px; border-bottom: 1px solid var(--rule); }
td { padding: 11px 10px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
tr:last-child td { border-bottom: 0; }
.table-wrap { overflow-x: auto; }
.table-wrap > table { min-width: 620px; }
.table-wrap.fit > table { min-width: 0; table-layout: fixed; }
.decided td:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.decided th:nth-child(2), .decided td:nth-child(2) { width: 24%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.decided th:nth-child(3) { width: 112px; } .decided th:nth-child(4) { width: 64px; }
.recent { table-layout: fixed; }
.recent td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.recent .when { width: 104px; color: var(--ink-3); }
.recent .what { width: 160px; }
.log:not(.recent) .when { white-space: nowrap; color: var(--ink-3); width: 1%; }
.log:not(.recent) .what { white-space: nowrap; width: 1%; }
.log .detail { overflow-wrap: anywhere; color: var(--ink-2); }
.kind { font-size: 13px; color: var(--ink-2); }
.sym { display: inline-block; width: 1.3em; color: var(--ink-3); }
.sym.learn { color: var(--good); } .sym.alert { color: var(--critical); } .sym.run { color: var(--accent); }
.filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; }
.filters a { padding: 6px 12px; border-radius: 999px; background: var(--raised); color: var(--ink-2); font-size: 13px; font-weight: 550; }
.filters a:hover { color: var(--ink); text-decoration: none; }
.filters a[aria-current="page"] { background: var(--accent); color: #fff; }

/* Small multiples. */
.stats, .mini { display: grid; grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr)); gap: 14px; margin: 8px 0 12px; }
@media (max-width: 600px) { .stats, .mini { --cols: 2 !important; } }
.stat .n, .mini .n { display: block; font-size: 26px; font-weight: 700; }
.stat .k, .mini .k { color: var(--ink-2); font-size: 13px; }
.lamp { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--ink-3); flex: none; }
.lamp.good { background: var(--good); } .lamp.warning { background: var(--warning); } .lamp.critical { background: var(--critical); }
.icon { flex: none; } .icon.good { color: var(--good); } .icon.warning { color: var(--warning); } .icon.critical { color: var(--critical); } .icon.off { color: var(--ink-3); }
.state { font-size: 13px; color: var(--ink-2); }
.tag { display: inline-block; font-size: 12.5px; font-weight: 600; color: var(--ink-2); padding: 3px 10px; border-radius: 999px; background: var(--raised); }
.tag.no { color: var(--critical); background: color-mix(in srgb, var(--critical) 16%, transparent); }

/* Bars and dial (other pages). */
.chart { width: 100%; max-width: 680px; height: auto; display: block; overflow: visible; }
.chart path { fill: var(--accent); }
.chart .hit { fill: transparent; }
.chart .m:hover path { fill: var(--accent-2); }
.chart .base { stroke: var(--rule); }
.chart text { font: 12px var(--sans); fill: var(--ink-3); }
.chart text.v { fill: var(--ink); }
.dial { width: 100%; max-width: 220px; display: block; margin: 0 auto; }
.dial .track { fill: none; stroke: var(--raised); stroke-width: 10; stroke-linecap: round; }
.dial .fill { fill: none; stroke: var(--accent); stroke-width: 10; stroke-linecap: round; }
.dial .tick { stroke: var(--ink-3); } .dial .needle { stroke: var(--ink); stroke-width: 2; } .dial .hub { fill: var(--ink); }
.dial-value { font: 700 24px var(--sans); fill: var(--ink); } .dial-caption { font: 12px var(--sans); fill: var(--ink-3); }
details.table-view { margin-top: 8px; } details.table-view summary { color: var(--ink-3); font-size: 13px; }

/* (i) tooltips. */
.info { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 17px; height: 17px; margin-left: 4px; border: 1.3px solid var(--ink-3); border-radius: 50%; color: var(--ink-3); cursor: help; flex: none; }
.info .i { font: italic 700 11px/1 Georgia, serif; }
.info:hover, .info:focus-visible { border-color: var(--accent); color: var(--accent); }
.info .tip { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.info:hover .tip, .info:focus .tip { clip: auto; width: max-content; max-width: min(320px, 78vw); height: auto; overflow: visible; white-space: normal; left: -10px; top: calc(100% + 10px); z-index: 30; background: var(--raised); color: var(--ink); border: 1px solid var(--rule); font: 400 13.5px/1.5 var(--sans); letter-spacing: 0; text-align: left; padding: 10px 12px; border-radius: 12px; box-shadow: 0 12px 30px rgb(0 0 0 / .35); }

/* Entry pages. */
.entry-head { display: grid; gap: 10px; margin: 6px 0 20px; }
.entry-head h2 { font-size: 26px; }
.entry-head .tags { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.statement { margin: 0 0 18px; padding: 16px 18px; border-radius: 14px; background: var(--raised); max-width: 72ch; }
.statement .label { margin: 0 0 4px; }
.statement p { margin: 0; }
.statement.rule p { font-size: 18px; font-weight: 550; }
.statement.rejected p { font-size: 18px; text-decoration: line-through; text-decoration-color: var(--critical); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 8px 24px; margin: 20px 0 0; }
.facts dt { color: var(--ink-3); font-size: 13px; padding-top: 2px; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.reasons { list-style: none; padding: 0; margin: 4px 0 0; }
.reasons .d { display: inline-block; width: 3ch; text-align: right; margin-right: 8px; font-weight: 700; }
.reasons .d.pos { color: var(--good); } .reasons .d.neg { color: var(--critical); }
.flag { border-left: 3px solid var(--warning); padding-left: 12px; margin: 6px 0; }

/* Settings. */
.sections { list-style: none; padding: 0; margin: 10px 0 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
.sections li { display: flex; align-items: center; gap: 4px; padding: 14px 16px; border-radius: 14px; background: var(--raised); font-weight: 600; }
form.settings { display: grid; gap: 16px; max-width: 760px; }
.field { display: grid; grid-template-columns: 240px 1fr; gap: 6px 18px; align-items: start; }
@media (max-width: 700px) { .field { grid-template-columns: 1fr; } }
.field label { padding-top: 8px; color: var(--ink); font-weight: 550; display: flex; align-items: center; }
input[type=text], input[type=number], select, textarea { font: 14px var(--code); color: var(--ink); background: var(--raised); border: 1px solid var(--rule); border-radius: 10px; padding: 8px 10px; width: 100%; }
textarea { min-height: 84px; resize: vertical; }
.checks { display: flex; flex-wrap: wrap; gap: 6px 18px; padding-top: 6px; }
.rows td { padding: 5px 8px 5px 0; }
.rows input[type=text] { min-width: 90px; }
.rows select { min-width: 104px; }
button { font: 650 14px var(--sans); color: #fff; background: var(--accent-2); border: 0; border-radius: 999px; padding: 10px 20px; justify-self: start; }
button:hover { filter: brightness(1.1); }
.notice { border-radius: 12px; background: color-mix(in srgb, var(--good) 14%, transparent); padding: 12px 16px; margin-bottom: 16px; }
.notice.error { background: color-mix(in srgb, var(--critical) 14%, transparent); }
.notice ul { margin: 6px 0 0; padding-left: 18px; }
.units { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.unit { display: grid; gap: 4px; }
.gauge { display: inline-block; vertical-align: middle; }
.gauge .trough { fill: none; stroke: var(--raised); stroke-linecap: round; }
.gauge .rim { display: none; } .gauge .zero { stroke: var(--ink-3); }
.gauge .needle { stroke: var(--accent); stroke-linecap: round; } .gauge .pivot { fill: var(--ink); }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
`;

/** Stroke icons, drawn here (no icon font, nothing fetched). 20px, currentColor. */
const ICON: Record<string, string> = {
  "/": '<rect x="4" y="4" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="2"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="2"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2"/>',
  "/automation":
    '<path d="M20 12a8 8 0 0 1-14 5.3"/><path d="M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4"/><path d="M6 21v-4h4"/>',
  "/entries":
    '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="18" r="1"/>',
  "/members":
    '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3 2.9 3 6"/>',
  "/coverage":
    '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8"/>',
  "/impact": '<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>',
  "/documents": '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  "/desire-paths":
    '<path d="M5 19c3-1 3-5 7-6s4-5 7-6"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="7" r="1.6"/>',
  "/events": '<path d="M3 12h4l2-6 4 12 2-6h6"/>',
  "/settings":
    '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
};
const icon = (path: string, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

/** Pill labels in the top bar; the full name and reading are in the pill's title. */
const SHORT: Record<Lamp["key"], string> = { daily: "Run", queue: "Queue", sync: "Sync", kb: "KB" };

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
<div class="app">
<aside class="side">
  <a class="logo" href="/" aria-label="Homeostat overview"><svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs><rect width="30" height="30" rx="9" fill="url(#lg)"/><path d="M7 19a8 8 0 0 1 16 0" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M15 19l4-6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg><span>Homeostat</span></a>
  <nav class="menu" aria-label="Sections">${NAV.map(([href, label]) => `<a href="${href}"${current(href) ? ' aria-current="page"' : ""} title="${label}">${icon(ICON[href] ?? "")}<span>${label}</span></a>`).join("")}</nav>
  <div class="side-foot">
    <span class="kbname" title="${esc(opts.kbRoot)}">${esc(opts.kbRoot.split("/").filter(Boolean).at(-1) ?? opts.kbRoot)}${info("A local view of this KB checkout and its git-ignored event log. It sends nothing anywhere. Settings changes are written to homeostat.yaml here: commit them on a branch and open a PR.")}</span>
    <a class="switch${opts.theme === "light" ? "" : " on"}" href="?theme=${opts.theme === "light" ? "dark" : "light"}" role="switch" aria-checked="${opts.theme === "light" ? "false" : "true"}">Dark mode<span class="track"><span class="knob"></span></span></a>
  </div>
</aside>
<div class="main">
  <header class="topbar">
    <form class="search" action="/entries" role="search">${icon('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>', 18)}<input type="search" name="q" placeholder="Search rules" aria-label="Search rules"></form>
    ${opts.status?.length ? `<div class="status" aria-label="Status">${opts.status.map((l) => `<a class="pill" href="${l.href}" title="${esc(`${l.label}: ${l.value}${l.detail ? `, ${l.detail}` : ""}`)}">${stateIcon(l.state, 15)}${esc(SHORT[l.key])} <b>${esc(l.value)}</b></a>`).join("")}</div>` : ""}
    <a class="btn primary" href="/automation#queue">${icon('<path d="M4 12l5 5L20 6"/>', 18)}Review queue</a>
  </header>
  <main>${opts.body}</main>
</div>
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
        `<div class="hunit">${gauge(l.state, 120, `${l.label}: ${STATE_WORD[l.state]}`)}<span class="name"><a href="${l.href}">${esc(l.label)}</a>${info(esc(l.about))}</span><span class="reading ${l.state}">${esc(l.value)}</span>${l.detail ? `<span class="detail">${esc(l.detail)}</span>` : ""}</div>`,
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

/** A small arrow for a change: up, down or level. */
const arrow = (d: number) =>
  icon(
    d > 0
      ? '<path d="M4 17l6-6 4 4 6-7"/><path d="M15 8h5v5"/>'
      : d < 0
        ? '<path d="M4 7l6 6 4-4 6 7"/><path d="M15 16h5v-5"/>'
        : '<path d="M5 12h14"/>',
    16,
  );

export interface OverviewExtras {
  name?: string;
  /** Rules accepted in the last 7 days. */
  newThisWeek: number;
  decided: { member: string; id: string; decision: string; confidence?: number; at: string }[];
}

export function overviewPage(
  h: Health,
  agents: AgentLiveness[],
  imp: Impact,
  _recent: Event[],
  v: AutomationView,
  _ls: readonly Lamp[],
  x: OverviewExtras = { newThisWeek: 0, decided: [] },
): string {
  const daily: Datum[] = imp.injectionsByDay.map((d) => ({
    label: new Date(`${d.day}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }),
    value: d.count,
    title: `${d.day}: ${d.count} sessions given rules`,
  }));
  const runs = v.runs;
  const last = runs.at(-1);
  const prev = runs.at(-2);
  const sum = (r: typeof last, k: "merged" | "review" | "declined") =>
    r?.members.reduce((n, m) => n + m[k], 0) ?? 0;
  const kpi = (label: string, now: number, before: number | undefined, tip: string) =>
    `<div class="kpi"><span class="k">${label}${info(tip)}</span><span class="v">${before === undefined ? "" : `<span class="trend ${now > before ? "up" : now < before ? "down" : "flat"}" style="border:0;padding:0">${arrow(now - before)}</span>`}${now}</span></div>`;
  const totals = {
    merged: runs.reduce((n, r) => n + sum(r, "merged"), 0),
    review: runs.reduce((n, r) => n + sum(r, "review"), 0),
    declined: runs.reduce((n, r) => n + sum(r, "declined"), 0),
    settled: runs.reduce((n, r) => n + r.settled, 0),
  };
  const segments = [
    { label: "Merged", value: totals.merged, color: "var(--good)" },
    { label: "To review", value: totals.review, color: "var(--warning)" },
    { label: "Declined", value: totals.declined, color: "var(--critical)" },
    { label: "Settled", value: totals.settled, color: "var(--accent)" },
  ];
  const decidedTotal = totals.merged + totals.review + totals.declined;
  const schedules = agents
    .map((a) => `${a.agent === "curator" ? "Daily run" : "Deep dive"}: ${schedule(a.schedule)}.`)
    .join(" ");
  const rows = x.decided.slice(0, 6);
  return `<p class="hello">Hi ${esc(x.name ?? "there")},</p><h1 class="welcome">Welcome back</h1>
<div class="grid">
<section class="card span-12" aria-labelledby="kb">
  <div class="card-head"><h2 id="kb">Knowledge${info("The rules every session gets, and how much they're used. Rules in force are accepted and not disputed.")}</h2></div>
  <div class="hero-body">
    <div>
      <div class="tabs" role="tablist"><span class="on" role="tab" aria-selected="true">Rules in force</span><a role="tab" href="/entries?status=candidate">Awaiting review</a><a role="tab" href="/entries?status=disputed">Disputed</a></div>
      <div class="big">${h.byStatus.accepted}<span class="trend ${x.newThisWeek > 0 ? "up" : "flat"}">${arrow(x.newThisWeek)}${x.newThisWeek > 0 ? `+${x.newThisWeek}` : "0"} this week</span></div>
      <p class="big-sub">${h.flagged.length + h.byStatus.disputed} flagged, ${h.stale.length} stale</p>
    </div>
    <div>${areaChart(daily, {
      title: "Sessions given team rules, per day",
      id: "sessions",
      unit: "sessions",
    })}</div>
  </div>
  <div class="kpis">
    ${kpi("Merged", sum(last, "merged"), prev ? sum(prev, "merged") : undefined, "Lessons the last daily run merged on its own: confident, safe and not repeats.")}
    ${kpi("To review", sum(last, "review"), prev ? sum(prev, "review") : undefined, "Lessons the last daily run sent to a reviewer, in a review PR.")}
    ${kpi("Declined", sum(last, "declined"), prev ? sum(prev, "declined") : undefined, "Lessons the last daily run declined: weak, invalid, or a repeat of a rule the team already has.")}
    ${kpi("Settled", last?.settled ?? 0, prev?.settled, "Review PRs reviewers merged or closed since the run before.")}
  </div>
</section>
<section class="card span-5" aria-labelledby="runs">
  <div class="card-head"><h2 id="runs">Daily run${info(`Every decision recorded on the state branch. ${schedules}`)}</h2><a class="detail-link" href="/automation">Detail ${icon('<path d="M9 6l6 6-6 6"/>', 16)}</a></div>
  <div class="split"><div><div class="total"><span class="k">Lessons decided</span><span class="v">${decidedTotal}</span></div>
  <ul class="legend">${segments.map((g) => `<li><span class="dot" style="background:${g.color}"></span>${g.label}<b>${g.value}</b></li>`).join("")}</ul></div>
  ${rings(segments, "Lessons decided by the daily run")}</div>
</section>
<section class="card span-7" aria-labelledby="decided">
  <div class="card-head"><h2 id="decided">Recent decisions</h2><a class="detail-link" href="/automation">Detail ${icon('<path d="M9 6l6 6-6 6"/>', 16)}</a></div>
  ${
    rows.length
      ? `<div class="table-wrap fit"><table class="decided"><thead><tr><th>Lesson</th><th>Developer</th><th>Decision</th><th class="num">Score</th></tr></thead><tbody>${rows
          .map(
            (d) =>
              `<tr><td>${d.id.startsWith("knowledge/") ? esc(d.id.replace(/^knowledge\//, "")) : `<a href="/entries/${esc(d.id)}">${esc(d.id)}</a>`}</td><td>${esc(d.member)}</td><td><span class="status-pill ${esc(d.decision)}">${d.decision === "review" ? "to review" : esc(d.decision)}</span></td><td class="num">${d.confidence ?? "—"}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<p class="empty">No decisions yet. The first daily run fills this in.</p>'
  }
</section>
</div>`;
}

export function entriesPage(
  entries: readonly Entry[],
  status: string | null,
  query: string | null = null,
): string {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (e: Entry) => {
    const hay = `${e.frontmatter.id} ${e.frontmatter.title} ${e.sections.rule ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const shown = entries
    .filter((e) => (!status || e.frontmatter.status === status) && matches(e))
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
<div class="tags"><span class="chip ${fm.status}">${fm.status}</span>${rejected ? `<span class="tag no">decided against</span>${info("Considered and not adopted. Agents see it as context, never as an instruction, so they stop proposing it unless something below no longer holds.")}` : fm.kind ? `<span class="tag">${esc(fm.kind)}</span>` : ""}<span class="tag">${esc(fm.area)}</span><span class="mono muted">${esc(fm.id)}</span></div></header>
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
<p style="margin-top:18px"><code>homeostat flag ${esc(fm.id)} --reason "…"</code>${info("If this rule is wrong or out of date, flag it: it leaves sessions at once and goes back for review.")}</p></section>`;
}

export function membersPage(rowsData: Contribution[]): string {
  return `<section class="panel"><h2>Members${info("What each person's sessions, reviews and captures have fed into the shared knowledge base. Listed alphabetically: this is contribution to a shared product, not a ranking.")}</h2>
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
<section class="panel"><h2>Section usage${info("Reads through MCP and sessions each section was given in full, from this machine's event log over the last 90 days. A section nobody used or confirmed in 90 days is a review candidate: its owner confirms, updates or removes it.")}</h2>
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
  return `<section class="panel"><h2>Desire paths${info("Tool names agents tried that are not the real ones. Resolved guesses already work as aliases; unresolved ones that keep coming back are worth turning into real tools.")}</h2>
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
  return `<section class="panel"><h2>Settings${info("Every key in homeostat.yaml, as forms. Changes are validated before anything is written, and comments in the file are kept.")}</h2>
<ul class="sections">${SECTIONS.map((s) => `<li><a href="/settings/${s.id}">${esc(s.title)}</a>${info(esc(s.intro))}</li>`).join("")}</ul></section>`;
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
  return `<div class="field"><label for="${id}">${esc(field.label)}${field.help ? info(esc(field.help)) : ""}</label>${control}</div>`;
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
      )}</tbody></table></div><p class="muted">Adding rows${info("Blank rows add members. Areas are comma-separated.")}</p>`;
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
      )}</tbody></table></div><p class="muted">Adding rows${info("Blank rows add teams. Lists are comma-separated; the handle is an @org/team.")}</p>`;
  }
  const areas = [...Object.entries(config.areas), ...Array(3).fill(undefined)];
  return `<div class="table-wrap"><table class="rows"><thead><tr><th>Area</th><th>Path globs</th><th>Remove</th></tr></thead><tbody>${areas
    .map(
      (a, i) =>
        `<tr><td><input type="text" name="area.${i}.name" value="${esc(a?.[0] ?? "")}" aria-label="Area name"></td><td><input type="text" name="area.${i}.globs" value="${esc((a?.[1] as string[] | undefined)?.join(", ") ?? "")}" aria-label="Path globs"></td><td>${a ? `<input type="checkbox" name="area.${i}.remove" aria-label="Remove ${esc(a[0])}">` : ""}</td></tr>`,
    )
    .join(
      "",
    )}</tbody></table></div><p class="muted">Adding rows${info("Blank rows add areas. Globs are comma-separated.")}</p>`;
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
  return `<section class="panel"><p><a href="/settings">Back to settings</a></p><h2>${esc(section.title)}${info(esc(section.intro))}</h2>${banner}
<form class="settings" method="post" action="/settings/${section.id}"><input type="hidden" name="_token" value="${esc(token)}">${body}<button type="submit">Save</button></form></section>`;
}

export function messagePage(title: string, text: string): string {
  return `<section class="panel"><h2>${esc(title)}</h2><p class="lede">${esc(text)}</p></section>`;
}
