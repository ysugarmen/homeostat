import { expect, test } from "vitest";
import { reviewLatency } from "../src/metrics/latency.ts";
import { record, snapshot } from "./metrics-fixture.ts";

test("hours from opening to settling, and the open queue oldest first", () => {
  const l = reviewLatency(
    snapshot({
      decisions: [
        {
          member: "lee",
          decided: [
            record({
              decision: "merged",
              openedAt: "2026-10-20T04:00:00Z",
              settledAt: "2026-10-20T07:00:00Z",
              pr: "homeostat/review-lee-2026-10-20",
            }),
            record({
              decision: "declined",
              openedAt: "2026-10-19T04:00:00Z",
              settledAt: "2026-10-20T04:00:00Z",
              pr: "homeostat/review-lee-2026-10-19",
            }),
            // Settled by a 0.2.1 run: no times to measure.
            record({
              decision: "merged",
              pr: "homeostat/review-lee-2026-10-18",
              reason: "merged by a reviewer",
            }),
            record({
              decision: "review",
              id: "old",
              at: "2026-10-17T04:00:00Z",
              pr: "homeostat/review-lee-2026-10-17",
              confidence: 61,
            }),
            record({
              decision: "review",
              id: "new",
              at: "2026-10-21T04:00:00Z",
              openedAt: "2026-10-21T04:00:00Z",
              pr: "homeostat/review-lee-2026-10-21",
            }),
            // Settled in the previous window.
            record({
              decision: "merged",
              openedAt: "2026-09-01T04:00:00Z",
              settledAt: "2026-09-02T04:00:00Z",
            }),
          ],
        },
      ],
    }),
  );
  // Nearest-rank percentiles: of 3 h and 24 h the median is 3 h.
  expect(l).toMatchObject({
    settled: 2,
    unmeasured: 1,
    medianHours: 3,
    p90Hours: 24,
    previous: { medianHours: 24 },
  });
  expect(l.open.map((o) => [o.id, Math.round(o.hoursOpen), o.overdue])).toEqual([
    ["old", 104, true],
    ["new", 8, false],
  ]);
  expect(l.open[0]).toMatchObject({ member: "lee", confidence: 61 });
});

test("with nothing settled there are no hours", () => {
  const l = reviewLatency(snapshot());
  expect(l).toEqual({ settled: 0, unmeasured: 0, open: [] });
});
