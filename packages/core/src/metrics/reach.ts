import type { UsageDay } from "../automation.ts";
import type { Entry } from "../entry.ts";
import type { Event } from "../events.ts";
import { isRejectedDecision } from "../schema.ts";
import { inRepo, visibleTo } from "../visibility.ts";
import type { DailyCount, MetricsSnapshot } from "./types.ts";
import { byDay, DAY, day, inWindow, ratio, windows } from "./util.ts";

export interface Reach {
  injectionsByDay: DailyCount[];
  /** Distinct sessions that got rules in the window. */
  sessions: number;
  /** Distinct rules injected in the window. */
  distinctRules: number;
  /** Accepted rules a session here could get: shared ones plus every repo seen in the window. */
  reachable: number;
  servedShare?: number;
  /** Session starts that pushed rules to the index for lack of budget, over session starts. */
  indexOverflowShare?: number;
  /** Documents in session indexes, documents an agent opened, and the share opened. */
  docs: { listed: number; read: number; pullThrough?: number };
  /** Members who share usage counts, and their last seven days summed per day. */
  team: { sharing: number; members: number; byDay: ({ day: string } & UsageDay)[] };
  previous: { sessions: number; distinctRules: number };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const ids = (e: Event) => ((e.entries as { id: string }[] | undefined) ?? []).map((x) => x.id);

export function reach(snap: MetricsSnapshot): Reach {
  const w = windows(snap.now, snap.window.days);
  const injections = snap.events.filter((e) => e.type === "injection");
  const current = injections.filter((e) => inWindow(e.ts, w.current));
  const before = injections.filter((e) => inWindow(e.ts, w.previous));
  const sessions = (list: Event[]) => new Set(list.flatMap((e) => str(e.session) ?? [])).size;
  const rules = (list: Event[]) => new Set(list.flatMap(ids)).size;

  // Rules a session on this machine could have been given: shared ones plus those of every repo
  // its sessions were in. Without repo folders every rule applies everywhere.
  const placed = snap.entries.filter((e): e is Entry & { path: string } => e.path !== undefined);
  const repos = [...new Set(current.flatMap((e) => str(e.repo) ?? []))];
  const inForce = (list: readonly (Entry & { path?: string })[]) =>
    list.filter((e) => e.frontmatter.status === "accepted" && !isRejectedDecision(e.frontmatter));
  const scoped = repos.length
    ? [
        ...new Map(
          repos.flatMap((r) => inRepo(placed, snap.config, r)).map((e) => [e.frontmatter.id, e]),
        ).values(),
      ]
    : [...snap.entries];
  const reachable = visibleTo(inForce(scoped), snap.config, snap.member).length;

  const starts = current.filter((e) => e.source === "startup");
  const overflow = starts.filter((e) => ((e.dropped as unknown[] | undefined) ?? []).length > 0);

  // Per document: the index lists documents (`docs`), and an agent opens a document or one of
  // its sections with `read`. The sections a session got in full are not counted as listed.
  const listed = new Set(
    snap.events
      .filter((e) => e.type === "doc-injection" && inWindow(e.ts, w.current))
      .flatMap((e) => ((e.docs as unknown[] | undefined) ?? []).flatMap((d) => str(d) ?? [])),
  );
  const read = new Set(
    snap.events
      .filter((e) => e.type === "doc-read" && inWindow(e.ts, w.current))
      .flatMap((e) => str(e.doc) ?? []),
  );

  const sharing = snap.heartbeats.filter((h) => h.usage);
  const teamByDay: ({ day: string } & UsageDay)[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = day(new Date(snap.now.getTime() - i * DAY));
    const sum: UsageDay = {
      sessions: 0,
      injections: 0,
      rules: 0,
      mcpCalls: 0,
      docReads: 0,
      turns: 0,
      retrievedTurns: 0,
      creditedTurns: 0,
    };
    for (const h of sharing) {
      const u = h.usage?.[d];
      if (!u) continue;
      sum.sessions += u.sessions;
      sum.injections += u.injections;
      sum.rules += u.rules;
      sum.mcpCalls += u.mcpCalls;
      sum.docReads += u.docReads;
      sum.turns = (sum.turns ?? 0) + (u.turns ?? 0);
      sum.retrievedTurns = (sum.retrievedTurns ?? 0) + (u.retrievedTurns ?? 0);
      sum.creditedTurns = (sum.creditedTurns ?? 0) + (u.creditedTurns ?? 0);
    }
    teamByDay.push({ day: d, ...sum });
  }

  const served = ratio(rules(current), reachable);
  const overflowShare = ratio(overflow.length, starts.length);
  const pull = ratio(read.size, listed.size);
  return {
    injectionsByDay: byDay(current, snap.now, snap.window.days),
    sessions: sessions(current),
    distinctRules: rules(current),
    reachable,
    ...(served === undefined ? {} : { servedShare: served }),
    ...(overflowShare === undefined ? {} : { indexOverflowShare: overflowShare }),
    docs: {
      listed: listed.size,
      read: read.size,
      ...(pull === undefined ? {} : { pullThrough: pull }),
    },
    team: { sharing: sharing.length, members: snap.config.team.members.length, byDay: teamByDay },
    previous: { sessions: sessions(before), distinctRules: rules(before) },
  };
}
