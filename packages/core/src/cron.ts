import type { Config } from "./config.ts";

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week, 0 and 7 are Sunday
];

/** The values one cron field allows, or undefined if the field is malformed. */
function field(spec: string, [min, max]: [number, number]): Set<number> | undefined {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const from = m[1] === "*" ? min : Number(m[2]);
    const to = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : from;
    const step = m[4] ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) return undefined;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/** Whether a five-field cron expression matches `date`'s minute, in UTC. */
export function cronMatches(expr: string, date: Date): boolean {
  const specs = expr.trim().split(/\s+/);
  if (specs.length !== 5) return false;
  const sets = specs.map((s, i) => field(s, RANGES[i] as [number, number]));
  if (sets.some((s) => s === undefined)) return false;
  const [minute, hour, dom, month, dow] = sets as Set<number>[];
  const day = date.getUTCDay();
  const domHit = dom?.has(date.getUTCDate()) ?? false;
  const dowHit = (dow?.has(day) ?? false) || (day === 0 && (dow?.has(7) ?? false));
  // Standard cron: when both day fields are restricted, either one matching is enough.
  const dayHit = specs[2] !== "*" && specs[4] !== "*" ? domHit || dowHit : domHit && dowHit;
  return (
    (minute?.has(date.getUTCMinutes()) ?? false) &&
    (hour?.has(date.getUTCHours()) ?? false) &&
    (month?.has(date.getUTCMonth() + 1) ?? false) &&
    dayHit
  );
}

export type AgentName = "curator" | "deepDive";

/** The enabled scheduled agents due at `date`'s minute. */
export function dueAgents(config: Config, date: Date): AgentName[] {
  return (["curator", "deepDive"] as const).filter(
    (name) => config.agents[name].enabled && cronMatches(config.agents[name].schedule, date),
  );
}
