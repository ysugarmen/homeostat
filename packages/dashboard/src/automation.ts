import { execFileSync } from "node:child_process";
import {
  type Config,
  type DecisionRecord,
  type DecisionsFile,
  HEARTBEAT_PATH,
  type Heartbeat,
  REVIEW_REMINDER_DAYS,
  type RunReport,
  STALE_HEARTBEAT_HOURS,
  STATE_BRANCH,
} from "@homeostat/core";
import { columns, type Datum, dataTable, esc, info } from "./charts.ts";

/**
 * The Automation page reads the `homeostat/state` branch the daily run writes. It reads the
 * clone's copy (`origin/homeostat/state`), which every sync fetches, so the page makes no network
 * call: it is as current as this clone's last sync.
 */
export interface AutomationState {
  /** False when no daily run has written the state branch yet (or this clone never fetched it). */
  present: boolean;
  runs: RunReport[];
  heartbeats: Heartbeat[];
  decisions: DecisionsFile[];
}

const REF = `refs/remotes/origin/${STATE_BRANCH}`;
const CANDIDATES = "refs/remotes/origin/candidates/";

function git(dir: string, ...args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function json<T>(dir: string, path: string): T | undefined {
  try {
    return JSON.parse(git(dir, "show", `${REF}:${path}`) ?? "") as T;
  } catch {
    return undefined;
  }
}

export function readAutomation(kbRoot: string, maxRuns = 30): AutomationState {
  const listing = git(kbRoot, "ls-tree", "-r", "--name-only", REF);
  if (listing === undefined) return { present: false, runs: [], heartbeats: [], decisions: [] };
  const paths = listing.split("\n").filter(Boolean);
  const under = (dir: string) =>
    paths.filter((p) => p.startsWith(`${dir}/`) && p.endsWith(".json"));
  const runs = under("runs")
    .sort()
    .slice(-maxRuns)
    .flatMap((p) => json<RunReport>(kbRoot, p) ?? []);
  // The daily run's copy of each heartbeat is as old as the run; each developer's candidates
  // branch has the latest one their sync pushed (sync fetches them all). Keep the newer.
  const latest = new Map<string, Heartbeat>();
  const fresher = (h: Heartbeat | undefined) => {
    if (!h?.member) return;
    const known = latest.get(h.member);
    if (!known || h.at > known.at) latest.set(h.member, h);
  };
  for (const p of under("heartbeats")) fresher(json<Heartbeat>(kbRoot, p));
  const branches = git(kbRoot, "for-each-ref", "--format=%(refname)", CANDIDATES) ?? "";
  for (const ref of branches.split("\n").filter(Boolean)) {
    try {
      fresher(JSON.parse(git(kbRoot, "show", `${ref}:${HEARTBEAT_PATH}`) ?? "") as Heartbeat);
    } catch {
      // A candidates branch without a heartbeat: skip it.
    }
  }
  const heartbeats = [...latest.values()];
  const decisions = under("decisions").flatMap((p) => json<DecisionsFile>(kbRoot, p) ?? []);
  return { present: true, runs, heartbeats, decisions };
}

export interface SyncHealth {
  member: string;
  role: string;
  heartbeat?: Heartbeat;
  /** "ok", "stale" (no report for STALE_HEARTBEAT_HOURS), "never" (no sync has reported) */
  state: "ok" | "stale" | "never";
  ageHours?: number;
  today?: RunReport["members"][number];
}

export interface QueueItem extends DecisionRecord {
  member: string;
  ageDays: number;
  overdue: boolean;
}

export interface AutomationView {
  present: boolean;
  lastRun?: RunReport;
  runs: RunReport[];
  health: SyncHealth[];
  queue: QueueItem[];
  /** Lessons decided per day, by outcome, over the runs on record. */
  byDay: { day: string; merged: number; review: number; declined: number }[];
}

export function automationView(state: AutomationState, config: Config, now: Date): AutomationView {
  const lastRun = state.runs.at(-1);
  const health: SyncHealth[] = config.team.members.map((m) => {
    const heartbeat = state.heartbeats.find((h) => h.member === m.id);
    const ageHours = heartbeat ? (now.getTime() - Date.parse(heartbeat.at)) / 3_600_000 : undefined;
    // The latest run that had lessons from this developer, not just the latest run.
    const today = [...state.runs]
      .reverse()
      .map((r) => r.members.find((x) => x.member === m.id))
      .find((x) => x !== undefined);
    return {
      member: m.id,
      role: m.role,
      ...(heartbeat ? { heartbeat } : {}),
      ...(ageHours !== undefined ? { ageHours } : {}),
      ...(today ? { today } : {}),
      state: !heartbeat ? "never" : (ageHours ?? 0) > STALE_HEARTBEAT_HOURS ? "stale" : "ok",
    };
  });
  const queue = state.decisions
    .flatMap((d) =>
      d.decided
        .filter((r) => r.decision === "review")
        .map((r) => {
          const ageDays = (now.getTime() - Date.parse(r.at)) / 86_400_000;
          return { ...r, member: d.member, ageDays, overdue: ageDays > REVIEW_REMINDER_DAYS };
        }),
    )
    .sort((a, b) => b.ageDays - a.ageDays);
  // A day can have several runs (the schedule, a manual run): one bar per day.
  const days = new Map<string, { day: string; merged: number; review: number; declined: number }>();
  for (const r of state.runs) {
    const day = r.at.slice(0, 10);
    const d = days.get(day) ?? { day, merged: 0, review: 0, declined: 0 };
    for (const m of r.members) {
      d.merged += m.merged;
      d.review += m.review;
      d.declined += m.declined;
    }
    days.set(day, d);
  }
  const byDay = [...days.values()];
  return {
    present: state.present,
    ...(lastRun ? { lastRun } : {}),
    runs: state.runs,
    health,
    queue,
    byDay,
  };
}

const age = (hours?: number) =>
  hours === undefined
    ? "—"
    : hours < 1
      ? "under 1h"
      : hours < 48
        ? `${Math.round(hours)}h`
        : `${Math.round(hours / 24)}d`;

const prLink = (url?: string, label = "PR") =>
  url && /^https:\/\//.test(url) ? `<a href="${esc(url)}">${esc(label)}</a>` : "";

function healthRow(h: SyncHealth): string {
  const lamp = h.state === "ok" ? "good" : h.state === "stale" ? "warning" : "";
  const state =
    h.state === "ok"
      ? "Syncing"
      : h.state === "stale"
        ? `Not syncing for ${age(h.ageHours)}`
        : "No sync yet";
  const hb = h.heartbeat;
  const kb = !hb ? "—" : hb.behind > 0 ? `${hb.behind} behind` : "current";
  const t = h.today;
  const outcome = t
    ? `${t.merged} merged, ${t.review} to review, ${t.declined} declined${t.mergeError ? ", merge refused" : ""}`
    : "—";
  return `<tr><td class="mono">${esc(h.member)}</td><td>${esc(h.role)}</td><td><span class="lamp ${lamp}" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>${esc(state)}</td><td class="num">${age(h.ageHours)}</td><td class="mono">${esc(kb)}</td><td class="num">${hb?.pending ?? "—"}</td><td class="mono">${esc(hb?.version ?? "—")}</td><td>${esc(outcome)} ${prLink(t?.dailyPr, "daily")} ${prLink(t?.reviewPr, "review")}</td></tr>`;
}

export function automationPage(v: AutomationView): string {
  if (!v.present) {
    return `<section class="panel"><h2>Automation${info(`No daily run on record in this clone yet. The daily run (<code>homeostat daily</code>, scheduled in the KB repo's CI) writes its decisions to the <code>${STATE_BRANCH}</code> branch, and each developer's sync fetches it. Once the first run has happened and this clone has synced, its runs, every developer's sync health and the review queue show up here.`)}</h2><p class="empty">No daily run yet.</p></section>`;
  }
  const r = v.lastRun;
  const stat = (n: number | string, k: string) =>
    `<div class="stat"><span class="n">${n}</span><span class="k">${k}</span></div>`;
  const total = (k: "merged" | "review" | "declined") =>
    r?.members.reduce((n, m) => n + m[k], 0) ?? 0;
  const notSyncing = v.health.filter((h) => h.state !== "ok");
  const overdue = v.queue.filter((q) => q.overdue).length;
  const daily: Datum[] = v.byDay.map((d) => ({
    label: d.day.slice(5),
    value: d.merged + d.review + d.declined,
    title: `${d.day}: ${d.merged} merged, ${d.review} to review, ${d.declined} declined`,
  }));
  return `<div class="grid">
<section class="panel span-8" aria-labelledby="last"><h2 id="last">Last daily run</h2>
${r ? `<p class="lede">${esc(r.at.replace("T", " ").slice(0, 16))} UTC</p>` : ""}
<div class="stats" style="--cols: 4">${stat(total("merged"), "merged")}${stat(total("review"), "to review")}${stat(total("declined"), "declined")}${stat(r?.settled ?? 0, "settled by reviewers")}</div>
${daily.length > 1 ? `<div style="margin-top:14px"><span class="label">Lessons decided per day</span>${columns(daily, { title: "Lessons decided per day", labelled: "ends", tickEvery: 7 })}${dataTable(daily, ["Day", "Lessons"])}</div>` : ""}
${r?.skipped?.length ? `<details style="margin-top:12px"><summary>${r.skipped.length} review thread${r.skipped.length === 1 ? "" : "s"} read with no lesson</summary><ul>${r.skipped.map((s) => `<li>${prLink(s.url, s.url.replace(/^https:\/\/[^/]+\//, ""))}: ${esc(s.reason)}</li>`).join("")}</ul></details>` : ""}</section>
<section class="panel span-4" aria-labelledby="attention"><h2 id="attention">Needs attention</h2>
<div class="stats" style="--cols: 2">${stat(v.queue.length, "in review")}${stat(overdue, `waiting &gt; ${REVIEW_REMINDER_DAYS} days`)}${stat(notSyncing.length, "not syncing")}${stat(r?.members.filter((m) => m.mergeError).length ?? 0, "merges refused")}</div>
${notSyncing.length ? `<p>Not syncing: ${notSyncing.map((h) => `<span class="mono">${esc(h.member)}</span>`).join(", ")}${info("Their lessons reach the daily run only after one of their sessions syncs. Check that the Homeostat plugin is installed for them.")}</p>` : ""}</section>
<section class="panel span-12" aria-labelledby="queue"><h2 id="queue">Review queue${info(`Lessons the daily run could not decide on its own. Merging the review PR accepts them; closing it declines them. The next daily run records the outcome, and the developer's sync picks it up.`)}</h2>
${
  v.queue.length
    ? `<div class="table-wrap"><table><thead><tr><th>Lesson</th><th>Developer</th><th class="num">Confidence</th><th>Why it waits</th><th class="num">Waiting</th><th>PR branch</th></tr></thead><tbody>${v.queue
        .map(
          (q) =>
            `<tr><td class="mono">${esc(q.id)}</td><td class="mono">${esc(q.member)}</td><td class="num">${q.confidence ?? "—"}</td><td>${esc(q.reason)}</td><td class="num">${q.overdue ? '<span class="chip disputed">' : ""}${Math.floor(q.ageDays)}d${q.overdue ? "</span>" : ""}</td><td class="mono">${esc(q.pr ?? "—")}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : '<p class="empty">Nothing waiting for a reviewer.</p>'
}</section>
<section class="panel span-12" aria-labelledby="health"><h2 id="health">Developer sync${info(`Each developer's sessions sync their clone in the background and report a heartbeat; the daily run collects them. "Not syncing" means no report for ${STALE_HEARTBEAT_HOURS} hours: normal over a weekend, worth a look after that.`)}</h2>
<div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Sync</th><th class="num">Last report</th><th>KB clone</th><th class="num">Pending</th><th>Version</th><th>Last run with lessons</th></tr></thead><tbody>${v.health.map(healthRow).join("")}</tbody></table></div></section>
<section class="panel span-12" aria-labelledby="runs"><h2 id="runs">Runs</h2>
<div class="table-wrap"><table><thead><tr><th>Run</th><th class="num">Merged</th><th class="num">To review</th><th class="num">Declined</th><th class="num">Settled</th><th>Merge refused</th></tr></thead><tbody>${[
    ...v.runs,
  ]
    .reverse()
    .map((run) => {
      const sum = (k: "merged" | "review" | "declined") =>
        run.members.reduce((n, m) => n + m[k], 0);
      const refused = run.members.filter((m) => m.mergeError).map((m) => m.member);
      return `<tr><td class="mono">${esc(run.at.replace("T", " ").slice(0, 16))}</td><td class="num">${sum("merged")}</td><td class="num">${sum("review")}</td><td class="num">${sum("declined")}</td><td class="num">${run.settled}</td><td class="mono">${esc(refused.join(", ") || "—")}</td></tr>`;
    })
    .join("")}</tbody></table></div></section>
</div>`;
}

/** One lamp on the console: what state the team's knowledge loop is in, at a glance. */
export interface Lamp {
  key: "daily" | "queue" | "sync" | "kb";
  label: string;
  state: "good" | "warning" | "critical" | "off";
  value: string;
  /** A few words under the reading. */
  detail: string;
  /** What this unit measures and what to do about it: the (i) text. */
  about: string;
  href: string;
}

const hhmm = (iso?: string) => (iso ? iso.slice(11, 16) : "—");

/**
 * The four lamps every page shows: the daily run, the review queue, developer sync and the
 * knowledge base. `nextRun` comes from the schedule; everything else from the state branch.
 */
export function lamps(
  v: AutomationView,
  kb: { stability: number; accepted: number; flagged: number; disputed: number },
  now: Date,
  nextRun?: string,
): Lamp[] {
  const last = v.lastRun;
  const ageH = last ? (now.getTime() - Date.parse(last.at)) / 3_600_000 : undefined;
  const refused = last?.members.some((m) => m.mergeError || m.reviewError);
  const when = (iso: string) => {
    const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
    return `${days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`} at ${hhmm(iso)}`;
  };
  const next = nextRun ? `, next ${hhmm(nextRun)}` : "";
  const daily: Lamp = {
    key: "daily",
    label: "Daily run",
    href: "/automation",
    about:
      "The scheduled job in the KB repo's CI. Each morning it scores every developer's new lessons and merges, declines or sends them to a reviewer.",
    ...(!last
      ? {
          state: "off",
          value: "Not run yet",
          detail: nextRun ? `First at ${hhmm(nextRun)} UTC` : "Not scheduled",
        }
      : (ageH ?? 0) > 30
        ? { state: "critical", value: "Late", detail: `Last ${when(last.at)}` }
        : refused
          ? {
              state: "warning",
              value: "Needs a look",
              detail: "A merge or review request was refused",
            }
          : { state: "good", value: "Steady", detail: `Ran ${hhmm(last.at)}${next}` }),
  };
  const overdue = v.queue.filter((q) => q.overdue).length;
  const oldest = v.queue[0];
  const queue: Lamp = {
    key: "queue",
    label: "Review queue",
    href: "/automation#queue",
    about:
      "Lessons the daily run could not decide on its own. Merging their review PR accepts them; closing it declines them.",
    state: !v.present ? "off" : overdue ? "critical" : v.queue.length ? "warning" : "good",
    value: !v.present ? "Unknown" : v.queue.length ? `${v.queue.length} waiting` : "Clear",
    detail:
      !v.present || !v.queue.length
        ? ""
        : `Oldest ${Math.floor(oldest?.ageDays ?? 0)} days${overdue ? `, ${overdue} overdue` : ""}`,
  };
  const syncing = v.health.filter((h) => h.state === "ok").length;
  const silent = v.health.filter((h) => h.state !== "ok").map((h) => h.member);
  const sync: Lamp = {
    key: "sync",
    label: "Developer sync",
    href: "/automation#health",
    about:
      "Each developer's sessions sync their KB clone in the background and report in. A developer silent for two days isn't sending lessons or getting the team's.",
    state: !v.present
      ? "off"
      : silent.length === 0
        ? "good"
        : syncing === 0
          ? "critical"
          : "warning",
    value: `${syncing} of ${v.health.length}`,
    detail: silent.length ? `${silent.join(", ")} silent` : "",
  };
  const pct = Math.round(kb.stability * 100);
  const issues = kb.flagged + kb.disputed;
  const kbLamp: Lamp = {
    key: "kb",
    label: "Knowledge",
    href: "/entries",
    about:
      "The share of rules an agent can rely on today: accepted, confirmed recently and not flagged.",
    state: kb.accepted === 0 ? "off" : pct >= 80 ? "good" : pct >= 50 ? "warning" : "critical",
    value: kb.accepted === 0 ? "Empty" : `${pct}% sound`,
    detail: `${kb.accepted} ${kb.accepted === 1 ? "rule" : "rules"}${issues ? `, ${issues} flagged` : ""}`,
  };
  return [daily, queue, sync, kbLamp];
}
