import type { Config } from "../config.ts";
import { detectConflicts } from "../conflicts.ts";
import type { Entry } from "../entry.ts";
import type { MetricsSnapshot } from "./types.ts";
import { DAY } from "./util.ts";

/** The KB's health in five counts, as the daily run records it after its merges. */
export interface KbSnapshot {
  accepted: number;
  /** Accepted rules unconfirmed for longer than `agents.deepDive.staleAfterDays`. */
  stale: number;
  flagged: number;
  disputed: number;
  possibleDuplicates: number;
}

export type HealthPoint = { at: string } & KbSnapshot;

export function kbSnapshot(entries: readonly Entry[], config: Config, now: Date): KbSnapshot {
  const fm = entries.map((e) => e.frontmatter);
  const accepted = fm.filter((f) => f.status === "accepted");
  const staleAfter = config.agents.deepDive.staleAfterDays;
  return {
    accepted: accepted.length,
    stale: accepted.filter(
      (f) => Math.floor((now.getTime() - Date.parse(f.lastConfirmed)) / DAY) > staleAfter,
    ).length,
    flagged: fm.filter((f) => f.flags?.length).length,
    disputed: fm.filter((f) => f.status === "disputed").length,
    possibleDuplicates: detectConflicts(fm).filter((c) => c.kind === "possible-duplicate").length,
  };
}

/** One point per run in the window that recorded a snapshot; runs before 0.2.2 have none. */
export function healthTrend(snap: MetricsSnapshot): HealthPoint[] {
  return snap.runs.slice(-snap.window.runs).flatMap((r) => (r.kb ? [{ at: r.at, ...r.kb }] : []));
}
