import type { DecisionsFile, Heartbeat, RunReport } from "../automation.ts";
import type { Config } from "../config.ts";
import type { Entry } from "../entry.ts";
import type { Event } from "../events.ts";

/**
 * Everything the metrics are computed from, read at one moment. Nothing here touches the network:
 * the runs, decisions and heartbeats come from the clone's copy of `homeostat/state`, the events
 * from the machine's own log.
 */
export interface MetricsSnapshot {
  config: Config;
  entries: readonly (Entry & { path?: string })[];
  /** Local events covering at least twice the window, so trends have a previous window. */
  events: readonly Event[];
  /** Run reports, oldest first, covering twice `window.runs` when the KB has that many. */
  runs: readonly RunReport[];
  decisions: readonly DecisionsFile[];
  heartbeats: readonly Heartbeat[];
  /** The member whose clone this is, for team-only visibility; unknown hides team-only areas. */
  member?: string;
  now: Date;
  window: { days: number; runs: number };
}

export const DEFAULT_WINDOW = { days: 30, runs: 30 } as const;

export interface Percentiles {
  count: number;
  median: number;
  p90: number;
}

export interface DailyCount {
  day: string;
  count: number;
}
