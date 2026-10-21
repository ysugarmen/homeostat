# Performance metrics (0.2.2) implementation plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the metrics designed in [metrics.md](metrics.md): a pure metrics module in core, a `homeostat metrics` command, the additive data fields, and a Performance dashboard page.

**Architecture:** Core gets `src/metrics/` (pure functions over a `MetricsSnapshot`) and `src/state.ts` (the state-branch reader moved from the dashboard). The CLI command and the dashboard page are renderers over `metricsReport()`. The daily run, sync, hook and MCP server gain optional fields; nothing reads a field that must exist.

**Tech Stack:** TypeScript on Node 22 (type stripping, `erasableSyntaxOnly`), vitest, zod, `node:sqlite` event log, inline-SVG dashboard, Biome. No new dependency.

**Conventions for every task**

- Work in `~/Desktop/Personal/homeostat-demofix` on `main`.
- Run one test file: `npx vitest run <path>`. Full check before each commit: `pnpm check` (lint, typecheck, all tests). After edits: `npx biome check --write packages`.
- Commit as `git -c user.name="Yonatan Sugarmen" -c user.email=sugaryoni3@gmail.com commit -m "…"` with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The employer-name grep from the handover must print nothing before a commit (`grep -ri <employer> packages docs`).
- Comments explain why, in plain sentences, like the surrounding code. No em-dashes.
- Tests build fixtures by hand (see `packages/dashboard/test/metrics.test.ts` for the `snapshot()` and `ev()` helpers, `packages/dashboard/test/automation.test.ts` for a clone with a state branch).

---

## Chunk 1: core metrics module, state reader, CLI command (commit 1)

### Task 1: Move the state-branch reader into core

**Files:**
- Create: `packages/core/src/state.ts`
- Modify: `packages/core/src/index.ts` (export block)
- Modify: `packages/dashboard/src/automation.ts:1-80` (delete `readAutomation`, `git`, `json`, `REF`, `CANDIDATES`; import from core)
- Test: `packages/core/test/state.test.ts` (new), `packages/dashboard/test/automation.test.ts` (keeps passing)

- [ ] **Step 1: Write the failing test** `packages/core/test/state.test.ts`. Reuse the `clone(state, candidates)` helper from `packages/dashboard/test/automation.test.ts` (copy it; it builds a starter-KB clone whose origin has `homeostat/state` and `candidates/<m>` branches).

```ts
import { expect, test } from "vitest";
import { readState } from "../src/state.ts";
// clone() copied from the dashboard's automation test

test("reads runs, decisions and the freshest heartbeat per member from the clone", () => {
  const kb = clone(
    {
      "runs/2026-10-15T06-00-00Z.json": { at: "2026-10-15T06:00:00Z", members: [], settled: 0, lessons: [] },
      "runs/2026-10-16T06-00-00Z.json": { at: "2026-10-16T06:00:00Z", members: [], settled: 0, lessons: [] },
      "decisions/lee.json": { member: "lee", decided: [] },
      "heartbeats/lee.json": { member: "lee", at: "2026-10-15T06:00:00Z", kbCommit: null, behind: 0, pending: 0, version: "0.2.1" },
    },
    { lee: { member: "lee", at: "2026-10-16T08:00:00Z", kbCommit: null, behind: 0, pending: 1, version: "0.2.1" } },
  );
  const s = readState(kb, 1);
  expect(s.present).toBe(true);
  expect(s.runs.map((r) => r.at)).toEqual(["2026-10-16T06:00:00Z"]); // maxRuns keeps the newest
  expect(s.heartbeats[0]?.pending).toBe(1); // the candidates branch is fresher
  expect(s.decisions[0]?.member).toBe("lee");
});

test("a clone without the state branch is not present", () => {
  expect(readState(clone())).toEqual({ present: false, runs: [], heartbeats: [], decisions: [] });
});
```

- [ ] **Step 2: Run it**: `npx vitest run packages/core/test/state.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Create `packages/core/src/state.ts`** by moving lines 1-80 of `packages/dashboard/src/automation.ts` (the `AutomationState` interface renamed `StateView`, `readAutomation` renamed `readState`, plus `git`, `json`, `REF`, `CANDIDATES`). Keep the doc comment. Signature: `export function readState(kbRoot: string, maxRuns = 30): StateView`. Import `HEARTBEAT_PATH`, `STATE_BRANCH` and the types from `./automation.ts`, not from the package index.

- [ ] **Step 4: Export from core**: in `packages/core/src/index.ts` add `export { readState, type StateView } from "./state.ts";` in alphabetical position.

- [ ] **Step 5: Update the dashboard**: in `packages/dashboard/src/automation.ts` delete the moved code and add `import { readState, type StateView } from "@homeostat/core";`, then `export type AutomationState = StateView;` and `export const readAutomation = readState;` so `server.ts`, `build.ts` and the tests keep working unchanged.

- [ ] **Step 6: Run** `npx vitest run packages/core/test/state.test.ts packages/dashboard/test/automation.test.ts`. Expected: PASS.

- [ ] **Step 7: Commit** `refactor: read the state branch from core` (this is a mid-chunk commit; chunk 1 ends with one squash-free series, that is fine).

### Task 2: Metrics types, windows and percentiles

**Files:**
- Create: `packages/core/src/metrics/types.ts`, `packages/core/src/metrics/util.ts`
- Test: `packages/core/test/metrics-util.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "vitest";
import { percentiles, windows } from "../src/metrics/util.ts";

test("percentiles use the nearest rank on the sorted values", () => {
  expect(percentiles([5, 1, 3, 2, 4])).toEqual({ count: 5, median: 3, p90: 5 });
  expect(percentiles([])).toBeUndefined();
  expect(percentiles([7])).toEqual({ count: 1, median: 7, p90: 7 });
});

test("windows: the current days and the days before, as ISO bounds", () => {
  const w = windows(new Date("2026-10-21T12:00:00Z"), 30);
  expect(w.current.since).toBe("2026-09-21T12:00:00.000Z");
  expect(w.previous).toEqual({ since: "2026-08-22T12:00:00.000Z", until: "2026-09-21T12:00:00.000Z" });
});
```

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Write `types.ts`**

```ts
import type { DecisionsFile, Heartbeat, RunReport } from "../automation.ts";
import type { Config } from "../config.ts";
import type { Entry } from "../entry.ts";
import type { Event } from "../events.ts";

/** Everything the metrics are computed from, read at one moment; nothing here touches the network. */
export interface MetricsSnapshot {
  config: Config;
  entries: readonly (Entry & { path?: string })[];
  /** Local events covering at least twice the window. */
  events: readonly Event[];
  /** Run reports, oldest first, covering twice `window.runs` when the KB has that many. */
  runs: readonly RunReport[];
  decisions: readonly DecisionsFile[];
  heartbeats: readonly Heartbeat[];
  /** The member whose clone this is, for team-only visibility; unknown hides team-only areas. */
  member?: string;
  now: Date;
  window: { days: number; runs: number };
}

