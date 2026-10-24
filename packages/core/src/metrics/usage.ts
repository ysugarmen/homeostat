import type { UsageDay } from "../automation.ts";
import type { Event } from "../events.ts";
import { DAY, day } from "./util.ts";

/**
 * The last `days` days of a machine's event log as per-day counts, for a member who chose to
 * share them in their heartbeat. Counts only: no rule ids, paths, repos or session ids leave; turns
 * are counted, never what was asked or credited.
 */
export function usageCounts(
  events: readonly Event[],
  now: Date,
  days = 7,
): Record<string, UsageDay> {
  const out: Record<string, UsageDay> = {};
  const sessions = new Map<string, Set<string>>();
  for (let i = days - 1; i >= 0; i--) {
    const d = day(new Date(now.getTime() - i * DAY));
    out[d] = {
      sessions: 0,
      injections: 0,
      rules: 0,
      mcpCalls: 0,
      docReads: 0,
      turns: 0,
      retrievedTurns: 0,
      creditedTurns: 0,
    };
    sessions.set(d, new Set());
  }
  // A turn re-read by a later Stop is logged again; the last reading counts, once.
  const turns = new Map<string, Event>();
  for (const e of events) {
    if (e.type === "turn-usage") turns.set(`${String(e.session)}\n${String(e.turn)}`, e);
  }
  for (const e of turns.values()) {
    const u = out[e.ts.slice(0, 10)];
    if (!u) continue;
    u.turns = (u.turns ?? 0) + 1;
    if (e.retrieved === true) u.retrievedTurns = (u.retrievedTurns ?? 0) + 1;
    if (e.credited === true) u.creditedTurns = (u.creditedTurns ?? 0) + 1;
  }
  for (const e of events) {
    const d = e.ts.slice(0, 10);
    const u = out[d];
    if (!u) continue;
    switch (e.type) {
      case "injection":
        u.injections++;
        u.rules += ((e.entries as unknown[] | undefined) ?? []).length;
        if (typeof e.session === "string") sessions.get(d)?.add(e.session);
        break;
      case "mcp-call":
        u.mcpCalls++;
        break;
      case "doc-read":
        u.docReads++;
        break;
    }
  }
  for (const [d, ids] of sessions) {
    const u = out[d];
    if (u) u.sessions = ids.size;
  }
  return out;
}
