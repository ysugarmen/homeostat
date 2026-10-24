import {
  DEFAULT_WINDOW,
  type DecisionRecord,
  type Event,
  type MetricsSnapshot,
  metricsReport,
  type RunReport,
  readKbFiles,
  validate,
} from "@homeostat/core";
import { describe, expect, test } from "vitest";
import { performancePage } from "../src/performance.ts";

const starter = new URL("../../../examples/starter-kb", import.meta.url).pathname;
const NOW = new Date("2026-10-21T12:00:00Z");

function snapshot(over: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
  const kb = validate(readKbFiles(starter));
  if (!kb.config) throw new Error("config");
  return {
    config: kb.config,
    entries: kb.entries.map((e) => ({ ...e.entry, path: e.path })),
    events: [],
    runs: [],
    decisions: [],
    heartbeats: [],
    now: NOW,
    window: DEFAULT_WINDOW,
    ...over,
  };
}

const record = (over: Partial<DecisionRecord>): DecisionRecord => ({
  path: "knowledge/core/x.md",
  id: "x",
  hash: "h",
  decision: "merged",
  reason: "",
  at: "2026-10-20T06:00:00Z",
  ...over,
});
const ev = (ts: string, type: string, rest: Record<string, unknown> = {}): Event => ({
  ts,
  type,
  ...rest,
});

/** A full snapshot: the first live run's calibration, a timed run, a sharing member, local events. */
function full(): MetricsSnapshot {
  const review = {
    pr: "homeostat/review-lee-2026-10-20",
    settledAt: "2026-10-20T09:00:00Z",
    openedAt: "2026-10-20T06:00:00Z",
    confidence: 68,
  };
  const decided = [
    ...Array.from({ length: 30 }, () => record({ ...review, decision: "merged" })),
    ...Array.from({ length: 4 }, () => record({ ...review, decision: "declined" })),
    record({
      decision: "review",
      id: "waiting",
      confidence: 60,
      pr: "homeostat/review-lee-2026-10-21",
      at: "2026-10-17T06:00:00Z",
    }),
  ];
  const run: RunReport = {
    at: "2026-10-20T06:00:00Z",
    members: [{ member: "lee", merged: 2, review: 1, declined: 1 }],
    settled: 0,
    lessons: [
      { member: "lee", id: "a", decision: "merged", reason: "", confidence: 82 },
      { member: "lee", id: "b", decision: "merged", reason: "", confidence: 90 },
      { member: "lee", id: "c", decision: "review", reason: "", confidence: 68 },
      { member: "lee", id: "d", decision: "declined", reason: "", duplicateOf: "a" },
    ],
    timing: {
      started: "2026-10-20T06:00:00Z",
      finished: "2026-10-20T06:02:30Z",
      modelCalls: 8,
      chars: 4000,
      failedCalls: 1,
    },
    kb: { accepted: 5, stale: 1, flagged: 0, disputed: 0, possibleDuplicates: 0 },
  };
  return snapshot({
    decisions: [{ member: "lee", decided }],
    runs: [run],
    heartbeats: [
      {
        member: "lee",
        at: "2026-10-21T08:00:00Z",
        kbCommit: null,
        behind: 0,
        pending: 0,
        version: "0.2.2",
        usage: { "2026-10-21": { sessions: 2, injections: 3, rules: 9, mcpCalls: 1, docReads: 0 } },
      },
    ],
    events: [
      ev("2026-10-21T09:00:00Z", "injection", {
        session: "s1",
        source: "startup",
        ms: 150,
        ok: true,
        tokens: 120,
        chars: 900,
        entries: [{ id: "redact-before-logging", form: "full" }],
        dropped: [],
      }),
      ev("2026-10-21T09:01:00Z", "mcp-call", { tool: "context", ms: 20, ok: true }),
      ev("2026-10-21T09:02:00Z", "sync-run", { ms: 800, ok: true }),
    ],
  });
}