export const DEFAULT_WINDOW = { days: 30, runs: 30 } as const;

export interface Percentiles { count: number; median: number; p90: number }
export interface DailyCount { day: string; count: number }
```

- [ ] **Step 4: Write `util.ts`**: `percentiles(values)` (sort ascending; nearest rank: index `Math.ceil(p * n) - 1`), `windows(now, days)` returning `{ current: { since }, previous: { since, until } }`, `inWindow(ts, w)`, `byDay(events, now, days)` (like the dashboard's private helper but without the `type` parameter: callers filter by type first; the dashboard keeps its own copy for now), `ratio(a, b)` returning `undefined` when `b` is 0, and `day(d: Date)`.

- [ ] **Step 5: Run**: PASS. Biome.

### Task 3: Decisions metrics

**Files:**
- Create: `packages/core/src/metrics/decisions.ts`
- Test: `packages/core/test/metrics-decisions.test.ts`

Fixture helper for this and later tests: `packages/core/test/metrics-fixture.ts` (already written) exporting `NOW` (2026-10-21T12:00:00Z), `snapshot(over)` built from `examples/starter-kb` with entries carrying their `path`, `ev(ts, type, rest)`, `run(at, lessons)` building a `RunReport` whose member rows are summed from the lessons (each lesson defaults `member`, `id`, `decision`, `reason`), and `record(over)` for decision records.

- [ ] **Step 1: Write the failing test**

```ts
test("totals per window, per member and per source; duplicates come from the field or the reason", () => {
  // The current window is the last `window.runs` reports; here one, so the older run is the previous window.
  const m = decisionsMetrics(snapshot({ window: { days: 30, runs: 1 }, runs: [
    run("2026-09-01T06:00:00Z", [{ member: "lee", decision: "merged", confidence: 80, source: "manual" }]),
    run("2026-10-20T06:00:00Z", [
      { member: "lee", decision: "merged", confidence: 76, source: "pr-feedback", origin: "review" },
      { member: "lee", decision: "review", confidence: 68, source: "manual" },
      { member: "sam", decision: "declined", confidence: 92, reason: "duplicate of x, which it reconfirms" },
      { member: "sam", decision: "declined", confidence: 30, duplicateOf: "y" },
      { member: "sam", decision: "declined", confidence: 20 },
    ]),
  ] }));
  expect(m.current).toEqual({ merged: 1, review: 1, declined: 3, duplicates: 2, total: 5, autoMergeShare: 1 / 3 });
  expect(m.previous).toMatchObject({ merged: 1, total: 1 });
  expect(m.byMember.map((x) => [x.member, x.merged, x.review, x.declined])).toEqual([["lee", 1, 1, 0], ["sam", 0, 0, 3]]);
  expect(m.bySource.find((s) => s.source === "unknown")?.declined).toBe(3);
  expect(m.perRun).toHaveLength(1);
});
```

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**. Types:

```ts
export interface DecisionTotals { merged: number; review: number; declined: number; duplicates: number; total: number; /** merged over decisions that were not duplicates */ autoMergeShare?: number }
export interface DecisionsMetrics {
  current: DecisionTotals; previous?: DecisionTotals;
  perRun: ({ at: string } & DecisionTotals)[];
  byMember: ({ member: string } & DecisionTotals)[];
  bySource: ({ source: string } & DecisionTotals)[];
}
```

A run is in the current window when it is among the last `window.runs` reports; the ones before are the previous window (`previous` is `undefined` when there are none). `isDuplicate(l) = l.duplicateOf !== undefined || /^duplicate of /.test(l.reason)`. `autoMergeShare = ratio(merged, total - duplicates)`. `bySource` groups by `l.source ?? "unknown"`, sorted by source; `byMember` sorted by member.

- [ ] **Step 4: Run**: PASS.

### Task 4: Calibration

**Files:**
- Create: `packages/core/src/metrics/calibration.ts`
- Test: `packages/core/test/metrics-calibration.test.ts`

- [ ] **Step 1: Write the failing test**, with a fixture shaped like the first live run (34 at 68 to review of which 30 merged by a reviewer and 4 closed, 12 at 76 to review all merged, 11 merged at 82, duplicates declined at 86 and 92, one open review at 60):

```ts
test("bands of ten, the configured lines, reviewer agreement and the band under accept", () => {
  const decided = [
    ...Array.from({ length: 30 }, () => record({ decision: "merged", confidence: 68, pr: "homeostat/review-x", settledAt: "2026-10-20T09:00:00Z", reason: "merged by a reviewer" })),
    ...Array.from({ length: 4 }, () => record({ decision: "declined", confidence: 68, pr: "homeostat/review-x", settledAt: "2026-10-20T09:00:00Z", reason: "closed by a reviewer" })),
    ...Array.from({ length: 12 }, () => record({ decision: "merged", confidence: 76, pr: "homeostat/review-x", reason: "merged by a reviewer" })), // settled by a 0.2.1 run: no settledAt, but a pr
    ...Array.from({ length: 11 }, () => record({ decision: "merged", confidence: 82, pr: "homeostat/daily-lee-2026-10-20" })), // merged by the run itself
    record({ decision: "declined", confidence: 86, reason: "duplicate of a, which it reconfirms" }),
    record({ decision: "declined", confidence: 92, reason: "duplicate of b, which it reconfirms" }),
    record({ decision: "review", confidence: 60, pr: "homeostat/review-y" }),
  ];
  const c = calibration(snapshot({ decisions: [{ member: "lee", decided }] }));
  expect(c.lines).toEqual({ decline: 35, accept: 70, coreAccept: 80 });
  expect(c.bands).toHaveLength(10);
  expect(c.bands[6]).toEqual({ from: 60, to: 69, merged: 0, reviewMerged: 30, reviewDeclined: 4, reviewOpen: 1, declined: 0 });
  expect(c.bands[7]).toMatchObject({ reviewMerged: 12 });
  expect(c.bands[8]).toMatchObject({ merged: 11, declined: 1 });
  expect(c.reviewerAgreement).toBeCloseTo(42 / 46);
  expect(c.underAccept).toEqual({ from: 60, to: 69, merged: 30, of: 34 });
});
```

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**: `wasReview(r) = r.settledAt !== undefined || (r.pr?.startsWith("homeostat/review-") === true && r.decision !== "review")`. A lesson merged by the daily run also carries its `pr` (the `homeostat/daily-…` branch, daily.ts line 552), so the branch prefix matters, not the presence of a PR. Export `wasReview` for Task 5. Band index `Math.min(9, Math.floor(confidence / 10))`; records without `confidence` are skipped. Only records whose `at` is in the current days window count, so the figures match the page's window. `lines` from `config.scoring.confidence`. `underAccept` is the band containing `accept - 1`, with `merged = reviewMerged`, `of = reviewMerged + reviewDeclined`. `reviewerAgreement = ratio(sum reviewMerged, sum reviewMerged + reviewDeclined)`.

- [ ] **Step 4: Run**: PASS.

### Task 5: Review latency

**Files:**
- Create: `packages/core/src/metrics/latency.ts`
- Test: `packages/core/test/metrics-latency.test.ts`

- [ ] **Step 1: Test**: settled records with `openedAt`/`settledAt` give median and p90 hours; records settled without timestamps are skipped and counted in `unmeasured`; open reviews list `hoursOpen` from `openedAt ?? at`, oldest first, `overdue` past `REVIEW_REMINDER_DAYS`; `previous.medianHours` from the previous window.

```ts
test("hours from opening to settling, and the open queue oldest first", () => {
  const l = reviewLatency(snapshot({ decisions: [{ member: "lee", decided: [
    record({ decision: "merged", openedAt: "2026-10-20T04:00:00Z", settledAt: "2026-10-20T07:00:00Z", pr: "r1" }),
    record({ decision: "declined", openedAt: "2026-10-19T04:00:00Z", settledAt: "2026-10-20T04:00:00Z", pr: "r2" }),
    record({ decision: "merged", pr: "r0", reason: "merged by a reviewer" }), // settled by 0.2.1: no times
    record({ decision: "review", id: "old", at: "2026-10-17T04:00:00Z", pr: "r3" }),
    record({ decision: "review", id: "new", at: "2026-10-21T04:00:00Z", openedAt: "2026-10-21T04:00:00Z", pr: "r4" }),
  ] }] }));
  // Nearest-rank percentiles (Task 2): of 3 h and 24 h the median is 3 h.
  expect(l).toMatchObject({ settled: 2, unmeasured: 1, medianHours: 3, p90Hours: 24 });
  expect(l.open.map((o) => [o.id, Math.round(o.hoursOpen), o.overdue])).toEqual([["old", 104, true], ["new", 8, false]]);
});
```

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement** with the `ReviewLatency` interface (`settled`, `unmeasured`, `medianHours?`, `p90Hours?`, `previous?: { medianHours?: number }`, `open: { id; member; pr?; confidence?; hoursOpen; overdue }[]`). A record is settled when `settledAt` is present, measured when it also has `openedAt`; `unmeasured` counts settled-by-reviewer records without times (`wasReview` from Task 4, decision not `review`, no `settledAt`). Windows by `settledAt`.

- [ ] **Step 4: Run**: PASS.

### Task 6: Reach

**Files:**
- Create: `packages/core/src/metrics/reach.ts`
- Test: `packages/core/test/metrics-reach.test.ts`

- [ ] **Step 1: Test** with the starter KB's entries (two accepted rules, `redact-before-logging` and `outbound-http-retry-helper`; `use-design-tokens-for-colors` is a candidate) and three members (dana, lee, sam):

```ts
test("injections per day, rules served against the rules reachable here, overflow, docs, team counters", () => {
  const r = reach(snapshot({
    events: [
      ev("2026-10-20T10:00:00Z", "injection", { session: "a", source: "startup", entries: [{ id: "redact-before-logging", form: "full" }], dropped: ["use-design-tokens-for-colors"], tokens: 300 }),
      ev("2026-10-20T11:00:00Z", "injection", { session: "a", source: "update", entries: [{ id: "outbound-http-retry-helper", form: "rule" }] }),
      ev("2026-10-21T10:00:00Z", "injection", { session: "b", source: "startup", entries: [], dropped: [], tokens: 0 }),
      ev("2026-10-21T10:00:01Z", "doc-injection", { session: "b", docs: ["integrations/partner-calls"], sections: ["auth"] }),
      ev("2026-10-21T10:05:00Z", "doc-read", { doc: "integrations/partner-calls", section: "auth" }),
      ev("2026-08-01T10:00:00Z", "injection", { session: "z", source: "startup", entries: [], tokens: 0 }), // outside both windows
    ],
    heartbeats: [
      { member: "lee", at: "2026-10-21T08:00:00Z", kbCommit: null, behind: 0, pending: 0, version: "0.2.2", usage: { "2026-10-21": { sessions: 2, injections: 3, rules: 9, mcpCalls: 1, docReads: 0 } } },
      { member: "sam", at: "2026-10-21T08:00:00Z", kbCommit: null, behind: 0, pending: 0, version: "0.2.1" },
    ],
  }));
  expect(r.injectionsByDay).toHaveLength(30);
  expect(r.injectionsByDay.at(-1)).toEqual({ day: "2026-10-21", count: 1 });
  expect(r).toMatchObject({ sessions: 2, distinctRules: 2, reachable: 2, servedShare: 1, indexOverflowShare: 0.5 });
  expect(r.docs).toEqual({ listed: 1, read: 1, pullThrough: 1 });
  expect(r.team).toMatchObject({ sharing: 1, members: 3 });
  expect(r.team?.byDay.at(-1)).toEqual({ day: "2026-10-21", sessions: 2, injections: 3, rules: 9, mcpCalls: 1, docReads: 0 });
});
```

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**: `injectionsByDay` counts all injection events per day over `window.days`. `sessions` = distinct `session` values in the window. `distinctRules` = distinct ids in `entries[].id` across injections in the window. `reachable`: accepted entries that are not rejected decisions (`isRejectedDecision`), restricted with `inRepo(entries, config, repo)` for each distinct `repo` seen in the window's injections (or every entry when none carries `repo`, the single-repo case), unioned by id, then `visibleTo(…, config, snapshot.member)`. `inRepo` needs a definite `path`, so narrow to the entries that have one first (`entries.filter((e): e is Entry & { path: string } => e.path !== undefined)`). `indexOverflowShare` = startup injections with a non-empty `dropped` over startup injections. `docs.listed` = distinct section ids across `doc-injection.sections`; `docs.read` = distinct `doc#section` across `doc-read`; `pullThrough = ratio(read, listed)`. `team`: heartbeats with `usage` are `sharing`; `members = config.team.members.length`; `byDay` sums each member's per-day counts over the last 7 days (days with no data are 0). `previous: { sessions, distinctRules }` for the trend. Reuse `isRejectedDecision` from `../schema.ts`, `inRepo`/`visibleTo` from `../visibility.ts`.

