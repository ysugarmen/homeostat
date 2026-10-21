# 0.2.2: performance metrics

Status: agreed design, 2026-10-21, for implementation.

## The problem

Homeostat decides most lessons without a person and injects rules into every session, but nobody can see whether that works. The run reports, decisions and heartbeats on `homeostat/state`, the local event log and the git host's pull requests already hold the raw data, and the dashboard shows parts of it (runs, the review queue, sync health, injections per day). Nothing answers the questions a team asks after a week:

- Are the confidence thresholds right? The first live run under 0.2 sent 34 lessons to review at a confidence of 68, two points under the accept line, and reviewers then merged six of the seven review PRs within three hours.
- How long do lessons wait for a person?
- Do the rules reach sessions, or sit in the KB?
- What does every session start cost, and what does a daily run cost?

Nothing here collects telemetry. Figures are computed where the data already is, and the one new thing that leaves a laptop, per-day usage counts in the heartbeat, is off until a member turns it on.

## Metrics

Every figure is computed at read time from a snapshot: config, entries, the local events, and the state branch's runs, decisions and heartbeats. Unless marked *new*, its data exists today.

### Effectiveness

| Metric | From | Answers |
| --- | --- | --- |
| Decisions per run: merged, review, declined, declined as a duplicate | run reports | how much gets through without a person |
| Auto-merge share, per member and per source type | run reports, decisions | where the middle band is widest |
| Calibration: per confidence band (under 35, 35 to 59, 60 to 69, 70 to 79, 80 and up), how many were merged, sent to review and then merged, sent to review and then declined, declined | decisions after settling | whether 70 and 80 are the right lines |
| Reviewer agreement: share of review-PR lessons a reviewer merged | settled decisions | whether review is a filter or a formality |
| Review latency: hours from a review PR opening to its merge or close, median and 90th percentile | *new* `openedAt` and `settledAt` on decision records, written by the daily run from the host's PR list | how long lessons wait |
| Rule reach: injections per day, distinct rules served, share of accepted rules served at least once in the window | injection events; *new* opt-in heartbeat counters for the team | whether rules reach sessions |
| Index overflow: share of injections that dropped rules to the index | injection events (`dropped`) | whether the token budget is too small |
| Document pull-through: sections read after being listed | doc-injection and doc-read events | whether the documents index earns its tokens |
| Health trend: accepted, stale, flagged, disputed and possible-duplicate counts per run | *new* `kb` snapshot in the run report | whether the KB is decaying |

### Runtime

| Metric | From |
| --- | --- |
| Session start latency: hook wall time, median and 90th percentile | injection event, *new* `ms` |
| Context size: tokens and characters injected; rules in full versus rule-only | injection event (`tokens` exists; *new* `chars`, `full`, `ruleOnly`) |
| MCP latency per tool | mcp-call event, *new* `ms` |
| Daily run: duration, model calls, characters sent, failed calls | *new* `timing` block in the run report |
| Model calls per lesson decided | run report |
| Sync duration and failures | *new* `sync-run` event |

Left out on purpose: dollar cost (price tables go stale), rankings of members by usage (the dashboard does not rank people), and whether a session obeyed a rule (needs the transcript, which Homeostat never reads).

## New data

All fields are optional. Old events, reports and heartbeats keep working, and a 0.2.1 laptop talking to a newer KB keeps working.

**Local events** (git-ignored, pruned after `security.eventRetentionDays`, never leave the machine):

- `injection` gains `ms`, `chars`, `full` and `ruleOnly`.
- `mcp-call` gains `ms`.
- `sync-run`, new: `ms`, `ok`, and `step` when a step failed. No branch names, no lesson content.

**Run report** (`runs/<timestamp>.json` on `homeostat/state`) gains:

```json
"timing": { "started": "…", "finished": "…", "modelCalls": 12, "chars": 410233, "failedCalls": 0 },
"kb": { "accepted": 61, "stale": 0, "flagged": 1, "disputed": 0, "possibleDuplicates": 2 }
```

