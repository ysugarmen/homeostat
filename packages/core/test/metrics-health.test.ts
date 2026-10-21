import { expect, test } from "vitest";
import { healthTrend, kbSnapshot } from "../src/metrics/health-trend.ts";
import { NOW, run, snapshot } from "./metrics-fixture.ts";

test("the KB snapshot counts what the daily run records, and the trend reads it back per run", () => {
  const s = snapshot();
  expect(kbSnapshot(s.entries, s.config, NOW)).toEqual({
    accepted: 2,
    stale: 0,
    flagged: 0,
    disputed: 0,
    possibleDuplicates: 0,
  });
  // 182 days after the starter rules were last confirmed (2026-10-07), both are stale.
  expect(kbSnapshot(s.entries, s.config, new Date("2027-04-07T00:00:00Z")).stale).toBe(2);
  const kb = { accepted: 5, stale: 1, flagged: 0, disputed: 0, possibleDuplicates: 2 };
  const t = healthTrend(
    snapshot({
      runs: [run("2026-10-19T06:00:00Z", []), { ...run("2026-10-20T06:00:00Z", []), kb }],
    }),
  );
  expect(t).toEqual([{ at: "2026-10-20T06:00:00Z", ...kb }]);
});
