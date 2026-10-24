import { expect, test } from "vitest";
import { turnMetrics } from "../src/metrics/turns.ts";
import { usageCounts } from "../src/metrics/usage.ts";
import { ev, NOW, snapshot } from "./metrics-fixture.ts";

const turn = (ts: string, session: string, n: number, rest: Record<string, unknown> = {}) =>
  ev(ts, "turn-usage", {
    session,
    turn: n,
    calls: [],
    retrieved: false,
    credited: false,
    credits: [],
    ...rest,
  });

const events = [
  ev("2026-10-20T09:00:00Z", "injection", {
    session: "a",
    source: "startup",
    entries: [
      { id: "redact-before-logging", form: "full" },
      { id: "outbound-http-retry-helper", form: "full" },
    ],
  }),
  // Turn 1 first logged before its reply was flushed, then again with the credit: counts once.
  turn("2026-10-20T09:01:00Z", "a", 1, { calls: ["search"], retrieved: true }),
  turn("2026-10-20T09:01:00Z", "a", 1, {
    calls: ["search"],
    retrieved: true,
    credited: true,
    credits: ["redact-before-logging", "integrations/partner-calls#timeouts"],
  }),
  turn("2026-10-20T09:05:00Z", "a", 2),
  turn("2026-10-20T09:06:00Z", "a", 3, { calls: ["read"], retrieved: true }),
  turn("2026-10-21T08:00:00Z", "b", 1, { credited: true, credits: [] }),
  // The previous window.
  turn("2026-09-10T08:00:00Z", "old", 1, { calls: ["context"], retrieved: true }),
];

test("shares of turns that retrieved and credited, distinct credits, rules never credited", () => {
  const m = turnMetrics(snapshot({ events }));
  expect(m).toEqual({
    turns: 4,
    retrievedShare: 0.5,
    creditedShare: 0.5,
    creditedAfterRetrieval: 0.5,
    distinctRules: 1,
    distinctDocs: 1,
    neverCredited: ["outbound-http-retry-helper"],
    previous: { turns: 1, retrievedShare: 1, creditedShare: 0 },
  });
});

test("without recorded turns nothing is called never credited", () => {
  const m = turnMetrics(snapshot({ events: events.filter((e) => e.type === "injection") }));
  expect(m).toMatchObject({ turns: 0, neverCredited: [] });
  expect(m.retrievedShare).toBeUndefined();
});

test("the heartbeat's counts carry turns as numbers only", () => {
  const u = usageCounts(events, NOW);
  expect(u["2026-10-20"]).toMatchObject({ turns: 3, retrievedTurns: 2, creditedTurns: 1 });
  expect(u["2026-10-21"]).toMatchObject({ turns: 1, retrievedTurns: 0, creditedTurns: 1 });
  expect(JSON.stringify(u)).not.toContain("redact");
});
