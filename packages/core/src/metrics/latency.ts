import { REVIEW_REMINDER_DAYS } from "../automation.ts";
import { wasReview } from "./calibration.ts";
import type { MetricsSnapshot } from "./types.ts";
import { inWindow, percentiles, windows } from "./util.ts";

export interface OpenReview {
  id: string;
  member: string;
  pr?: string;
  confidence?: number;
  hoursOpen: number;
  overdue: boolean;
}

export interface ReviewLatency {
  /** Reviews a reviewer settled in the window. */
  settled: number;
  /** Settled before 0.2.2 recorded times, so they have no latency. */
  unmeasured: number;
  medianHours?: number;
  p90Hours?: number;
  previous?: { medianHours?: number };
  /** Still waiting, oldest first. */
  open: OpenReview[];
}

const HOUR = 3_600_000;

export function reviewLatency(snap: MetricsSnapshot): ReviewLatency {
  const w = windows(snap.now, snap.window.days);
  const records = snap.decisions.flatMap((d) => d.decided.map((r) => ({ ...r, member: d.member })));
  const hours = (r: { openedAt?: string; settledAt?: string }) =>
    r.openedAt && r.settledAt
      ? (Date.parse(r.settledAt) - Date.parse(r.openedAt)) / HOUR
      : undefined;
  const settled = records.filter((r) => r.settledAt && inWindow(r.settledAt, w.current));
  const before = records.filter((r) => r.settledAt && inWindow(r.settledAt, w.previous));
  const current = percentiles(settled.flatMap((r) => hours(r) ?? []));
  const previous = percentiles(before.flatMap((r) => hours(r) ?? []));
  const open = records
    .filter((r) => r.decision === "review")
    .map((r) => {
      const hoursOpen = (snap.now.getTime() - Date.parse(r.openedAt ?? r.at)) / HOUR;
      return {
        id: r.id,
        member: r.member,
        ...(r.pr ? { pr: r.pr } : {}),
        ...(r.confidence === undefined ? {} : { confidence: r.confidence }),
        hoursOpen,
        overdue: hoursOpen > REVIEW_REMINDER_DAYS * 24,
      };
    })
    .sort((a, b) => b.hoursOpen - a.hoursOpen);
  return {
    settled: settled.length,
    unmeasured: records.filter((r) => r.decision !== "review" && wasReview(r) && !r.settledAt)
      .length,
    ...(current ? { medianHours: current.median, p90Hours: current.p90 } : {}),
    ...(before.length ? { previous: previous ? { medianHours: previous.median } : {} } : {}),
    open,
  };
}
