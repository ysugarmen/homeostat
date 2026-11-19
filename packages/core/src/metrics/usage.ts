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
      case "injection": {
        const entries = (e.entries as { form?: string }[] | undefined) ?? [];
        u.injections++;
        u.rules += entries.length;
        if (typeof e.session === "string") sessions.get(d)?.add(e.session);
        const moment = momentOf(e.source);
        u.moments = { ...u.moments, [moment]: (u.moments?.[moment] ?? 0) + entries.length };
        const found = entries.filter((x) => x.form === "finding").length;
        if (found) u.findings = (u.findings ?? 0) + found;
        if (moment === "commit") u.commitsHeld = (u.commitsHeld ?? 0) + 1;
        break;
      }
      case "finding-settled":
        if (e.outcome === "fixed") u.findingsFixed = (u.findingsFixed ?? 0) + 1;
        if (e.outcome === "answered") u.findingsAnswered = (u.findingsAnswered ?? 0) + 1;
        break;
      case "commit-after-hold":
        if (e.changed === true) u.commitsChanged = (u.commitsChanged ?? 0) + 1;
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

/** The moment an injection came at: session start (any kind), a prompt, MCP, a file, code, a commit. */
export function momentOf(source: unknown): string {
  const s = typeof source === "string" ? source : "";
  if (["startup", "resume", "clear", "compact"].includes(s)) return "start";
  if (s === "update") return "prompt";
  return s || "other";
}
