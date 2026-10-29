import { resolve } from "node:path";
import {
  DEFAULT_WINDOW,
  type MetricsReport,
  memberFromGit,
  metricsReport,
  readEvents,
  readKbFiles,
  readState,
  validate,
} from "@homeostat/core";
import type { Io } from "./cli.ts";
import { git } from "./git.ts";
import { findKb } from "./hook.ts";

export interface MetricsOptions {
  dir?: string;
  days?: string;
  runs?: string;
  json?: boolean;
}

const DAY = 86_400_000;

const pct = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v * 100)}%`);
const hours = (v: number | undefined) => (v === undefined ? "—" : `${v.toFixed(1)} h`);
const ms = (v: number | undefined) => (v === undefined ? "—" : `${Math.round(v)} ms`);
const duration = (v: number | undefined) => {
  if (v === undefined) return "—";
  const s = Math.round(v / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};
const waiting = (h: number) =>
  h < 1 ? "under 1h" : h < 48 ? `${Math.floor(h)}h` : `${Math.floor(h / 24)}d`;

/** The report as text: seven headings in the Performance page's order, two-space indented lines. */
export function formatMetrics(r: MetricsReport, present: boolean): string {
  const out: string[] = [];
  const h = (title: string) => out.push("", title);
  const line = (label: string, value: string) => out.push(`  ${label.padEnd(22)} ${value}`);
  const noRuns = () => out.push("  no runs yet");
  out.push(
    `Performance, last ${r.window.days} days and ${r.window.runs} runs (${r.window.runsOnRecord} on record)`,
  );

  h("Summary");
  if (present) {
    line("auto-merge share", pct(r.decisions.current.autoMergeShare));
    line("reviewer agreement", pct(r.calibration.reviewerAgreement));
    line(
      "review latency",
      `median ${hours(r.latency.medianHours)}, p90 ${hours(r.latency.p90Hours)}`,
    );
    line("last run", duration(r.runtime.lastRun?.durationMs));
  } else noRuns();
  line("rules served", `${r.reach.distinctRules} of ${r.reach.reachable} reachable`);
  const ss = r.runtime.sessionStart;
  line(
    "session start",
    ss ? `median ${ms(ss.median)}, p90 ${ms(ss.p90)} (${ss.count} starts)` : "—",
  );

  h("Calibration");
  if (!present) noRuns();
  else {
    const c = r.calibration;
    line(
      "lines",
      `decline ${c.lines.decline}, accept ${c.lines.accept}, core ${c.lines.coreAccept}`,
    );
    for (const b of c.bands) {
      const n = b.merged + b.reviewMerged + b.reviewDeclined + b.reviewOpen + b.declined;
      if (!n) continue;
      line(
        `${b.from}-${b.to}`,
        `merged ${b.merged}, reviewed then merged ${b.reviewMerged}, reviewed then declined ${b.reviewDeclined}, open ${b.reviewOpen}, declined ${b.declined}`,
      );
    }
    const u = c.underAccept;
    out.push(
      u.of
        ? `  Lessons sent to review at ${u.from} to ${u.to} were merged by a reviewer ${u.merged} of ${u.of} times.`
        : `  No lesson at ${u.from} to ${u.to} has been settled by a reviewer yet.`,
    );
  }

  h("Decisions and health");
  if (!present) noRuns();
  else {
    const kb = new Map(r.healthTrend.map((p) => [p.at, p]));
    for (const run of r.decisions.perRun) {
      const p = kb.get(run.at);
      line(
        run.at.slice(0, 16).replace("T", " "),
        `merged ${run.merged}, review ${run.review}, declined ${run.declined} (${run.duplicates} duplicates)${
          p
            ? `; accepted ${p.accepted}, stale ${p.stale}, flagged ${p.flagged}, disputed ${p.disputed}, duplicates ${p.possibleDuplicates}`
            : ""
        }`,
      );
    }
    for (const m of r.decisions.byMember)
      line(`  ${m.member}`, `merged ${m.merged}, review ${m.review}, declined ${m.declined}`);
  }

  h("Reach");
  const re = r.reach;
  line("sessions", `${re.sessions} (previous ${re.previous.sessions})`);
  line("rules served", `${re.distinctRules} of ${re.reachable} reachable (${pct(re.servedShare)})`);
  line("index overflow", pct(re.indexOverflowShare));
  line(
    "documents",
    `${re.docs.listed} covering sessions, ${re.docs.read} opened (${pct(re.docs.pullThrough)})`,
  );
  line("team", `${re.team.sharing} of ${re.team.members} members share usage counts`);

  h("Use");
  const u = r.usage;
  line("turns", `${u.turns} (previous ${u.previous.turns})`);
  line(
    "retrieved",
    `${pct(u.retrievedShare)} of turns (previous ${pct(u.previous.retrievedShare)})`,
  );
  line("credited", `${pct(u.creditedShare)} of turns (previous ${pct(u.previous.creditedShare)})`);
  line("credited after lookup", pct(u.creditedAfterRetrieval));
  line("distinct credited", `${u.distinctRules} rules, ${u.distinctDocs} document sections`);
  line(
    "never credited",
    u.turns
      ? `${u.neverCredited.length} rules served but never credited${u.neverCredited.length ? `: ${u.neverCredited.slice(0, 10).join(", ")}${u.neverCredited.length > 10 ? ", …" : ""}` : ""}`
      : "no turns recorded yet",
  );

  h("Runtime");
  const cx = r.runtime.context;
  line(
    "context",
    cx
      ? `median ${cx.tokensMedian} tokens${cx.charsMedian === undefined ? "" : `, ${cx.charsMedian} chars`}, full rules ${pct(cx.fullShare)}`
      : "—",
  );
  for (const t of r.runtime.mcp)
    line(
      `mcp ${t.tool}`,
      `${t.calls} calls, ${t.failures} failed${t.latency ? `, median ${ms(t.latency.median)}` : ""}`,
    );
  if (!present) line("daily run", "no runs yet");
  else
    for (const run of r.runtime.dailyRuns)
      line(
        `run ${run.at.slice(0, 10)}`,
        `${duration(run.durationMs)}, ${run.modelCalls ?? "—"} model calls, ${run.failedCalls ?? "—"} failed, ${run.lessons} lessons${run.callsPerLesson === undefined ? "" : ` (${run.callsPerLesson.toFixed(1)} calls each)`}`,
      );
  const sy = r.runtime.sync;
  line(
    "sync",
    sy
      ? `${sy.runs} runs, ${sy.failures} failed${sy.latency ? `, median ${ms(sy.latency.median)}` : ""}`
      : "—",
  );

  h("Review latency");
  if (!present) noRuns();
  else {
    const l = r.latency;
    line(
      "settled",
      `${l.settled} (median ${hours(l.medianHours)}, p90 ${hours(l.p90Hours)}), ${l.unmeasured} without times`,
    );
    for (const o of l.open)
      line(
        `  ${o.id}`,
        `${o.member}, ${o.confidence ?? "—"}, waiting ${waiting(o.hoursOpen)}${o.overdue ? " (overdue)" : ""}${o.pr ? `, ${o.pr}` : ""}`,
      );
    if (!l.open.length) line("open", "nothing waiting for review");
  }
  return `${out.join("\n")}\n`;
}

/** `homeostat metrics`: the Performance page's figures from the terminal; reads the clone only. */
export function runMetrics(opts: MetricsOptions, io: Io): number {
  const root = opts.dir ? resolve(opts.dir) : findKb(io.env, process.cwd());
  if (!root) {
    io.stderr("no knowledge base here: pass --dir, set HOMEOSTAT_DIR, or run inside the KB repo\n");
    return 1;
  }
  const kb = validate(readKbFiles(root));
  if (!kb.config) {
    io.stderr("homeostat.yaml is missing or invalid; run homeostat validate\n");
    return 1;
  }
  const days = Math.max(1, Number.parseInt(opts.days ?? "", 10) || DEFAULT_WINDOW.days);
  const runs = Math.max(1, Number.parseInt(opts.runs ?? "", 10) || DEFAULT_WINDOW.runs);
  const now = io.now?.() ?? new Date();
  const state = readState(root, 2 * runs, kb.config.sources?.baseBranch);
  const member = memberFromGit(kb.config.team.members, git(root, "config", "user.name"));
  const report = metricsReport({
    config: kb.config,
    entries: kb.entries.map((e) => ({ ...e.entry, path: e.path })),
    events: readEvents(root, { since: new Date(now.getTime() - 2 * days * DAY).toISOString() }),
    runs: state.runs,
    decisions: state.decisions,
    heartbeats: state.heartbeats,
    member,
    now,
    window: { days, runs },
  });
  io.stdout(
    opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatMetrics(report, state.present),
  );
  return 0;
}
