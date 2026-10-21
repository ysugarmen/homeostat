import { type Calibration, calibration } from "./calibration.ts";
import { type DecisionsMetrics, decisionsMetrics } from "./decisions.ts";
import { type HealthPoint, healthTrend } from "./health-trend.ts";
import { type ReviewLatency, reviewLatency } from "./latency.ts";
import { type Reach, reach } from "./reach.ts";
import { type Runtime, runtime } from "./runtime.ts";
import type { MetricsSnapshot } from "./types.ts";
import { windows } from "./util.ts";

/**
 * Every performance metric, computed at read time from the snapshot. The dashboard's
 * Performance page and `homeostat metrics` render this one object; nothing is stored.
 */
export interface MetricsReport {
  window: { days: number; runs: number; since: string; runsOnRecord: number };
  decisions: DecisionsMetrics;
  calibration: Calibration;
  latency: ReviewLatency;
  reach: Reach;
  runtime: Runtime;
  healthTrend: HealthPoint[];
}

export function metricsReport(snap: MetricsSnapshot): MetricsReport {
  return {
    window: {
      ...snap.window,
      since: windows(snap.now, snap.window.days).current.since,
      runsOnRecord: snap.runs.length,
    },
    decisions: decisionsMetrics(snap),
    calibration: calibration(snap),
    latency: reviewLatency(snap),
    reach: reach(snap),
    runtime: runtime(snap),
    healthTrend: healthTrend(snap),
  };
}