describe("the Performance page", () => {
  test("renders the six panels with a tooltip on every KPI, and the calibration sentence", () => {
    const html = performancePage(metricsReport(full()), { shared: false });
    for (const id of ["kpis", "calibration", "runs", "reach", "use", "runtime", "latency"])
      expect(html).toContain(`aria-labelledby="${id}"`);
    expect(html.match(/class="info"/g)?.length).toBeGreaterThanOrEqual(6);
    expect(html).toContain(
      "Lessons sent to review at 60 to 69 were merged by a reviewer 30 of 34 times.",
    );
    expect(html).toContain("1 of 3 members share usage counts");
    expect(html).toContain('id="session-start"');
    expect(html).toContain('id="g-reach"');
    expect(html).toContain("waiting");
    expect(html).toContain('<span class="chip disputed">');
    expect(html).toContain("2m 30s");
    expect(html).not.toContain("NaN");
  });

  test("an empty snapshot says what is missing, panel by panel", () => {
    const html = performancePage(metricsReport(snapshot()), { shared: false });
    for (const text of [
      "No decisions with a confidence yet.",
      "No daily run yet.",
      "No sessions recorded on this machine yet.",
      "No member shares usage counts.",
      "No timed session starts yet.",
      "No MCP calls yet.",
      "No run timing recorded yet.",
      "No syncs recorded yet.",
      "No turns recorded on this machine yet.",
      "Nothing waiting for review.",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  test("with decisions but none settled under the accept line, the sentence says so", () => {
    const html = performancePage(
      metricsReport(
        snapshot({
          decisions: [
            {
              member: "lee",
              decided: [record({ confidence: 82, pr: "homeostat/daily-lee-2026-10-20" })],
            },
          ],
        }),
      ),
      { shared: false },
    );
    expect(html).toContain("No lesson at 60 to 69 has been settled by a reviewer yet.");
  });

  test("the Use panel shows lookups, credits and rules served but never credited", () => {
    const snap = full();
    const turn = (n: number, rest: Record<string, unknown>) =>
      ev(`2026-10-21T09:1${n}:00Z`, "turn-usage", {
        session: "s1",
        turn: n,
        calls: [],
        retrieved: false,
        credited: false,
        credits: [],
        ...rest,
      });
    snap.events = [
      ...snap.events,
      ev("2026-10-21T09:00:30Z", "injection", {
        session: "s1",
        source: "update",
        entries: [{ id: "outbound-http-retry-helper", form: "full" }],
      }),
      turn(1, {
        calls: ["search"],
        retrieved: true,
        credited: true,
        credits: ["redact-before-logging"],
      }),
      turn(2, {}),
    ];
    snap.heartbeats = snap.heartbeats.map((h) => ({
      ...h,
      usage: {
        "2026-10-21": {
          sessions: 2,
          injections: 3,
          rules: 9,
          mcpCalls: 1,
          docReads: 0,
          turns: 4,
          retrievedTurns: 2,
          creditedTurns: 1,
        },
      },
    }));
    const html = performancePage(metricsReport(snap), { shared: false });
    expect(html).toContain('aria-labelledby="use"');
    expect(html).toContain("turns that looked things up");
    expect(html).toContain('<span class="chip mono">outbound-http-retry-helper</span>');
    expect(html).not.toContain('<span class="chip mono">redact-before-logging</span>');
    expect(html).toContain("team turns that credited");
    // A shared build keeps the team's counts and leaves this machine's out.
    const shared = performancePage(metricsReport(snap), { shared: true });
    expect(shared).toContain("team turns that looked things up");
    expect(shared).not.toContain("credited after a lookup");
    expect(shared).not.toContain("outbound-http-retry-helper");
  });

  test("a shared build leaves out what only this machine's event log can fill", () => {
    const html = performancePage(metricsReport(full()), { shared: true });
    for (const local of [
      "Rules served",
      "Session start",
      'id="session-start"',
      'id="mcp"',
      'id="sync"',
      'id="g-reach"',
    ])
      expect(html).not.toContain(local);
    expect(html).toContain('id="daily-run"');
    expect(html).toContain("1 of 3 members share usage counts");
    expect(html).toContain('style="--cols: 4"');
  });
});
