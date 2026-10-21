import { expect, test } from "vitest";
import type { Event } from "../src/events.ts";
import { byDay, percentiles, ratio, windows } from "../src/metrics/util.ts";

test("percentiles use the nearest rank on the sorted values", () => {
  expect(percentiles([5, 1, 3, 2, 4])).toEqual({ count: 5, median: 3, p90: 5 });
  expect(percentiles([])).toBeUndefined();
  expect(percentiles([7])).toEqual({ count: 1, median: 7, p90: 7 });
  expect(percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toEqual({
    count: 10,
    median: 50,
    p90: 90,
  });
});

test("windows: the current days and the days before, as ISO bounds", () => {
  const w = windows(new Date("2026-10-21T12:00:00Z"), 30);
  expect(w.current).toEqual({
    since: "2026-09-21T12:00:00.000Z",
    until: "2026-10-21T12:00:00.000Z",
  });
  expect(w.previous).toEqual({
    since: "2026-08-22T12:00:00.000Z",
    until: "2026-09-21T12:00:00.000Z",
  });
});

test("byDay counts events per calendar day over the window, zeros included", () => {
  const ev = (ts: string): Event => ({ ts, type: "injection" });
  const days = byDay(
    [ev("2026-10-20T01:00:00Z"), ev("2026-10-20T23:00:00Z"), ev("2026-10-18T12:00:00Z")],
    new Date("2026-10-21T12:00:00Z"),
    3,
  );
  expect(days).toEqual([
    { day: "2026-10-19", count: 0 },
    { day: "2026-10-20", count: 2 },
    { day: "2026-10-21", count: 0 },
  ]);
});

test("ratio is undefined over zero", () => {
  expect(ratio(1, 4)).toBe(0.25);
  expect(ratio(0, 0)).toBeUndefined();
});
