import {
  type AgentName,
  CORE_AREA,
  type Config,
  detectConflicts,
  type Entry,
  type Event,
  nextRun,
  STATUSES,
  type Status,
} from "@homeostat/core";

const DAY = 86_400_000;
const day = (d: Date) => d.toISOString().slice(0, 10);
const daysSince = (iso: string, now: Date) => Math.floor((now.getTime() - Date.parse(iso)) / DAY);

export interface Snapshot {
  config: Config;
  entries: readonly Entry[];
  events: readonly Event[];
  now: Date;
}

// --- Agent liveness -------------------------------------------------------------------------

export interface AgentLiveness {
  agent: AgentName;
  enabled: boolean;
  schedule: string;
  nextRun?: string;
  lastRun?: { ts: string; ok: boolean; summary: string };
  lastSuccess?: string;
  failures7d: number;
}

export function agentLiveness({ config, events, now }: Snapshot): AgentLiveness[] {
  const week = new Date(now.getTime() - 7 * DAY).toISOString();
  return (["curator", "deepDive"] as const).map((agent) => {
    const runs = events.filter((e) => e.type === "agent-run" && e.agent === agent);
    const last = runs.at(-1);
    const success = runs.filter((r) => r.ok === true).at(-1);
    const next = config.agents[agent].enabled
      ? nextRun(config.agents[agent].schedule, now)
      : undefined;
    return {
      agent,
      enabled: config.agents[agent].enabled,
      schedule: config.agents[agent].schedule,
      ...(next ? { nextRun: next.toISOString() } : {}),
      ...(last
        ? { lastRun: { ts: last.ts, ok: last.ok === true, summary: String(last.summary ?? "") } }
        : {}),
      ...(success ? { lastSuccess: success.ts } : {}),
      failures7d: runs.filter((r) => r.ok === false && r.ts >= week).length,
    };
  });
}

// --- Knowledge-base health ------------------------------------------------------------------

export interface Health {
  total: number;
  byStatus: Record<Status, number>;
  /** Days since last confirmed, averaged over accepted entries. */
  averageAgeDays: number;
  stale: string[];
  disputed: string[];
  flagged: string[];
  possibleDuplicates: [string, string][];
  /** Share of all entries that are accepted, not stale and not flagged: the dial on the overview. */
  stability: number;
}

export function health({ config, entries, now }: Snapshot): Health {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const e of entries) byStatus[e.frontmatter.status]++;
  const accepted = entries.filter((e) => e.frontmatter.status === "accepted");
  const staleAfter = config.agents.deepDive.staleAfterDays;
  const stale = accepted.filter((e) => daysSince(e.frontmatter.lastConfirmed, now) > staleAfter);
  const flagged = entries.filter((e) => e.frontmatter.flags?.length);
  const healthy = accepted.filter((e) => !stale.includes(e) && !e.frontmatter.flags?.length);
  return {
    total: entries.length,
    byStatus,
    averageAgeDays: accepted.length
      ? Math.round(
          accepted.reduce((n, e) => n + daysSince(e.frontmatter.lastConfirmed, now), 0) /
            accepted.length,
        )
      : 0,
    stale: stale.map((e) => e.frontmatter.id),
    disputed: entries
      .filter((e) => e.frontmatter.status === "disputed")
      .map((e) => e.frontmatter.id),
    flagged: flagged.map((e) => e.frontmatter.id),
    possibleDuplicates: detectConflicts(entries.map((e) => e.frontmatter))
      .filter((c) => c.kind === "possible-duplicate")
      .map((c) => [c.ids[0] ?? "", c.ids[1] ?? ""]),
    stability: entries.length ? healthy.length / entries.length : 0,
  };
}

// --- Contributions (shown alphabetically; no ranking, by design) ----------------------------

export interface Contribution {
  member: string;
  role: string;
  authored: number;
  accepted: number;
  /** Accepted share of what they authored; undefined with nothing authored. */
  acceptedRatio?: number;
  flagsRaised: number;
  captured30d: number;
}

