import type { MetricsReport } from "@homeostat/core";
import { age } from "./automation.ts";
import {
  areaChart,
  columns,
  type Datum,
  dataTable,
  esc,
  info,
  rows,
  type StackedDatum,
  stackedColumns,
} from "./charts.ts";
import { kpi, stat } from "./views.ts";

const pct = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v * 100)}%`);
const ms = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v)} ms`);
const duration = (v: number | undefined) => {
  if (v === undefined) return "—";
  const s = Math.round(v / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const delta = (now: number | undefined, before: number | undefined) =>
  now === undefined || before === undefined ? undefined : now - before;
/** The arrow of a figure where lower is better points up when it fell. */
const lowerIsBetter = (now: number | undefined, before: number | undefined) => {
  const d = delta(now, before);
  return d === undefined ? undefined : -d;
};
const empty = (text: string) => `<p class="empty">${esc(text)}</p>`;

/**
 * The Performance page: how the daily run decides, whether its confidence lines sit right, how
 * long reviews wait, whether rules reach sessions, and what every step costs. Every figure is
 * computed at read time; a shared build leaves out what only this machine's event log can fill.
 */
export function performancePage(r: MetricsReport, opts: { shared: boolean }): string {
  const { shared } = opts;
  const w = r.window;
  const d = r.decisions;
  const c = r.calibration;
  const l = r.latency;
  const re = r.reach;
  const rt = r.runtime;
  const runsNote = `in the last ${w.runs} runs${d.previous ? ", against the runs before" : ""}`;

  // 1. The KPI row.
  const kpis = [
    kpi(
      "Auto-merged",
      pct(d.current.autoMergeShare),
      delta(d.current.autoMergeShare, d.previous?.autoMergeShare),
      `Lessons the daily run merged on its own, over the lessons that were not repeats, ${runsNote}.`,
    ),
    kpi(
      "Reviewer agreement",
      pct(c.reviewerAgreement),
      undefined,
      `Of the lessons reviewers settled in the last ${w.days} days, the share they merged rather than closed.`,
    ),
    kpi(
      "Review latency",
      age(l.medianHours),
      lowerIsBetter(l.medianHours, l.previous?.medianHours),
      `Median time from a review PR opening to a reviewer merging or closing it, over the last ${w.days} days; ${l.unmeasured} settled before times were recorded. The arrow points up when it got shorter.`,
    ),
    kpi(
      "Last run",
      duration(rt.lastRun?.durationMs),
      lowerIsBetter(rt.lastRun?.durationMs, rt.lastRun?.previousMedianMs),
      "How long the last daily run took, against the median of the runs before it. The arrow points up when it got faster.",
    ),
    ...(shared
      ? []
      : [
          kpi(
            "Rules served",
            `${re.distinctRules} of ${re.reachable}`,
            delta(re.distinctRules, re.previous.distinctRules),
            `Distinct rules this machine's sessions were given in the last ${w.days} days, of the rules a session here could get: the shared ones plus those of every repo seen.`,
          ),
          kpi(
            "Session start",
            ms(rt.sessionStart?.median),
            lowerIsBetter(rt.sessionStart?.median, rt.sessionStart?.previous?.median),
            `Median wall time of the session-start hook on this machine, inside the CLI (without the launcher's spawn, Node's startup or writing the event), over the last ${w.days} days. The arrow points up when it got faster.`,
          ),
        ]),
  ];

  // 2. Calibration: every decision with a confidence, in ten-point bands, with the lines drawn.
  const decided = c.bands.some(
    (b) => b.merged + b.reviewMerged + b.reviewDeclined + b.reviewOpen + b.declined > 0,
  );
  const bands: StackedDatum[] = c.bands.map((b) => ({
    label: String(b.from),
    title: `${b.from} to ${b.to}: ${b.merged} merged, ${b.reviewMerged} reviewed then merged, ${b.reviewDeclined} reviewed then declined, ${b.declined} declined, ${b.reviewOpen} waiting`,
    parts: [
      { name: "merged", value: b.merged, color: "var(--good)" },
      { name: "reviewed then merged", value: b.reviewMerged, color: "var(--accent)" },
      { name: "reviewed then declined", value: b.reviewDeclined, color: "var(--warning)" },
      { name: "declined", value: b.declined, color: "var(--critical)" },
    ],
  }));
  const u = c.underAccept;
  const sentence = u.of
    ? `Lessons sent to review at ${u.from} to ${u.to} were merged by a reviewer ${u.merged} of ${u.of} times.`
    : `No lesson at ${u.from} to ${u.to} has been settled by a reviewer yet.`;
  const bandTable = `<details class="table-view"><summary>Table</summary><table><thead><tr><th>Band</th><th class="num">Merged</th><th class="num">Reviewed, merged</th><th class="num">Reviewed, declined</th><th class="num">Waiting</th><th class="num">Declined</th></tr></thead><tbody>${c.bands
    .map(
      (b) =>
        `<tr><td>${b.from} to ${b.to}</td><td class="num">${b.merged}</td><td class="num">${b.reviewMerged}</td><td class="num">${b.reviewDeclined}</td><td class="num">${b.reviewOpen}</td><td class="num">${b.declined}</td></tr>`,
    )
    .join("")}</tbody></table></details>`;
  const calibration = decided
    ? `${stackedColumns(bands, {
        title: "Decisions by confidence band",
        markers: [
          { at: c.lines.decline / 10, label: `decline ${c.lines.decline}` },
          { at: c.lines.accept / 10, label: `accept ${c.lines.accept}` },
          { at: c.lines.coreAccept / 10, label: `core ${c.lines.coreAccept}` },
        ],
      })}<p class="muted">${esc(sentence)}</p>${bandTable}`
    : empty("No decisions with a confidence yet.");

  // 3. Decisions and health per run, with the health counts as lines where a run recorded them.
  const trend = new Map(r.healthTrend.map((p) => [p.at, p]));
  const perRun: StackedDatum[] = d.perRun.map((run) => ({
    label: run.at.slice(5, 10),
    title: `${run.at.slice(0, 16).replace("T", " ")}: ${run.merged} merged, ${run.review} to review, ${run.declined - run.duplicates} declined, ${run.duplicates} repeats`,
    parts: [
      { name: "merged", value: run.merged, color: "var(--good)" },
      { name: "to review", value: run.review, color: "var(--warning)" },
      { name: "declined", value: run.declined - run.duplicates, color: "var(--critical)" },
      { name: "repeats", value: run.duplicates, color: "var(--ink-3)" },
    ],
  }));
  const healthLines = (
    [
      ["accepted", "Accepted", "var(--ink)"],
      ["stale", "Stale", "var(--warning)"],
      ["flagged", "Flagged", "var(--critical)"],
      ["disputed", "Disputed", "var(--accent-2)"],
      ["possibleDuplicates", "Possible duplicates", "var(--ink-3)"],
    ] as const
  ).map(([key, name, color]) => ({
    name,
    color,
    values: d.perRun.map((run) => trend.get(run.at)?.[key]),
  }));
  const runsPanel = d.perRun.length
    ? `${stackedColumns(perRun, {
        title: "Lessons decided per run",
        tickEvery: d.perRun.length > 15 ? 5 : 1,
        ...(r.healthTrend.length ? { lines: healthLines } : {}),
      })}${dataTable(
        d.perRun.map((run) => ({ label: run.at.slice(0, 10), value: run.total })),
        ["Run", "Lessons"],
      )}`
    : empty("No daily run yet.");

  // 4. Reach: this machine's sessions, and the team's where members share counts.
  const local: Datum[] = re.injectionsByDay.map((x) => ({
    label: x.day.slice(5),
    value: x.count,
    title: `${x.day}: ${x.count} injections`,
  }));
  const team: Datum[] = re.team.byDay.map((x) => ({
    label: x.day.slice(5),
    value: x.injections,
    title: `${x.day}: ${x.injections} injections in ${x.sessions} sessions, ${x.rules} rules, ${x.mcpCalls} MCP calls, ${x.docReads} document reads, ${x.turns ?? 0} turns`,
  }));
  const teamPanel = re.team.sharing
    ? `${columns(team, { title: "Team injections per day", labelled: "ends" })}<p class="muted">${re.team.sharing} of ${re.team.members} members share usage counts</p>`
    : empty("No member shares usage counts.");
  const localPanel = shared
    ? ""
    : re.sessions
      ? `${areaChart(local, { title: `Sessions given rules per day, last ${w.days} days`, id: "reach", unit: "injections" })}<div class="stats" style="--cols: 3">${stat(pct(re.servedShare), "reachable rules served")}${stat(pct(re.indexOverflowShare), "starts that left rules out")}${stat(pct(re.docs.pullThrough), "covering documents opened")}</div>`
      : empty("No sessions recorded on this machine yet.");

  // 4b. Use: whether agents look things up, and credit what they used.
  const us = r.usage;
  const teamTurns = re.team.byDay.reduce(
    (a, x) => ({
      turns: a.turns + (x.turns ?? 0),
      retrieved: a.retrieved + (x.retrievedTurns ?? 0),
      credited: a.credited + (x.creditedTurns ?? 0),
    }),
    { turns: 0, retrieved: 0, credited: 0 },
  );
  const share = (n: number, of: number) => (of ? pct(n / of) : "—");
  const teamUse = teamTurns.turns
    ? `<div class="stats" style="--cols: 3">${stat(teamTurns.turns, "team turns, last 7 days")}${stat(share(teamTurns.retrieved, teamTurns.turns), "team turns that looked things up")}${stat(share(teamTurns.credited, teamTurns.turns), "team turns that credited")}</div>`
    : "";
  const shown = us.neverCredited.slice(0, 12);
  const neverList = us.neverCredited.length
    ? `<p class="muted">Served, never credited${info(`Accepted rules a session on this machine was given in the last ${w.days} days that no reply credited. A rule that is served often and never credited may be unclear, or not needed.`)}</p><p>${shown.map((id) => `<span class="chip mono">${esc(id)}</span>`).join(" ")}${us.neverCredited.length > shown.length ? ` <span class="muted">+${us.neverCredited.length - shown.length} more</span>` : ""}</p>`
    : "";
  const localUse = shared
    ? ""
    : us.turns
      ? `<div class="stats" style="--cols: 4">${stat(pct(us.retrievedShare), "turns that looked things up")}${stat(pct(us.creditedShare), "turns that credited")}${stat(pct(us.creditedAfterRetrieval), "credited after a lookup")}${stat(`${us.distinctRules} · ${us.distinctDocs}`, "rules · sections credited")}</div>${neverList}`
      : empty("No turns recorded on this machine yet.");
  const usePanel =
    localUse || teamUse ? `${localUse}${teamUse}` : empty("No member shares usage counts.");

  // 5. Runtime: four cards; only the daily run's survives a shared build.
  const ss = rt.sessionStart;
  const cx = rt.context;
  const sessionCard = ss
    ? `<div class="stats" style="--cols: 4">${stat(ms(ss.median), "median start")}${stat(ms(ss.p90), "p90 start")}${stat(ss.count, "starts measured")}${stat(ss.failures, "failed starts")}</div>${
        cx
          ? `<div class="stats" style="--cols: 3">${stat(cx.tokensMedian, "median tokens")}${stat(cx.charsMedian ?? "—", "median characters")}${stat(pct(cx.fullShare), "rules given in full")}</div>`
          : ""
      }`
    : empty("No timed session starts yet.");
  const mcpCard = rt.mcp.length
    ? rows(
        rt.mcp.map((t) => ({
          label: t.tool,
          value: t.calls,
          title: `${t.tool}: ${t.calls} calls, ${t.failures} failed${t.latency ? `, median ${Math.round(t.latency.median)} ms` : ""}`,
        })),
        { title: "MCP calls per tool", labelWidth: 120 },
      )
    : empty("No MCP calls yet.");
  const timedRuns = rt.dailyRuns.filter((run) => run.durationMs !== undefined);
  const lastTimed = timedRuns.at(-1);
  const runCard = timedRuns.length
    ? `${columns(
        timedRuns.map((run) => ({
          label: run.at.slice(5, 10),
          value: Math.round((run.durationMs ?? 0) / 1000),
          title: `${run.at.slice(0, 10)}: ${duration(run.durationMs)}, ${run.modelCalls ?? 0} model calls, ${run.failedCalls ?? 0} failed, ${run.lessons} lessons`,
        })),
        {
          title: "Daily run duration in seconds",
          labelled: "ends",
          tickEvery: timedRuns.length > 15 ? 5 : 1,
        },
      )}<div class="stats" style="--cols: 4">${stat(duration(lastTimed?.durationMs), "last run")}${stat(duration(rt.lastRun?.previousMedianMs), "median before")}${stat(lastTimed?.callsPerLesson === undefined ? "—" : lastTimed.callsPerLesson.toFixed(1), "model calls per lesson")}${stat(
        timedRuns.reduce((n, run) => n + (run.failedCalls ?? 0), 0),
        "failed model calls",
      )}</div>`
    : empty("No run timing recorded yet.");
  const sy = rt.sync;
  const syncCard = sy
    ? `<div class="stats" style="--cols: 3">${stat(sy.runs, "syncs")}${stat(sy.failures, "failed")}${stat(ms(sy.latency?.median), "median")}</div>`
    : empty("No syncs recorded yet.");
  const card = (id: string, title: string, tip: string, body: string) =>
    `<section class="card span-6" id="${id}" aria-labelledby="${id}-h"><h3 id="${id}-h">${esc(title)}${info(tip)}</h3>${body}</section>`;
  const runtimeCards = [
    ...(shared
      ? []
      : [
          card(
            "session-start",
            "Session start",
            `The hook's wall time inside the CLI on this machine over the last ${w.days} days, and what it injected: tokens, characters, and the share of rules given in full rather than rule-only.`,
            sessionCard,
          ),
          card(
            "mcp",
            "MCP",
            `Calls per tool on this machine over the last ${w.days} days; the tooltip has failures and the median time.`,
            mcpCard,
          ),
        ]),
    card(
      "daily-run",
      "Daily run",
      `Each run's wall time and model calls, as the run recorded them on the state branch (runs before 0.2.2 recorded none).`,
      runCard,
    ),
    ...(shared
      ? []
      : [
          card(
            "sync",
            "Sync",
            `Background syncs on this machine over the last ${w.days} days: how many, how many failed, and the median time.`,
            syncCard,
          ),
        ]),
  ];

  // 6. Review latency: what was settled, and what still waits, oldest first.
  const openTable = l.open.length
    ? `<div class="table-wrap"><table><thead><tr><th>Lesson</th><th>Developer</th><th class="num">Confidence</th><th class="num">Waiting</th><th>PR branch</th></tr></thead><tbody>${l.open
        .map(
          (o) =>
            `<tr><td class="mono">${esc(o.id)}</td><td class="mono">${esc(o.member)}</td><td class="num">${o.confidence ?? "—"}</td><td class="num">${o.overdue ? '<span class="chip disputed">' : ""}${age(o.hoursOpen)}${o.overdue ? "</span>" : ""}</td><td class="mono">${esc(o.pr ?? "—")}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : empty("Nothing waiting for review.");

  return `<div class="grid">
<section class="panel span-12" aria-labelledby="kpis"><h2 id="kpis">Performance${info(`Computed when the page loads, from the clone's copy of the state branch${shared ? "" : " and this machine's event log"}: the last ${w.days} days and ${w.runs} daily runs (${w.runsOnRecord} on record).`)}</h2>
<div class="kpis" style="--cols: ${kpis.length}">${kpis.join("")}</div></section>
<section class="panel span-6" aria-labelledby="calibration"><h2 id="calibration">Calibration${info(`Every decision with a confidence in the last ${w.days} days, in ten-point bands: merged by the run, sent to review and then merged or declined by a reviewer, or declined by the run. The dashed lines are the configured thresholds. The sentence covers the band just under the accept line.`)}</h2>${calibration}</section>
<section class="panel span-6" aria-labelledby="runs"><h2 id="runs">Decisions and health${info(`Lessons decided per run, split by outcome, with the KB's health after each run as lines (accepted, stale, flagged, disputed, possible duplicates) where the run recorded it. The <a href="/automation">Automation page</a> shows the same decisions per day.`)}</h2>${runsPanel}</section>
<section class="panel span-12" aria-labelledby="reach"><h2 id="reach">Reach${info(`Whether rules get to sessions${shared ? "" : ": this machine's sessions per day, the share of reachable rules served, the share of session starts that left rules out for lack of budget (they are counted for the agent to look up), and the share of documents covering the session that an agent opened"}. Team figures come only from members who share usage counts.`)}</h2>${localPanel}${teamPanel}</section>
<section class="panel span-12" aria-labelledby="use"><h2 id="use">Use${info(`Whether agents look the knowledge up and use it, per user turn${shared ? ", from members who share usage counts" : ` on this machine over the last ${w.days} days (${us.turns} turns; previous window ${us.previous.turns})`}. A turn looked things up when it called context, search, explain, docs or read; it credited when the reply carried a "&gt; From Homeostat (…)" line. The Stop hook reads the session transcript for this and keeps only tool names and credited ids.`)}</h2>${usePanel}</section>
<section class="panel span-12" aria-labelledby="runtime"><h2 id="runtime">Runtime${info(shared ? "What the daily run costs, as it recorded it on the state branch." : "What each step costs. The hook, MCP and sync figures come from this machine's event log; the daily run's from the state branch.")}</h2><div class="grid">${runtimeCards.join("")}</div></section>
<section class="panel span-12" aria-labelledby="latency"><h2 id="latency">Review latency${info(`Reviews settled in the last ${w.days} days: ${l.settled}, median ${age(l.medianHours)}, 90th percentile ${age(l.p90Hours)}${l.unmeasured ? `; ${l.unmeasured} settled before times were recorded` : ""}. Below, what still waits, oldest first; over ${2} days is marked. The <a href="/automation#queue">Automation page</a> has the same queue with reasons.`)}</h2>
<div class="stats" style="--cols: 3">${stat(l.settled, "settled")}${stat(age(l.medianHours), "median wait")}${stat(age(l.p90Hours), "p90 wait")}</div>${openTable}</section>
</div>`;
}
