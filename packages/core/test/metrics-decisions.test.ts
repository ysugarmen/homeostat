import { expect, test } from "vitest";
import { decisionsMetrics } from "../src/metrics/decisions.ts";
import { run, snapshot } from "./metrics-fixture.ts";

test("totals per window, per member and per source; duplicates come from the field or the reason", () => {
  // The current window is the last `window.runs` reports; here one, so the older run is the
  // previous window.
  const m = decisionsMetrics(
    snapshot({
      window: { days: 30, runs: 1 },
      runs: [
        run("2026-09-01T06:00:00Z", [
          { member: "lee", decision: "merged", confidence: 80, source: "manual" },
        ]),
        run("2026-10-20T06:00:00Z", [
          {
            member: "lee",
            decision: "merged",
            confidence: 76,
            source: "pr-feedback",
            origin: "review",
          },
          { member: "lee", decision: "review", confidence: 68, source: "manual" },
          {
            member: "sam",
            decision: "declined",
            confidence: 92,
            reason: "duplicate of x, which it reconfirms",
          },
          { member: "sam", decision: "declined", confidence: 30, duplicateOf: "y" },
          { member: "sam", decision: "declined", confidence: 20 },
        ]),
      ],
    }),
  );
  expect(m.current).toEqual({
    merged: 1,
    review: 1,
    declined: 3,
    duplicates: 2,
    total: 5,
    autoMergeShare: 1 / 3,
  });
  expect(m.previous).toMatchObject({ merged: 1, total: 1, autoMergeShare: 1 });
  expect(m.byMember.map((x) => [x.member, x.merged, x.review, x.declined])).toEqual([
    ["lee", 1, 1, 0],
    ["sam", 0, 0, 3],
  ]);
  expect(m.bySource.map((s) => s.source)).toEqual(["manual", "pr-feedback", "unknown"]);
  expect(m.bySource.find((s) => s.source === "unknown")?.declined).toBe(3);
  expect(m.perRun).toEqual([{ at: "2026-10-20T06:00:00Z", ...m.current }]);
});

test("with no runs everything is zero and there is no previous window", () => {
  const m = decisionsMetrics(snapshot());
  expect(m.current).toEqual({ merged: 0, review: 0, declined: 0, duplicates: 0, total: 0 });
  expect(m.previous).toBeUndefined();
  expect(m.perRun).toEqual([]);
});
