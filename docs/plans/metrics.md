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

Every figure is computed at read time from a snapshot: config, entries, the local events, and the state branch's runs, decisions and heartbeats. Unless marked *new*, its data exists today. The window is 30 days and 30 runs for both surfaces; "the previous window" is the 30 days before it.

### Effectiveness

| Metric | From | Answers |
| --- | --- | --- |
| Decisions per run: merged, review, declined, declined as a duplicate | run reports; *new* `duplicateOf` on the report lesson (today a duplicate is only visible in the reason text) | how much gets through without a person |
| Auto-merge share, per member and per source type | run reports; *new* `source` and `origin` on the report lesson | where the middle band is widest |
| Calibration: per ten-point confidence band, how many were merged, sent to review and then merged, sent to review and then declined, declined. The configured lines (`scoring.confidence.decline`, `accept`, `coreAccept`) are drawn on the chart, and the summary sentence covers the band just under `accept` | decisions after settling. A settled decision was a review when `settledAt` is present | whether the lines are in the right place |
| Reviewer agreement: share of review-PR lessons a reviewer merged | settled decisions | whether review is a filter or a formality |
| Review latency: hours from a review PR opening to its merge or close, median and 90th percentile | *new* `openedAt` and `settledAt` on decision records | how long lessons wait |
| Rule reach: injections per day, distinct rules served, share of the rules visible to this clone (shared plus its repo, minus team-only areas it cannot see) served at least once in the window | injection events; *new* opt-in heartbeat counters for team totals | whether rules reach sessions |
| Index overflow: share of injections that dropped rules to the index | injection events (`dropped`) | whether the token budget is too small |
| Document pull-through: sections read in the window against sections listed, and reads within the same session as a listing | doc-injection and doc-read events; *new* `session` on doc-read | whether the documents index earns its tokens |
| Health trend: accepted, stale, flagged, disputed and possible-duplicate counts per run | *new* `kb` snapshot in the run report | whether the KB is decaying |

### Runtime

| Metric | From |
| --- | --- |
| Session start latency: CLI wall time of the hook, median and 90th percentile | injection event, *new* `ms` and `ok` |
| Context size: tokens and characters injected; rules in full versus rule-only | injection event (`tokens` exists; *new* `chars`, `full`, `ruleOnly`) |
| MCP latency per tool | mcp-call event, *new* `ms` and `ok` |
| Daily run: duration, model calls, characters sent, failed calls | *new* `timing` block in the run report |
| Model calls per lesson decided | run report |
| Sync duration and failures | *new* `sync-run` event |

`ms` is measured inside the CLI, from entry to output ready, with `performance.now()`. It excludes the plugin runner's spawn and Node's startup, which Claude Code also waits for; the page's tooltip says so.

Left out on purpose: dollar cost (price tables go stale), rankings of members by usage (the dashboard does not rank people), and whether a session obeyed a rule (needs the transcript, which Homeostat never reads).

## New data

All fields are optional. Old events, reports and heartbeats keep working, and a 0.2.1 laptop talking to a newer KB keeps working.

**Local events** (git-ignored, pruned after `security.eventRetentionDays`, never leave the machine):

- `injection` gains `ms`, `ok`, `chars`, `full` and `ruleOnly`. Today the hook logs it before rendering; it moves to the end of the hook, in a `finally`, so a hook that throws still logs the event with `ok: false` and no selection fields.
- `mcp-call` gains `ms` and `ok`. Today the server logs it before the tool runs; it moves to after the tool returns or throws.
- `doc-read` gains `session` when the MCP server knows one.
- `sync-run`, new: `ms`, `ok`, and `step` when a step failed. No branch names, no lesson content.

**Run report** (`runs/<timestamp>.json` on `homeostat/state`):