- [ ] **Step 4: Run**: PASS.

### Task 7: Runtime

**Files:**
- Create: `packages/core/src/metrics/runtime.ts`
- Test: `packages/core/test/metrics-runtime.test.ts`

- [ ] **Step 1: Test**

```ts
test("session start, context, MCP, daily runs and sync, from events and run timing", () => {
  const r = runtime(snapshot({ window: { days: 30, runs: 1 }, events: [
    ev("2026-10-20T10:00:00Z", "injection", { session: "a", source: "startup", ms: 120, ok: true, tokens: 300, chars: 1200, entries: [{ id: "x", form: "full" }, { id: "y", form: "rule" }] }),
    ev("2026-10-20T11:00:00Z", "injection", { session: "b", source: "startup", ms: 480, ok: true, tokens: 500, chars: 2000, entries: [{ id: "x", form: "full" }] }),
    ev("2026-10-20T12:00:00Z", "injection", { session: "c", source: "startup", ms: 60, ok: false }),
    ev("2026-10-20T13:00:00Z", "injection", { session: "a", source: "update", ms: 999, entries: [] }), // prompt-time: not a session start
    ev("2026-10-19T10:00:00Z", "injection", { session: "d", source: "startup", tokens: 100, entries: [] }), // 0.2.1: no ms
    ev("2026-09-01T10:00:00Z", "injection", { session: "p", source: "startup", ms: 900, ok: true, tokens: 100, entries: [] }), // previous window
    ev("2026-10-20T10:01:00Z", "mcp-call", { tool: "context", ms: 30, ok: true }),
    ev("2026-10-20T10:02:00Z", "mcp-call", { tool: "context", ms: 50, ok: false }),
    ev("2026-10-20T10:03:00Z", "mcp-call", { tool: "read" }), // 0.2.1: no ms
    ev("2026-10-20T10:04:00Z", "sync-run", { ms: 2000, ok: true }),
    ev("2026-10-20T10:05:00Z", "sync-run", { ms: 100, ok: false, step: "push" }),
  ], runs: [
    { ...run("2026-10-19T06:00:00Z", [{}]), timing: { started: "2026-10-19T06:00:00Z", finished: "2026-10-19T06:04:00Z", modelCalls: 4, chars: 1000, failedCalls: 0 } },
    { ...run("2026-10-20T06:00:00Z", [{}, {}]), timing: { started: "2026-10-20T06:00:00Z", finished: "2026-10-20T06:03:00Z", modelCalls: 6, chars: 2000, failedCalls: 1 } },
  ] }));
  expect(r.sessionStart).toEqual({ count: 2, median: 120, p90: 480, failures: 1, previous: { count: 1, median: 900, p90: 900 } });
  expect(r.context).toEqual({ injections: 3, tokensMedian: 300, charsMedian: 1200, fullShare: 2 / 3 });
  expect(r.mcp).toEqual([
    { tool: "context", calls: 2, failures: 1, latency: { count: 2, median: 30, p90: 50 } },
    { tool: "read", calls: 1, failures: 0 },
  ]);
  expect(r.dailyRuns).toEqual([{ at: "2026-10-20T06:00:00Z", durationMs: 180_000, modelCalls: 6, chars: 2000, failedCalls: 1, lessons: 2, callsPerLesson: 3 }]);
  expect(r.lastRun).toEqual({ at: "2026-10-20T06:00:00Z", durationMs: 180_000, previousMedianMs: 240_000 });
  expect(r.sync).toEqual({ runs: 2, failures: 1, latency: { count: 2, median: 100, p90: 2000 } });
});
```

