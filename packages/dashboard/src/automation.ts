import { execFileSync } from "node:child_process";
import {
  type Config,
  type DecisionRecord,
  type DecisionsFile,
  type Heartbeat,
  REVIEW_REMINDER_DAYS,
  type RunReport,
  STALE_HEARTBEAT_HOURS,
  STATE_BRANCH,
} from "@homeostat/core";
import { columns, type Datum, dataTable, esc } from "./charts.ts";

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
  const heartbeats = under("heartbeats").flatMap((p) => json<Heartbeat>(kbRoot, p) ?? []);
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
    const today = lastRun?.members.find((r) => r.member === m.id);
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
  const byDay = state.runs.map((r) => ({
    day: r.at.slice(0, 10),
    merged: r.members.reduce((n, m) => n + m.merged, 0),
    review: r.members.reduce((n, m) => n + m.review, 0),
    declined: r.members.reduce((n, m) => n + m.declined, 0),
  }));
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
    ? `${t.merged} merged · ${t.review} to review · ${t.declined} declined${t.mergeError ? " · merge refused" : ""}`
    : "—";
  return `<tr><td class="mono">${esc(h.member)}</td><td>${esc(h.role)}</td><td><span class="lamp ${lamp}" aria-hidden="true" style="display:inline-block;vertical-align:middle;margin-right:6px"></span>${esc(state)}</td><td class="num">${age(h.ageHours)}</td><td class="mono">${esc(kb)}</td><td class="num">${hb?.pending ?? "—"}</td><td class="mono">${esc(hb?.version ?? "—")}</td><td>${esc(outcome)} ${prLink(t?.dailyPr, "daily")} ${prLink(t?.reviewPr, "review")}</td></tr>`;
}

export function automationPage(v: AutomationView): string {
  if (!v.present) {
    return `<section class="panel"><h2>Automation</h2><p class="lede">No daily run on record in this clone yet. The daily run (<code>homeostat daily</code>, scheduled in the KB repo's CI) writes its decisions to the <code>${STATE_BRANCH}</code> branch, and each developer's sync fetches it. Once the first run has happened and this clone has synced, its runs, every developer's sync health and the review queue show up here.</p></section>`;
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
${r ? `<p class="lede mono">${esc(r.at.replace("T", " ").slice(0, 16))} UTC</p>` : ""}
<div class="stats" style="--cols: 4">${stat(total("merged"), "merged")}${stat(total("review"), "to review")}${stat(total("declined"), "declined")}${stat(r?.settled ?? 0, "settled by reviewers")}</div>
${daily.length > 1 ? `<div style="margin-top:14px"><span class="label">Lessons decided per run</span>${columns(daily, { title: "Lessons decided per run", labelled: "ends", tickEvery: 7 })}${dataTable(daily, ["Run", "Lessons"])}</div>` : ""}
${r?.skipped?.length ? `<details style="margin-top:12px"><summary>${r.skipped.length} review thread${r.skipped.length === 1 ? "" : "s"} read with no lesson</summary><ul>${r.skipped.map((s) => `<li>${prLink(s.url, s.url.replace(/^https:\/\/[^/]+\//, ""))}: ${esc(s.reason)}</li>`).join("")}</ul></details>` : ""}</section>
<section class="panel span-4" aria-labelledby="attention"><h2 id="attention">Needs attention</h2>
<div class="stats" style="--cols: 2">${stat(v.queue.length, "in review")}${stat(overdue, `waiting &gt; ${REVIEW_REMINDER_DAYS} days`)}${stat(notSyncing.length, "not syncing")}${stat(r?.members.filter((m) => m.mergeError).length ?? 0, "merges refused")}</div>
${notSyncing.length ? `<p class="lede">Not syncing: ${notSyncing.map((h) => `<span class="mono">${esc(h.member)}</span>`).join(", ")}. Their lessons reach the daily run only after a session syncs; check that the Homeostat plugin is installed for them.</p>` : ""}</section>
<section class="panel span-12" aria-labelledby="queue"><h2 id="queue">Review queue</h2><p class="lede">Lessons the daily run could not decide on its own. Merging the review PR accepts them; closing it declines them. The next daily run records the outcome, and the developer's sync picks it up.</p>
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
<section class="panel span-12" aria-labelledby="health"><h2 id="health">Developer sync</h2><p class="lede">Each developer's sessions sync their clone in the background and report a heartbeat; the daily run collects them. "Not syncing" means no report for ${STALE_HEARTBEAT_HOURS} hours: normal over a weekend, worth a look after that.</p>
<div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Sync</th><th class="num">Last report</th><th>KB clone</th><th class="num">Pending</th><th>Version</th><th>Last daily run</th></tr></thead><tbody>${v.health.map(healthRow).join("")}</tbody></table></div></section>
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