export function contributions({ config, entries, events, now }: Snapshot): Contribution[] {
  const month = new Date(now.getTime() - 30 * DAY).toISOString();
  return [...config.team.members]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const authored = entries.filter((e) => e.frontmatter.source.author === m.id);
      const accepted = authored.filter((e) => e.frontmatter.status === "accepted").length;
      return {
        member: m.id,
        role: m.role,
        authored: authored.length,
        accepted,
        ...(authored.length ? { acceptedRatio: accepted / authored.length } : {}),
        flagsRaised: entries.reduce(
          (n, e) => n + (e.frontmatter.flags ?? []).filter((f) => f.by === m.id).length,
          0,
        ),
        captured30d: events.filter(
          (e) => e.type === "entry-created" && e.author === m.id && e.ts >= month,
        ).length,
      };
    });
}

// --- Coverage (repo view) -------------------------------------------------------------------

export interface AreaCoverage {
  area: string;
  globs: readonly string[];
  accepted: number;
  candidates: number;
}

export interface SourceCoverage {
  repo: string;
  /** Entries whose source review comment came from this repo. */
  entries: number;
}

export function coverage({ config, entries }: Snapshot): {
  areas: AreaCoverage[];
  sources: SourceCoverage[];
} {
  const areas = [CORE_AREA, ...Object.keys(config.areas)].map((area) => {
    const inArea = entries.filter((e) => e.frontmatter.area === area);
    return {
      area,
      globs: area === CORE_AREA ? ["**"] : (config.areas[area] ?? []),
      accepted: inArea.filter((e) => e.frontmatter.status === "accepted").length,
      candidates: inArea.filter((e) => e.frontmatter.status === "candidate").length,
    };
  });
  const sources = (config.sources?.repos ?? []).map((repo) => ({
    repo,
    entries: entries.filter((e) =>
      e.frontmatter.source.url?.toLowerCase().includes(`/${repo.toLowerCase()}/`),
    ).length,
  }));
  return { areas, sources };
}

// --- Impact ---------------------------------------------------------------------------------

export interface DailyCount {
  day: string;
  count: number;
}

export interface Impact {
  injectionsByDay: DailyCount[];
  mcpCallsByDay: DailyCount[];
  sessions: number;
  rulesPerInjection: number;
  tokensPerInjection: number;
  topRules: { id: string; injections: number }[];
  toolUse: { tool: string; calls: number }[];
}

function byDay(events: readonly Event[], type: string, now: Date, days: number): DailyCount[] {
  const out: DailyCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = day(new Date(now.getTime() - i * DAY));
    out.push({
      day: d,
      count: events.filter((e) => e.type === type && e.ts.slice(0, 10) === d).length,
    });
  }
  return out;
}

export function impact({ events, now }: Snapshot, days = 14): Impact {
  const injections = events.filter((e) => e.type === "injection");
  const ids = injections.flatMap((e) =>
    ((e.entries as { id: string }[] | undefined) ?? []).map((x) => x.id),
  );
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const tools = new Map<string, number>();
  for (const e of events.filter((x) => x.type === "mcp-call"))
    tools.set(String(e.tool), (tools.get(String(e.tool)) ?? 0) + 1);
  return {
    injectionsByDay: byDay(events, "injection", now, days),
    mcpCallsByDay: byDay(events, "mcp-call", now, days),
    sessions: new Set(injections.map((e) => e.session).filter(Boolean)).size,
    rulesPerInjection: injections.length
      ? Math.round((ids.length / injections.length) * 10) / 10
      : 0,
    tokensPerInjection: injections.length
      ? Math.round(injections.reduce((n, e) => n + (Number(e.tokens) || 0), 0) / injections.length)
      : 0,
    topRules: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([id, n]) => ({ id, injections: n })),
    toolUse: [...tools].sort((a, b) => b[1] - a[1]).map(([tool, calls]) => ({ tool, calls })),
  };
}

// --- Desire paths ---------------------------------------------------------------------------

export interface DesirePath {
  name: string;
  /** The real tool it resolved to, or undefined when nothing did. */
  resolved?: string;
  count: number;
  last: string;
}

/** Tool names agents guessed: the ones to consider implementing (execution plan 3.2). */
export function desirePaths({ events }: Snapshot): DesirePath[] {
  const paths = new Map<string, DesirePath>();
  for (const e of events) {
    if (e.type !== "mcp-alias" && e.type !== "mcp-unknown-tool") continue;
    const name = String(e.name);
    const p = paths.get(name) ?? {
      name,
      count: 0,
      last: e.ts,
      ...(e.resolved ? { resolved: String(e.resolved) } : {}),
    };
    p.count++;
    p.last = e.ts > p.last ? e.ts : p.last;
    paths.set(name, p);
  }
  return [...paths.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
