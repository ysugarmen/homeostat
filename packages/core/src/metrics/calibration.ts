import type { DecisionRecord } from "../automation.ts";
import type { MetricsSnapshot } from "./types.ts";
import { inWindow, ratio, windows } from "./util.ts";

export interface CalibrationBand {
  from: number;
  to: number;
  /** Merged by the run itself. */
  merged: number;
  /** Sent to a reviewer, who merged it. */
  reviewMerged: number;
  /** Sent to a reviewer, who closed it. */
  reviewDeclined: number;
  /** Still waiting for a reviewer. */
  reviewOpen: number;
  /** Declined by the run itself. */
  declined: number;
}

export interface Calibration {
  /** Ten bands of ten points, 0 to 9 up to 90 to 100. */
  bands: CalibrationBand[];
  lines: { decline: number; accept: number; coreAccept: number };
  /** Of the lessons reviewers settled, the share they merged. */
  reviewerAgreement?: number;
  /** The band just under the accept line: how often reviewers merged what the run held back. */
  underAccept: { from: number; to: number; merged: number; of: number };
}

/**
 * Whether a decision went through a review PR. A lesson merged by the run itself also carries
 * its daily branch as `pr`, so the branch name tells the two apart; a settled time is decisive.
 */
export const wasReview = (r: DecisionRecord) =>
  r.settledAt !== undefined ||
  (r.pr?.startsWith("homeostat/review-") === true && r.decision !== "review");

export function calibration(snap: MetricsSnapshot): Calibration {
  const w = windows(snap.now, snap.window.days).current;
  const bands: CalibrationBand[] = Array.from({ length: 10 }, (_, i) => ({
    from: i * 10,
    to: i === 9 ? 100 : i * 10 + 9,
    merged: 0,
    reviewMerged: 0,
    reviewDeclined: 0,
    reviewOpen: 0,
    declined: 0,
  }));
  for (const d of snap.decisions) {
    for (const r of d.decided) {
      if (r.confidence === undefined || !inWindow(r.at, w)) continue;
      const band = bands[Math.min(9, Math.floor(r.confidence / 10))];
      if (!band) continue;
      if (r.decision === "review") band.reviewOpen++;
      else if (wasReview(r)) band[r.decision === "merged" ? "reviewMerged" : "reviewDeclined"]++;
      else band[r.decision]++;
    }
  }
  const c = snap.config.scoring.confidence;
  const under = bands[Math.min(9, Math.floor(Math.max(0, c.accept - 1) / 10))] ?? bands[0];
  const merged = bands.reduce((n, b) => n + b.reviewMerged, 0);
  const declined = bands.reduce((n, b) => n + b.reviewDeclined, 0);
  const agreement = ratio(merged, merged + declined);
  return {
    bands,
    lines: { decline: c.decline, accept: c.accept, coreAccept: c.coreAccept },
    ...(agreement === undefined ? {} : { reviewerAgreement: agreement }),
    underAccept: {
      from: under?.from ?? 0,
      to: under?.to ?? 9,
      merged: under?.reviewMerged ?? 0,
      of: (under?.reviewMerged ?? 0) + (under?.reviewDeclined ?? 0),
    },
  };
}
