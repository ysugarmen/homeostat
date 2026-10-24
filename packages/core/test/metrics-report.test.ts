import { expect, test } from "vitest";
import { metricsReport } from "../src/metrics/index.ts";
import { ev, record, run, snapshot } from "./metrics-fixture.ts";

test("an empty snapshot gives every group, with nothing undefined turned into NaN", () => {
  const r = metricsReport(snapshot());
  expect(r.window).toEqual({
    days: 30,
    runs: 30,
    since: "2026-09-21T12:00:00.000Z",
    runsOnRecord: 0,
  });
  expect(Object.keys(r)).toEqual([
    "window",
    "decisions",
    "calibration",
    "latency",
    "reach",
    "runtime",
    "usage",
    "healthTrend",
  ]);
  // No report field is legitimately null, so a null in the JSON would be a NaN or an Infinity.
  expect(JSON.stringify(r)).not.toContain("null");
});

test("a snapshot with runs, decisions and events fills every group", () => {
  const r = metricsReport(
    snapshot({
      runs: [run("2026-10-20T06:00:00Z", [{ decision: "merged", confidence: 80 }])],
      decisions: [
        {
          member: "lee",
          decided: [record({ confidence: 80, pr: "homeostat/daily-lee-2026-10-20" })],
        },
      ],
      events: [
        ev("2026-10-20T10:00:00Z", "injection", {
          session: "a",
          source: "startup",
          ms: 100,
          ok: true,
          tokens: 10,
          entries: [],
        }),
      ],
    }),
  );
  expect(r.decisions.current.merged).toBe(1);
  expect(r.calibration.bands[8]?.merged).toBe(1);
  expect(r.reach.sessions).toBe(1);
  expect(r.runtime.sessionStart?.median).toBe(100);
  expect(r.window.runsOnRecord).toBe(1);
  expect(JSON.stringify(r)).not.toContain("null");
});
