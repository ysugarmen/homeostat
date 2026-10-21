import type { Event } from "../events.ts";
import type { DailyCount, Percentiles } from "./types.ts";

export const DAY = 86_400_000;

/** The calendar day of a date, as `YYYY-MM-DD` in UTC. */
export const day = (d: Date) => d.toISOString().slice(0, 10);

/** Median and 90th percentile by nearest rank; undefined with no values. */
export function percentiles(values: readonly number[]): Percentiles | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
  return { count: sorted.length, median: at(0.5), p90: at(0.9) };
}

export interface Window {
  since: string;
  until: string;
}

/** The last `days` days up to `now`, and the `days` before them, as ISO bounds. */
export function windows(now: Date, days: number): { current: Window; previous: Window } {
  const until = now.toISOString();
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const before = new Date(now.getTime() - 2 * days * DAY).toISOString();
  return { current: { since, until }, previous: { since: before, until: since } };
}

export const inWindow = (ts: string, w: Window) => ts >= w.since && ts < w.until;

/** Events per calendar day over the last `days` days, every day present. */
export function byDay(events: readonly Event[], now: Date, days: number): DailyCount[] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.ts.slice(0, 10), (counts.get(e.ts.slice(0, 10)) ?? 0) + 1);
  const out: DailyCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = day(new Date(now.getTime() - i * DAY));
    out.push({ day: d, count: counts.get(d) ?? 0 });
  }
  return out;
}

/** `a / b`, or undefined when there is nothing to divide by, so pages can show a dash. */
export const ratio = (a: number, b: number): number | undefined => (b > 0 ? a / b : undefined);

/** The nearest-rank median of `values`, or undefined with none. */
export const median = (values: readonly number[]) => percentiles(values)?.median;