`context.injections` counts startup injections in the window with `tokens` (the failed one has none); `fullShare` is full forms over all forms in those injections. `sessionStart.failures` counts startup injections with `ok: false`. `mcp` is sorted by tool name; a tool with no `ms` has no `latency`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement** the `Runtime` interface:

```ts
export interface Runtime {
  sessionStart?: Percentiles & { previous?: Percentiles; failures: number };
  context?: { injections: number; tokensMedian: number; charsMedian?: number; fullShare?: number };
  mcp: { tool: string; calls: number; failures: number; latency?: Percentiles }[];
  dailyRuns: { at: string; durationMs?: number; modelCalls?: number; chars?: number; failedCalls?: number; lessons: number; callsPerLesson?: number }[];
  lastRun?: { at: string; durationMs?: number; previousMedianMs?: number };
  sync?: { runs: number; failures: number; latency?: Percentiles };
}
```

`dailyRuns` covers the current window's runs; `lastRun.previousMedianMs` is the median duration of the other runs on record that have timing.

- [ ] **Step 4: Run**: PASS.

### Task 8: Health trend and the KB snapshot shared with the daily run

**Files:**
- Create: `packages/core/src/metrics/health-trend.ts`
- Test: `packages/core/test/metrics-health.test.ts`

- [ ] **Step 1: Test**

```ts
test("the KB snapshot counts what the daily run records, and the trend reads it back per run", () => {
  const s = snapshot();
  expect(kbSnapshot(s.entries, s.config, NOW)).toEqual({ accepted: 2, stale: 0, flagged: 0, disputed: 0, possibleDuplicates: 0 });
  // 181 days after the starter rules were last confirmed (2026-10-07), both are stale.
  expect(kbSnapshot(s.entries, s.config, new Date("2027-04-07T00:00:00Z")).stale).toBe(2);
  const kb = { accepted: 5, stale: 1, flagged: 0, disputed: 0, possibleDuplicates: 2 };
  const t = healthTrend(snapshot({ runs: [run("2026-10-19T06:00:00Z", []), { ...run("2026-10-20T06:00:00Z", []), kb }] }));
  expect(t).toEqual([{ at: "2026-10-20T06:00:00Z", ...kb }]);
});
```

Stale uses `config.agents.deepDive.staleAfterDays` (180) against `lastConfirmed`, as the dashboard's `health()` does; `possibleDuplicates` counts `detectConflicts` results of kind `possible-duplicate`; `flagged` counts entries with flags; `disputed` counts status `disputed`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**. Export the `KbSnapshot` type and `HealthPoint = { at: string } & KbSnapshot`; the `RunReport.kb` field (added in Task 9) uses `KbSnapshot`.

- [ ] **Step 4: Run**: PASS.

### Task 9: Report types and `metricsReport`

**Files:**
- Modify: `packages/core/src/automation.ts` (add the optional fields; types only, no behaviour)
- Create: `packages/core/src/metrics/index.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/metrics-report.test.ts`

- [ ] **Step 1: Add the fields** to `automation.ts` with doc comments: `DecisionRecord.openedAt?`, `DecisionRecord.settledAt?`; `Heartbeat.usage?: Record<string, UsageDay>` with `export interface UsageDay { sessions: number; injections: number; rules: number; mcpCalls: number; docReads: number }`; `RunReport.lessons[].source?: string`, `.origin?: "pending" | "review"`, `.duplicateOf?: string`; `RunReport.timing?: { started: string; finished: string; modelCalls: number; chars: number; failedCalls: number }`; `RunReport.kb?: KbSnapshot` (`import type { KbSnapshot } from "./metrics/health-trend.ts"`; the type-only import keeps the cycle through `metrics/types.ts` erasable).

- [ ] **Step 2: Test**: `metricsReport(snapshot({}))` on an empty snapshot returns every group with empty arrays and no NaN anywhere (`JSON.stringify` the result and assert it contains no `null` from NaN); with the fixtures from Tasks 3-8 the groups are present. (The `null` check works only because no report field is legitimately null; say so in a comment.)