**Decision records** gain `openedAt` (the review PR's creation time, from the host) and `settledAt` (when the daily run saw it merged or closed). The daily run already lists the host's PRs when it settles, so this adds no call, and the dashboard still makes none.

**Heartbeat usage counters, opt-in.** A member sets `usage: true` on their own entry in `team.members`, or `HOMEOSTAT_SHARE_USAGE=1` in their environment. Then each sync adds to the heartbeat:

```json
"usage": { "2026-10-21": { "sessions": 3, "injections": 5, "rules": 41, "mcpCalls": 2, "docReads": 1 } }
```

Seven days, counts only: no rule ids, paths, repos, session ids, or times finer than a day. The dashboard shows team reach only from members who opted in and says how many did. `homeostat doctor --security` lists them.

**Documentation.** `data-handling.md` gets one row under "What it stores" for the counters and one under "How to turn each part off". `architecture.md` lists the new events and the report fields.

## Surfaces

### Dashboard: `/performance`

In the nav after Automation. Same layout and style as the other pages: dark, inline SVG, minimal text, an (i) tooltip on every figure saying how it is computed and over which window.

1. **KPI row**: auto-merge share, reviewer agreement, median review latency, rules served in the window as a share of accepted rules, median session-start latency, last daily-run duration. Each with a trend arrow against the previous window, as on the overview.
2. **Calibration**: columns per confidence band, each split into merged, review then merged, review then declined, declined. Under it one computed sentence: "Lessons sent to review at 60 to 69 were merged by a reviewer N of M times." The page states, never recommends.
3. **Decisions over time**: stacked columns per run, last 30 runs.
4. **Reach**: injections per day as an area chart, with the opt-in team counters stacked when present and "N of M members share usage counts".
5. **Runtime**: session start (latency percentiles, context size) and daily run (duration, model calls, failures per run).
6. **Review latency**: rows per review PR, oldest open first, overdue marked, in the Automation page's queue style.

The page is in the static build. A shared build hides the per-machine panels (session start, MCP latency, local reach) through the existing local-only mechanism, as the impact and events pages are hidden today.

### CLI: `homeostat metrics`

The same objects as a compact text report under the same six headings. `--json` prints one object for scripts and CI logs. `--days <n>` sets the window (30). `--runs <n>` sets how many run reports to read (30). It reads the clone only, never the host. A clone without a state branch prints "no runs yet" and exits 0.

## Code shape

- `packages/core/src/metrics/`: pure functions over a `MetricsSnapshot` (config, entries, events, runs, decisions, heartbeats, now), one file per group (`decisions.ts`, `calibration.ts`, `latency.ts`, `reach.ts`, `runtime.ts`, `health-trend.ts`) and an `index.ts` that builds the whole report. Each has its own test on a hand-built snapshot.
- The dashboard's `metrics.ts` keeps its functions; the new page and the CLI command are renderers over core's report.
- `readAutomation` in the dashboard already reads runs, decisions and heartbeats from the clone; it moves to core (or a shared helper) so the CLI can use it without a dashboard import.
- Durations use `performance.now()` from Node. No new dependency.

## Testing

- Core: one test file per metrics group. The calibration fixture mirrors the first live run: 34 at 68 to review, 12 at 76 to review, duplicates declined at 86 and 92, and settled outcomes.
- Dashboard: the page renders from a full snapshot and from an empty one; the static build hides the local-only panels.
- CLI: the `--json` shape, and a clone without a state branch.
- Daily run: the report carries `timing` and `kb`, decisions carry `openedAt` and `settledAt`.
- Sync: the heartbeat carries `usage` only when opted in, and only counts.
- Hook and MCP: events carry `ms`; a hook that fails still exits 0 and logs nothing wrong.
- The settings test that every config key has a form covers the new member field.

## Two fixes that ship with this

The trial showed that the plugin's `run.mjs` prefers any `homeostat` on the PATH over the pinned npx version. On the author's laptop that was a global 0.1.7, which rejects the 0.2 config, so the session hooks, the sync and the MCP server exited silently for a day. Two changes:

1. `run.mjs` runs the pinned version unless `HOMEOSTAT_CLI` is set. A PATH binary is used only when its `--version` matches the plugin's.
2. `homeostat doctor` warns when a `homeostat` on the PATH differs from the plugin's version.

## Out of scope

Metrics in the weekly digest, dollar cost, member usage rankings, any shared aggregate beyond the opt-in counters, self-tuning thresholds, and any change to the work KB during its trial.

## Order of work

Three commits on `main`, each passing `pnpm check`:

1. Core metrics module with tests, the shared state reader, and `homeostat metrics`. No behaviour change for anyone.
2. The new event fields, the run-report `timing` and `kb` blocks, the decision timestamps, the opt-in heartbeat counters, `data-handling.md`, `architecture.md`, the doctor's security listing, and the two plugin fixes.
3. The Performance page and the static build change.

Then release 0.2.2 with the maintainer's approval. It also carries the pending learn and review skill updates. KB pipelines stay pinned to 0.2.1 until the trial ends.
