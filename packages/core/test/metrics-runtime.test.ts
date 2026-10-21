import { expect, test } from "vitest";
import { runtime } from "../src/metrics/runtime.ts";
import { ev, run, snapshot } from "./metrics-fixture.ts";

test("session start, context, MCP, daily runs and sync, from events and run timing", () => {
  const r = runtime(
    snapshot({
      window: { days: 30, runs: 1 },
      events: [
        ev("2026-10-20T10:00:00Z", "injection", {
          session: "a",
          source: "startup",
          ms: 120,
          ok: true,
          tokens: 300,
          chars: 1200,
          entries: [
            { id: "x", form: "full" },
            { id: "y", form: "rule" },
          ],
        }),
        ev("2026-10-20T11:00:00Z", "injection", {
          session: "b",
          source: "startup",
          ms: 480,
          ok: true,
          tokens: 500,
          chars: 2000,
          entries: [{ id: "x", form: "full" }],
        }),
        ev("2026-10-20T12:00:00Z", "injection", {
          session: "c",
          source: "startup",
          ms: 60,
          ok: false,
        }),
        // Prompt-time: not a session start.
        ev("2026-10-20T13:00:00Z", "injection", {
          session: "a",
          source: "update",
          ms: 999,
          entries: [],
        }),
        // From 0.2.1: no ms.
        ev("2026-10-19T10:00:00Z", "injection", {
          session: "d",
          source: "startup",
          tokens: 100,
          entries: [],
        }),
        // The previous window.
        ev("2026-09-01T10:00:00Z", "injection", {
          session: "p",
          source: "startup",
          ms: 900,
          ok: true,
          tokens: 100,
          entries: [],
        }),
        ev("2026-10-20T10:01:00Z", "mcp-call", { tool: "context", ms: 30, ok: true }),
        ev("2026-10-20T10:02:00Z", "mcp-call", { tool: "context", ms: 50, ok: false }),
        // From 0.2.1: no ms.
        ev("2026-10-20T10:03:00Z", "mcp-call", { tool: "read" }),
        ev("2026-10-20T10:04:00Z", "sync-run", { ms: 2000, ok: true }),
        ev("2026-10-20T10:05:00Z", "sync-run", { ms: 100, ok: false, step: "push" }),
      ],
      runs: [
        {
          ...run("2026-10-19T06:00:00Z", [{}]),
          timing: {
            started: "2026-10-19T06:00:00Z",
            finished: "2026-10-19T06:04:00Z",
            modelCalls: 4,
            chars: 1000,
            failedCalls: 0,
          },
        },
        {
          ...run("2026-10-20T06:00:00Z", [{}, {}]),
          timing: {
            started: "2026-10-20T06:00:00Z",
            finished: "2026-10-20T06:03:00Z",
            modelCalls: 6,
            chars: 2000,
            failedCalls: 1,
          },
        },
      ],
    }),
  );
  expect(r.sessionStart).toEqual({
    count: 3,
    median: 120,
    p90: 480,
    failures: 1,
    previous: { count: 1, median: 900, p90: 900 },
  });
  expect(r.context).toEqual({
    injections: 3,
    tokensMedian: 300,
    charsMedian: 1200,
    fullShare: 2 / 3,
  });
  expect(r.mcp).toEqual([
    { tool: "context", calls: 2, failures: 1, latency: { count: 2, median: 30, p90: 50 } },
    { tool: "read", calls: 1, failures: 0 },
  ]);
  expect(r.dailyRuns).toEqual([
    {
      at: "2026-10-20T06:00:00Z",
      durationMs: 180_000,
      modelCalls: 6,
      chars: 2000,
      failedCalls: 1,
      lessons: 2,
      callsPerLesson: 3,
    },
  ]);
  expect(r.lastRun).toEqual({
    at: "2026-10-20T06:00:00Z",
    durationMs: 180_000,
    previousMedianMs: 240_000,
  });
  expect(r.sync).toEqual({ runs: 2, failures: 1, latency: { count: 2, median: 100, p90: 2000 } });
});

test("with nothing recorded the optional groups are absent", () => {
  const r = runtime(snapshot({ runs: [run("2026-10-20T06:00:00Z", [])] }));
  expect(r).toEqual({
    mcp: [],
    dailyRuns: [{ at: "2026-10-20T06:00:00Z", lessons: 0 }],
    lastRun: { at: "2026-10-20T06:00:00Z" },
  });
});
