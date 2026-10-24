import { expect, test } from "vitest";
import { reach } from "../src/metrics/reach.ts";
import { ev, snapshot } from "./metrics-fixture.ts";

test("injections per day, rules served against the rules reachable here, overflow, docs, team counters", () => {
  // The starter KB has two accepted rules (redact-before-logging, outbound-http-retry-helper)
  // and one candidate, and three members.
  const r = reach(
    snapshot({
      events: [
        ev("2026-10-20T10:00:00Z", "injection", {
          session: "a",
          source: "startup",
          entries: [{ id: "redact-before-logging", form: "full" }],
          dropped: ["use-design-tokens-for-colors"],
          tokens: 300,
        }),
        ev("2026-10-20T11:00:00Z", "injection", {
          session: "a",
          source: "update",
          entries: [{ id: "outbound-http-retry-helper", form: "rule" }],
        }),
        ev("2026-10-21T10:00:00Z", "injection", {
          session: "b",
          source: "startup",
          entries: [],
          dropped: [],
          tokens: 0,
        }),
        ev("2026-10-21T10:00:01Z", "doc-injection", {
          session: "b",
          docs: ["integrations/partner-calls", "integrations/billing"],
          sections: [{ doc: "integrations/partner-calls", id: "auth" }],
        }),
        ev("2026-10-21T10:05:00Z", "doc-read", {
          doc: "integrations/partner-calls",
          section: "auth",
        }),
        // Outside both windows.
        ev("2026-08-01T10:00:00Z", "injection", { session: "z", source: "startup", entries: [] }),
        // The previous window.
        ev("2026-09-10T10:00:00Z", "injection", {
          session: "p",
          source: "startup",
          entries: [{ id: "redact-before-logging", form: "full" }],
        }),
      ],
      heartbeats: [
        {
          member: "lee",
          at: "2026-10-21T08:00:00Z",
          kbCommit: null,
          behind: 0,
          pending: 0,
          version: "0.2.2",
          usage: {
            "2026-10-21": { sessions: 2, injections: 3, rules: 9, mcpCalls: 1, docReads: 0 },
          },
        },
        {
          member: "sam",
          at: "2026-10-21T08:00:00Z",
          kbCommit: null,
          behind: 0,
          pending: 0,
          version: "0.2.1",
        },
      ],
    }),
  );
  expect(r.injectionsByDay).toHaveLength(30);
  expect(r.injectionsByDay.at(-1)).toEqual({ day: "2026-10-21", count: 1 });
  expect(r.injectionsByDay.at(-2)).toEqual({ day: "2026-10-20", count: 2 });
  expect(r).toMatchObject({
    sessions: 2,
    distinctRules: 2,
    reachable: 2,
    servedShare: 1,
    indexOverflowShare: 0.5,
    previous: { sessions: 1, distinctRules: 1 },
  });
  // Two documents in the index, one opened.
  expect(r.docs).toEqual({ listed: 2, read: 1, pullThrough: 0.5 });
  expect(r.team).toMatchObject({ sharing: 1, members: 3 });
  expect(r.team.byDay).toHaveLength(7);
  expect(r.team.byDay.at(-1)).toEqual({
    day: "2026-10-21",
    sessions: 2,
    injections: 3,
    rules: 9,
    mcpCalls: 1,
    docReads: 0,
    turns: 0,
    retrievedTurns: 0,
    creditedTurns: 0,
  });
  expect(r.team.byDay[0]).toEqual({
    day: "2026-10-15",
    sessions: 0,
    injections: 0,
    rules: 0,
    mcpCalls: 0,
    docReads: 0,
    turns: 0,
    retrievedTurns: 0,
    creditedTurns: 0,
  });
});

test("with no events nothing was served and the shares are unknown", () => {
  const r = reach(snapshot());
  expect(r).toMatchObject({ sessions: 0, distinctRules: 0, reachable: 2 });
  expect(r.servedShare).toBe(0);
  expect(r.indexOverflowShare).toBeUndefined();
  expect(r.docs).toEqual({ listed: 0, read: 0 });
  expect(r.team.sharing).toBe(0);
});