- [ ] **Step 3: Implement** `index.ts`:

```ts
export interface MetricsReport {
  window: { days: number; runs: number; since: string; runsOnRecord: number };
  decisions: DecisionsMetrics; calibration: Calibration; latency: ReviewLatency;
  reach: Reach; runtime: Runtime; healthTrend: HealthPoint[];
}
export function metricsReport(snap: MetricsSnapshot): MetricsReport
```

Export from `packages/core/src/index.ts`: `metricsReport`, `DEFAULT_WINDOW`, `kbSnapshot`, `percentiles`, and the types (`MetricsSnapshot`, `MetricsReport`, `DecisionsMetrics`, `Calibration`, `ReviewLatency`, `Reach`, `Runtime`, `HealthPoint`, `KbSnapshot`, `UsageDay`, `Percentiles`).

- [ ] **Step 4: Run** `npx vitest run packages/core/test/metrics-*.test.ts` and `pnpm typecheck`. Expected: PASS.

### Task 10: `homeostat metrics`

**Files:**
- Create: `packages/cli/src/metrics-command.ts`
- Modify: `packages/cli/src/cli.ts` (register after `events`, around line 430)
- Modify: `docs/guide/dashboard.md` (a short "From the terminal" paragraph) and the command table in `README.md` (a row after `homeostat events`, line 57)
- Test: `packages/cli/test/metrics.test.ts`

- [ ] **Step 1: Test** using `runCli` as `events.test.ts` does: (a) `--json` on a clone with a state branch (reuse the `team()` helper pattern from `daily.test.ts`, or the simpler `clone()` from Task 1) prints an object with the six groups and `window.days` 30; (b) `--days 7 --runs 5` are honoured in `window`; (c) a KB without a state branch prints the Reach and Runtime sections and the line `no runs yet` under the run-based headings, exit 0; (d) no KB: exit 1 with the same message as `events`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement** `runMetrics(opts: { dir?; days?; runs?; json? }, io)`: resolve the root like `runEvents`; `validate(readKbFiles(root))`; `readEvents(root, { since: now - 2*days })`; `readState(root, 2*runs)`; `member = memberFromGit(config.team.members, git(root, "config", "user.name"))` with `memberFromGit` from `@homeostat/core` (`packages/core/src/handles.ts`) and `git` from `packages/cli/src/git.ts`; import core's `readState` directly (hook.ts has an unrelated private `readState` for handoff state); build the snapshot; `metricsReport`. Text output: six headings in panel order (`Summary`, `Calibration`, `Decisions and health`, `Reach`, `Runtime`, `Review latency`), two-space indented `label  value` lines, percentages rounded, hours to one decimal, `—` for undefined. Under run-based headings print `no runs yet` when `state.present` is false.

- [ ] **Step 4: Register** in `cli.ts`:

```ts
program
  .command("metrics")
  .description("Performance metrics: decisions, calibration, review latency, reach and runtime.")
  .option("--dir <dir>", "knowledge base root (default: $HOMEOSTAT_DIR or the current dir)")
  .option("--days <n>", "window in days", "30")
  .option("--runs <n>", "daily runs to read", "30")
  .option("--json", "print JSON")
  .action((opts) => { exitCode = runMetrics(opts, io); });
```

- [ ] **Step 5: Run** the test, then `pnpm check`. Expected: PASS, 793 + new tests.

- [ ] **Step 6: Commit** `feat: metrics module in core and homeostat metrics`.

---

## Chunk 2: data fields, docs, plugin fixes (commit 2)

### Task 11: Hook timing

**Files:**
- Modify: `packages/cli/src/hook.ts:59-160` (sessionStart)
- Test: `packages/cli/test/hook-session-start.test.ts`

