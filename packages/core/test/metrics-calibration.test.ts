import { expect, test } from "vitest";
import { calibration, wasReview } from "../src/metrics/calibration.ts";
import { record, snapshot } from "./metrics-fixture.ts";

const many = (n: number, over: Parameters<typeof record>[0]) =>
  Array.from({ length: n }, () => record(over));

test("bands of ten, the configured lines, reviewer agreement and the band under accept", () => {
  // Shaped like the first live run: 34 held back at 68, 12 at 76, 11 merged at 82, two
  // duplicates declined high, one review still open.
  const decided = [
    ...many(30, {
      decision: "merged",
      confidence: 68,
      pr: "homeostat/review-lee-2026-10-20",
      settledAt: "2026-10-20T09:00:00Z",
      reason: "merged by a reviewer",
    }),
    ...many(4, {
      decision: "declined",
      confidence: 68,
      pr: "homeostat/review-lee-2026-10-20",
      settledAt: "2026-10-20T09:00:00Z",
      reason: "closed by a reviewer",
    }),
    // Settled by a 0.2.1 run: no settledAt, but the review branch.
    ...many(12, {
      decision: "merged",
      confidence: 76,
      pr: "homeostat/review-lee-2026-10-19",
      reason: "merged by a reviewer",
    }),
    // Merged by the run itself: its daily branch is not a review.
    ...many(11, { decision: "merged", confidence: 82, pr: "homeostat/daily-lee-2026-10-20" }),
    record({ decision: "declined", confidence: 86, reason: "duplicate of a, which it reconfirms" }),
    record({ decision: "declined", confidence: 92, reason: "duplicate of b, which it reconfirms" }),
    record({ decision: "review", confidence: 60, pr: "homeostat/review-lee-2026-10-21" }),
    // Outside the window: ignored.
    record({ decision: "merged", confidence: 99, at: "2026-01-01T00:00:00Z" }),
    // No confidence (a flag or a document): ignored.
    record({ decision: "review" }),
  ];
  const c = calibration(snapshot({ decisions: [{ member: "lee", decided }] }));
  expect(c.lines).toEqual({ decline: 35, accept: 70, coreAccept: 80 });
  expect(c.bands).toHaveLength(10);
  expect(c.bands[6]).toEqual({
    from: 60,
    to: 69,
    merged: 0,
    reviewMerged: 30,
    reviewDeclined: 4,
    reviewOpen: 1,
    declined: 0,
  });
  expect(c.bands[7]).toMatchObject({ from: 70, to: 79, reviewMerged: 12 });
  expect(c.bands[8]).toMatchObject({ merged: 11, declined: 1 });
  expect(c.bands[9]).toMatchObject({ from: 90, to: 100, declined: 1 });
  expect(c.reviewerAgreement).toBeCloseTo(42 / 46);
  expect(c.underAccept).toEqual({ from: 60, to: 69, merged: 30, of: 34 });
});

test("with nothing decided the bands are empty and agreement is unknown", () => {
  const c = calibration(snapshot());
  expect(c.bands.every((b) => b.merged + b.reviewMerged + b.reviewDeclined === 0)).toBe(true);
  expect(c.reviewerAgreement).toBeUndefined();
  expect(c.underAccept).toEqual({ from: 60, to: 69, merged: 0, of: 0 });
});

test("a daily branch is not a review; a review branch or a settled time is", () => {
  expect(wasReview(record({ pr: "homeostat/daily-lee-2026-10-20" }))).toBe(false);
  expect(wasReview(record({ pr: "homeostat/review-lee-2026-10-20" }))).toBe(true);
  expect(wasReview(record({ decision: "review", pr: "homeostat/review-lee-2026-10-20" }))).toBe(
    false,
  );
  expect(wasReview(record({ settledAt: "2026-10-20T09:00:00Z" }))).toBe(true);
});