- each lesson gains `source` (the entry's `source.type`), `origin` (`pending` or `review`) and `duplicateOf` when declined as a duplicate
- a `timing` block: `started` and `finished` as ISO strings, `modelCalls`, `chars`, `failedCalls`
- a `kb` block: `accepted`, `stale`, `flagged`, `disputed`, `possibleDuplicates`, from the existing health computation

**Decision records** gain `openedAt`, the run time when the record is first written (the daily run opens the review PR itself in that run), and `settledAt` on settling: the host's `mergedAt` when the PR was merged (exact on GitHub, the last update on Bitbucket), else the settling run's time. `listMergedPullRequests` already returns `mergedAt`, so this adds no host call, and the dashboard still makes none. `at` keeps its meaning.

**Heartbeat usage counters, opt-in.** A member sets `usage: true` on their own entry in `team.members`, or `HOMEOSTAT_SHARE_USAGE=1` in their environment. The next heartbeat the sync pushes (when pending changed, or 12 hours passed, as today) carries the last seven days of counts from the local event log:

```json
"usage": { "2026-10-21": { "sessions": 3, "injections": 5, "rules": 41, "mcpCalls": 2, "docReads": 1 } }
```

`sessions` is distinct session ids that day; `rules` is the sum of rules injected. Counts only: no rule ids, paths, repos, session ids, or times finer than a day. Heartbeats replace each other, so the team view covers each member's last seven days. The dashboard shows team reach only from members who opted in and says how many did. `homeostat doctor --security` lists them.

**Documentation.** `data-handling.md` gets one row under "What it stores" for the counters and one under "How to turn each part off". `architecture.md` lists the new events and the report fields.

## Surfaces

### Dashboard: `/performance`

In the nav after Automation. Same layout and style as the other pages: dark, inline SVG, minimal text, an (i) tooltip on every figure saying how it is computed and over which window.

1. **KPI row**: auto-merge share, reviewer agreement, median review latency, last daily-run duration (team figures), then rules served as a share of the rules visible here and median session-start latency (local figures). Each with a trend arrow against the previous window; the run duration compares with the median of the previous runs.
2. **Calibration**: columns per ten-point band, each split into merged, review then merged, review then declined, declined, with the three configured lines drawn. Under it one computed sentence: "Lessons sent to review at 60 to 69 were merged by a reviewer N of M times." The page states, never recommends.
3. **Decisions over time**: stacked columns per run, last 30 runs, split by decision including duplicates. The Automation page keeps its per-day count; this one is per run and links there.
4. **Reach**: injections per day over 30 days as an area chart; when members share usage, their counts for the last seven days are stacked on the same axis, with "N of M members share usage counts".
5. **Runtime**: session start (latency percentiles, context size) and daily run (duration, model calls, failures per run).
6. **Review latency**: rows per review PR, oldest open first, overdue marked, in the Automation page's queue style, with hours open per row. The Automation queue links here.

**Shared build.** Today the static build hides whole pages (`LOCAL_ONLY_PAGES`). This page needs panel-level hiding, which is new plumbing: `renderPage` gets a `shared` flag, the build sets it, and the page omits the local KPIs, the Reach panel's local series, the session-start and MCP-latency panels. `/performance` is added to the build's page list.

### CLI: `homeostat metrics`

The same objects as a compact text report under the same six headings. `--json` prints one object for scripts and CI logs. `--days <n>` sets the window (30). `--runs <n>` sets how many run reports to read (30). It reads the clone only, never the host. A clone without a state branch prints "no runs yet" and exits 0.

## Code shape

- `packages/core/src/metrics/`: pure functions over a `MetricsSnapshot` (config, entries, events, runs, decisions, heartbeats, now), one file per group (`decisions.ts`, `calibration.ts`, `latency.ts`, `reach.ts`, `runtime.ts`, `health-trend.ts`) and an `index.ts` that builds the whole report. Each has its own test on a hand-built snapshot.
- `readAutomation` moves from the dashboard to core as `readState(kbRoot)`, next to the other code that spawns git; the dashboard imports it from there. The dashboard's `metrics.ts` keeps its functions; the new page and the CLI command are renderers over core's report.
- Durations in events use `performance.now()`; the run report's `timing` uses `Date`. No new dependency.

## Testing

- Core: one test file per metrics group. The calibration fixture mirrors the first live run: 34 at 68 to review, 12 at 76 to review, duplicates declined at 86 and 92, and settled outcomes.
- Dashboard: the page renders from a full snapshot and from an empty one; the shared build omits the local panels and includes the page.
- CLI: the `--json` shape, and a clone without a state branch.
- Daily run: the report carries `timing`, `kb` and the lesson fields; decisions carry `openedAt` and `settledAt`, with `settledAt` taken from the host's `mergedAt` when present.
- Sync: the heartbeat carries `usage` only when opted in, and only counts.
- Hook and MCP: events carry `ms` and `ok`; a hook that throws still exits 0 and logs the event with `ok: false`.
- The settings test that every config key has a form covers the new member field.

## Two plugin fixes, as their own task in commit 2

The trial showed that the plugin's `run.mjs` prefers any `homeostat` on the PATH over the pinned npx version. On the author's laptop that was a global 0.1.7, which rejects the 0.2 config, so the session hooks, the sync and the MCP server exited silently for a day.

1. `run.mjs` order becomes: `HOMEOSTAT_CLI` when set; else a PATH `homeostat` only when `homeostat --version` equals the plugin's version, with the answer cached per binary path and modification time for 24 hours in the OS temp dir, so the extra spawn happens once a day; else `npx --yes homeostat@<pinned>`.
2. `homeostat doctor` runs `homeostat --version` on the PATH and warns when it differs from its own `VERSION`, since that is the mismatch the plugin would hit.

## Out of scope

Metrics in the weekly digest, dollar cost, member usage rankings, any shared aggregate beyond the opt-in counters, self-tuning thresholds, and any change to the work KB during its trial.

## Order of work

Three commits on `main`, each passing `pnpm check`:

1. Core metrics module with tests, `readState` in core, and `homeostat metrics`. No behaviour change for anyone.
2. The new event fields, the run-report additions, the decision timestamps, the opt-in heartbeat counters, `data-handling.md`, `architecture.md`, the doctor's security listing; then, as a separate task, the two plugin fixes.
3. The Performance page, the `shared` flag, and the build's page list.

Then release 0.2.2 with the maintainer's approval. It also carries the pending learn and review skill updates. KB pipelines stay pinned to 0.2.1 until the trial ends.