- [ ] **Step 1: Tests**: extend "logs what was injected" to expect `ms` (a number ≥ 0), `ok: true` and `chars` (the length of the whole context injected, over 100 here) on the event; add "a broken KB logs the start with ok: false" (the test at line 144 already builds a broken KB; assert `readEvents(kbDir)` has one injection with `ok: false`, no `entries`); add "a prompt-time injection carries no ms" (reuse the sync test's long-session case or the `prompt` handler test, assert `ms` undefined on the `update` event).

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**: at the top of `sessionStart`, `const started = performance.now();` and `let record: Record<string, unknown> | undefined;`. Replace the early `logEvent` (line 92) with assignment of the same object to `record`, plus `chars: context.length` once the context is assembled. Declare `const ts = (io.now?.() ?? new Date()).toISOString()` and `let failed = false` before the try. Wrap the body from the `validate(readKbView(...))` call (line 64, so the `HookSkip` for an invalid config is inside) to the final `io.stdout` in `try { … } catch (e) { failed = true; throw e } finally { logEvent(kbRoot, { ts, type: "injection", session: input.session_id, source: input.source, cwd, ...(record ?? {}), ok: !failed, ms: Math.round(performance.now() - started) }) }`. `if (!kbRoot) return` stays outside, so a session with no KB logs nothing; the early `if (!context) return` inside is fine (`finally` runs, `ok: true`). `chars` is `context.length`, the whole text injected. The `finally` runs after `io.stdout`, so `ms` excludes the event write.

- [ ] **Step 4: Run** hook tests and `packages/cli/test/sync.test.ts`. PASS.

### Task 12: MCP call timing

**Files:**
- Modify: `packages/mcp/src/server.ts:270-460`
- Test: `packages/mcp/test/server.test.ts`

- [ ] **Step 1: Tests**: "context … logs it" expects the `mcp-call` event to carry `ms` and `ok: true`; "bad arguments get a clear message" expects an `mcp-call` with `ok: false`; the unknown-tool test still expects only `mcp-unknown-tool`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**: remove the early `deps.log({ ts, type: "mcp-call", tool })`. Declare `type ToolResult = ReturnType<typeof fail>` (the shape `text()` and `fail()` return). Move everything after the unknown-tool early return into `const dispatch = async (): Promise<ToolResult> => { … }`. Then:

```ts
const started = performance.now();
let result: ToolResult;
try { result = await dispatch(); } catch (e) { result = fail(`${tool} failed: ${(e as Error).message}`); }
deps.log({ ts, type: "mcp-call", tool, ms: Math.round(performance.now() - started), ok: result.isError !== true });
return result;
```

Keep `describeEvent` output unchanged (it prints `tool ${rest.tool}`).

- [ ] **Step 4: Run**: PASS.

### Task 13: Sync run event and opt-in usage counters

**Files:**
- Create: `packages/core/src/metrics/usage.ts` (`usageCounts(events, now, days = 7): Record<string, UsageDay>`)
- Modify: `packages/core/src/config.ts:63-90` (`usage: z.boolean().optional()` on a member, with a doc comment)
- Modify: `packages/cli/src/sync.ts:90-260`
- Modify: `packages/dashboard/src/settings.ts:407-424` (read `member.<i>.usage` like `optOut`) and `packages/dashboard/src/views.ts:863` (the member row editor's checkbox)
- Modify: `packages/core/src/index.ts` (export `usageCounts`) and `packages/core/src/events.ts` (`describeEvent` case for `sync-run`: `${ms} ms${ok ? "" : `, failed at ${step}`}`), with a line in `packages/core/test/describe-event.test.ts`
- Modify: `docs/guide/config.md:10` (mention `usage: true`)
- Test: `packages/core/test/metrics-usage.test.ts`, `packages/cli/test/sync.test.ts`, `packages/dashboard/test/settings.test.ts` (runs unchanged)

- [ ] **Step 1: Tests**: `usageCounts` turns injection, mcp-call and doc-read events into per-day counts, `sessions` distinct per day, days without events present with zeros, nothing older than 7 days; in `sync.test.ts`: a sync logs one `sync-run` event with `ok: true` and `ms`; the heartbeat has no `usage` by default; with `usage: true` on the member in `homeostat.yaml` the heartbeat carries `usage` with only the five counters; with `HOMEOSTAT_SHARE_USAGE=1` likewise; a failing push logs `sync-run` with `ok: false, step: "push"`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**: in `runSync`, `const started = performance.now()` at the top and `let ok = true; let step = "fetch"`. Nothing in the sync throws (`git()` returns `undefined` on failure, and the push failure is already caught at line 231), so set `ok = false` where failures are detected today: in the push `catch` (`step = "push"`), and when the fetch of the base branch returns `undefined` (`step = "fetch"`); the state and candidates fetches may fail before any daily run, which is not a failure. Log once before every `return` after the config check: `logEvent(root, { type: "sync-run", ms: Math.round(performance.now() - started), ok, ...(ok ? {} : { step }) })`. The `return 1` for a missing config logs nothing (no KB to log to); the `return 0` for no origin logs `ok: true`. `usageCounts` counts every `injection` event toward `injections` and `rules` (startup, update and MCP alike), `sessions` as distinct `session` ids per day, `mcpCalls` from `mcp-call`, `docReads` from `doc-read`; `readEvents` takes `since` as an ISO string. Opt-in: `const shares = config.team.members.find((m) => m.id === member)?.usage === true || io.env?.HOMEOSTAT_SHARE_USAGE === "1"`; when true, `heartbeat.usage = usageCounts(readEvents(root, { since: now - 8 days }), now)`. In `settings.ts`, add `...(form.get(\`member.${i}.usage\`) ? { usage: true } : {})` and the matching checkbox in the row editor.

- [ ] **Step 4: Run** sync, settings and config tests. PASS.

### Task 14: Daily run: report fields, timing, kb, decision timestamps

**Files:**
- Modify: `packages/cli/src/agents.ts` (an optional `stats` counter)
- Modify: `packages/cli/src/daily.ts:98-130, 150-195, 246, 422, 596-640`
- Test: `packages/cli/test/daily.test.ts`

- [ ] **Step 1: Tests**: in the first test, the report carries `timing` with `modelCalls: 0, chars: 0, failedCalls: 0` (the test passes a `FakeDrafter`, so no asker runs) and `kb` with `accepted: 3` (the starter KB's two plus the drafted lesson that merged); a new unit test in `packages/cli/test/agents.test.ts` calls the function `askerFor` returns with `config.agents.runtime` set to `api` and no key, expects it to throw, and asserts `stats` is `{ calls: 1, chars: system.length + user.length, failed: 1 }`; every report lesson carries `origin` and `source` (`manual` for Lee's, `pr-feedback` for the drafted one); the review decision carries `openedAt` equal to the run's `now`. In the settle test (the one that sets `provider.kbMerged`), the settled record carries `settledAt: "2026-10-16T12:00:00Z"` (the fake's `mergedAt`) and a closed one carries the run's time. The reconfirm scenario at `daily.test.ts:463` runs with `--dry-run`, which writes no state; add a copy of it without `--dry-run` that reads `runs/2026-10-16T06-00-00Z.json` from the state branch and expects the twin lesson with `decision: "declined"` and `duplicateOf: "outbound-http-retry-helper"`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**: `askerFor(config, agent, io, kbRoot, stats?: { calls: number; chars: number; failed: number })` increments `stats` in `record`. In `runDaily`, `const stats = { calls: 0, chars: 0, failed: 0 }` and `const started = now` at the top; pass `stats` at both `askerFor` call sites. In the settle loop build `const mergedAt = new Map(prs.map((p) => [p.sourceBranch, p.mergedAt]))` and set `r.settledAt = mergedAt.get(r.pr) ?? now.toISOString()` next to `r.at = …`. In the report push add `source: l.kind === "doc" ? "doc" : parseEntry(l.text).entry?.frontmatter.source.type`, `origin: l.origin`, and `duplicateOf` when set; in the record add `openedAt: now.toISOString()`. Before writing state: `report.timing = { started: started.toISOString(), finished: (io.now?.() ?? new Date()).toISOString(), modelCalls: stats.calls, chars: stats.chars, failedCalls: stats.failed }` and `report.kb = kbSnapshot(validate(refFiles(root, remote(base))).entries.map((e) => ({ ...e.entry, path: e.path })), config, now)` after a fresh `git fetch` of `base` (as `onFreshBase` does at line 140); `refFiles` in `packages/cli/src/kb-write.ts:13` reads a whole KB at a ref.

- [ ] **Step 4: Run** `npx vitest run packages/cli/test/daily.test.ts`. PASS.

### Task 15: Doctor: usage listing and PATH binary check

**Files:**
- Modify: `packages/cli/src/doctor.ts:214-275`
- Test: `packages/cli/test/doctor.test.ts`

- [ ] **Step 1: Tests**: the "What leaves your network?" section lists `usage counts shared by: lee` when Lee has `usage: true` in config, and `nobody shares usage counts` otherwise; with a fake `homeostat` script on a temp `PATH` printing `0.1.7`, the "compromised" section has a `warn` naming both versions; with a script printing the current `VERSION`, an `ok`; with none, an `info`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement**: `sharingUsage(root, config)` = config members with `usage` plus members whose heartbeat in `readState(root).heartbeats` carries `usage`, deduplicated; `pathBinaryCheck(io)`: find `homeostat` on `io.env.PATH` (split on `path.delimiter`, `existsSync(join(dir, "homeostat"))`), run `execFileSync(bin, ["--version"], { timeout: 2000, encoding: "utf8" })` in a try, compare the trimmed output with `VERSION`.

- [ ] **Step 4: Run**: PASS.

### Task 16: Plugin runner prefers the pinned version

**Files:**
- Modify: `packages/plugin/hooks/run.mjs`
- Test: `packages/cli/test/hook-launcher.test.ts`

- [ ] **Step 1: Tests**, one fresh `mkdtemp` bin dir per scenario (the cache is keyed by binary path and mtime, and rewriting a script within a second can keep its mtime): each dir holds an executable (`#!/bin/sh`, `chmod 755`) `homeostat` script that appends its arguments to a marker file and prints a given version for `--version`, and an `npx` script that writes its own marker. Run the launcher with `PATH=<bin>:<dirname of process.execPath>` (the fake `npx` shadows the real one) and no `HOMEOSTAT_CLI` in `env`: (a) version equal to the plugin's: the hook marker exists, `npx` was not run; (b) version `0.1.7`: the `npx` marker holds `--yes homeostat@<plugin version> hook session-start`, the hook marker does not exist; (c) a script that sleeps 5 s on `--version`: falls through to `npx` (test timeout 15 s); (d) scenario (a) run twice: the marker shows one `--version` invocation, since the second run read the cache file. Delete the cache files the tests created in `afterAll`.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement** in `run.mjs`, lazily: candidates are tried in order and the PATH probe runs only when `HOMEOSTAT_CLI` is unset or missing, so the existing launcher tests (which set it) never spawn a real `homeostat`. `findOnPath("homeostat")` walks `process.env.PATH` with `existsSync`; `versionOf(bin)` using `spawnSync(bin, ["--version"], { timeout: 2000, encoding: "utf8" })`, trimmed, `undefined` on any error, signal or non-zero status; cache at `join(tmpdir(), \`homeostat-plugin-${hash(bin)}.json\`)` holding `{ mtimeMs, version, checkedAt }`, valid for 24 h when `mtimeMs` matches `statSync(bin).mtimeMs`; candidates order: `HOMEOSTAT_CLI`, the PATH binary only when `versionOf === version`, then npx. Update the file's header comment.

- [ ] **Step 4: Run**: PASS. Also `npx vitest run packages/cli/test/plugin.test.ts`.

### Task 17: Documentation and architecture

**Files:**
- Modify: `docs/data-handling.md` ("Nothing else" bullet; "What it stores" row; "How to turn each part off" row)
- Modify: `docs/architecture.md` (Event log paragraph; the `homeostat/state` table row for the run report; Monitoring paragraph mentions the Performance page)
- Modify: `docs/guide/config.md`, `docs/guide/dashboard.md` (Performance page section, written now so chunk 3 only ships it)

- [ ] **Step 1**: Edit the texts. The heartbeat sentence becomes: "…plus a small heartbeat (your member id, KB commit, pending count, Homeostat version, and, only if you set `usage: true` on your member or `HOMEOSTAT_SHARE_USAGE=1`, per-day counts of your sessions, injections, rules served, MCP calls and document reads for the last seven days; never rule ids, paths or times finer than a day)". Storage row: "**Usage counts in the heartbeat** (opt-in): …". Turn-off row: "Sharing usage counts | Leave `usage` unset on your member and `HOMEOSTAT_SHARE_USAGE` unset (the default)".

- [ ] **Step 2**: `npx vitest run packages/cli/test/versions.test.ts packages/core/test/config-docs.test.ts` (the config docs test checks every key is documented). PASS.

- [ ] **Step 3**: `pnpm check`; the employer-name grep. **Commit** `feat: timing, usage counters and run-report fields for metrics; the plugin runner prefers its pinned version`.

---

## Chunk 3: the Performance page (commit 3)

### Task 18: Stacked columns with markers and lines

**Files:**
- Modify: `packages/dashboard/src/charts.ts` (add `stackedColumns`)
- Modify: `packages/dashboard/src/views.ts` (the stylesheet near line 231: `.chart .part { }` is not needed because parts carry inline `style`; add `.chart polyline { fill: none; stroke-width: 1.5 }` and `.chart .marker { stroke: var(--ink-3); stroke-dasharray: 3 4 }`, `.chart .marker-label { fill: var(--ink-2); font-size: 11px }`)
- Test: `packages/dashboard/test/charts.test.ts`

Signature:

```ts
export interface StackedDatum { label: string; title?: string; parts: { name: string; value: number; color: string }[] }
export function stackedColumns(
  data: readonly StackedDatum[],
  opts: {
    title: string;
    height?: number;
    tickEvery?: number;
    /** Vertical lines at fractional category positions: a line at confidence 35 on ten-point bands is at 3.5. */
    markers?: { at: number; label: string }[];
    /** Series drawn as polylines on their own scale, one value per category; undefined leaves a gap. */
    lines?: { name: string; values: (number | undefined)[]; color: string }[];
  },
): string
```

- [ ] **Step 1: Test**: `stackedColumns` renders one `<g class="m">` per category with one shape per non-zero part, each part with `style="fill:${color}"` (the stylesheet's `.chart path { fill: var(--accent) }` would otherwise win over a `fill` attribute), a `<title>` listing `name: value` for every part; markers render `<line class="marker">` at `pad.left + at * slot` with a `<text class="marker-label">`; lines render one `<polyline>` per series with `style="stroke:${color}"`, split into several polylines where a value is undefined; an empty series renders the baseline only.

- [ ] **Step 2: Run**: FAIL.

- [ ] **Step 3: Implement** following `columns()`: same width, padding and slot maths; the top part uses `columnPath` (rounded top), the parts below it plain `<rect>`s; the hover rule `.chart .m:hover path { fill: var(--accent-2) }` is beaten by the inline style, so add `.chart .m:hover .part { filter: brightness(1.15) }` and give every part `class="part"`. Lines scale to their own max over the inner height.

- [ ] **Step 4: Run**: PASS.

### Task 19: The page

**Files:**
- Create: `packages/dashboard/src/performance.ts` (`performancePage(report: MetricsReport, opts: { shared: boolean }): string`)
- Modify: `packages/dashboard/src/views.ts:320-334` (NAV entry `["/performance", "Performance"]` after automation; ICON `'<path d="M4 16a8 8 0 0 1 16 0"/><path d="M12 16l4-5"/>'`; hoist `kpi` out of `overviewPage` as `export function kpi(label: string, value: string, delta: number | undefined, tip: string)` where `delta` drives only the arrow, and change `overviewPage`'s four call sites to `kpi("Merged", String(sum(last, "merged")), prev ? sum(last, "merged") - sum(prev, "merged") : undefined, "…")`; `.kpis` gets `grid-template-columns: repeat(var(--cols, 4), minmax(0, 1fr))` so a six-cell row fits; the shared-build `info()` text in `layout()` (line 367) and `docs/guide/dashboard.md:28` mention the hidden Performance panels)
- Modify: `packages/dashboard/src/automation.ts` (export the private `age(hours)` formatter; extract `gitUserName(kbRoot)` from `firstName` and export it)
- Modify: `packages/dashboard/src/server.ts` (`DashboardView.metrics`; `dashboardView` reads `readState(kbRoot, 60)` once, passes `{ ...state, runs: state.runs.slice(-30) }` to `automationView`, builds the snapshot with `member: memberFromGit(config.team.members, gitUserName(kbRoot))`; `renderPage` takes `opts.shared?: boolean` and routes `/performance`)
- Modify: `packages/dashboard/src/build.ts` (add `/performance` to the page list; pass `{ shared: true }`)
- Test: `packages/dashboard/test/performance.test.ts`, `packages/dashboard/test/build.test.ts`, `packages/dashboard/test/server.test.ts`, `packages/dashboard/test/views.test.ts` (new `layout()` test: Performance follows Automation in the nav)

Fixture for the page tests: build a `MetricsSnapshot` from the starter KB (copy the small `snapshot()` builder from `packages/dashboard/test/metrics.test.ts`, with `path` on entries, `runs`, `decisions`, `heartbeats`, `now = 2026-10-21T12:00:00Z`, `window: DEFAULT_WINDOW`) and call `metricsReport`. The calibration fixture: 30 records `{ decision: "merged", confidence: 68, pr: "homeostat/review-lee-2026-10-20", settledAt: "2026-10-20T09:00:00Z", at: "2026-10-20T06:00:00Z", reason: "merged by a reviewer" }` and 4 the same with `decision: "declined"`, in `decisions: [{ member: "lee", decided }]`.

Empty-state strings, one per panel, asserted by test (b): KPIs show `—`; calibration: `No decisions with a confidence yet.`; decisions and health: `No daily run yet.`; reach: `No sessions recorded on this machine yet.` and, for the team series, `No member shares usage counts.`; runtime: `No timed session starts yet.`, `No MCP calls yet.`, `No run timing recorded yet.`, `No syncs recorded yet.`; review latency: `Nothing waiting for review.`

The calibration sentence: `Lessons sent to review at ${from} to ${to} were merged by a reviewer ${merged} of ${of} times.` when `of > 0`, else `No lesson at ${from} to ${to} has been settled by a reviewer yet.`

- [ ] **Step 1: Tests**: (a) the page renders six sections with `aria-labelledby` ids `kpis`, `calibration`, `runs`, `reach`, `runtime`, `latency`, every KPI has an `info()` tooltip (`class="info"` count ≥ 6), and the calibration sentence reads `Lessons sent to review at 60 to 69 were merged by a reviewer 30 of 34 times.`; (b) `metricsReport(snapshot())` on an empty snapshot renders every empty-state string above and no `NaN`; (c) with `shared: true` the local KPIs (`Rules served`, `Session start`) and the session-start, MCP and sync panels are absent, the Reach panel shows only the team series or its empty state; (d) `buildDashboard` writes `performance.html` without the local panels; (e) `GET /performance` on the server is 200 and the nav marks it current; (f) `layout()` renders `Performance` after `Automation` in the nav.

- [ ] **Step 2**: FAIL.

- [ ] **Step 3: Implement** the page, panel by panel, with the hoisted `kpi()` and `impactPage`'s `stat()`:

1. KPI row (`.kpis` with `--cols: 4`, or 6 when not shared): auto-merge share (percent), reviewer agreement (percent), median review latency (`age(hours)`), last run duration (`Ns` or `Nm Ss`); then, unless shared, rules served (`served of reachable`) and median session start (`N ms`). Deltas against `previous` where the group has one; the run duration's delta is against `lastRun.previousMedianMs`.
2. Calibration: `stackedColumns` over the ten bands (labels `0`, `10`, … `90`) with parts merged (`--good`), review then merged (`--accent`), review then declined (`--warning`), declined (`--critical`); markers at `decline / 10`, `accept / 10`, `coreAccept / 10` labelled `decline 35` and so on; the sentence beneath; a `dataTable` of the bands.
3. Decisions and health: `stackedColumns` per run in `decisions.perRun` (label = day, title = the timestamp) with parts merged, review, declined minus duplicates, duplicates; `lines` for accepted, stale, flagged, disputed, possible duplicates aligned to `perRun` by `at` from `healthTrend`, undefined where a run has no `kb`; link to `/automation`.
4. Reach: unless shared, `areaChart` of `injectionsByDay`; when `team` is present a `columns` chart of team injections per day (a second chart, not stacked onto the area chart, because the two cover different windows: 30 local days against each member's last 7) and the line `${sharing} of ${members} members share usage counts`; stats row (local): rules served, index overflow, document pull-through.
5. Runtime: four `.panel span-6` cards: session start (median and p90 ms, injections measured, failures, context tokens and chars medians, full share), MCP (`rows` of calls per tool, latency in the title), daily run (`columns` of duration per run, last against previous median, calls per lesson, failures), sync (runs, failures, median ms). Session start, MCP and sync are omitted when shared.
6. Review latency: settled count, median and p90 (`unmeasured` in the tooltip); the open queue table in the Automation page's style (`age(hoursOpen)`, overdue marked with `chip disputed`); link to `/automation#queue`.

Every heading uses `info()` with the computation and window, for example `info("Lessons the daily run merged on its own, over lessons that were not repeats, in the last 30 runs.")`.

- [ ] **Step 4: Server wiring**: in `dashboardView`, `const state = readState(kbRoot, 2 * DEFAULT_WINDOW.runs)`, `autoState = { ...state, runs: state.runs.slice(-DEFAULT_WINDOW.runs) }`, `metrics = metricsReport({ config, entries, events, runs: state.runs, decisions: state.decisions, heartbeats: state.heartbeats, member, now, window: DEFAULT_WINDOW })` (`readSnapshot` already reads 90 days of events). In `renderPage` add `case "/performance": return ok("Performance", performancePage(v.metrics, { shared: opts.shared === true }))`; `build.ts` passes `{ shared: true }`.

- [ ] **Step 5: Run** all dashboard tests, then `pnpm check`. PASS.

- [ ] **Step 6: Docs**: `docs/guide/dashboard.md` gets a Performance section listing the six panels in one sentence each and the note that a shared build leaves out the per-machine panels; `docs/architecture.md`'s Dashboard paragraph lists `performance`.

- [ ] **Step 7: Commit** `feat: Performance page in the dashboard`.

---

## After the three chunks

- `pnpm check` green, the employer-name grep empty.
- `git log --oneline` shows, newest first: `feat: Performance page in the dashboard`, `feat: timing, usage counters and run-report fields for metrics; the plugin runner prefers its pinned version`, `feat: metrics module in core and homeostat metrics`, `refactor: read the state branch from core`, then the design-doc commits.
- Report to the maintainer with the real figures from `homeostat metrics --dir "<work KB clone>"`. That command is read-only (`git show`, `ls-tree`, `for-each-ref`, no fetch), so it keeps the trial's untouched rule. Ask about cutting 0.2.2; the release steps are in `docs/releasing.md` and need their approval.
